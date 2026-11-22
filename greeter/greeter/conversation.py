"""Talking with the greeter: who it is talking to, the voice session, and switching between people.

The camera decides who the greeter is talking with: everyone it knows at the table (a face at least a third
as big as the biggest one in view, named for at least a second), once that set has held for a moment (1.5 s, or 0.5 s
when the greeter is talking to nobody). Two or more people make a group conversation, id U1+U2 (talk.py), so
the greeter talks with all of them at once. A face it doesn't know, with nobody it knows, becomes a new
guest-<ms> after 3 s. With nobody in view for 8 s it stops talking to anyone.
Every person has their own id, every line is kept per id (talk.py), and the Flue agent keeps its own
memory per id, so the greeter switches conversations when someone else steps up and picks up where it
left off when the first person comes back.

The voice is an OpenAI Realtime session the page opens over WebRTC (GET /session): speech to speech,
interruptible, like ChatGPT voice. The session is briefed with the person's profile from the Flue agent and
their whole conversation so far; the page posts every spoken line back (POST /log), which keeps the record
and catches the Flue agent up. With a Cartesia key the session answers in text and the page has Cartesia
speak it, with a short-lived Cartesia token handed out alongside the OpenAI one.

Endpoints (main.py routes them here):
  GET  /session?id=   a short-lived voice key for the active person (or id): {id, name, model, key, expires_at, opener, tts}
  GET  /tts           a fresh Cartesia token for the page's voice: {token, version, model, voice, speed, rate}
  POST /log?id=       {"who": "person"|"greeter", "text": ...} one line said in the voice session
  POST /say?id=       {"text": ...} typed; the Flue agent answers
  POST /hear?id=      recorded audio; transcribed, then like /say
  GET  /speak?text=   a line as MP3, for when no voice session is open
  GET  /history?id=   {id, name, lines}
  GET  /talk          {voice, agent, active}
Events on /events: active (who the greeter is talking with, or null), history (their lines), line (one new line).
"""
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import os
import re
import threading
import time

from .talk import Talk, TalkError, members
from .voice import TURN, Voice, VoiceError

SWITCH = 1.5  # seconds a different set of known people must hold before the greeter turns to them
FIRST = 0.5  # the same, when the greeter is talking to nobody
JOIN = 1.0  # seconds a known face must be named before it counts as at the table (not walking past)
JOIN_MORE = 2.0  # the same, to join a conversation that's already going (someone pausing on the way past isn't joining)
SETTLED = 5.0  # seconds in the conversation before a member gets STAY's long grace (newer: PRESENT)
MAX_GROUP = 8  # the Flue agent takes up to 8 people in one conversation id
# Off (default): one person at a time, the main face in view (main.py passes only them). GREETER_GROUPS=1:
# everyone it knows at the table shares one conversation.
GROUPS = os.environ.get("GREETER_GROUPS") == "1"
# One person at a time: the conversation follows the main face fast. A known face that steps up takes over
# in a quarter second; a face it can't name that steps up (a new face, not the same person looking away)
# becomes a new guest in a second.
ONE_JOIN = 0.15
ONE_SWITCH = 0.2
ONE_STRANGER = 0.6
ONE_RENAME = 1.5  # the same face named as someone else: a misread unless it holds this long
ONE_CLEAR = 4.0  # nobody in front this long and the one-person conversation ends
CLAIM = 3  # frames in a row the active person must be named on a new main face before it counts as theirs
GAP = 0.6  # seconds unseen that restart JOIN's clock for someone not yet in the conversation
PRESENT = 4.0  # a known person named this recently still counts as here (people turn their heads)
STAY = 8.0  # the same for someone settled in the group being talked with (scores dip; don't break the group up)
FRESH = 30.0  # seconds after a switch that "X just joined" / "X just left" still makes sense as an opener
STRANGER = 3.0  # seconds a face it doesn't know must hold the middle before it becomes a new guest
TURNED = 10.0  # a known person unseen this long, so a face it can't name is someone new (not them turning their head or scoring low)
CLEAR = 8.0  # seconds with nobody in view before the greeter stops talking to anyone
WELCOME_BACK = 120  # seconds since they last spoke before a return gets a welcome back
VOICE_ON = 25  # seconds the page's voice counts as on after its last check-in (it checks in every 10 s)
MAX_AUDIO = 10 * 1024 * 1024
SPOKEN_CACHE = 64
HISTORY = 60  # lines of past conversation the voice session is briefed with
REALTIME_MODEL = os.environ.get("GREETER_REALTIME_MODEL", "gpt-realtime-2.1")
REALTIME_VOICE = os.environ.get("GREETER_VOICE", "cedar")

