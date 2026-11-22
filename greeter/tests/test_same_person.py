import unittest
from pathlib import Path

from greeter import roster

DATA = Path(__file__).resolve().parents[2] / "hack-western-13-people"
LINKED = {"U0CEWJ10TAT": "U0CFA0WM7C6", "U0CKECV7E92": "U0CFW6P7GBG", "U0CJWP7RR6Z": "U0CKFK2QD36",
          "U0CHSV19T6H": "U0CJF8GBZ54", "tf:zhan-hang-thomson-l": "U0CJJ7RKQ2W"}


@unittest.skipUnless((DATA / "hack-western-13-people-profiles.csv").is_file(), "needs the Hack Western data")
class SamePersonTests(unittest.TestCase):
    def test_linked_accounts_become_one_identity(self):
        flat = roster.load(DATA / "__none__", DATA, fold=False, with_variants=False)
        people = roster.load(DATA / "__none__", DATA, with_variants=False)
        for second, first in LINKED.items():
            self.assertIn(second, flat)
            self.assertNotIn(second, people)
            self.assertIn(second, people[first].merged_ids)
            # nothing the second account knew is lost
            facts = {f.casefold() for f in people[first].facts}
            self.assertTrue({f.casefold() for f in flat[second].facts} <= facts)
        self.assertEqual(len(flat) - len(people), len(LINKED))

    def test_one_face_file_never_belongs_to_two_people(self):
        people = roster.load(DATA / "__none__", DATA, with_variants=False)
        for second, first in LINKED.items():
            digests = [roster.photo_digest(p) for p in people[first].photos]
            self.assertEqual(len(digests), len(set(digests)))


if __name__ == "__main__":
    unittest.main()
