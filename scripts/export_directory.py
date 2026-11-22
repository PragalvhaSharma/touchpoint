"""Write every person the booth knows, with everything the repo holds about them, to one file.

hack-western-13-people/directory.jsonl is the merged view that search and matching read:
one JSON line per person (linked Slack accounts and team-finder cards folded together), their
talking points, their source-linked profile sections and the photos used for face matching.
It is built from the same loaders as the greeter (greeter/greeter/roster.py) and the booth
gallery (scripts/booth_gallery_profiles.py), so the three never disagree.

Run from the repository root: python3 scripts/export_directory.py
People added at the table (greeter/people/) stay local and are left out.
"""
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "hack-western-13-people"
sys.path.insert(0, str(ROOT / "greeter"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from greeter import roster  # noqa: E402
from booth_gallery_profiles import build_profiles  # noqa: E402

FIRST = ("Event profile", "Hack Western team finder", "Devpost registration")


def build(data: Path) -> list[dict]:
    no_local = data / "__no_local_people__"
    flat = roster.load(no_local, data, fold=False)
    people = roster.load(no_local, data)
    profiles = build_profiles(data, flat)
    out = []
    for pid, person in people.items():
        sections: dict[str, list] = {}
        for source in (pid, *sorted(person.merged_ids)):
            for section in profiles.get(source, {}).get("sections", []):
                items = sections.setdefault(section["title"], [])
                items += [i for i in section["items"] if i not in items]
        ordered = sorted(sections.items(), key=lambda s: (s[0] not in FIRST, FIRST.index(s[0]) if s[0] in FIRST else 0))
        school = next((i["text"] for t, items in ordered for i in items
                       if i["label"] in ("Organization / school", "School", "School / program")), "")
        record = {
            "id": pid,
            "also": sorted(person.merged_ids),
            "name": person.name,
            "aliases": sorted(person.aliases),
            "role": person.role,
            "school": school,
            "talking_points": person.facts,
            "sections": [{"title": t, "items": items} for t, items in ordered],
            "photos": [p.relative_to(data).as_posix() for p in person.photos if p.is_relative_to(data)],
            "verified_photo": person.verified_photo.relative_to(data).as_posix() if person.verified_photo else None,
        }
        words = [person.name, *sorted(person.aliases), person.role, school, *person.facts]
        words += [i["text"] for _, items in ordered for i in items]
        record["search_text"] = " ".join(" ".join(w.split()) for w in words if w).casefold()
        out.append(record)
    return sorted(out, key=lambda r: (r["name"].casefold(), r["id"]))


def main():
    directory = build(DATA)
    target = DATA / "directory.jsonl"
    with tempfile.NamedTemporaryFile("w", dir=target.parent, delete=False, encoding="utf-8") as tmp:
        for record in directory:  # one person per line: easy to grep, stream and diff
            tmp.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.chmod(tmp.name, 0o644)
    os.replace(tmp.name, target)
    print(f"{len(directory)} people, {sum(bool(r['also']) for r in directory)} with linked accounts folded in, "
          f"{sum(len(r['talking_points']) for r in directory)} talking points, "
          f"{sum(len(r['photos']) for r in directory)} matching photos -> {target.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
