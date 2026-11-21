"""Who the greeter knows: a face's photos and what to talk about.

Two sources, read in place (never copied):
- people/<name>/photos/*.jpg + about.md: anyone added at the table
- the Hack Western 13 people data (../hack-western-13-people): every Slack
  member, from their Slack photo, their LinkedIn photo when the match is
  "Confirmed", and their hackwestern.com photo. Talking points only when the
  profile match is "high", so the agent never says another person's facts.
  A photo with no face in it (letter avatars, landscapes) teaches nothing.
- faces/*.csv in that data: Confirmed photos from more sources (GitHub,
  Gravatar, Devpost, hackwestern.com), and people not on Slack.
- people.db at the repo root: facts the person-lookup agents confirmed from each
  person's own pages (LinkedIn, GitHub, personal site, blog...), each with its
  source. Only "confirmed" facts become talking points.
"""
from dataclasses import dataclass, field
from pathlib import Path
import csv
import hashlib
import json

PHOTO_TYPES = {".jpg", ".jpeg", ".png", ".webp"}
LIGHTING_KINDS = ("brighter", "dimmer", "left-shadow", "right-shadow")
VERIFIED_SHEET = "verified-portraits.csv"


def clean(name: str) -> str:
    """Slack's export marks the account that ran it as "Name (you)"."""
    return name.removesuffix(" (you)").strip()


def csv_rows(path: Path):
    with path.open(newline="") as stream:
        yield from csv.DictReader(stream)


@dataclass
class Person:
    id: str
    name: str
    photos: list[Path] = field(default_factory=list)
    facts: list[str] = field(default_factory=list)
    role: str = ""
    variants: dict[Path, Path] = field(default_factory=dict)
    verified_photo: Path | None = None
    aliases: set[str] = field(default_factory=set)
    research_owners: set[tuple[str, str, str, str]] = field(default_factory=set)
    merged_ids: set[str] = field(default_factory=set)  # other roster IDs folded into this person


def legacy_lighting_hashes(data: Path) -> dict[str, str]:
    index = data / "lighting-variants" / "legacy-source-hashes.json"
    return json.loads(index.read_text()) if index.is_file() else {}


def lighting_paths(data: Path, person_id: str, source: Path, *,
                   legacy: dict[str, str] | None = None) -> tuple[Path, ...]:
    """Bind edits to the person, the path and the actual bytes of the original."""
    relative = source.relative_to(data).as_posix()
    identity = f"{person_id}\0{relative}"
    digest = photo_digest(source)
    key = hashlib.sha256(identity.encode()).hexdigest()[:24]
    if legacy is None:
        legacy = legacy_lighting_hashes(data)
    if legacy.get(key) != digest:
        key = hashlib.sha256(f"{identity}\0{digest}".encode()).hexdigest()[:24]
    folder = data / "lighting-variants" / key
    return tuple(folder / f"{kind}.jpg" for kind in LIGHTING_KINDS)


def photo_digest(photo: Path) -> str:
    with photo.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def from_folder(people: Path) -> list[Person]:
    out = []
    for d in sorted(p for p in people.iterdir() if p.is_dir() and not p.name.startswith("_")):
        photos = sorted(p for p in (d / "photos").glob("*") if p.suffix.lower() in PHOTO_TYPES)
        about = d / "about.md"
        facts = [l.lstrip("-* ").strip() for l in about.read_text().splitlines()
                 if l.strip().startswith(("-", "*"))] if about.exists() else []
        out.append(Person(d.name, d.name, photos, facts))
    return out


def from_hack_western(data: Path, with_linkedin: bool = True) -> list[Person]:
    linkedin = {r["Slack user ID"]: r for r in csv_rows(data / "hack-western-13-linkedin.csv")}
    profiles = {r["Slack user ID"]: r for r in csv_rows(data / "hack-western-13-people-profiles.csv") if r["Slack user ID"]}
    out = []
    for r in csv_rows(data / "hack-western-13-slack-members.csv"):
        sid = r["Slack user ID"]
        photos = [data / r["Photo file"]] if r["Photo file"] else []
        li = linkedin.get(sid, {})
        if with_linkedin and li.get("LinkedIn match") == "Confirmed":
            # the CSV can miss a photo that was saved before the match was confirmed
            saved = li.get("LinkedIn photo") or f"photos-linkedin/{sid}-linkedin.jpg"
            photos.append(data / saved)
        if with_linkedin and li.get("HW site photo"):
            photos.append(data / li["HW site photo"])
        prof = profiles.get(sid, {})
        facts = [t.strip() for t in prof.get("Talking points", "").split("|") if t.strip()] \
            if prof.get("LinkedIn match") == "high" else []
        role = ", ".join(x for x in (r["Role"], r["Organization / school"]) if x)
        out.append(Person(sid, clean(r["Name"]), [p for p in photos if p.exists()], facts, role))
    return out


