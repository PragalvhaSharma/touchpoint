"""Rebuild the portable booth profile and portrait gallery from this checkout."""
import argparse
import csv
import hashlib
import json
import os
import re
import sys
import tempfile
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
from urllib.parse import quote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "hack-western-13-people"
sys.path.insert(0, str(ROOT / "greeter"))
from greeter import roster
from booth_gallery_profiles import build_profiles

LABELS = {"linkedin": "LinkedIn", "github": "GitHub", "devpost": "Devpost", "x": "X",
          "gravatar": "Gravatar", "instagram": "Instagram", "hackwestern-site": "Hack Western",
          "personal-site": "Personal site", "sessionize": "Sessionize", "commure-blog": "Commure"}


def rows(path):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def read(path):
    return json.loads(path.read_text())


@lru_cache(maxsize=None)
def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def public_page(value):
    try:
        url = urlsplit(value or "")
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
            return ""
        if url.hostname.endswith(("licdn.com", "slack-edge.com", "cloudfront.net", "githubusercontent.com")):
            return ""
        if re.search(r"\.(?:jpe?g|png|webp|gif|svg)$", url.path, re.I):
            return ""
        return value if not re.search(r'[\x00-\x20<>"]', value) else ""
    except ValueError:
        return ""


def page_key(url):
    url = urlsplit(public_page(url))
    host = (url.hostname or "").removeprefix("www.")
    if host.endswith(".linkedin.com"):
        host = "linkedin.com"
    return (host, url.path.lower().rstrip("/")) if host else None


def source_link(row):
    if row.get("Source URL"):
        return public_page(row["Source URL"])
    evidence = row.get("Evidence", "")
    m = re.search(r"https?://[^\s|<>]+|(?:github|sessionize)\.com/[a-zA-Z0-9-]+", evidence)
    if not m:
        return ""
    link = m[0].rstrip(".,;)")
    return public_page(link if link.startswith("http") else "https://" + link)


def related_profiles(profile_rows):
    """Co-owned image bytes may be displayed for explicitly linked accounts."""
    parent = {}
    def group(pid):
        while pid != parent.get(pid, pid):
            pid = parent[pid]
        return pid
    for row in profile_rows:
        name = re.fullmatch(r"\(team finder only: (.+)\)", row["Slack name"], re.I)
        owner = row["Slack user ID"] or (team_id(name[1]) if name else None)
        if owner:
            for other in re.findall(r"\((U[A-Z0-9]+)\)", row["Same person as"]):
                parent[group(owner)] = group(other)
    return group


