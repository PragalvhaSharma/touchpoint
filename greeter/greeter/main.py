"""Run the greeter: faces -> who it is -> the brain decides what to say (or a mock agent, without one).

This is the camera and the API; the page is the Next.js app in web/ (http://localhost:3000),
which reads /frame, /events, /samples, /photo, /face, /voice and posts to /see and /add here.

  uv run greeter                       # no camera: drop a photo onto the camera page
  uv run greeter --camera 0            # a webcam (at the table)
  uv run greeter --camera 0 --serial /dev/serusb1    # the real Arduino
  uv run greeter --brain http://127.0.0.1:8090       # let the AI decide (cd ../flue && npm run brain)
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from collections import OrderedDict, deque
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import argparse
import json
import os
import queue
import threading
import time
import uuid

import cv2
import numpy as np

from . import roster
from .agent import MockAgent
from .brain import Brain, BrainError
from .conversation import GROUPS, Conversation, is_group, is_guest
from .db import FaceDB
from .faces import CONFIDENT, SAME_PERSON, Faces, Focus, level_face_crop, reliable_alignment
from .link import MockLink, SerialLink
from .voice import Voice

HERE = Path(__file__).resolve().parent.parent
UI = os.environ.get("GREETER_UI", "http://localhost:3000")  # the Next.js page (web/)
VOICE_MODEL = os.environ.get("GREETER_VOICE_MODEL", "gpt-realtime")
VOICE = os.environ.get("GREETER_VOICE", "cedar")
STREAK = 3  # camera frames in a row before we trust a match
MIN_FACE = 40  # pixels on the shorter side for the standard naming rule
MIN_SMALL_FACE = 24
MARGIN = 0.05  # the best match must beat the next person by this much; a near tie means a stranger
GROUP_SIZE = 0.4  # a known face at least this big next to the biggest face in view joins the conversation (smaller: across the room)
# GROUPS (conversation.py) off, the default: the greeter talks with one person at a time, the main face
# (closest and most central; see faces.Focus), and everyone else in view is only named on screen.
SUGGEST = 0.30  # closest people at least this alike are offered when someone clicks a face to say who it is
KEEP_FRAMES = 90  # recent frames (about 3 s) whose unknown faces can still be clicked
CROP_MAX = 480  # pixels; a clicked face is kept (and saved) at most this big


class Greeter:
    def __init__(self, camera, people: Path, data: Path, away: float, link, turn: int = 0, brain: Brain | None = None):
        self.people, self.data, self.away, self.link = people, data, away, link
        self.turn = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}.get(turn)
        self.faces = Faces(HERE / "models")
        self.db = FaceDB(HERE / "greeter.db")
        self.focus = Focus()
        self.agent = MockAgent()
        self.voice = Voice(HERE, voice=VOICE)  # /voice: a Realtime key briefed on one person (the /talk page)
        self.brain = brain
        self.visits: dict[str, int] = {}  # times greeted since start, per person
        self.cam = None
        if camera is not None:
            self.cam = cv2.VideoCapture(camera)
            if not self.cam.isOpened():
                raise SystemExit(f"can't open camera {camera!r} (another program may be using it)")
        self.lock = threading.Lock()
        self.jpeg = b""
        self.shot = (b"", "")  # the newest frame as JPEG, and its faces (X-Faces) for the page
        self.seq = 0
        self.unknown: deque = deque(maxlen=KEEP_FRAMES)  # (seq, {face index: (crop, fingerprint, score)})
        self.bigs: deque = deque()  # (time, biggest face) over the last second
        self.held: OrderedDict = OrderedDict()  # token -> (crop, fingerprint): faces clicked on the page
        self.raw = None
        self.streak: dict[str, int] = {}
        self.last_seen: dict[str, float] = {}
        self.scores: dict[str, float] = {}  # each person's latest match score, for their card
        self.here: list[str] = []
        self.here_ids: list[str] = []
        self.recent: deque = deque(maxlen=40)  # replayed to a page that opens late
        self.say_lock = threading.Lock()  # greet one person at a time
        self.listeners: list[queue.Queue] = []
        self.conv = Conversation(self, HERE)  # voice and per-person memory (conversation.py)
        self.relearn()

    def relearn(self):
        persons = roster.load(self.people, self.data)
        with self.lock:
            self.db.sync(persons.values(), self.faces, trusted=self.people)
        self.emit({"kind": "people", "known": self.db.known(), "total": self.db.total()})
        print(f"knows {self.db.known()} of {self.db.total()} people by face", flush=True)

    def emit(self, event):
        if event["kind"] in ("step", "say", "who"):
            self.recent.append(event)
        for q in list(self.listeners):
            q.put(event)
        if event["kind"] == "say" and event.get("id"):
            self.conv.greeted(event)

    def photo_of(self, pid: str) -> Path | None:
        """Prefer the verified portrait, then accepted originals in roster order."""
        with self.lock:
            return self.db.display_photo(pid)

    def greet(self, pid, score, others=(), live=False):
        """live: from the camera, where only the person the greeter is talking with gets greeted."""
        with self.lock:
            person = self.db.person(pid)
        mine = lambda: GROUPS or not live or self.conv.active == pid
        with self.say_lock:
            if not mine():
                return  # they stepped away (or someone else stepped up) while another greeting was going
            self.visits[pid] = self.visits.get(pid, 0) + 1
            self.emit({"kind": "who", "id": pid, "name": person.name, "role": person.role,
                       "facts": person.facts[:8], "score": round(score, 3), "t": time.time()})
            if self.brain and self.ask_brain(person, score, list(others), mine, CONFIDENT if live else SAME_PERSON):
                return
            self.link.send(f"P {person.name}")
            for kind, text in self.agent.say_to(person, score):
                if not mine():
                    return
                self.emit({"kind": kind, "id": pid, "name": person.name, "text": text})
                time.sleep(0.4 if kind == "step" else 0)

    def card(self, pid: str):
        """Show pid's card at once when the greeter turns to them, so the panel always matches the camera
        (a greeting only comes after they've been away a while)."""
        try:
            with self.lock:
                person = self.db.person(pid)
        except TypeError:  # not in greeter.db
            return
        self.emit({"kind": "who", "id": pid, "name": person.name, "role": person.role, "facts": person.facts[:8],
                   "score": round(self.scores.get(pid, 0.0), 3), "t": time.time()})

    def ask_brain(self, person, score, others, mine=lambda: True, threshold=CONFIDENT) -> bool:
        """Let the brain decide and act on it. False when the brain can't answer, so the mock agent speaks."""
        step = lambda text: self.emit({"kind": "step", "id": person.id, "name": person.name, "text": text})
        step(f"Face matched: {person.name}; asking the brain")
        try:
            v = self.brain.decide(person, score, threshold, self.visits[person.id], others)
        except BrainError as e:
            step(f"Brain unavailable ({e}); the mock agent answers")
            return False
        point = f", talking point {v.fact + 1}" if v.fact is not None else ""
        step(f"Brain: {v.action}{point} ({v.why})" if v.source == "agent"
             else f"Brain fell back to a safe greeting ({v.error})")
        if v.link:
            self.link.send(v.link)
        if v.action != "skip" and mine():  # still the one in front
            self.emit({"kind": "say", "id": person.id, "name": person.name, "text": v.say})
        return True

    def name_all(self, frame, found) -> list[tuple[str | None, float]]:
        """Names and scores for the still-photo API and its paired benchmarks."""
        named, _ = self._name_and_print(frame, found, live=False)
        return named

    def _name_and_print(self, frame, found, *, live: bool):
        """Assign each identity to at most one face and retain the fingerprints for tracking."""
        options = []
        named = [(None, 0.0)] * len(found)
        prints = [None] * len(found)
        min_size = MIN_FACE if live else MIN_SMALL_FACE
        for i, face in enumerate(found):
            size = min(face[2:4])
            if size < min_size:
                continue
            prints[i] = self.faces.fingerprint(frame, face)
            near = self.db.closest(prints[i])
            if not near:
                continue
            pid, score = near[0]
            named[i] = (None, score)
            standard_size = size >= MIN_FACE
            if standard_size:
                confident = score > CONFIDENT if live else score >= SAME_PERSON
                margin = MARGIN
            else:
                confident = len(near) >= 2 and score >= SAME_PERSON + MARGIN
                margin = 2 * MARGIN
            runner_up = near[1][1] if len(near) > 1 else 0.0
            if confident and score - runner_up >= margin:
                options.append((standard_size, score, i, pid))
        taken = set()
        for _, score, i, pid in sorted(options, reverse=True):
            if pid not in taken:
                named[i] = (pid, score)
                taken.add(pid)
        if len(found) == 1 and named[0][0] is None and min(found[0][2:4]) >= MIN_FACE:
            retry = self._retry_alignment(frame, found[0])
            if retry is not None:
                pid, score, fingerprint = retry
                if not live or score > CONFIDENT:
                    named[0] = (pid, score)
                    prints[0] = fingerprint
        return named, prints

    @staticmethod
    def crop(frame, face):
        """The face with room around it, as saved to someone's photos."""
        x, y, w, h = map(int, face[:4])
        pad = int(max(w, h) * 0.6)
        crop = frame[max(0, y - pad):y + h + pad, max(0, x - pad):x + w + pad]
        k = CROP_MAX / max(crop.shape[:2])
        return cv2.resize(crop, None, fx=k, fy=k, interpolation=cv2.INTER_AREA) if k < 1 else crop.copy()

    def _retry_alignment(self, frame, face) -> tuple[str, float, np.ndarray] | None:
        """Recheck one poor landmark fit. Both views must confidently name the same person."""
        if reliable_alignment(face):
            return None
        crop, box = level_face_crop(frame, face)
        first = self._match_crop(crop, box)
        if first is None:
            return None
        lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB)
        lab[:, :, 0] = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(lab[:, :, 0])
        second = self._match_crop(cv2.cvtColor(lab, cv2.COLOR_LAB2BGR), box)
        if second is None or second[0] != first[0]:
            return None
        return first[0], min(first[1], second[1]), first[2]

    def _match_crop(self, crop, box) -> tuple[str, float, np.ndarray] | None:
        found = self.faces.find(crop)
        if not len(found):
            return None
        face = max(found, key=lambda f: Focus.overlap(f[:4], box))
        if Focus.overlap(face[:4], box) < 0.5 or not reliable_alignment(face):
            return None
        fingerprint = self.faces.fingerprint(crop, face)
        near = self.db.closest(fingerprint)
        if len(near) < 2:
            return None
        (person, score), (_, second) = near[:2]
        if score < SAME_PERSON + MARGIN or score - second < 2 * MARGIN:
            return None
        return person, score, fingerprint

    def see(self, frame, now: float, live: bool):
        """Name every face and greet each person once they've been in view a moment (on a photo, at once).
        The frame goes out clean; the page draws one box, on the main face, from the X-Faces header."""
        self.raw = frame.copy()
        raw = self.raw
        with self.lock:
            found = self.faces.find(frame)
            if len(found):  # left to right, so face numbers stay put between frames (the page clicks by number)
                found = found[np.argsort(found[:, 0], kind="stable")]
            focus = self.focus if live else Focus()
            main = focus.pick(found, frame.shape[1], frame.shape[0], now)
            named, prints = self._name_and_print(frame, found, live=live)
            if live and main is not None:
                # someone else in the same spot is a new face, not the last person
                focus.confirm(prints[main], Focus.facing(found[main]) >= 0.5)
            names = {pid: self.db.person(pid).name for pid, _ in named if pid}
            self.seq += 1  # under the lock: a dropped photo and the camera loop must never share a number
            seq = self.seq
        boxes, clickable = [], {}
        for i, (f, (pid, score)) in enumerate(zip(found, named)):
            x, y, w, h = map(int, f[:4])
            pick = pid is None and prints[i] is not None
            if pick:
                clickable[i] = (self.crop(raw, f), prints[i], score)
            boxes.append({"i": i, "x": x, "y": y, "w": w, "h": h, "id": pid, "name": names.get(pid, ""),
                          "score": round(float(score), 3), "pick": pick})
        # The box always names who the greeter is talking with: their face turned away, its score dipped or it was
        # misread as someone else for a moment, but it's the same face (Focus kept the lock and its fingerprint
        # agrees), so it stays them, like the chip, the card and the voice.
        talking = self.conv.active
        if (live and not GROUPS and main is not None and boxes[main]["id"] != talking and talking
                and not is_guest(talking) and not is_group(talking) and self.focus.track == self.conv.active_track):
            boxes[main].update(id=talking, name=self.conv.active_name,
                               score=round(self.scores.get(talking, 0.0), 3), pick=False)
        if clickable:
            with self.lock:
                self.unknown.append((seq, clickable, set(names)))
        self.jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])[1].tobytes()
        meta = {"seq": seq, "w": int(frame.shape[1]), "h": int(frame.shape[0]), "main": main, "faces": boxes}
        self.shot = (self.jpeg, json.dumps(meta, separators=(",", ":")))
        known = [(pid, score) for pid, score in named if pid]
        if not live:
            for pid, score in known:
                others = [names[p] for p, _ in known if p != pid]
                threading.Thread(target=self.greet, args=(pid, score, others), daemon=True).start()
            if not known:
                closest = max((s for _, s in named), default=0.0)
                self.emit({"kind": "step", "text": "No face in the photo" if not len(found)
                           else f"No confident match (closest {closest:.2f})"})
            return
        sizes = [min(f[2], f[3]) for f in found]
        lead = named[main][0] if main is not None and sizes[main] >= MIN_FACE else None  # the person it talks with
        for pid, score in known:
            self.streak[pid] = self.streak.get(pid, 0) + 1
            self.scores[pid] = float(score)
            if not GROUPS and (pid != lead or self.conv.active != pid):
                continue  # not the person it's talking with (yet): named on screen, never greeted or listened to
            if self.streak[pid] >= STREAK and now - self.last_seen.get(pid, 0) > self.away:
                others = [names[p] for p, _ in known if p != pid] if GROUPS else []
                threading.Thread(target=self.greet, args=(pid, score, others, True), daemon=True).start()
            if self.streak[pid] >= STREAK:
                self.last_seen[pid] = now
        for other in list(self.streak):
            if other not in names:
                self.streak[other] = 0
        # Who the greeter talks with (conversation.py waits for faces to hold before switching). One person:
        # the main face, or a stranger there becomes a guest. Groups: everyone it knows at the table; a much
        # smaller face than the biggest in the last second is someone across the room.
        if GROUPS:
            self.bigs.append((now, max(sizes, default=0)))
            while now - self.bigs[0][0] > 1.0:
                self.bigs.popleft()
            biggest = max(s for _, s in self.bigs)
            near = [pid for (pid, _), s in zip(named, sizes) if pid and s >= GROUP_SIZE * biggest]
            self.conv.seen(near, max(sizes, default=0) >= MIN_FACE)
        else:
            self.conv.seen([lead] if lead else [], main is not None and sizes[main] >= MIN_FACE, self.focus.track)
        if GROUPS:
            here = sorted((names[pid], pid) for pid, _ in known if self.streak[pid] >= STREAK)
        else:  # one person at a time: the chip is the person the greeter is talking with, nobody else
            talking = self.conv.active
            here = [(self.conv.active_name, talking)] if talking and not is_guest(talking) else []
        if [n for n, _ in here] != self.here:
            self.here = [n for n, _ in here]
            self.here_ids = [p for _, p in here]
            self.emit({"kind": "here", "names": self.here, "ids": self.here_ids})

    def loop(self):
        while True:
            try:
                self.link.heartbeat()
                if self.cam is None:
                    time.sleep(0.05)
                    continue
                ok, frame = self.cam.read()
                if not ok:
                    time.sleep(0.1)
                    continue
                if self.turn is not None:
                    frame = cv2.rotate(frame, self.turn)
                self.see(frame, time.time(), live=True)
            except Exception as e:  # one bad frame must not stop the camera
                print(f"camera loop: {type(e).__name__}: {e}", flush=True)
                time.sleep(0.2)

    def show_photo(self, data: bytes) -> str:
        frame = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if frame is None:
            return "not an image"
        h, w = frame.shape[:2]
        if max(h, w) > 1280:
            frame = cv2.resize(frame, None, fx=1280 / max(h, w), fy=1280 / max(h, w))
        self.see(frame, time.time(), live=False)
        return "ok"

    def samples(self) -> list[str]:
        """A second photo of known people (their LinkedIn photo), to try without a camera."""
        if not self.data.exists():
            return []
        with self.lock:
            known = {r[0] for r in self.db.db.execute("select distinct person_id from faces where ok = 1")}
        return [str(p.relative_to(self.data)) for pid, p in roster.held_out(self.data) if pid in known]

    def grab(self, seq: int, i: int) -> dict | None:
        """Hold on to a face clicked on the page (face i of frame seq), and say who it looks most like.
        None when that frame is too old."""
        with self.lock:
            frames = list(self.unknown)
        face, taken = next(((faces.get(i), taken) for s, faces, taken in reversed(frames) if s == seq), (None, set()))
        if face is None:
            return None
        crop, fp, score = face
        token = uuid.uuid4().hex[:16]
        self.held[token] = (crop, fp)
        while len(self.held) > 20:
            self.held.popitem(last=False)
        with self.lock:
            # people already named on another face in that frame can't be this one
            near = [(pid, s) for pid, s in self.db.closest(fp, 8) if s >= SUGGEST and pid not in taken][:3]
            people = [{"id": pid, "name": self.db.person(pid).name, "score": round(float(s), 3)} for pid, s in near]
        return {"token": token, "score": round(float(score), 3), "candidates": people}

    def held_jpeg(self, token: str) -> bytes | None:
        face = self.held.get(token)
        return cv2.imencode(".jpg", face[0], [cv2.IMWRITE_JPEG_QUALITY, 88])[1].tobytes() if face else None

    def add_face(self, name: str, about: str, token: str = "", pid: str = "") -> dict:
        """Save a face as a photo: the one clicked on the page (token), or else the main face in view.
        pid: it is someone the greeter already knows (the photo goes to people/<their id>/);
        otherwise name: someone new (people/<name>/)."""
        if token:
            if token not in self.held:
                return {"message": "That face is gone. Click it again."}
            crop = self.held[token][0]
        else:
            frame = self.raw
            if frame is None:
                return {"message": "nothing in view yet"}
            with self.lock:
                found = self.faces.find(frame)
            if len(found) == 0:
                return {"message": "no face in view"}
            crop = self.crop(frame, found[Focus().pick(found, frame.shape[1], frame.shape[0], 0.0)])
        if not pid and name:
            if name.startswith(("_", ".")) or len(name) > 80:
                return {"message": "Use a plain name (letters and spaces, under 80 characters)."}
            # a full name it already knows is that person, not a second one (one word is too likely someone else)
            with self.lock:
                same = self.db.db.execute("select id from people where lower(name) = lower(?)", (name.strip(),)).fetchall()
            if len(same) == 1 and " " in name.strip():
                pid = same[0][0]
        if pid:
            if Path(pid).name != pid or pid in (".", "..") or "+" in pid:
                return {"message": "bad id"}
            with self.lock:
                row = self.db.db.execute("select name from people where id = ?", (pid,)).fetchone()
            if row is None:
                return {"message": f"nobody with id {pid!r}"}
            folder, name = pid, row[0] or pid
        elif name:
            folder = name
        else:
            return {"message": "give a name"}
        photos = self.people / folder / "photos"
        photos.mkdir(parents=True, exist_ok=True)
        saved = photos / f"{int(time.time() * 1000)}.jpg"
        cv2.imwrite(str(saved), crop)
        if about.strip():
            with open(self.people / folder / "about.md", "a") as f:  # added to what's there, never replacing it
                f.write("".join(f"- {l.strip()}\n" for l in about.strip().splitlines() if l.strip()))
        self.held.pop(token, None)
        self.relearn()
        with self.lock:
            rows = self.db.db.execute("select photo from faces where person_id = ? and ok = 1", (folder,)).fetchall()
        if not any(Path(p).resolve() == saved.resolve() for p, in rows):  # the new photo itself must have given a face
            return {"message": f"Saved the photo, but there's no clear face in it to learn {name} from. Click a clearer frame.", "id": folder}
        return {"message": f"Saved. The greeter knows {name} now.", "id": folder}