def add_faces(data: Path, persons: dict[str, Person]):
    """Confirmed rows from faces/*.csv (GitHub, Gravatar, Devpost, hackwestern.com...): more photos of
    people we know, and people who aren't on Slack (judges, sponsors) as new entries."""
    by_name = {p.name.lower(): p for p in persons.values()}
    for sheet in sorted((data / "faces").glob("*.csv")):
        reviewed = sheet.name == VERIFIED_SHEET
        for r in csv_rows(sheet):
            if r.get("Match") != "Confirmed":
                continue
            pid = r["Person ID"]
            photo = data / r["Photo"] if r.get("Photo") else None
            if reviewed and (not photo or not photo.is_file() or photo_digest(photo) != r.get("SHA256")):
                continue
            # a row with no Slack ID for someone already known by name is the same person, not a second one
            person = persons.get(pid)
            if person is None and not reviewed and not r.get("Slack user ID"):
                person = by_name.get(clean(r["Name"]).lower())
            if person is None:
                facts = [f.strip() for f in r.get("Facts", "").split("|") if f.strip()]
                role = ", ".join(x for x in (r.get("Role", ""), r.get("Organization", "")) if x)
                person = persons[pid] = Person(pid, clean(r["Name"]), [], facts, role)
                by_name.setdefault(person.name.lower(), person)
            if photo and photo.is_file():
                if reviewed:
                    # Keep the exact reviewed roster ID and prefer its named portrait
                    # when no two independent originals agree.
                    person.name = clean(r["Name"])
                    by_name.setdefault(person.name.lower(), person)
                    person.verified_photo = photo
                    person.photos = [photo, *(p for p in person.photos if p != photo)]
                elif photo not in person.photos:
                    person.photos.append(photo)

    ledger = data / "faces" / "verified-portraits" / "superseded.csv"
    if ledger.is_file():
        for row in csv_rows(ledger):
            person = persons.get(row["Person ID"])
            photo = data / row["Photo"]
            # A corrected image may later be published at the historical path.
            if person is not None and photo in person.photos and photo_digest(photo) == row["SHA256"]:
                person.photos.remove(photo)


def held_out(data: Path) -> list[tuple[str, Path]]:
    """A second, different photo of a person (their Confirmed LinkedIn photo), for testing."""
    out = []
    for r in csv_rows(data / "hack-western-13-linkedin.csv"):
        if r["Slack photo"] and r["LinkedIn photo"] and r["LinkedIn match"] == "Confirmed":
            out.append((r["Slack user ID"], data / r["LinkedIn photo"]))
    return out


def same_person_groups(data: Path, persons: dict[str, Person]) -> list[list[str]]:
    """Roster IDs the profiles sheet links as one person ("Same person as"): a second Slack
    account, or a team-finder card for someone who is also on Slack."""
    import re
    from .research import team_id
    parent: dict[str, str] = {}

    def root(pid):
        while parent.get(pid, pid) != pid:
            pid = parent[pid]
        return pid

    sheet = data / "hack-western-13-people-profiles.csv"
    if not sheet.is_file():
        return []
    for r in csv_rows(sheet):
        team = re.fullmatch(r"\(team finder only: (.+)\)", r.get("Slack name", ""), re.I)
        ids = [r.get("Slack user ID") or (team_id(team[1]) if team else "")]
        ids += re.findall(r"\((U[A-Z0-9]+)\)", r.get("Same person as", ""))
        team = re.search(r"\(team finder only: ([^)]+)\)", r.get("Same person as", ""), re.I)
        if team:
            ids.append(team_id(team[1]))
        ids = [i for i in ids if i in persons]
        for other in ids[1:]:
            parent[root(other)] = root(ids[0])
    groups: dict[str, list[str]] = {}
    for pid in parent:
        groups.setdefault(root(pid), []).append(pid)
    for top, members in groups.items():
        if top not in members:
            members.append(top)
    return [sorted(m) for m in groups.values() if len(m) > 1]


def fold_same_person(data: Path, persons: dict[str, Person]) -> None:
    """Keep one identity per person. Two IDs holding the same face tie with each other, so the
    greeter would never name them, and a lookup would find two half-filled records."""
    for group in same_person_groups(data, persons):
        # keep the Slack account with a full name and the most to talk about
        ranked = sorted(group, key=lambda pid: (not pid.startswith("U"), " " not in persons[pid].name.strip(),
                                                -len(persons[pid].facts), -len(persons[pid].photos), pid))
        keep = persons[ranked[0]]
        seen = {photo_digest(p) for p in keep.photos if p.is_file()}
        for pid in ranked[1:]:
            other = persons.pop(pid)
            keep.merged_ids |= {pid, *other.merged_ids}
            keep.aliases |= other.aliases
            keep.research_owners |= other.research_owners
            keep.role = keep.role or other.role
            keep.verified_photo = keep.verified_photo or other.verified_photo
            for photo in other.photos:
                digest = photo_digest(photo) if photo.is_file() else None
                if photo not in keep.photos and digest not in seen:
                    keep.photos.append(photo)
                    seen.add(digest)
                    keep.variants.update((v, s) for v, s in other.variants.items() if s == photo)
            known = {f.casefold() for f in keep.facts}
            keep.facts += [f for f in other.facts if f.casefold() not in known]


def load(people: Path, data: Path | None, with_linkedin: bool = True, *,
         with_variants: bool = True, fold: bool = True) -> dict[str, Person]:
    persons = {p.id: p for p in (from_hack_western(data, with_linkedin) if data and data.exists() else [])}
    if data and data.exists() and with_linkedin:
        add_faces(data, persons)
        from .research import add_research
        add_research(data, persons)
    if data and with_variants and (data / "lighting-variants").is_dir():
        legacy = legacy_lighting_hashes(data)
        for person in persons.values():
            for source in person.photos:
                if source.is_relative_to(data):
                    variants = lighting_paths(data, person.id, source, legacy=legacy)
                    if all(path.is_file() for path in variants):
                        person.variants.update((path, source) for path in variants)
    if data and data.exists() and fold:
        fold_same_person(data, persons)
    folded = {old: p.id for p in persons.values() for old in p.merged_ids}
    for p in (from_folder(people) if people.exists() else []):
        known = persons.get(folded.get(p.id, p.id))  # people/<a folded ID>/ belongs to the kept person
        if known is None:
            persons[p.id] = p
            continue
        # people/<their id>/: photos of someone we already know, taken at the table (clicked on the page)
        known.photos = p.photos + [x for x in known.photos if x not in p.photos]
        known.facts += [f for f in p.facts if f.lower() not in {x.lower() for x in known.facts}]
    return persons