VOICE_RULES = """
How you talk, live and out loud (this overrides anything above about length or questions):
You're a mind that can talk with anyone, and right now you're hanging out with this person. This is a real
back and forth between two people, never a form or a scripted interview. Talk the way a sharp, warm recruiter
who actually likes people does.

- Keep every turn short: one sentence, two at most, always. Often just a few words: "oh no way", "wait,
  how?", "ha, okay, that's sick". Even when you're helping, give one idea and stop so they can react.
  If they want more, they'll ask. Never give a list of tips.
- React to what they just said first (a few words is fine), then ask one short question that moves you
  toward a match. One question per turn, never two.
- Listen. Use their exact words and details, follow their thread, and connect it to what they told you before.
- Jump in. When they pause, come right back. If they trail off, finish the thought or nudge them along.
- Sound human: contractions, "yeah", "honestly", "hm", a laugh, starting a thought and changing it. Match
  their energy and pace. If they joke, joke back.
- If they go quiet, keep it alive with one light thing: a thought, a callback, a playful poke. Never ask
  "are you still there" or "is there anything else".
- Never sound like an assistant: no "great question", no "happy to help", no recaps, no lists.
- Use their first name now and then. Speak English unless they switch languages. Never read out email
  addresses, links or long numbers."""

ONE_PERSON = """
You're talking with one person, the one right in front of you. Other people nearby may be talking among
themselves; that isn't to you. If what you hear is clearly someone else's conversation, a fragment, or
background chatter, don't answer it: say nothing, or carry on with your person where you left off."""

GROUP_RULES = """
Right now {count} people are with you at once: {names}. It's one shared conversation, like hanging out with a
few friends at once, not separate interviews and not taking turns by the rules:
- You hear everyone through one mic and can't tell voices apart. Work out who is talking from what they say
  and what you know about each of them; if it matters and you can't tell, ask lightly ("wait, was that you, {first}?").
- Use first names to aim a line at someone. Bring in whoever has been quiet, connect what one says to the
  other ("{first}, didn't you build something like that?"), and let them talk to each other.
- What you know about each person is theirs alone. Never mix up whose facts or projects are whose.
- Lines marked "(alone with X)" in the history were said when only X was here; the others didn't hear them."""

# The greeter recruits for the Hack Western 13 sponsors: it uses what it knows, asks, follows up, and pitches the
# one sponsor that fits. The sponsors come from the follow-up's own list (web/lib/followup/sponsors.ts), so what it
# pitches out loud is what the recruiter's follow-up email is about. GREETER_RECRUITER=0 turns this off.
SPONSORS_TS = Path(__file__).resolve().parents[1] / "web" / "lib" / "followup" / "sponsors.ts"


def sponsor_lines() -> str:
    try:
        text = SPONSORS_TS.read_text()
    except OSError:
        return ""
    found = re.findall(r'company:\s*"([^"]+)".*?hires:\s*"([^"]+)"', text)
    return "\n".join(f"- {c}: {h}" for c, h in found)


# The email the follow-up goes to unless they give another out loud: the Hack Western Slack directory's (the same
# file the web follow-up reads in web/lib/visitor.ts). Read once; the greeter only ever says its domain.
MEMBERS_CSV = Path(os.environ.get("HW_DATA") or Path(__file__).resolve().parents[2] / "hack-western-13-people") / "hack-western-13-slack-members.csv"
_emails: dict[str, str] | None = None


