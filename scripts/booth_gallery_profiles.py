"""Gather the shareable, source-attributed text for each booth gallery profile."""
import csv
import html
import importlib.util
import json
import re
import sqlite3
import unicodedata
from collections import defaultdict
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

# Use the same output-time privacy filter as the project's research exports.
_spec = importlib.util.spec_from_file_location(
    "booth_gallery_scrub", Path(__file__).resolve().parents[1] / "hack-western-13-people" / "scrub.py")
scrub = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(scrub)

PROFILE_FIELDS = ("School / program", "Grad year", "Current role", "Past roles", "Projects",
                  "Hackathon wins", "Awards", "Publications", "News", "Clubs / leadership",
                  "Skills / interests", "Talking points")
LINK_FIELDS = ("GitHub", "Devpost", "Personal site", "Other links", "Sources")
LINKEDIN_SECTIONS = {
    "education": "LinkedIn education", "awards": "LinkedIn honors/awards (self-reported)",
    "certifications": "LinkedIn certifications", "li_projects": "LinkedIn projects",
    "publications": "LinkedIn publications", "volunteering": "LinkedIn volunteering",
    "organizations": "LinkedIn organizations",
}


def _rows(path):
    with path.open(encoding="utf-8-sig", newline="") as source:
        yield from csv.DictReader(source)


def _json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def _parts(text):
    return [part.strip() for part in (text or "").split(" | ") if part.strip()]


def _name_key(name):
    return " ".join(unicodedata.normalize("NFC", name.removesuffix(" (you)")).casefold().split())


def _text(value):
    if not isinstance(value, str):
        return ""
    value = html.unescape(value.strip())
    if scrub.unsafe(value):
        return ""
    return scrub.scrub(value).replace("A data-broker result was ignored.", "").strip()


def _url(value):
    if not isinstance(value, str):
        return ""
    value = html.unescape(value.strip())
    try:
        parts = urlsplit(value)
        if parts.scheme.lower() not in ("http", "https") or not parts.hostname or parts.username or parts.password:
            return ""
        if re.search(r'[\x00-\x20<>"]', value) or scrub.unsafe(value) or scrub.EMAIL.search(value):
            return ""
        if re.search(r"rocketreach|zoominfo|signalhire|contactout|lusha|apollo\.io", parts.hostname, re.I):
            return ""
    except ValueError:
        return ""
    return value


def _linkedin_slug(url):
    parts = urlsplit(_url(url))
    path = parts.path.lower().strip("/").split("/")
    host = parts.hostname or ""
    if (host == "linkedin.com" or host.endswith(".linkedin.com")) and len(path) >= 2 and path[0] == "in":
        return path[1]
    return ""


def _account_key(url):
    parts = urlsplit(_url(url))
    host = (parts.hostname or "").lower().removeprefix("www.")
    segments = parts.path.lower().strip("/").split("/")
    slug = _linkedin_slug(url)
    if slug and len(segments) == 2:
        return "linkedin.com", slug
    if host in ("github.com", "devpost.com") and len(segments) == 1 and segments[0]:
        return host, segments[0]
    return None


def _date(stamp):
    return datetime.fromtimestamp(float(stamp), tz=timezone.utc).date().isoformat() if stamp else ""