def handler(g: Greeter):
    data_root = g.data.resolve()

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def send(self, body: bytes, ctype: str, code: int = 200):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            url = urlparse(self.path)
            if url.path == "/":
                self.send_response(302)  # the page lives in the Next.js app (web/)
                self.send_header("Location", UI)
                self.end_headers()
            elif url.path == "/samples":
                self.send(json.dumps(g.samples()).encode(), "application/json")
            elif url.path == "/frame":
                jpg, faces = g.shot
                if not jpg:
                    self.send_response(204)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(jpg)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Faces", faces)  # where each face is, so the page can make unknown ones clickable
                self.end_headers()
                self.wfile.write(jpg)
            elif url.path == "/held":  # a face clicked on the page, for the "who is this?" sheet
                jpg = g.held_jpeg(parse_qs(url.query).get("token", [""])[0])
                if jpg is None:
                    return self.send_error(404)
                self.send(jpg, "image/jpeg")
            elif url.path == "/photo":
                path = (data_root / parse_qs(url.query).get("p", [""])[0]).resolve()
                if data_root not in path.parents or not path.is_file():
                    return self.send_error(404)
                self.send(path.read_bytes(), "image/jpeg")
            elif url.path == "/face":
                path = g.photo_of(parse_qs(url.query).get("id", [""])[0])
                if path is None:
                    return self.send_error(404)
                self.send(path.read_bytes(), {".png": "image/png", ".webp": "image/webp"}.get(path.suffix.lower(), "image/jpeg"))
            elif url.path == "/voice":  # a short-lived OpenAI Realtime key, its session briefed on this person
                pid = parse_qs(url.query).get("id", [""])[0]
                with g.lock:
                    known = g.db.db.execute("select 1 from people where id = ?", (pid,)).fetchone()
                    person = g.db.person(pid) if known else None
                out = g.voice.mint(person, VOICE_MODEL) if person else {"error": f"nobody with id {pid!r}"}
                self.send(json.dumps(out).encode(), "application/json")
            elif url.path == "/video":
                self.send_response(200)
                self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=f")
                self.end_headers()
                sent = None
                try:
                    while True:
                        jpg = g.jpeg
                        if not jpg or jpg is sent:
                            time.sleep(0.05)
                            continue
                        self.wfile.write(b"--f\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                         + str(len(jpg)).encode() + b"\r\n\r\n" + jpg + b"\r\n")
                        sent = jpg
                        time.sleep(1 / 15)
                except (BrokenPipeError, ConnectionResetError):
                    pass
            elif url.path == "/events":
                q = queue.Queue()
                g.listeners.append(q)
                q.put({"kind": "people", "known": g.db.known(), "total": g.db.total()})
                for ev in list(g.recent):
                    q.put(ev)
                q.put({"kind": "here", "names": g.here, "ids": g.here_ids})
                q.put(g.conv.active_event())
                if g.conv.active:
                    q.put({"kind": "history", "id": g.conv.active, "lines": g.conv.talk.history(g.conv.active)})
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                try:
                    while True:
                        try:
                            self.wfile.write(f"data: {json.dumps(q.get(timeout=15))}\n\n".encode())
                        except queue.Empty:
                            self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    g.listeners.remove(q)
            elif url.path in ("/talk", "/history", "/speak", "/session", "/tts"):
                code, ctype, body = g.conv.get(url.path, parse_qs(url.query))
                self.send(body, ctype, code)
            else:
                self.send_error(404)

        def do_POST(self):
            url = urlparse(self.path)
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if url.path == "/see":
                sample = parse_qs(url.query).get("sample", [""])[0]
                if sample:
                    path = (data_root / sample).resolve()
                    if data_root not in path.parents or not path.is_file():
                        return self.send_error(404)
                    body = path.read_bytes()
                msg = g.show_photo(body)
            elif url.path == "/add":
                req = json.loads(body)
                name = "".join(c for c in req.get("name", "").strip() if c.isalnum() or c in " -_").strip()
                out = g.add_face(name, req.get("about", ""), str(req.get("token", "")), str(req.get("id", "")))
                return self.send(json.dumps(out).encode(), "application/json", 200 if "id" in out else 400)
            elif url.path == "/grab":
                try:
                    req = json.loads(body)
                    out = g.grab(int(req["seq"]), int(req["i"]))
                except (ValueError, KeyError, TypeError):
                    return self.send(json.dumps({"message": "give seq and i"}).encode(), "application/json", 400)
                if out is None:
                    return self.send(json.dumps({"message": "They moved. Click the face again."}).encode(), "application/json", 404)
                return self.send(json.dumps(out).encode(), "application/json")
            elif url.path in ("/hear", "/say", "/log"):
                code, ctype, out = g.conv.post(url.path, parse_qs(url.query), body, self.headers.get("Content-Type", ""))
                return self.send(out, ctype, code)
            else:
                return self.send_error(404)
            self.send(json.dumps({"message": msg}).encode(), "application/json")

    return H


def cli():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--camera", default="none", help="webcam index, a video file, or none (photos only)")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="127.0.0.1", help="0.0.0.0 to let other devices reach the API directly")
    ap.add_argument("--people", type=Path, default=HERE / "people", help="people added at the table")
    ap.add_argument("--data", type=Path, default=HERE.parent / "hack-western-13-people", help="the Hack Western people data")
    ap.add_argument("--away", type=float, default=20, help="seconds out of view before we greet someone again")
    ap.add_argument("--turn", type=int, default=0, choices=[0, 90, 180, 270], help="rotate a sideways camera clockwise")
    ap.add_argument("--serial", help="Arduino port; without it the Arduino is mocked")
    ap.add_argument("--brain", default=os.environ.get("GREETER_BRAIN"),
                    help="URL of the AI brain (cd ../flue && npm run brain), e.g. http://127.0.0.1:8090; "
                         "without it the mock agent talks")
    a = ap.parse_args()
    a.people.mkdir(exist_ok=True)
    camera = None if a.camera == "none" else int(a.camera) if a.camera.isdigit() else a.camera
    link = SerialLink(a.serial) if a.serial else MockLink()
    g = Greeter(camera, a.people, a.data, a.away, link, a.turn, Brain(a.brain) if a.brain else None)
    threading.Thread(target=g.loop, daemon=True).start()
    print(f"API on http://localhost:{a.port}; open the page at {UI} (cd web && npm run dev)", flush=True)
    ThreadingHTTPServer((a.host, a.port), handler(g)).serve_forever()