def email_on_file(pid: str) -> str:
    global _emails
    if _emails is None:
        import csv
        _emails = {}
        try:
            with open(MEMBERS_CSV, newline="") as f:
                for row in csv.DictReader(f):
                    mail = (row.get("Email") or row.get("Other email") or "").strip()
                    if row.get("Slack user ID") and re.fullmatch(r"[^\s@]+@[^\s@]+\.[A-Za-z]{2,}", mail):
                        _emails[row["Slack user ID"]] = mail
        except OSError:
            pass
    return _emails.get(pid, "")


RECRUITER = """
Your job at this table: you're the recruiter for the Hack Western 13 sponsors. With every person, your goal is
to find the one sponsor that fits them best, get them excited about it, and make sure the matching roles reach
their inbox. After they leave, the recruiter here reviews what you found and sends them the follow-up email.
- You already know a lot about them (above). Use it: your hello names one specific thing you know (a win, a
  job, a project), and you never ask for something you already know. Ask only for what a recruiter still needs.
- What you still need, roughly in this order, one question at a time: what they're building this weekend and
  which part is theirs; what they want next (co-op, internship or full time, and when); what kind of work they
  love most (backend, ML, product, hardware, finance, design...); and where they'd want to be.
- Follow up on every answer. Dig one level deeper into the most interesting detail before moving on ("wait,
  which part did you build?", "what was the hard bit?"). That detail is what makes the match.
- Pitch early. As soon as you know roughly what they build and what they want next (usually their second or
  third answer), name the one sponsor below that fits best and why, in one line tied to their words, e.g. "Honestly,
  that's TinyFish: they build web agents and hire interns." A recruiter who only asks questions is failing.
  If it doesn't land, ask what's off and pitch the next best one.
- Always confirm their email before they go: once a match lands, or as soon as they start wrapping up or
  saying bye, whichever comes first. {email}
  Ask it once, in one short line. If they give a different address, have them spell it and say back only the
  domain ("got it, the outlook one"). Then tell them the recruiter will send the roles there. There is no QR to
  scan and nothing to sign; never mention one.
- Talk about what each sponsor hires for. Never invent job titles, openings, pay, deadlines or contacts.
- Still a person, not a form: react, be warm, laugh. Never fire off a checklist.

The sponsors and what they hire for:
{sponsors}"""


def ago(seconds: float) -> str:
    m = round(seconds / 60)
    if m < 60:
        return f"{max(m, 1)} minute{'s' if m != 1 else ''}"
    h = round(seconds / 3600, 1)
    return f"{h:g} hour{'s' if h != 1 else ''}"


def is_guest(pid: str | None) -> bool:
    return bool(pid) and pid.startswith("guest-")


def is_group(pid: str | None) -> bool:
    return bool(pid) and "+" in pid


def together(names: list[str]) -> str:
    """"Prag", "Prag and Parum", "Prag, Parum and Emily"."""
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1] if names else ""


