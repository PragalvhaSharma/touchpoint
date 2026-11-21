"""One SQLite file holds everyone the greeter knows: people, their faces, their talking points.

Face fingerprints live in a sqlite-vec table (pure C, no dependencies, runs
wherever SQLite runs, Pi included); finding who a face is, is one SQL nearest
neighbour query. Each photo is fingerprinted once and remembered by its
modified time, so a start only reads new or changed photos.
"""
from pathlib import Path
import json
import sqlite3

import numpy as np
import sqlite_vec

from .faces import SAME_PERSON
from .roster import Person

VERSION = 3  # Rebuild cached single-view fingerprints using the mirrored embedding.
SCHEMA = """
create table if not exists people(id text primary key, name text, role text, facts text);
create table if not exists photos(path text primary key, mtime real, person_id text, face_row integer);
create table if not exists directory_aliases(person_id text not null, alias text not null, primary key(person_id, alias));
create table if not exists research_owners(name text not null, source text not null, source_match text not null,
    person_id text not null, confidence text not null, primary key(name, source, source_match));
create table if not exists display_portraits(
    person_id text not null, priority integer not null, path text not null,
    primary key(person_id, priority)
);
create virtual table if not exists faces using vec0(fingerprint float[512] distance_metric=cosine, person_id text, ok integer, +photo text);
"""


