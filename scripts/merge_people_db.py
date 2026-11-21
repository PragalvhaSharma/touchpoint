#!/usr/bin/env python3
"""Git merge driver for people.db: two people's copies combine row by row instead of conflicting.

  git config merge.peopledb.driver "python3 scripts/merge_people_db.py %O %A %B"

(.gitattributes routes people.db here.) Three-way, per row of pages and facts:
- a row the other side added or updated more recently (newer t) is taken;
- a row the other side deleted (it was in the common ancestor, unchanged on this side) is deleted.
The result is written to %A, as git expects.
"""
import sqlite3
import sys

TABLES = {"pages": ("person", "url"), "facts": ("person", "fact")}


def main(base, ours, theirs):
    db = sqlite3.connect(ours)
    db.execute("attach ? as o", (base,))
    db.execute("attach ? as b", (theirs,))
    have = lambda s, t: db.execute(f"select 1 from {s}.sqlite_master where name = ?", (t,)).fetchone()
    for table, key in TABLES.items():
        if not have("b", table):
            continue
        if not have("main", table):
            db.execute(f"create table main.{table} as select * from b.{table} where 0")
        on = " and ".join(f"x.{k} = y.{k}" for k in key)
        cols = ", ".join(c[1] for c in db.execute(f"pragma b.table_info({table})"))
        # Taken from theirs: new rows, and rows they changed after ours.
        db.execute(f"""insert or replace into main.{table} ({cols})
            select {cols} from b.{table} y where not exists
              (select 1 from main.{table} x where {on} and x.t >= y.t)""")
        if have("o", table):  # Deleted on their side, untouched on ours: delete.
            zx = " and ".join(f"z.{k} = x.{k}" for k in key)
            db.execute(f"""delete from main.{table} where rowid in (
                select x.rowid from main.{table} x join o.{table} y on {on} and x.t = y.t
                where not exists (select 1 from b.{table} z where {zx}))""")
    db.commit()
    db.execute("detach o")
    db.execute("detach b")
    db.execute("vacuum")
    db.close()


if __name__ == "__main__":
    main(*sys.argv[1:4])