class _Profiles:
    def __init__(self, data, people):
        self.data = data
        self.names = {pid: person.name for pid, person in people.items()}
        self.sections = defaultdict(dict)
        self.seen = defaultdict(set)
        self.owners = {}
        self.aliases = defaultdict(set)
        self.team_only = {}
        for pid, person in people.items():
            for alias in person.aliases:
                self.aliases[alias].add(pid)
            for name, url, match, confidence in person.research_owners:
                self.owners[name, url, match] = (pid, confidence)

    def add(self, pid, section, label, text, url="", date="", body=""):
        text, url = _text(text), _url(url)
        if not text or text in {"[email omitted]", "N/A"}:
            return
        key = (section, label.casefold(), text.casefold(), url)
        if key in self.seen[pid]:
            return
        self.seen[pid].add(key)
        item = {"label": label, "text": text}
        if url:
            item["url"] = url
        if date:
            item["date"] = date
        body = _text(body)
        if body and body != text:
            item["body"] = body
        self.sections[pid].setdefault(section, []).append(item)

    def event(self, people):
        slack_ids = set()
        for row in _rows(self.data / "hack-western-13-slack-members.csv"):
            pid = row["Slack user ID"]
            if pid not in self.names:
                continue
            slack_ids.add(pid)
            for field in ("Role", "Organization / school", "Title", "Slack display name", "Slack username"):
                self.add(pid, "Event profile", field, row[field])
            if _url(row["Profile link"]):
                self.add(pid, "Event profile", "Slack profile", "Open Slack profile", row["Profile link"])
        for pid, person in people.items():
            if pid not in slack_ids:
                self.add(pid, "Event profile", "Role", person.role)

        site = self.data / "hackwestern-site"
        for row in _json(site / "mentors.json"):
            pid = row.get("slack_id")
            if pid not in self.names:
                continue
            self.add(pid, "Hack Western mentor listing", "Mentor", row.get("tags"))
            if _url(row.get("linkedin")):
                self.add(pid, "Hack Western mentor listing", "LinkedIn", "Mentor-listed profile", row["linkedin"])
        for row in _json(site / "team-finder.json"):
            name = row["name"]
            pid = row.get("slack_id") or "tf:" + re.sub("[^a-z0-9]+", "-", name.lower()).strip("-")
            self.names.setdefault(pid, name)
            if not row.get("slack_id"):
                self.team_only[_name_key(name)] = pid
            for key, label in (("status", "Status"), ("school", "School"), ("skills", "Skills"),
                               ("looking_for", "Looking for"), ("idea", "Idea")):
                value = row.get(key)
                self.add(pid, "Hack Western team finder", label, ", ".join(value) if isinstance(value, list) else value)
            for key in ("linkedin", "github", "instagram"):
                if _url(row.get(key)):
                    self.add(pid, "Hack Western team finder", key.title(), "Profile listed on team card", row[key])

        registry = self.data / "devpost-registrants.json"
        for row in _json(registry) if registry.is_file() else []:
            account = _account_key(row.get("Devpost"))
            if not account or account[0] != "devpost.com":
                continue
            pid = "devpost:" + account[1]
            self.names.setdefault(pid, row["Name"])
            source = _url(row.get("Sources"))
            for field in ("Role", "Status", "Confidence notes", "Skills / interests"):
                for text in _parts(row.get(field)):
                    self.add(pid, "Devpost registration", field, text, source)
            self.add(pid, "Devpost registration", "Devpost", "Registrant profile", row["Devpost"])

    def professional(self):
        for row in _rows(self.data / "hack-western-13-linkedin.csv"):
            pid = row["Slack user ID"]
            level = row["LinkedIn match"].lower()
            if pid not in self.names or level not in ("confirmed", "likely"):
                continue
            url = row["LinkedIn URL"]
            section = "LinkedIn · " + level + " match"
            for key in ("Headline / current work", "Education", "Location"):
                self.add(pid, section, key, row[key], url)
            if _url(url):
                self.add(pid, section, "LinkedIn", "View profile", url)

        for row in _rows(self.data / "hack-western-13-people-profiles.csv"):
            pid = row["Slack user ID"]
            if not pid:
                match = re.fullmatch(r"\(team finder only: (.+)\)", row["Slack name"], re.I)
                pid = self.team_only.get(_name_key(match[1])) if match else None
            if pid not in self.names:
                continue
            level = row["LinkedIn match"].lower()
            label = {"high": "confirmed match", "medium": "likely match"}.get(level, "non-LinkedIn sources")
            section = "Professional profile · " + label
            if _name_key(row["Name"]) != _name_key(self.names[pid]):
                self.add(pid, section, "Profile name", row["Name"])
            self.add(pid, section, "Related account", row["Same person as"])
            for key in PROFILE_FIELDS:
                for text in _parts(row[key]):
                    self.add(pid, section, key, text)
            for key in LINK_FIELDS:
                for url in re.findall(r"https?://[^\s<>|]+", row[key]):
                    if _url(url):
                        self.add(pid, "Profile sources · " + label, key, url, url)
            if level in ("high", "medium"):
                self.linkedin_text(pid, label, row)

    def linkedin_text(self, pid, label, row):
        url, fetched = row["LinkedIn"], row["LinkedIn page fetched"]
        record = self.data / "linkedin" / "li-public" / (pid + ".json")
        raw = _json(record) if record.is_file() else {}
        if not _linkedin_slug(url) or _linkedin_slug(raw.get("url")) != _linkedin_slug(url):
            raw = {}
        expanded = {}
        for key, column in LINKEDIN_SECTIONS.items():
            for entry in raw.get(key) or []:
                title = entry.get("title") or ""
                org, dates = entry.get("org"), entry.get("dates")
                if org and org != dates:
                    title += (", " if title else "") + org
                if dates:
                    title += " (" + dates + ")"
                description = entry.get("description") or ""
                short = title + (": " + description[:300] if description else "")
                expanded[column, _text(short)] = (title + (": " + description if description else ""), url, fetched)
        for entry in raw.get("posts") or []:
            post_url, text = _url(entry.get("url")), (entry.get("text") or "").strip()
            if not post_url or "/posts/" + _linkedin_slug(url) + "_" not in post_url.lower():
                continue
            short = f"{entry.get('date') or ''}: {text[:300]} {post_url}"
            expanded["Recent LinkedIn posts", _text(short)] = (text, post_url, entry.get("date") or fetched)
        for key, value in row.items():
            if key in ("LinkedIn match", "LinkedIn page fetched"):
                continue
            if not key.startswith("LinkedIn ") and key != "Recent LinkedIn posts":
                continue
            for part in _parts(value):
                text, source, date = expanded.get((key, _text(part)), (part, url, fetched))
                if not _text(text):
                    text, source, date = part, url, fetched
                field = "Experience listed on profile" if key == "LinkedIn current" else key.removeprefix("LinkedIn ").capitalize()
                self.add(pid, "Public LinkedIn text · " + label, field, text, source, date)

    def portrait_notes(self):
        for path in sorted((self.data / "faces").glob("*.csv")):
            for row in _rows(path):
                if row["Match"] != "Confirmed":
                    continue
                pid = row["Slack user ID"] or row["Person ID"]
                if pid not in self.names:
                    owners = self.aliases.get(_name_key(row["Name"]), set())
                    if row["Slack user ID"] or len(owners) != 1:
                        continue
                    pid = next(iter(owners))
                for note in _parts(row["Facts"]):
                    self.add(pid, "Portrait source notes", row["Source"], note, row.get("Source URL", ""))

    def research(self):
        path = self.data.parent / "people.db"
        if not path.is_file():
            return
        with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
            db.execute("begin")  # Read facts and pages from a single snapshot, including any committed WAL.
            source_facts = defaultdict(list)
            for name, text, url, confidence, stamp in db.execute(
                    "select person,fact,source,match,t from facts order by t,person,fact"):
                pid, level = self.owners.get((name, url or "", confidence), (None, None))
                if pid:
                    self.add(pid, "Research facts · " + level, "Source record", text, url, _date(stamp))
                    if level == "confirmed" and _url(url) and _text(text):
                        source_facts[pid, _url(url).rstrip("/")].append(_text(text))
            for name, url, kind, title, page, confidence, stamp in db.execute(
                    "select person,url,kind,title,text,match,t from pages order by t,person,url"):
                pid, level = self.owners.get((name, url or "", confidence), (None, None))
                if not pid or not _url(url):
                    continue
                # Show excerpts only when a confirmed fact was found verbatim on this exact page.
                body = []
                if level == "confirmed" and page:
                    page_text = " ".join(html.unescape(page).split()).casefold()
                    for fact in source_facts[pid, _url(url).rstrip("/")]:
                        anchor = fact.strip(" .")
                        if 40 <= len(fact) <= 450 and len(fact.split()) >= 7 and anchor.casefold() in page_text:
                            if anchor not in body:
                                body.append(anchor)
                self.add(pid, "Source pages · " + level, kind or "Web page", title or url, url, _date(stamp),
                         "\n\n".join(body))

    def export(self):
        return {pid: {"name": self.names[pid],
                      "sections": [{"title": title, "items": items} for title, items in self.sections[pid].items()]}
                for pid in sorted(self.names)}


def build_profiles(data: Path, people: dict) -> dict:
    """Return source sections keyed by stable booth, team-finder or registrant ID."""
    profiles = _Profiles(data, people)
    profiles.event(people)
    profiles.professional()
    profiles.portrait_notes()
    profiles.research()
    return profiles.export()
