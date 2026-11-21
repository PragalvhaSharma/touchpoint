import csv
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from greeter import roster


def write_csv(path, columns, rows):
    with path.open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(columns)
        writer.writerows(rows)


class VerifiedPortraitTests(unittest.TestCase):
    def test_review_uses_exact_id_and_bytes_and_retires_only_reviewed_versions(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            data = root / "data"
            verified = data / "faces" / "verified-portraits"
            verified.mkdir(parents=True)
            old = data / "old.jpg"
            old.write_bytes(b"old avatar")
            original = verified / "portrait.jpg"
            original.write_bytes(b"reviewed portrait")
            write_csv(data / "hack-western-13-slack-members.csv",
                      ["Slack user ID", "Name", "Photo file", "Role", "Organization / school"],
                      [["U1", "Same Name", "old.jpg", "Participant", ""]])
            for name in ("hack-western-13-linkedin.csv", "hack-western-13-people-profiles.csv"):
                write_csv(data / name, ["Slack user ID"], [])
            write_csv(data / "faces" / roster.VERIFIED_SHEET,
                      ["Person ID", "Slack user ID", "Name", "Photo", "Match", "SHA256"],
                      [["tf:same-name", "", "Same Name", original.relative_to(data), "Confirmed",
                        hashlib.sha256(original.read_bytes()).hexdigest()]])
            write_csv(verified / "superseded.csv", ["Person ID", "Photo", "SHA256"],
                      [["U1", "old.jpg", hashlib.sha256(old.read_bytes()).hexdigest()]])
            derivatives = roster.lighting_paths(data, "tf:same-name", original)
            derivatives[0].parent.mkdir(parents=True)
            for path in derivatives:
                path.touch()

            people = roster.load(root / "local", data)
            self.assertEqual(people["U1"].photos, [])
            reviewed = people["tf:same-name"]
            self.assertEqual(reviewed.photos, [original])
            self.assertEqual(reviewed.variants, dict.fromkeys(derivatives, original))

            # Older sets were named only by roster ID and file path. A source
            # replacement at that path must never inherit the old lighting.
            legacy_key = hashlib.sha256(b"tf:same-name\0" + original.relative_to(data).as_posix().encode()).hexdigest()[:24]
            old_folder = data / "lighting-variants" / legacy_key
            derivatives[0].parent.rename(old_folder)
            (old_folder.parent / "legacy-source-hashes.json").write_text(
                json.dumps({legacy_key: roster.photo_digest(original)}))
            self.assertEqual(roster.lighting_paths(data, "tf:same-name", original)[0].parent, old_folder)

            old.write_bytes(b"corrected image at the old path")
            original.write_bytes(b"unreviewed replacement")
            self.assertNotEqual(roster.lighting_paths(data, "tf:same-name", original)[0].parent, old_folder)
            people = roster.load(root / "local", data)
            self.assertEqual(people["U1"].photos, [old])
            self.assertNotIn("tf:same-name", people)
