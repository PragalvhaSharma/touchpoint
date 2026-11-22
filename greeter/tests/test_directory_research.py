import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from greeter.db import FaceDB
from greeter.research import Ownership
from greeter import roster
from test_verified_portraits import write_csv


class DirectoryResearchTests(unittest.TestCase):
    def test_shared_name_needs_verified_account(self):
        people = {pid: roster.Person(pid, "Daniel") for pid in ("alpha", "beta")}
        owners = Ownership(people)
        owners.account("alpha", "https://www.linkedin.com/in/alpha/")
        owners.account("beta", "https://github.com/beta")
        owners.account("beta", "https://www.linkedin.com/in/beta", "likely")
        self.assertIsNone(owners.resolve("Daniel", "https://example.com/team", "confirmed"))
        self.assertEqual(owners.resolve("Daniel", "https://ca.linkedin.com/in/alpha", "confirmed"),
                         ("alpha", "confirmed"))
        self.assertIsNone(owners.resolve("alpha", "https://github.com/beta", "confirmed"))
        self.assertIsNone(owners.resolve("alpha", "https://www.linkedin.com/in/stranger", "confirmed"))
        self.assertEqual(owners.resolve("beta", "https://www.linkedin.com/in/beta", "confirmed"), ("beta", "likely"))
        self.assertIsNone(owners.resolve("Daniel", "https://github.com/beta/shared-project", "confirmed"))

    def test_directory_records_and_persisted_ownership(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = root / "data"
            site = data / "hackwestern-site"
            site.mkdir(parents=True)
            (site / "team-finder.json").write_text(json.dumps([
                {"name": "One A.", "slack_id": "U1"}, {"name": "Other A.", "slack_id": "", "school": "College"},
            ]))
            (data / "devpost-registrants.json").write_text(json.dumps([
                {"Name": "T. Singh", "Devpost": "https://devpost.com/participant", "Confidence notes": "Registration only."},
            ]))
            write_csv(data / "hack-western-13-slack-members.csv",
                      ["Slack user ID", "Name", "Photo file", "Role", "Organization / school"],
                      [["U1", "One", "", "Participant", ""]])
            write_csv(data / "hack-western-13-linkedin.csv", ["Slack user ID"], [])
            write_csv(data / "hack-western-13-people-profiles.csv",
                      ["Slack user ID", "Slack name", "Name", "LinkedIn match", "Talking points"],
                      [["", "(team finder only: Other A.)", "Other Attendee", "high", "Studies engineering"]])
            (data / "scrub.py").write_text("def unsafe(s): return False\ndef scrub(s): return s\n")
            with sqlite3.connect(root / "people.db") as source:
                source.execute("create table pages(person,url,match)")
                source.execute("create table facts(person,fact,source,match,t)")
                source.execute("insert into pages values(?,?,?)", ("alias", "https://devpost.com/participant", "confirmed"))
                source.execute("insert into facts values(?,?,?,?,?)", ("T. Singh", "Registered at the event.",
                               "https://devpost.com/participant/challenges", "confirmed", 1))
            people = roster.load(root / "local", data)
            self.assertEqual(set(people), {"U1", "tf:other-a", "devpost:participant"})
            self.assertEqual(people["tf:other-a"].name, "Other Attendee")
            self.assertEqual(people["tf:other-a"].facts, ["Studies engineering"])
            self.assertEqual(people["devpost:participant"].photos, [])
            self.assertIn("Registered at the event.", people["devpost:participant"].facts)
            db = FaceDB(":memory:")
            try:
                db.sync(people.values(), None)
                got = db.db.execute("select person_id,confidence from research_owners where name = 'alias'").fetchall()
                self.assertEqual(got, [("devpost:participant", "confirmed")])
                self.assertEqual(db.db.execute("select count(*) from directory_aliases where alias='other a.'").fetchone()[0], 1)
                db.sync([people["U1"]], None)
                self.assertEqual(db.db.execute("select count(*) from research_owners").fetchone()[0], 0)
            finally:
                db.db.close()
