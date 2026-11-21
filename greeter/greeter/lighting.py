"""Create and check lighting references for the booth's existing roster portraits.

Run `uv run python -m greeter.lighting` from greeter/. Completed sets are reused.
"""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import tempfile

import cv2
import numpy as np

from . import roster
from .db import FaceDB
from .faces import Faces, SAME_PERSON


def make_variants(image: np.ndarray, face: np.ndarray) -> list[np.ndarray]:
    height, width = image.shape[:2]
    x, _, face_width, _ = face[:4]
    progress = np.clip((np.arange(width) - x) / face_width, 0, 1)
    left_light = (0.55 + 0.45 * progress)[None, :, None]
    levels = np.arange(256) / 255
    brighter = cv2.LUT(image, np.round(255 * levels ** 0.72).astype(np.uint8))
    dimmer = cv2.LUT(image, np.round(255 * levels ** 1.32).astype(np.uint8))
    left = np.round(image * left_light).astype(np.uint8)
    right = np.round(image * (1.55 - left_light)).astype(np.uint8)
    variants = [brighter, dimmer, left, right]
    if max(height, width) > 512:
        scale = 512 / max(height, width)
        size = (max(1, round(width * scale)), max(1, round(height * scale)))
        variants = [cv2.resize(edit, size, interpolation=cv2.INTER_AREA) for edit in variants]
    return variants


def generate(data: Path, people: Path, models: Path, *, verified_only: bool = False) -> dict:
    persons = roster.load(people, data, with_variants=False)
    attendee_ids = {person.id for person in roster.from_hack_western(data)}
    reviewed = {p.id: p for p in persons.values() if p.verified_photo is not None}
    attendee_ids.update(reviewed)
    if verified_only:
        attendee_ids = set(reviewed)
        sources = {(p.id, p.verified_photo) for p in reviewed.values()}
    else:
        sources = {(p.id, photo) for p in persons.values() if p.id in attendee_ids
                   for photo in p.photos if photo.is_relative_to(data)}
    faces = Faces(models)
    db = FaceDB(":memory:")
    db.sync((reviewed if verified_only else persons).values(), faces)
    active = {(pid, Path(photo)): np.frombuffer(blob, np.float32)
              for pid, photo, blob in db.db.execute(
                  "select person_id, photo, fingerprint from faces where ok = 1")}
    db.db.close()

    digests = {}
    owners = {}
    for person in persons.values():
        for photo in person.photos:
            if photo not in digests:
                with photo.open("rb") as stream:
                    digests[photo] = hashlib.file_digest(stream, "sha256").digest()
            owners.setdefault(digests[photo], set()).add(person.id)

    skips = Counter()
    covered = set()
    processed = set()
    legacy = roster.legacy_lighting_hashes(data)
    new_sets = saved_sets = 0
    for (pid, source), fingerprint in active.items():
        if (pid, source) not in sources:
            if not verified_only:
                skips["outside_attendee_roster"] += 1
            continue
        digest = digests[source]
        if len(owners[digest]) != 1:
            skips["same_image_under_multiple_ids"] += 1
            continue
        if (pid, digest) in processed:
            skips["duplicate_source"] += 1
            continue
        paths = roster.lighting_paths(data, pid, source, legacy=legacy)
        if paths[0].parent.exists():
            if all(path.is_file() for path in paths):
                saved_sets += 1
                covered.add(pid)
                processed.add((pid, digest))
            else:
                skips["incomplete_saved_set"] += 1
            continue

        image = cv2.imread(str(source))
        found = faces.find(image) if image is not None else []
        if len(found) != 1:
            skips["source_without_one_face"] += 1
            continue
        encoded = [cv2.imencode(".jpg", edit, [cv2.IMWRITE_JPEG_QUALITY, 88])[1]
                   for edit in make_variants(image, found[0])]
        for edit in encoded:
            decoded = cv2.imdecode(edit, cv2.IMREAD_COLOR)
            detected = faces.find(decoded)
            if len(detected) != 1:
                skips["variant_failed_face_check"] += 1
                break
            similarity = faces.fingerprint(decoded, detected[0]) @ fingerprint
            if not np.isfinite(similarity) or similarity < SAME_PERSON:
                skips["variant_failed_face_check"] += 1
                break
        else:
            output = paths[0].parent
            output.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix=".pending-", dir=output.parent) as temporary:
                for path, edit in zip(paths, encoded):
                    (Path(temporary) / path.name).write_bytes(edit.tobytes())
                Path(temporary).rename(output)
            new_sets += 1
            covered.add(pid)
            processed.add((pid, digest))

    skips["source_not_accepted_by_booth"] = len(sources - active.keys())
    per_set = len(roster.LIGHTING_KINDS)
    return {"attendee_roster": len(attendee_ids), "people_covered": len(covered),
            "people_without_variants": len(attendee_ids - covered), "new_source_sets": new_sets,
            "saved_source_sets": saved_sets, "new_images": new_sets * per_set,
            "saved_images": saved_sets * per_set, "skipped_sources": dict(skips)}


def cli():
    here = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=here.parent / "hack-western-13-people")
    parser.add_argument("--people", type=Path, default=here / "people")
    parser.add_argument("--models", type=Path, default=here / "models")
    parser.add_argument("--verified-only", action="store_true",
                        help="Generate only the independently verified primary portraits.")
    args = parser.parse_args()
    cv2.setNumThreads(1)
    print(json.dumps(generate(args.data, args.people, args.models, verified_only=args.verified_only),
                     indent=2))


if __name__ == "__main__":
    cli()
