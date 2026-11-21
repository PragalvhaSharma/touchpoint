import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

import numpy as np

from greeter.db import FaceDB
from greeter.faces import TEMPLATE
from greeter.main import Greeter
from greeter.roster import Person


class NamingTests(unittest.TestCase):
    def names(self, sizes, neighbors):
        booth = object.__new__(Greeter)
        booth.faces = Mock()
        booth.db = Mock()
        booth.db.closest.side_effect = neighbors
        found = [(0, 0, width, height) for width, height in sizes]
        return [name for name, _ in booth.name_all(None, found)]

    def test_small_face_needs_a_clear_runner_up_and_standard_face_has_priority(self):
        neighbors = [[("A", 0.82), ("B", 0.40)], [("A", 0.48), ("B", 0.40)]]
        self.assertEqual(self.names([(25, 30), (40, 50)], neighbors), [None, "A"])
        cases = [
            ((50, 23), [], None),
            ((24, 50), [[("A", 0.50), ("B", 0.39)]], "A"),
            ((39, 50), [[("A", 0.49), ("B", 0.30)]], None),
            ((39, 50), [[("A", 0.60), ("B", 0.51)]], None),
            ((39, 50), [[("A", 0.90)]], None),
            ((40, 50), [[("A", 0.46)]], "A"),
        ]
        for size, near, expected in cases:
            with self.subTest(size=size, neighbors=near):
                self.assertEqual(self.names([size], near), [expected])

    def test_alignment_retry_requires_two_clear_matches_on_the_same_face(self):
        booth = object.__new__(Greeter)
        booth.faces = Mock()
        booth.db = Mock()
        frame = np.zeros((200, 200, 3), dtype=np.uint8)
        points = TEMPLATE.copy()
        points[1, 0] += 59
        points[2, 1] -= 62
        poor = np.float32([0, 0, 112, 112, *points.ravel(), 1])
        good = np.float32([56, 56, 112, 112, *(TEMPLATE + 56).ravel(), 1])
        distant = good.copy()
        distant[:2] += 200
        weak = [("other", .42), ("A", .40)]
        strong = [("A", .58), ("other", .34)]
        cases = [
            (good, [("A", .55), ("other", .39)], ("A", .55)),
            (good, [("other", .61), ("A", .39)], (None, .42)),
            (good, [("A", .55), ("other", .48)], (None, .42)),
            (good, [("A", .49), ("other", .29)], (None, .42)),
            (good, [("A", .70)], (None, .42)),
            (distant, strong, (None, .42)),
        ]
        for confirmation, neighbors, expected in cases:
            with self.subTest(confirmation=confirmation[:4], neighbors=neighbors):
                booth.faces.find.side_effect = [[good], [confirmation]]
                booth.db.closest.side_effect = [weak, strong, neighbors]
                self.assertEqual(booth.name_all(frame, [poor]), [expected])

    def test_retry_stays_off_for_reliable_or_already_named_faces_and_group_frames(self):
        booth = object.__new__(Greeter)
        booth.faces = Mock()
        booth.db = Mock()
        weak = [("A", .40), ("B", .39)]
        strong = [("B", .62), ("A", .52)]
        single = np.float32([0, 0, 112, 112, *TEMPLATE.ravel(), 1])
        poor = single.copy()
        poor[6] += 59
        poor[9] -= 62
        small = poor.copy()
        small[2] = 39
        for found, neighbors in [([single], [weak]), ([poor], [strong]),
                                 ([poor, single], [weak, weak]), ([small], [weak]), ([], [])]:
            with self.subTest(faces=len(found), neighbors=neighbors):
                booth.db.closest.side_effect = neighbors
                booth.name_all(None, found)
                booth.faces.find.assert_not_called()

    def test_live_threshold_and_tracking_fingerprint(self):
        booth = object.__new__(Greeter)
        booth.faces = Mock()
        booth.db = Mock()
        face = np.float32([0, 0, 40, 40, *TEMPLATE.ravel(), 1])
        small = face.copy()
        small[2] = 39
        booth.db.closest.return_value = [("A", .50), ("B", .31)]
        self.assertEqual(booth.name_all(None, [face]), [("A", .50)])
        self.assertEqual(booth.name_all(None, [small]), [("A", .50)])
        named, prints = booth._name_and_print(None, [small], live=True)
        self.assertEqual((named, prints), ([(None, 0.0)], [None]))
        corrected = np.ones(512, dtype=np.float32)
        booth._retry_alignment = Mock(return_value=("A", .50, corrected))
        named, _ = booth._name_and_print(None, [face], live=True)
        self.assertIsNone(named[0][0])
        booth._retry_alignment.return_value = ("A", .51, corrected)
        named, prints = booth._name_and_print(None, [face], live=True)
        self.assertEqual(named, [("A", .51)])
        self.assertIs(prints[0], corrected)

    def test_version_two_cache_recomputes_unchanged_portrait_once(self):
        with tempfile.TemporaryDirectory() as folder:
            photo = Path(folder) / "portrait.jpg"
            photo.touch()
            people = [Person("A", "Attendee", [photo])]
            model = Mock()
            old_vector, new_vector = np.eye(2, 512, dtype=np.float32)
            model.main_print.side_effect = [old_vector, new_vector]
            path = Path(folder) / "greeter.db"
            cache = FaceDB(path)
            cache.sync(people, model)
            cache.db.execute("pragma user_version = 2")
            cache.db.close()
            for _ in range(2):
                cache = FaceDB(path)
                self.assertEqual(cache.sync(people, model), 1)
                blob, = cache.db.execute("select fingerprint from faces").fetchone()
                np.testing.assert_array_equal(np.frombuffer(blob, dtype=np.float32), new_vector)
                cache.db.close()
            self.assertEqual(model.main_print.call_count, 2)

    def test_preferred_display_original_on_cold_and_existing_caches(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            original, verified, rejected, variant = (root / name for name in
                                                     ("original.jpg", "verified.jpg", "rejected.jpg", "brighter.jpg"))
            for photo in (original, verified, rejected, variant):
                photo.touch()
            vector = np.eye(1, 512, dtype=np.float32)[0]
            model = Mock()
            model.main_print.side_effect = lambda path: -vector if path == rejected else vector
            person = Person("A", "Attendee", [original], variants={variant: original})
            warm = FaceDB(root / "cache.db")
            warm.sync([person], model)
            self.assertEqual(warm.display_photo("A"), original)
            warm.db.execute("drop table display_portraits")  # a pre-update version-3 cache
            warm.db.close()

            person.photos = [original, rejected, verified]
            person.verified_photo = verified
            for filename, expected_embeddings in [("cache.db", 2), ("fresh.db", 4)]:
                model.reset_mock()
                db = FaceDB(root / filename)
                db.sync([person], model)
                self.assertEqual(model.main_print.call_count, expected_embeddings)
                self.assertEqual(db.display_photo("A"), verified)
                person.verified_photo = rejected
                db.sync([person], model)
                self.assertEqual(db.display_photo("A"), original)
                person.verified_photo = verified
                db.db.close()

            db = FaceDB(root / "fresh.db")
            original.unlink()
            self.assertEqual(db.display_photo("A"), verified)
            verified.unlink()
            self.assertIsNone(db.display_photo("A"))  # the lighting edit and rejected photo still exist
            db.db.close()