class FaceDB:
    def __init__(self, path: Path | str):
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.enable_load_extension(True)
        sqlite_vec.load(self.db)
        self.db.enable_load_extension(False)
        if self.db.execute("pragma user_version").fetchone()[0] != VERSION:  # an older layout: rebuild
            self.db.executescript("drop table if exists people; drop table if exists photos; drop table if exists faces;")
            self.db.execute(f"pragma user_version = {VERSION}")
        self.db.executescript(SCHEMA)

    def sync(self, persons, faces, trusted: Path | None = None) -> int:
        """Bring the file up to date with `persons`; fingerprints only new or changed photos.
        Photos under `trusted` (taken at the table by someone who said who it is) are always kept."""
        persons = tuple(persons)
        db = self.db
        db.execute("delete from people")
        db.executemany("insert into people values (?, ?, ?, ?)",
                       [(p.id, p.name, p.role, json.dumps(p.facts)) for p in persons])
        db.execute("delete from directory_aliases")
        db.executemany("insert into directory_aliases values (?, ?)",
                       ((p.id, alias) for p in persons for alias in p.aliases))
        db.execute("delete from research_owners")
        db.executemany("insert into research_owners values (?, ?, ?, ?, ?)",
                       ((name, source, match, p.id, confidence) for p in persons
                        for name, source, match, confidence in p.research_owners))
        old = {r[0]: r[1:] for r in db.execute("select path, mtime, person_id, face_row from photos")}
        keep = set()
        for p in persons:
            for photo in (*p.photos, *p.variants):
                key, mtime = str(photo), photo.stat().st_mtime
                keep.add(key)
                if key in old and old[key][0] == mtime and old[key][1] == p.id:
                    continue
                self._drop(key, old.get(key))
                fp = faces.main_print(photo)
                row = None
                if fp is not None:
                    row = db.execute("insert into faces(fingerprint, person_id, ok, photo) values (?, ?, 1, ?)",
                                     (sqlite_vec.serialize_float32(fp), p.id, key)).lastrowid
                db.execute("insert or replace into photos values (?, ?, ?, ?)", (key, mtime, p.id, row))
        for key in set(old) - keep:
            self._drop(key, old[key])
        self._agree(persons, trusted)
        db.commit()
        return self.known()

    def _agree(self, persons, trusted: Path | None = None):
        """A person's photos must agree, so a face is never learned under the wrong name.
        Photos that look like at least one other photo of the same person are kept; the rest
        (a cartoon, a friend, a wrong match) are set aside. When none agree, only the most
        trusted photo is kept: the first in the person's list (Slack, then the event site,
        LinkedIn, Devpost, GitHub, Gravatar)."""
        rank = {str(photo): i for p in persons for i, photo in enumerate(p.photos)}
        sources = {(p.id, str(variant)): str(source)
                   for p in persons for variant, source in p.variants.items()}
        trusted_dir = trusted.resolve() if trusted else None
        by_person = {}
        variants = []
        for row, pid, blob, photo in self.db.execute("select rowid, person_id, fingerprint, photo from faces"):
            fingerprint = np.frombuffer(blob, np.float32)
            source = sources.get((pid, photo))
            if source is None:
                by_person.setdefault(pid, []).append((rank.get(photo, 99), row, fingerprint, photo))
            else:
                variants.append((row, pid, source, fingerprint))
        active = {}
        for pid, rows in by_person.items():
            rows.sort(key=lambda r: r[0])
            prints = np.stack([fingerprint for _, _, fingerprint, _ in rows])
            sims = prints @ prints.T
            np.fill_diagonal(sims, -1)
            agrees = sims.max(1) >= SAME_PERSON
            # Booth captures are vouched for in person. Preserve a published
            # original as the fallback even if the only agreement is between captures.
            vouched = np.array([trusted_dir is not None and Path(row[3]).resolve().is_relative_to(trusted_dir)
                                for row in rows])
            fallback = next((i for i, local in enumerate(vouched) if not local), 0)
            keep = agrees if (agrees & ~vouched).any() else np.arange(len(rows)) == fallback
            keep = keep | vouched
            for (_, row, fingerprint, photo), k in zip(rows, keep):
                self.db.execute("update faces set ok = ? where rowid = ?", (int(k), row))
                if k:
                    active[pid, photo] = fingerprint
        # Lighting edits inherit their source's status and cannot corroborate it.
        for row, pid, source, fingerprint in variants:
            original = active.get((pid, source))
            ok = original is not None and fingerprint @ original >= SAME_PERSON
            self.db.execute("update faces set ok = ? where rowid = ?", (int(ok), row))
        # Persist accepted originals in display order for the booth and the web reader.
        # Fingerprint insertion order changes as teammates refresh an existing cache.
        self.db.execute("delete from display_portraits")
        for person in persons:
            ordered = dict.fromkeys([person.verified_photo, *person.photos])
            self.db.executemany("insert into display_portraits values (?, ?, ?)",
                                ((person.id, i, str(path)) for i, path in enumerate(ordered)
                                 if path is not None and (person.id, str(path)) in active))

    def display_photo(self, pid: str) -> Path | None:
        rows = self.db.execute("select path from display_portraits where person_id = ? order by priority", (pid,))
        for (path,) in rows:
            photo = Path(path)
            if photo.is_file():
                return photo
        return None

    def _drop(self, key, old):
        if old is None:
            return
        if old[2] is not None:
            self.db.execute("delete from faces where rowid = ?", (old[2],))
        self.db.execute("delete from photos where path = ?", (key,))

    def who(self, fingerprint, exclude: str | None = None) -> tuple[str | None, float]:
        """The closest person and how alike (cosine, 1 = same); `exclude` leaves one person out."""
        sql = "select person_id, distance from faces where fingerprint match ? and k = 1 and ok = 1"
        args = [sqlite_vec.serialize_float32(fingerprint)]
        if exclude:
            sql += " and person_id != ?"
            args.append(exclude)
        row = self.db.execute(sql, args).fetchone()
        return (row[0], 1 - row[1]) if row else (None, 0.0)

    def closest(self, fingerprint, n: int = 3) -> list[tuple[str, float]]:
        """The n closest different people and how alike each is (cosine, 1 = same), best first."""
        rows = self.db.execute("select person_id, distance from faces where fingerprint match ? and k = ? and ok = 1",
                               [sqlite_vec.serialize_float32(fingerprint), n * 4]).fetchall()
        out = {}
        for pid, dist in rows:
            out.setdefault(pid, 1 - dist)
        # A cluster of lighting edits can fill the first batch for one person.
        # Look for the next distinct identity before applying the greeter's margin.
        if len(rows) == n * 4:
            for _ in range(n - len(out)):
                exclude = " and person_id != ?" * len(out)
                row = self.db.execute(
                    "select person_id, distance from faces where fingerprint match ? and k = 1 and ok = 1"
                    + exclude, [sqlite_vec.serialize_float32(fingerprint), *out]).fetchone()
                if row is None:
                    break
                out[row[0]] = 1 - row[1]
        return list(out.items())[:n]

    def known(self) -> int:
        return self.db.execute("select count(distinct person_id) from faces where ok = 1").fetchone()[0]

    def total(self) -> int:
        return self.db.execute("select count(*) from people").fetchone()[0]

    def person(self, pid: str) -> Person:
        name, role, facts = self.db.execute("select name, role, facts from people where id = ?", (pid,)).fetchone()
        return Person(pid, name, [], json.loads(facts), role)