def team_id(name):
    return "tf:" + re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def build(data):
    # The gallery shows linked accounts side by side ("Related account"), so keep them unfolded here.
    people = roster.load(data.parent / "greeter/people", data, fold=False)
    profiles = build_profiles(data, people)
    curated = read(data / "booth-gallery-review.json")
    verified = {p.id: p.verified_photo for p in people.values() if p.verified_photo}
    records = {pid: {"id": pid, "name": (people[pid].name if pid in verified else entry["name"]),
                     "sections": entry["sections"], "primarySrc": None, "photos": []}
               for pid, entry in profiles.items()}
    metadata = defaultdict(dict)
    originals = defaultdict(dict)
    rejected_stems = {str(Path(rel).with_suffix("")) for rel in read(data / "linkedin/photo-rejects.json")}
    excluded = {(r["id"], r["sha256"]) for r in curated["rejected_content"]}
    retired = {(r["Person ID"], r["SHA256"]) for r in rows(data / "faces/verified-portraits/superseded.csv")}
    approvals = read(data / "linkedin/fallback-photos.json")
    approved_pages = {(pid, page_key(r.get("page_url"))) for pid, r in approvals.items()
                      if r.get("reviewed") or r.get("manual")}
    rejected_pages = {(pid, page_key(r.get("page_url"))) for pid, rr in read(data / "linkedin/fallback-rejected.json").items()
                      for r in rr if r.get("page_url") and r.get("source") in ("Devpost photo", "GitHub avatar")}
    linkedin = {r["Slack user ID"]: r for r in rows(data / "hack-western-13-linkedin.csv")}
    likely_pages = {(pid, page_key(r["LinkedIn URL"])) for pid, r in linkedin.items()
                    if r["LinkedIn match"] == "Likely" and public_page(r["LinkedIn URL"])}

    def add(pid, path, label, page="", *, likely=False):
        if pid not in records or not path:
            return
        file = data / path
        if not file.resolve().is_relative_to(data) or not file.is_file():
            return
        rel = file.relative_to(data).as_posix()
        is_reviewed = file == verified.get(pid)
        key = (pid, page_key(page))
        if not is_reviewed and (str(Path(rel).with_suffix("")) in rejected_stems or (pid, sha(file)) in excluded
                               or (pid, sha(file)) in retired or (key in rejected_pages and key not in approved_pages)):
            return
        likely = not is_reviewed and (likely or (key in likely_pages and key not in approved_pages))
        new = {"src": quote(rel, safe="/"), "source": label + (" · likely match" if likely else ""), "variants": {}}
        public = public_page(page)
        if public:
            new["sourceUrl"] = public
        if file not in originals[pid] or (metadata[pid][file] and not likely):
            originals[pid][file] = new
            metadata[pid][file] = likely

    slack = rows(data / "hack-western-13-slack-members.csv")
    eligible_by_path = defaultdict(list)
    confirmed_face_files = set()
    for pid, person in people.items():
        for path in person.photos:
            eligible_by_path[path].append(pid)
    for sheet in sorted((data / "faces").glob("*.csv"), key=lambda f: (f.name != roster.VERIFIED_SHEET, f.name)):
        for r in rows(sheet):
            if r["Match"] != "Confirmed" or not r["Photo"]:
                continue
            file = data / r["Photo"]
            owners = eligible_by_path[file]
            pid = r["Person ID"] if r["Person ID"] in owners else (owners[0] if len(owners)==1 else None)
            if not pid:
                continue
            label = r["Source"].removeprefix("person-tool:")
            add(pid, r["Photo"], LABELS.get(label, label), source_link(r))
            confirmed_face_files.add((pid, file))
    for r in slack:
        pid = r["Slack user ID"]
        add(pid, r["Photo file"], "Slack")
        item = linkedin.get(pid, {})
        matched = item.get("LinkedIn match")
        if matched in ("Confirmed", "Likely"):
            add(pid, item.get("LinkedIn photo") or f"photos-linkedin/{pid}-linkedin.jpg", "LinkedIn",
                item.get("LinkedIn URL"), likely=matched == "Likely")
        add(pid, item.get("HW site photo"), "Hack Western")
    for r in read(data / "hackwestern-site/team-finder.json") + read(data / "hackwestern-site/mentors.json"):
        if r.get("photo_file"):
            add(r.get("slack_id") or team_id(r["name"]), "hackwestern-site/"+r["photo_file"], "Hack Western")
    for pid, r in approvals.items():
        if r.get("reviewed") or r.get("manual"):
            add(pid, r.get("file"), r.get("source") or "Reviewed portrait", r.get("page_url"))
    for pid, p in people.items():
        for path in p.photos:
            if path.is_relative_to(data) and path not in originals[pid]:
                # Sources explicitly excluded by a person/page decision must not slip back through a generic label.
                if path.parent.name not in ("photos", "photos-linkedin"):
                    continue
                li = linkedin.get(pid, {})
                label, url = ("LinkedIn", li.get("LinkedIn URL")) if path.parent.name=="photos-linkedin" else ("Slack", "")
                add(pid, path, label, url)

    group = related_profiles(rows(data / "hack-western-13-people-profiles.csv"))
    by_digest = defaultdict(set)
    for pid, collection in originals.items():
        for file in collection:
            by_digest[sha(file)].add(group(pid))

    for pid, record in records.items():
        collection = originals[pid]
        decision = curated["people"].get(pid, {})
        keep = {}
        for path, photo in collection.items():
            if len(by_digest[sha(path)]) > 1 and path != verified.get(pid):
                continue
            if pid in people and (not metadata[pid][path] or (pid, path) in confirmed_face_files):
                photo["variants"] = {v.stem: quote(v.relative_to(data).as_posix(), safe="/")
                                     for v in roster.lighting_paths(data, pid, path) if people[pid].variants.get(v)==path}
            keep[path] = photo
        primary = verified.get(pid)
        if primary and primary not in keep:
            raise ValueError(f"Missing verified portrait for {pid}")
        if not primary:
            selected = decision.get("primary", {})
            if selected:
                target = data / selected["path"]
                if target in keep and sha(target) == selected["sha256"]:
                    primary = target
                else:
                    primary = next((p for p in keep if sha(p)==selected["sha256"] and not metadata[pid][p]), None)
            if not primary and not decision.get("status") == "unresolved":
                candidate = approvals.get(pid, {})
                path = data / candidate.get("file", "")
                if path in keep and (candidate.get("reviewed") or candidate.get("manual")):
                    primary = path
        if primary:
            record["primarySrc"] = keep[primary]["src"]
        record["photos"] = [keep[p] for p in sorted(keep, key=lambda p: (p != primary, not keep[p]["variants"], p))]
        if decision.get("review"):
            record["sections"].append({"title":"Portrait review","items":decision["review"]})
        if pid in verified:
            record["photoReview"] = "primary"
        elif decision.get("status") == "unresolved" and not primary:
            record["photoReview"] = "unresolved"
        if pid.startswith("devpost:"):
            record["registrationOnly"] = True
    return sorted(records.values(), key=lambda p:(p["name"].casefold(), p["id"]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DATA / "booth-gallery.html")
    args = parser.parse_args()
    directory = build(DATA)
    template = Path(__file__).with_name("booth-gallery.template.html").read_text()
    payload = json.dumps(directory, ensure_ascii=True, separators=(",", ":"))
    for char, escaped in [("<", r"\u003c"), (">", r"\u003e"), ("&", r"\u0026")]:
        payload = payload.replace(char, escaped)
    assert template.count("__GALLERY_DATA__") == 1
    with tempfile.NamedTemporaryFile(mode="w", dir=args.output.parent, delete=False) as tmp:
        tmp.write(template.replace("__GALLERY_DATA__", payload))
    os.chmod(tmp.name, 0o644)
    os.replace(tmp.name, args.output)
    print(f"{len(directory)} people, {sum(bool(p['primarySrc']) for p in directory)} selected portraits, "
          f"{sum(len(p['photos']) for p in directory)} saved originals, "
          f"{sum(len(ph['variants']) for p in directory for ph in p['photos'])} lighting variants")


if __name__ == "__main__":
    main()
