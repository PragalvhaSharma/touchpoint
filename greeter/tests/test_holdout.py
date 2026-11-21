import tempfile
import unittest
from pathlib import Path

from greeter.evaluate import linkedin_holdout_paths


class HoldoutTests(unittest.TestCase):
    def test_reviewed_linkedin_source_is_excluded_at_every_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory)
            (data / "faces").mkdir()
            (data / "faces" / "verified-portraits.csv").write_text(
                "Person ID,Photo,Source\n"
                "A,faces/header.jpg,LinkedIn\n"
                "B,faces/header.jpg,other\n"
                "C,faces/event.jpg,qnx\n"
            )
            probe = data / "photos-linkedin" / "old.jpg"
            self.assertEqual(
                linkedin_holdout_paths(data, [("A", probe)]),
                {probe, data / "faces" / "header.jpg"},
            )
