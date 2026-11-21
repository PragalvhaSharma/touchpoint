"""Conversations: what each person and the greeter said, and the Flue agent that answers.

Every person has their own id (their greeter.db id: a Slack id, or the folder name of someone added at
the table, or guest-<time> for a face the camera doesn't know). Each line is kept in greeter.db's talk
table for the page, and the agent's own memory is its Flue conversation for that same id
(flue/.data/talk.db), so it remembers each person, switches when someone else steps up, and picks up
where it left off when they come back.

When several people it knows are at the table together, the conversation is theirs as a group: its id is
their ids sorted and joined with "+" (U1+U2), with its own lines and its own Flue conversation. A group's
history includes what each of them said alone, and a person's history includes the groups they were in.

The agent runs in flue/src/talk.ts (npm run talk, port 8095); GREETER_TALK points somewhere else.
"""
from pathlib import Path
import json
import os
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

URL = os.environ.get("GREETER_TALK", "http://127.0.0.1:8095")
SCHEMA = """
create table if not exists talk(n integer primary key, person_id text not null, who text not null, text text not null, t real not null);
create index if not exists talk_person on talk(person_id, n);
"""


class TalkError(Exception):
    pass


def members(pid: str) -> list[str]:
    """The people in a conversation id: one, or several for a group (U1+U2)."""
    return pid.split("+") if pid else []


def belongs(row_id: str, pid: str) -> bool:
    """Whether a line kept under row_id is part of pid's history: for one person, anything they were in;
    for a group, anything said among (some of) exactly them."""
    mine, theirs = set(members(pid)), set(members(row_id))
    return theirs <= mine or (len(mine) == 1 and mine <= theirs)


class Talk:
    def __init__(self, db: Path, url: str = URL):
        self.url = url.rstrip("/")
        self.lock = threading.Lock()
        self.db = sqlite3.connect(str(db), check_same_thread=False)
        self.db.create_function("belongs", 2, belongs, deterministic=True)
        self.db.executescript(SCHEMA)
        self.pending: dict[str, list[str]] = {}  # lines the greeting brain said that the agent hasn't heard yet

    def log(self, pid: str, who: str, text: str) -> dict:
        """Keep one line. who is "person" or "greeter"."""
        t = time.time()
        with self.lock:
            self.db.execute("insert into talk(person_id, who, text, t) values (?, ?, ?, ?)", (pid, who, text, t))
            self.db.commit()
        return {"who": who, "text": text, "t": t}

    def _rows(self, pid: str, n: int, only_person: bool = False):
        """Newest first: (person_id, who, text, t) for pid's history (see belongs)."""
        sql = ("select person_id, who, text, t from talk where belongs(person_id, ?)"
               + (" and who = 'person'" if only_person else "") + " order by n desc limit ?")
        with self.lock:
            return self.db.execute(sql, (pid, n)).fetchall()

    def history(self, pid: str, n: int = 40) -> list[dict]:
        """pid's lines, oldest first. A line said in a different conversation than pid (alone, or in a
        group) carries that conversation's id as "with"."""
        return [{"who": w, "text": x, "t": t, **({"with": r} if r != pid else {})}
                for r, w, x, t in reversed(self._rows(pid, n))]

    def said_in(self, pid: str) -> bool:
        """Whether anything was ever said in exactly this conversation."""
        with self.lock:
            return self.db.execute("select 1 from talk where person_id = ? limit 1", (pid,)).fetchone() is not None

    def last_heard(self, pid: str) -> float | None:
        """When this person (or someone in this group) last said something to the greeter, or None if never."""
        rows = self._rows(pid, 1, only_person=True)
        return rows[0][3] if rows else None

    def greeted(self, pid: str, text: str):
        """The greeting brain said this to them; the agent hears about it on the next turn."""
        self.note(pid, text)

    def note(self, pid: str, text: str):
        """Something said outside the agent (the camera greeting, the voice session); it hears it next turn."""
        with self.lock:
            self.pending.setdefault(pid, []).append(text[:900])  # the agent takes notes up to 1,000 characters
            del self.pending[pid][:-80]

    def _requeue(self, pid: str, context: list[str]):
        with self.lock:
            self.pending.setdefault(pid, [])[:0] = context

    def prompt(self, pid: str) -> str:
        """The agent's system prompt for this person (who they are, what it knows), for the voice session."""
        try:
            with urllib.request.urlopen(f"{self.url}/prompt/{urllib.parse.quote(pid, safe='')}", timeout=5) as r:
                return json.load(r)["prompt"]
        except urllib.error.HTTPError as e:
            raise TalkError(f"the talk agent said {e.code}") from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, KeyError, ValueError) as e:
            raise TalkError(f"the talk agent isn't running at {self.url} ({e})") from None

    def ask(self, pid: str, said: str | None = None, event: str | None = None) -> str:
        """The agent's reply to what they said, or to a camera event."""
        with self.lock:
            context = self.pending.pop(pid, [])
        body = {k: v for k, v in {"said": said, "event": event, "context": context}.items() if v}
        req = urllib.request.Request(f"{self.url}/talk/{urllib.parse.quote(pid, safe='')}", json.dumps(body).encode(),
                                     method="POST", headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)["text"]
        except urllib.error.HTTPError as e:
            if e.code >= 500:  # a 4xx means the notes themselves were refused; sending them again can't help
                self._requeue(pid, context)
            raise TalkError(f"the talk agent said {e.code}: {e.read().decode(errors='replace')[:200]}") from None
        except (urllib.error.URLError, TimeoutError) as e:
            self._requeue(pid, context)
            raise TalkError(f"the talk agent isn't running at {self.url} ({e}); start it with: cd flue && npm run talk") from None

    @property
    def up(self) -> bool:
        try:
            with urllib.request.urlopen(self.url + "/health", timeout=1) as r:
                return r.status == 200
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            return False
