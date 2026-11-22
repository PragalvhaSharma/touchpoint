"""Resolve the source of each research record to a stable directory ID."""
from collections import defaultdict
from contextlib import closing
import importlib.util
import json
from pathlib import Path
import re
import sqlite3
import unicodedata
from urllib.parse import urlsplit


def name_key(value):
    return " ".join(unicodedata.normalize("NFC", value or "").removesuffix(" (you)").casefold().split())


def team_id(name):
    return "tf:" + re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def account_key(url):
    """Only owner profile URLs establish identity. Shared projects do not."""
    try:
        parts = urlsplit(url or "")
        if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
            return None
        host = parts.hostname.lower().removeprefix("www.")
    except ValueError:
        return None
    path = parts.path.casefold().strip("/").split("/")
    if host == "linkedin.com" or host.endswith(".linkedin.com"):
        if len(path) >= 2 and path[0] == "in" and path[1]:
            return ("linkedin.com", path[1])
    if host in {"devpost.com", "github.com"} and path[0]:
        if len(path) == 1 or (host == "devpost.com" and path[1:] == ["challenges"]):
            return (host, path[0])
    return None


class Ownership:
    def __init__(self, people):
        self.people = people
        self.names = defaultdict(set)
        self.accounts = defaultdict(set)
        self.linkedin = {}
        for pid, p in people.items():
            self.alias(pid, p.name)

    def alias(self, pid, name):
        key = name_key(name)
        if key:
            self.names[key].add(pid)
            self.people[pid].aliases.add(key)

    def account(self, pid, url, confidence="confirmed"):
        key = account_key(url)
        if not key:
            return
        if key[0] == "linkedin.com" and self.linkedin.get((pid, key)) != "confirmed":
            self.linkedin[pid, key] = confidence
        if confidence == "confirmed":
            self.accounts[key].add(pid)

    def resolve(self, name, url, confidence):
        if confidence not in ("confirmed", "likely"):
            return None
        key = account_key(url)
        known = {name} if name in self.people else self.names.get(name_key(name), set())
        accounts = self.accounts.get(key, set())
        owners = (known & accounts) if known and accounts else (known or accounts)
        if len(owners) != 1:
            return None
        pid, = owners
        if key and key[0] == "linkedin.com":
            verified = self.linkedin.get((pid, key))
            if verified is None:
                return None
            if verified == "likely":
                confidence = "likely"
        return pid, confidence


def directory_index(data, people):
    from .roster import Person, csv_rows
    index = Ownership(people)
    def optional_json(file):
        return json.loads(file.read_text()) if file.is_file() else []

    for row in csv_rows(data / "hack-western-13-slack-members.csv"):
        pid = row["Slack user ID"]
        if pid in people:
            for field in ("Name", "Slack display name", "Slack username"):
                index.alias(pid, row.get(field))
    site = data / "hackwestern-site"
    for row in optional_json(site / "mentors.json"):
        if row.get("slack_id") in people:
            index.account(row["slack_id"], row.get("linkedin"))
    for row in optional_json(site / "team-finder.json"):
        pid = row.get("slack_id") or team_id(row["name"])
        if pid not in people:
            role = ", ".join(v for v in ("Team finder", row.get("school")) if v)
            people[pid] = Person(pid, row["name"], role=role)
        index.alias(pid, row["name"])
        for field in ("linkedin", "github", "devpost"):
            index.account(pid, row.get(field))
    for row in optional_json(data / "devpost-registrants.json"):
        key = account_key(row.get("Devpost"))
        if key and key[0] == "devpost.com":
            owners = index.accounts.get(key, set())
            if len(owners) > 1:
                continue
            pid = next(iter(owners)) if owners else "devpost:" + key[1]
            if pid not in people:
                people[pid] = Person(pid, row["Name"], role="Devpost registrant")
                if row.get("Confidence notes"):
                    people[pid].facts.append(row["Confidence notes"])
            index.alias(pid, row["Name"])
            index.account(pid, row["Devpost"])
    for row in csv_rows(data / "hack-western-13-linkedin.csv"):
        pid = row["Slack user ID"]
        level = row.get("LinkedIn match", "").lower()
        if pid in people and level in ("confirmed", "likely"):
            index.account(pid, row.get("LinkedIn URL"), level)
            if level == "confirmed":
                index.alias(pid, row.get("Name"))
    for row in csv_rows(data / "hack-western-13-people-profiles.csv"):
        pid = row["Slack user ID"]
        if not pid:
            card = re.fullmatch(r"\(team finder only: (.+)\)", row.get("Slack name", ""), re.I)
            pid = team_id(card[1]) if card else None
        if pid not in people:
            continue
        level = row.get("LinkedIn match", "")
        if level == "high":
            index.alias(pid, row.get("Name"))
            for field in ("LinkedIn", "GitHub", "Devpost"):
                index.account(pid, row.get(field))
            if pid.startswith("tf:"):
                person = people[pid]
                if not person.photos and row.get("Name"):
                    person.name = row["Name"]
                for fact in row.get("Talking points", "").split("|"):
                    if fact.strip() and fact.strip() not in person.facts:
                        person.facts.append(fact.strip())
        elif level == "medium":
            index.account(pid, row.get("LinkedIn"), "likely")
    for sheet in sorted((data / "faces").glob("*.csv")):
        for row in csv_rows(sheet):
            pid = row.get("Person ID")
            if pid in people and row.get("Match") == "Confirmed":
                if not row.get("Slack user ID") or people[pid].verified_photo:
                    index.alias(pid, row.get("Name"))
                if people[pid].verified_photo and sheet.name == "verified-portraits.csv":
                    index.account(pid, row.get("Source URL"))
    return index


def add_research(data: Path, people):
    index = directory_index(data, people)
    db_path = data.parent / "people.db"
    if not db_path.exists():
        return
    spec = importlib.util.spec_from_file_location("scrub", data / "scrub.py")
    scrub = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(scrub)
    with closing(sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)) as db:
        db.execute("begin")
        for name, url, match in db.execute("select person,url,match from pages"):
            resolved = index.resolve(name, url, match)
            if resolved:
                pid, confidence = resolved
                people[pid].research_owners.add((name, url or "", match, confidence))
        for name, fact, url, match in db.execute("select person,fact,source,match from facts order by t"):
            resolved = index.resolve(name, url, match)
            if not resolved:
                continue
            pid, confidence = resolved
            person = people[pid]
            person.research_owners.add((name, url or "", match, confidence))
            if confidence == "confirmed" and not scrub.unsafe(fact):
                fact = scrub.scrub(fact)
                if fact and fact.casefold() not in {f.casefold() for f in person.facts}:
                    person.facts.append(fact)
