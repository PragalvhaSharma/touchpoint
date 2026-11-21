"""Sweep similarity thresholds on the Hack Western LinkedIn holdout.

Learns everyone from every photo except LinkedIn (Slack, GitHub, Devpost, ...), then shows it each person's
confirmed LinkedIn photo. A copy published under another source can still
overlap this split. The paired portrait benchmark also screens for those copies.
This sweep reports correct and wrong names for enrolled people, and wrong names
when the gallery excludes the target identity to simulate a stranger.

  uv run greeter-eval [--data ../hack-western-13-people] [--out results.json]
"""
from pathlib import Path
import argparse
import json

import numpy as np

from .db import FaceDB
from .faces import Faces
from .main import HERE
from .roster import add_faces, csv_rows, from_hack_western, held_out


def linkedin_holdout_paths(data: Path, probes: list[tuple[str, Path]]) -> set[Path]:
    """Hold out a LinkedIn original even if another roster row also claims its path."""
    excluded = {path for _, path in probes}
    for sheet in (data / "faces").glob("*.csv"):
        for row in csv_rows(sheet):
            if row.get("Photo") and "linkedin" in row.get("Source", "").casefold():
                excluded.add(data / row["Photo"])
    return excluded


def cli():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, default=HERE.parent / "hack-western-13-people")
    ap.add_argument("--out", type=Path)
    a = ap.parse_args()
    faces = Faces(HERE / "models")
    persons = {p.id: p for p in from_hack_western(a.data, with_linkedin=False)}
    add_faces(a.data, persons)
    test = held_out(a.data)
    excluded = linkedin_holdout_paths(a.data, test)
    persons = list(persons.values())
    for person in persons:
        person.photos = [p for p in person.photos if p not in excluded]
    db = FaceDB(":memory:")
    db.sync(persons, faces)
    known = {r[0] for r in db.db.execute("select distinct person_id from faces where ok = 1")}
    probes = []
    for sid, path in test:
        f = faces.main_print(path)
        if sid not in known or f is None:
            continue
        best_id, best = db.who(f)
        _, others = db.who(f, exclude=sid)
        probes.append({"id": sid, "best_is_own": best_id == sid, "best": best, "others": others, "copy": best >= 0.98})
    rows = []
    for t in np.arange(0.20, 0.55, 0.05):
        right = sum(p["best_is_own"] and p["best"] >= t for p in probes)
        wrong = sum((not p["best_is_own"]) and p["best"] >= t for p in probes)
        stranger = sum(p["others"] >= t for p in probes)
        rows.append({"threshold": round(float(t), 2), "right_name": right / len(probes),
                     "wrong_name": wrong / len(probes), "stranger_named": stranger / len(probes)})
    report = {"people_learned": len(known), "people_in_data": len(persons),
              "test_photos": len(probes), "rank1": sum(p["best_is_own"] for p in probes) / len(probes),
              "best_other_median": float(np.median([p["others"] for p in probes])),
              "same_image_elsewhere": sum(p["copy"] for p in probes),
              "by_threshold": rows, "probes": probes}
    print(json.dumps({k: v for k, v in report.items() if k != "probes"}, indent=1))
    if a.out:
        a.out.write_text(json.dumps(report, indent=1))