class Conversation:
    def __init__(self, greeter, root: Path):
        self.g = greeter
        self.voice = Voice(root)
        self.talk = Talk(root / "greeter.db")
        self.lock = threading.Lock()
        self.active: str | None = None
        self.active_name = ""
        self.previous: list[str] = []  # who the greeter was talking with before the active conversation
        self.switched_at = 0.0  # when the active conversation started
        self.opened = False  # whether a voice session was already briefed for it (its opener is used up)
        self.candidate: str | None = None  # who is at the table now ("?" for a stranger)
        self.candidate_since = 0.0
        self.empty_since: float | None = None
        self.active_seen = 0.0  # when the active person's face was last named
        self.track = 0  # the camera's main face (faces.Focus.track); it changes when someone else steps up
        self.active_track = 0  # the main face the active conversation belongs to
        self.claim = (0, 0)  # (track, frames in a row the active person was named on it)
        self.named: dict[str, list[float]] = {}  # known person -> [first named, last named] while they stay
        self.seeded: set[str] = set()  # groups whose Flue conversation was told what each said alone
        self.voice_seen = 0.0  # when the page last said its live voice is on
        self.turns: dict[str, threading.Lock] = {}  # one agent turn per person at a time
        self.spoken: OrderedDict[str, bytes] = OrderedDict()  # recent TTS, so a replay costs nothing

    # Who the greeter is talking with

    def name_of(self, pid: str | None) -> str:
        if not pid:
            return ""
        if is_group(pid):
            return together([self.name_of(m) for m in members(pid)])
        if is_guest(pid):
            return "Guest"
        try:
            with self.g.lock:
                return self.g.db.person(pid).name
        except TypeError:  # not in greeter.db
            return pid

    def first_names(self, pid: str | None) -> list[str]:
        return [(self.name_of(m).split() or [m])[0] for m in members(pid or "")]

    def members_of(self, pid: str | None) -> list[dict]:
        return [{"id": m, "name": self.name_of(m)} for m in members(pid or "")]

    def email_note(self, pid: str) -> str:
        """What to say when confirming where the follow-up goes: the domain of the email on file, never the address."""
        notes = []
        for m in members(pid or ""):
            first = (self.name_of(m).split() or ["them"])[0]
            if is_guest(m):
                # the booth only follows up with people it recognizes, so don't promise a guest an email
                notes.append("You don't know this person yet, so skip the email question for them and don't promise "
                             "them a follow-up; point them to the sponsor's careers site instead.")
                continue
            mail = email_on_file(m)
            if mail:
                domain = mail.rsplit("@", 1)[1].lower()
                kind = domain.split(".")[0] if domain.count(".") == 1 else domain
                notes.append(f'{first} has a {domain} address on file from Hack Western. Ask something like "I\'ve got your '
                             f'{kind} on file, is that the one you want the roles sent to?"')
            else:
                notes.append(f"There's no email on file for {first}. Ask for the best email to send the roles to.")
        return " ".join(notes) or "Ask for the best email to send the roles to."

    def new_guest(self) -> str:
        return f"guest-{int(time.time() * 1000)}"

    def seen(self, known: list[str], face: bool, track: int | None = None):
        """Every camera frame. known: the people it knows at the table in this frame. face: whether there is
        a face big enough to name at all (a stranger, when nobody it knows is here). track: which face is the
        main one (one person at a time), so a new face is told apart from the same person not named for a moment."""
        now = time.time()
        with self.lock:
            one = not GROUPS and track is not None
            if one:
                self.track = track
                if self.active and self.active in known and track != self.active_track:
                    # their face came back as a new track (a missed detection): it's theirs once it holds a few
                    # frames, so one misread of a newcomer doesn't hand them the conversation
                    n = self.claim[1] + 1 if self.claim[0] == track else 1
                    self.claim = (track, n)
                    if n >= CLAIM:
                        self.active_track = track
                else:
                    self.claim = (track, 0)  # frames in a row: any frame without them on this face starts over
            new_face = one and self.active is not None and track != self.active_track
            mine = set(members(self.active or ""))
            for pid in known:
                rec = self.named.get(pid)
                if rec is None or (now - rec[1] > GAP and pid not in mine):
                    self.named[pid] = [now, now]  # JOIN means named the whole time, not twice a second apart
                else:
                    rec[1] = now
            seen_at = lambda p: self.named.get(p, (0.0, 0.0))[1]
            if any(now - seen_at(p) <= GAP for p in mine):
                self.active_seen = now
            # how long someone in the conversation keeps their place while unnamed (looking down, a low score):
            # a settled group member, long; anyone else, a few seconds. A group whose faces have all been gone
            # for TURNED has ended.
            grouped = is_group(self.active) and now - self.active_seen < TURNED
            grace = lambda p: STAY if grouped and now - self.named[p][0] >= SETTLED else PRESENT
            for pid in list(self.named):
                if now - self.named[pid][1] > (grace(pid) if pid in mine else PRESENT):
                    del self.named[pid]
            if not face:
                self.candidate = None
                self.empty_since = self.empty_since or now
                if self.active is None or now - self.empty_since < (ONE_CLEAR if one else CLEAR):
                    return
                target = None
            else:
                self.empty_since = None
                # Who is at the table: everyone named in view right now (newcomers once they've held for JOIN).
                # People in the conversation who were named recently only keep it going: if nobody new is in
                # view, the conversation stays as it is; a new set includes them only if seen within the last second.
                # joining people who are still here takes longer than stepping up once they've gone
                staying_here = any(now - seen_at(p) <= GAP for p in mine)
                join = ONE_JOIN if one else JOIN_MORE if staying_here and now - self.switched_at > SETTLED else JOIN
                inview = {p for p, (first, last) in self.named.items()
                          if now - last <= GAP and (p in mine or last - first >= join)}
                if new_face:  # someone new in front: only who is named on it right now (the last person only if it's them)
                    inview = {p for p in inview if p in known}
                # a new face in front means the last person has stepped away: they don't keep the conversation
                kept = set() if new_face else {p for p in mine if p in self.named and not is_guest(p)}
                ids = kept if inview <= kept else inview | {p for p in kept if now - seen_at(p) <= 1.0}
                here = "+".join(sorted(sorted(ids, key=lambda p: -seen_at(p))[:MAX_GROUP if GROUPS else 1])) or None
                key = here or (f"?{track}" if one else "?")  # a new unnamed face starts its own clock
                if key != self.candidate:
                    self.candidate, self.candidate_since = key, now
                if (here is not None and here == self.active) or (here is None and is_guest(self.active) and not new_face):
                    return
                if here is None and self.active is not None and now - self.active_seen < TURNED and not new_face:
                    return  # probably the same person turned away or the light changed
                if here is None and one and self.active is not None and not new_face:
                    return  # the same face (its fingerprint says so, faces.Focus.confirm), just not named right now
                # a conversation seconds old that hasn't started out loud yet still takes others arriving with them
                fresh = self.active is None or (not self.opened and now - self.switched_at < 3.0)
                if one:
                    hold = ONE_STRANGER if here is None else ONE_SWITCH if new_face or self.active is None else ONE_RENAME
                else:
                    hold = STRANGER if here is None else FIRST if fresh else SWITCH
                if now - self.candidate_since < hold:
                    return
                target = here or self.new_guest()
        self.focus(target)

    def focus(self, pid: str | None, name: str = ""):
        """Make pid (None: nobody) the person the greeter is talking with, and send their history."""
        with self.lock:
            if pid == self.active:
                return
            # who it was talking with, for "X just joined/left": only if that conversation got going out loud
            self.previous = members(self.active or "") if self.opened else []
            self.switched_at, self.opened = time.time(), False
            self.active, self.active_name = pid, (name or self.name_of(pid)) if pid else ""
            self.active_track = self.track
            if pid:
                self.empty_since = None
                self.active_seen = time.time()
            seed = is_group(pid) and pid not in self.seeded
            if seed:
                self.seeded.add(pid)
        if seed and not self.talk.said_in(pid):
            self.seed(pid)
        self.g.emit(self.active_event())
        if pid:
            if not is_guest(pid) and not is_group(pid):
                self.g.card(pid)  # the panel shows who it's talking with, the moment it turns to them
            self.g.emit({"kind": "history", "id": pid, "lines": self.talk.history(pid)})

    def seed(self, group: str):
        """A new group: tell its Flue conversation what each of them said with the greeter alone lately."""
        for m in members(group):
            first = (self.name_of(m).split() or [m])[0]
            for l in self.talk.history(m, 12):
                if "with" not in l:
                    self.talk.note(group, f"Earlier, alone with {first}, " + ("you said: " if l["who"] == "greeter" else "they said: ") + l["text"])

    def share(self, pid: str, who: str, text: str):
        """A line said in a group goes to each person's own memory too, so it is there when they come back alone."""
        if not is_group(pid):
            return
        firsts = dict(zip(members(pid), self.first_names(pid)))
        for m in members(pid):
            others = together([f for x, f in firsts.items() if x != m])
            said = "you said" if who == "greeter" else "someone in the group said"
            self.talk.note(m, f"In a group chat, with {others} there too, {said}: {text}")

    def active_event(self) -> dict:
        return {"kind": "active", "id": self.active, "name": self.active_name, "members": self.members_of(self.active)}

    def who_speaks(self, pid: str | None) -> str:
        """The id for a line someone just said: the one asked for, the active person, or a new guest."""
        if pid:
            return pid
        with self.lock:
            active = self.active
        if active:
            return active
        guest = self.new_guest()
        self.focus(guest)
        return guest

    def voice_on(self) -> bool:
        return time.time() - self.voice_seen < VOICE_ON

    # Lines

    def line(self, pid: str, who: str, text: str, name: str = ""):
        row = self.talk.log(pid, who, text)
        self.g.emit({"kind": "line", "id": pid, "name": name or self.name_of(pid), **row})

    def greeted(self, event: dict):
        """The camera greeting (brain or mock agent) said something to someone. Keep it and tell the agent;
        if they talked with the greeter before and have been gone a while, the agent welcomes them back.
        While the page's live voice is on, the voice does the greeting out loud, so this stays out of it."""
        pid, text, name = event["id"], event["text"], event.get("name", "")
        if self.voice_on():
            return
        with self.lock:
            group = self.active if is_group(self.active) and pid in members(self.active) else None
        if group:  # they're in the group conversation: the greeting is said to the group, once, with no separate welcome back
            self.line(group, "greeter", text)
            self.talk.note(group, f"You said: {text}")
            self.share(group, "greeter", text)
            return
        last = self.talk.last_heard(pid)
        self.line(pid, "greeter", text, name)
        self.talk.note(pid, f"You said: {text}")
        if last is not None and time.time() - last > WELCOME_BACK:
            first = (name or self.name_of(pid)).split()[0]
            note = f"{first} just walked back up to the table. They last talked with you {ago(time.time() - last)} ago."
            threading.Thread(target=self.reply, args=(pid, None, note, name), daemon=True).start()

    def reply(self, pid: str, said: str | None, event: str | None, name: str = "") -> str:
        """Ask the Flue agent and say its answer. Returns the answer ('' when the agent is down)."""
        with self.lock:
            turn = self.turns.setdefault(pid, threading.Lock())
        with turn:
            try:
                text = self.talk.ask(pid, said=said, event=event)
            except TalkError as e:
                self.g.emit({"kind": "step", "id": pid, "text": f"Talk agent unavailable: {e}"})
                if said is None:
                    return ""
                raise
            if text:
                self.line(pid, "greeter", text, name)
                self.share(pid, "greeter", text)
            return text

    def turn(self, pid: str | None, said: str) -> dict:
        pid = self.who_speaks(pid)
        name = self.name_of(pid)
        self.line(pid, "person", said, name)
        self.share(pid, "person", said)
        return {"id": pid, "heard": said, "reply": self.reply(pid, said, None, name)}

    # The voice session

    def brief(self, pid: str) -> str:
        """Everything the voice needs: who they are (from the Flue agent), how to talk, what was said before."""
        firsts = self.first_names(pid)
        with self.lock:  # who joined or left only counts for the first session after a switch, soon after it
            first = pid == self.active and not self.opened
            fresh = first and time.time() - self.switched_at < FRESH
            if pid == self.active:
                self.opened = True
            previous = list(self.previous) if fresh else []
        try:
            persona = self.talk.prompt(pid)
        except TalkError:
            name = self.name_of(pid)
            persona = ("You are the voice of a greeter robot at Prag's table at Hack Western 13, a student hackathon at "
                       "Western University. " + ("You don't know this person yet; ask their name." if is_guest(pid)
                                                  else f"You are talking with {name}. Ask what they are building this weekend."))
        rules = VOICE_RULES
        if is_group(pid):
            rules += GROUP_RULES.format(count=len(firsts), names=together([self.name_of(m) for m in members(pid)]), first=firsts[-1])
        else:
            rules += ONE_PERSON
        if os.environ.get("GREETER_RECRUITER", "1") != "0" and (sponsors := sponsor_lines()):
            rules += "\n" + RECRUITER.format(sponsors=sponsors, email=self.email_note(pid))
        lines = self.talk.history(pid, HISTORY)
        heard = self.talk.last_heard(pid)
        if lines:
            def where(l):
                if "with" not in l:  # said in exactly this conversation
                    return ""
                kind = "in a group with" if is_group(l["with"]) else "alone with"
                return f" ({kind} {together(self.first_names(l['with']))})"
            said = "\n".join(f"{'You' if l['who'] == 'greeter' else 'Them'}{where(l)}: {l['text']}" for l in lines)
            past = f"\n\nYour conversation with them so far, oldest first (it all really happened):\n{said}"
        else:
            past = ""
        if previous:
            joined = [f for m, f in zip(members(pid), firsts) if m not in previous]
        else:  # from nobody: anyone who hasn't talked with it lately still needs a hello
            joined = [f for m, f in zip(members(pid), firsts)
                      if (h := self.talk.last_heard(m)) is None or time.time() - h > WELCOME_BACK]
        left = [(self.name_of(m).split() or [m])[0] for m in previous if m not in members(pid)]
        # What they last said decides the opener; lines only shown on screen don't count as a conversation.
        if not first and heard is not None:  # the voice reconnected mid-conversation
            opener = "You were talking a moment ago. Pick up naturally and briefly; don't greet them again."
        elif is_group(pid) and joined and len(joined) < len(firsts):
            stay = together([f for f in firsts if f not in joined])
            opener = (f"{together(joined)} just walked up and joined you and {stay}. Say a quick hi to {together(joined)} "
                      f"by first name and bring them into what you were talking about, without dropping {stay}.")
        elif left and not joined:
            opener = (f"{together(left)} just left the table; you're still with {together(firsts)}. Carry on naturally "
                      "with them; don't greet them again.")
        elif is_group(pid) and (heard is None or time.time() - heard > WELCOME_BACK):
            opener = (f"Open now with one quick, easy hello to all of them by first name ({together(firsts)}), the way "
                      "you'd greet friends who walked up together, and get them talking.")
        elif heard is not None and time.time() - heard > WELCOME_BACK:
            opener = (f"They just walked back up to you; you last talked {ago(time.time() - heard)} ago. Open with a quick, "
                      "warm welcome back that picks up one specific thing from last time, like a friend would.")
        elif heard is not None:
            opener = "You were talking a moment ago. Pick up naturally and briefly; don't greet them again."
        else:
            opener = ("Open now with a quick, easy hello out loud" + (" and ask their name." if is_guest(pid)
                      else " by first name, the way you'd greet someone you're happy to see."))
        return persona + "\n" + rules + past + "\n\nRight now: " + opener

    def session(self, pid: str | None) -> tuple[int, str, bytes]:
        self.voice_seen = time.time()  # the voice is taking over before the camera greeting can land
        pid = self.who_speaks(pid)
        # Cartesia speaks; without it (or if it fails), OpenAI's own voice does. Its token and the OpenAI key are
        # fetched at the same time, so the next person's voice is up a quarter second sooner.
        brief = self.brief(pid)
        with ThreadPoolExecutor(max_workers=2) as pool:
            grant = pool.submit(self.voice.tts_grant) if self.voice.cartesia else None
            text_voice = pool.submit(self.voice.session, brief, REALTIME_MODEL, REALTIME_VOICE, True) if grant else None
            tts = None
            if grant:
                try:
                    tts = grant.result()
                except VoiceError as e:
                    print(f"[voice] Cartesia unavailable, using OpenAI's voice: {e}", flush=True)
            try:
                if tts is not None and text_voice is not None:
                    out = text_voice.result()
                else:  # no Cartesia: a session that speaks with OpenAI's voice
                    out = self.voice.session(brief, REALTIME_MODEL, REALTIME_VOICE, text_only=False)
            except VoiceError as e:
                return self.json(502, {"message": str(e)})
        return self.json(200, {"id": pid, "name": self.name_of(pid), "model": REALTIME_MODEL,
                               "members": self.members_of(pid),
                               "key": out["value"], "expires_at": out.get("expires_at"), "opener": True, "turn": TURN,
                               "tts": tts})

    def log(self, pid: str | None, body: bytes) -> tuple[int, str, bytes]:
        req = json.loads(body or b"{}")
        who, text = req.get("who"), str(req.get("text", "")).strip()[:4000]
        if who == "person" and text.lower().startswith("a conversation at hack western"):
            return self.json(200, {"ok": True, "skipped": "transcriber echo of its prompt, not speech"})
        if not pid or who not in ("person", "greeter"):
            return self.json(400, {"message": "give id, who (person or greeter) and text"})
        if text:
            self.voice_seen = time.time()
            self.line(pid, who, text)
            self.talk.note(pid, ("You said: " if who == "greeter" else "They said: ") + text)
            self.share(pid, who, text)
        return self.json(200, {"ok": True})

    # HTTP (main.py hands these paths over)

    def get(self, path: str, query: dict) -> tuple[int, str, bytes]:
        q = lambda k: query.get(k, [""])[0]
        if path == "/talk":
            if q("voice") in ("0", "1"):  # the page checks in while its live voice is on, and says when it ends
                self.voice_seen = time.time() if q("voice") == "1" else 0.0
            active = {"id": self.active, "name": self.active_name, "members": self.members_of(self.active)} if self.active else None
            return self.json(200, {"voice": self.voice.ready, "agent": self.talk.up, "active": active})
        if path == "/session":
            return self.session(q("id") or None)
        if path == "/tts":  # a fresh Cartesia token, for when the page's voice socket has to reopen
            try:
                return self.json(200, self.voice.tts_grant())
            except VoiceError as e:
                return self.json(502, {"message": str(e)})
        if path == "/history":
            pid = q("id") or self.active
            if not pid:
                return self.json(200, {"id": None, "name": "", "lines": []})
            return self.json(200, {"id": pid, "name": self.name_of(pid), "lines": self.talk.history(pid)})
        if path == "/speak":
            text = q("text").strip()[:1000]
            if not text:
                return self.json(400, {"message": "give text"})
            audio = self.spoken.get(text)
            if audio is None:
                try:
                    audio = self.voice.speak(text)
                except VoiceError as e:
                    return self.json(502, {"message": str(e)})
                self.spoken[text] = audio
                while len(self.spoken) > SPOKEN_CACHE:
                    self.spoken.popitem(last=False)
            return 200, "audio/mpeg", audio
        return self.json(404, {"message": "not found"})

    def post(self, path: str, query: dict, body: bytes, ctype: str) -> tuple[int, str, bytes]:
        pid = query.get("id", [""])[0] or None
        try:
            if path == "/log":
                return self.log(pid, body)
            if path == "/hear":
                if not body:
                    return self.json(400, {"message": "no audio"})
                if len(body) > MAX_AUDIO:
                    return self.json(413, {"message": "recording too long"})
                said = self.voice.hear(body, ctype, self.name_of(pid or self.active))
                if not said:
                    return self.json(200, {"id": pid or self.active, "heard": "", "reply": ""})
                return self.json(200, self.turn(pid, said))
            if path == "/say":
                said = str(json.loads(body or b"{}").get("text", "")).strip()[:2000]
                if not said:
                    return self.json(400, {"message": "give text"})
                return self.json(200, self.turn(pid, said))
        except (VoiceError, TalkError) as e:
            return self.json(502, {"message": str(e)})
        except (ValueError, AttributeError):
            return self.json(400, {"message": "body is not JSON"})
        return self.json(404, {"message": "not found"})

    @staticmethod
    def json(code: int, body) -> tuple[int, str, bytes]:
        return code, "application/json", json.dumps(body).encode()
