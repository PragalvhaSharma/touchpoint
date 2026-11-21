"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type RefObject,
} from "react";
import { Panel, type PanelLine, type PanelVoice } from "./live/panel";
import { ConfirmCard, type ConsentState } from "./live/confirm-card";
import { FollowUpView, useFollowUp } from "./live/followup";
import { useScreen } from "./talk/genui/screen";
import { useVoice, VoiceDock, type Member } from "./voice";

const API = "/api/greeter";
const SPRING = { type: "spring", bounce: 0, duration: 0.4 } as const;
// The booth follow-up starts once a visitor who actually talked has been gone this long (a face lost for a
// moment, or someone stepping in front, doesn't count as leaving).
const LEFT_AFTER = 20_000;
const SPOKE_AT_LEAST = 2; // lines from the visitor in this visit

type Line = { who: "person" | "greeter"; text: string; t: number };
type Shown = Line & { key: number; fresh: boolean };
type Active = { id: string | null; name: string; members: Member[] };
type Convo = { id: string | null; lines: Shown[] };
// For staging the panel without a live face or a live voice (?demo, then window.greeterDemo in the console).
type Demo = { person?: string | null; voice?: Partial<PanelVoice>; lines?: PanelLine[]; looking?: boolean };
// The one face the greeter is focused on (the main face), in frame pixels.
type Face = { i: number; x: number; y: number; w: number; h: number; id: string | null; name?: string; score: number; pick: boolean };
type Faces = { seq: number; w: number; h: number; nw: number; nh: number; faces: Face[] };
type Grab = { token: string; score: number; candidates: { id: string; name: string; score: number }[] };
type GreeterEvent =
  | { kind: "people"; known: number; total: number }
  | { kind: "here"; names: string[]; ids?: string[] }
  | { kind: "who"; id: string; name: string; role: string; facts: string[]; score: number; t: number }
  | { kind: "step"; text: string }
  | { kind: "say"; id?: string; name: string; text: string }
  | { kind: "active"; id: string | null; name: string; members?: Member[] }
  | { kind: "history"; id: string; lines: Line[] }
  | ({ kind: "line"; id: string; name: string } & Line);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
// No id in the key: a group's history repeats its members' own lines, which also arrive under their ids.
const lineKey = (l: Line) => `${l.t}|${l.who}|${l.text}`;
const post = (path: string, body: unknown) =>
  fetch(API + path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

// The focused face changes every frame; only the layer that draws it listens, not the whole page.
// It is smoothed so the box doesn't blink: a face missing for a frame or two keeps its box for a moment,
// and the box only turns from green to white (or to someone else) once the new answer holds for a few frames.
const HOLD_MS = 400;
const SETTLE_FRAMES = 3;
class FaceStore {
  private value: Faces | null = null;
  private fns = new Set<() => void>();
  private seen = 0; // when a face was last in the frame
  private pending: { key: string; n: number } | null = null;
  private clear: ReturnType<typeof setTimeout> | null = null;
  subscribe = (fn: () => void) => {
    this.fns.add(fn);
    return () => void this.fns.delete(fn);
  };
  get = () => this.value;
  set(next: Faces | null) {
    const now = Date.now();
    const face = next?.faces[0];
    const shown = this.value?.faces[0];
    if (!face) {
      if (!shown) return;
      if (now - this.seen < HOLD_MS) {
        this.clear ??= setTimeout(() => {
          this.clear = null;
          if (Date.now() - this.seen >= HOLD_MS) this.publish(null);
        }, HOLD_MS);
        return;
      }
      this.publish(null);
      return;
    }
    this.seen = now;
    if (this.clear) {
      clearTimeout(this.clear);
      this.clear = null;
    }
    const key = face.id ?? "?";
    if (shown && key !== (shown.id ?? "?")) {
      // a different answer: keep showing the old one, at the new spot, until this one holds
      this.pending = this.pending?.key === key ? { key, n: this.pending.n + 1 } : { key, n: 1 };
      if (this.pending.n < SETTLE_FRAMES) {
        this.publish({ ...next!, faces: [{ ...face, id: shown.id, name: shown.name, score: shown.score, pick: shown.pick }] });
        return;
      }
    }
    this.pending = null;
    this.publish(next);
  }
  private publish(next: Faces | null) {
    this.value = next;
    this.fns.forEach((fn) => fn());
  }
}

function readFaces(header: string | null, img: HTMLImageElement | null): Faces | null {
  if (!header) return null;
  try {
    const f = JSON.parse(header) as Omit<Faces, "nw" | "nh"> & { main?: number | null };
    const main = (f.faces ?? []).filter((x) => x.i === f.main && (x.id || x.pick));
    return { seq: f.seq, w: f.w, h: f.h, nw: img?.naturalWidth || f.w, nh: img?.naturalHeight || f.h, faces: main };
  } catch {
    return null;
  }
}

// The sound switch lives in localStorage so it survives reloads; the server render assumes on.
const SOUND_KEY = "greeter-sound";
const soundListeners = new Set<() => void>();
let soundChoice: boolean | null = null;
const soundStore = {
  subscribe(fn: () => void) {
    const other = () => {
      soundChoice = null;
      fn();
    };
    soundListeners.add(fn);
    window.addEventListener("storage", other);
    return () => {
      soundListeners.delete(fn);
      window.removeEventListener("storage", other);
    };
  },
  get() {
    if (soundChoice !== null) return soundChoice;
    try {
      return localStorage.getItem(SOUND_KEY) !== "off";
    } catch {
      return true;
    }
  },
  set(on: boolean) {
    soundChoice = on;
    try {
      localStorage.setItem(SOUND_KEY, on ? "on" : "off");
    } catch {
      // Storage can be off (private windows); the switch then lasts until reload.
    }
    soundListeners.forEach((fn) => fn());
  },
};

// A 44-byte silent WAV. Playing it during the first click lets later lines play without one (Safari).
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
type SpeakState = "quiet" | "speaking" | "blocked";

// Plays greeter lines one after another through a single audio element, so they never overlap.
class Speaker {
  private queue: string[] = [];
  private el: HTMLAudioElement | null = null;
  private turn = 0;
  private busy = false;
  private blocked = false;
  private primed = false;
  private on = true;
  private report: (s: SpeakState) => void;

  constructor(report: (s: SpeakState) => void) {
    this.report = report;
  }

  say(text: string) {
    if (!this.on || !text.trim()) return;
    this.queue.push(text);
    // If audio is stuck waiting for a click, only the last few lines are worth hearing.
    if (this.queue.length > 4) this.queue.splice(0, this.queue.length - 4);
    this.pump();
  }

  setOn(on: boolean) {
    this.on = on;
    if (!on) this.stop();
    else this.pump();
  }

  // Call from a user gesture: resumes anything the browser refused to autoplay.
  unlock() {
    this.blocked = false;
    if (this.busy) return;
    if (this.queue.length) return this.pump();
    if (this.primed) return;
    this.primed = true;
    const a = this.audio();
    a.src = SILENCE;
    a.play().catch(() => {});
  }

  stop() {
    this.queue = [];
    this.turn++;
    this.busy = false;
    if (this.el) {
      this.el.pause();
      this.el.removeAttribute("src");
      this.el.load();
    }
    this.report("quiet");
  }

  private audio() {
    return (this.el ??= new Audio());
  }

  private pump() {
    if (this.busy || this.blocked || !this.on) return;
    const text = this.queue.shift();
    if (text === undefined) return this.report("quiet");
    const a = this.audio();
    const turn = ++this.turn;
    const done = () => {
      if (turn !== this.turn) return;
      this.turn++;
      this.busy = false;
      this.pump();
    };
    this.busy = true;
    a.onended = done;
    a.onerror = done;
    a.src = API + "/speak?text=" + encodeURIComponent(text);
    this.report("speaking");
    a.play().catch((err: unknown) => {
      if (turn !== this.turn) return;
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        // No click yet: hold the line until the first one.
        this.turn++;
        this.busy = false;
        this.blocked = true;
        this.queue.unshift(text);
        this.report("blocked");
        return;
      }
      done();
    });
  }
}

export default function Greeter() {
  const reduce = useReducedMotion();
  const view = useRef<HTMLImageElement>(null);
  const [video, setVideo] = useState<"connecting" | "live" | "lost">("connecting");
  const [stream, setStream] = useState(false);
  const [here, setHere] = useState<{ name: string; id?: string }[]>([]);
  // The last person greeted from a photo (dropped on the camera, or POST /see): shown for a while.
  const [seen, setSeen] = useState<{ id: string; t: number } | null>(null);
  const [demo, setDemo] = useState<Demo | null>(null);
  const [dragging, setDragging] = useState(false);
  const [teaching, setTeaching] = useState(false);
  const [active, setActive] = useState<Active>({ id: null, name: "", members: [] });
  const [convo, setConvo] = useState<Convo>({ id: null, lines: [] });
  const [speakState, setSpeakState] = useState<SpeakState>("quiet");
  const [speaker] = useState(() => new Speaker(setSpeakState));
  const sound = useSyncExternalStore(soundStore.subscribe, soundStore.get, () => true);
  const seq = useRef(0);
  const activeId = useRef<string | null>(null);
  const activeMembers = useRef(new Set<string>());
  const known = useRef(new Set<string>());
  const [roster, setRoster] = useState<number | null>(null);
  const [faceStore] = useState(() => new FaceStore());
  const [grab, setGrab] = useState<Grab | null>(null);
  const [grabbing, setGrabbing] = useState<number | null>(null);
  const [camNote, setCamNote] = useState("");
  // Stable, so the open sheets don't re-run their focus and close timers on every event.
  const closeGrab = useCallback(() => setGrab(null), []);
  const closeTeach = useCallback(() => setTeaching(false), []);

  // The booth follow-up: when a visitor walks away, research roles for them and email them right away.
  // ?nofollowup turns the automatic run off (the button still works).
  const followUp = useFollowUp();
  // each visitor's phone approval, from their QR card: Follow up stays off until they approve an email
  const [consents, setConsents] = useState<Record<string, ConsentState>>({});
  const onConsent = useCallback((id: string, c: ConsentState) => {
    setConsents((all) => (all[id]?.status === c.status && all[id]?.needConsent === c.needConsent ? all : { ...all, [id]: c }));
  }, []);
  const [followSheet, setFollowSheet] = useState(false);
  const queue = useRef<{ id: string; force: boolean }[]>([]);
  const [queued, setQueued] = useState(0); // bumps when someone joins the queue
  const spoke = useRef(new Map<string, number>());
  const leaving = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const followed = useRef(new Set<string>());
  const autoFollow = useRef(true);
  const following = useRef<string | null>(null); // whose follow-up is running now
  const followUpFor = useCallback((id: string, force = false) => {
    // group ids (U1+U2) have no single inbox; a double click must not queue a second email
    if (id.includes("+") || following.current === id) return;
    if (!force && followed.current.has(id)) return;
    followed.current.add(id);
    if (queue.current.some((x) => x.id === id)) return;
    queue.current.push({ id, force });
    setQueued((n) => n + 1);
    setFollowSheet(true);
  }, []);
  const startFollowUp = followUp.start;
  // one at a time: the next visitor's follow-up starts when the last one has finished.
  // busy covers the gap while start() is still stopping the old run, before running turns true.
  const followBusy = useRef(false);
  useEffect(() => {
    if (followUp.running || followBusy.current) return;
    const next = queue.current.shift();
    if (!next) return;
    followBusy.current = true;
    following.current = next.id;
    void startFollowUp({ personId: next.id, force: next.force }).finally(() => {
      followBusy.current = false;
      following.current = null;
      if (queue.current.length) setQueued((n) => n + 1);
    });
  }, [queued, followUp.running, startFollowUp]);
  useEffect(() => {
    autoFollow.current = !new URLSearchParams(window.location.search).has("nofollowup");
    const timers = leaving.current;
    return () => timers.forEach(clearTimeout);
  }, []);
  // A visitor whose follow-up was skipped for want of an address (no consent yet, or no email on file) and who
  // then picks one on their phone from the booth QR: start their follow-up now (the server keeps that list).
  // ?nofollowup turns this off too.
  const retried = useRef(new Set<string>());
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("nofollowup")) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const res = await fetch("/api/confirm?ready=1", { cache: "no-store" });
        const { ready } = (await res.json()) as { ready?: string[] };
        for (const id of ready ?? []) {
          if (stop || retried.current.has(id) || following.current === id) continue;
          retried.current.add(id);
          followed.current.delete(id);
          followUpFor(id);
        }
      } catch {
        // the server restarting; try again on the next tick
      }
      if (!stop) timer = setTimeout(tick, 4000);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [followUpFor]);

  const screen = useScreen();
  const voice = useVoice(active, screen);
  // Is any face in view? Only flips when that changes, so the page doesn't re-render every frame.
  const looking = useSyncExternalStore(faceStore.subscribe, () => !!faceStore.get()?.faces.length, () => false);
  const voiceOn = useRef(false);
  useEffect(() => {
    voiceOn.current = voice.on;
  }, [voice.on]);

  // The live voice does its own talking; the line player only speaks when it is off.
  useEffect(() => {
    speaker.setOn(sound && !voice.on);
  }, [speaker, sound, voice.on]);

  // Browsers block sound until the page gets a click or key press; the first one unlocks it.
  useEffect(() => {
    const unlock = () => speaker.unlock();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      speaker.stop();
    };
  }, [speaker]);

  // Pull the newest frame again and again; when the greeter restarts or drops, keep retrying.
  useEffect(() => {
    let stop = false;
    let shown: string | null = null;
    let last = Date.now();
    const watch = setInterval(() => {
      if (!document.hidden && Date.now() - last > 2500) setVideo((v) => (v === "live" ? "lost" : v));
    }, 1000);
    (async () => {
      while (!stop) {
        // Nobody is watching a hidden tab, so stop pulling frames until it comes back.
        if (document.hidden) {
          await sleep(250);
          last = Date.now();
          continue;
        }
        try {
          const r = await fetch(API + "/frame", { cache: "no-store" });
          if (r.status !== 200) {
            await sleep(300);
            continue;
          }
          const url = URL.createObjectURL(await r.blob());
          const header = r.headers.get("x-faces");
          const img = view.current;
          if (img) {
            await new Promise<void>((done) => {
              img.onload = img.onerror = () => done();
              img.src = url;
            });
          }
          if (shown) URL.revokeObjectURL(shown);
          shown = url;
          // Kept with the frame actually on screen, so a click lands on the face they see.
          faceStore.set(readFaces(header, img));
          last = Date.now();
          setVideo("live");
          await sleep(40);
        } catch {
          await sleep(1000);
        }
      }
    })();
    return () => {
      stop = true;
      clearInterval(watch);
      if (shown) URL.revokeObjectURL(shown);
    };
  }, [faceStore]);

  // Live events. EventSource reconnects by itself and the greeter replays its recent lines.
  useEffect(() => {
    const es = new EventSource(API + "/events");
    es.onopen = () => {
      setStream(true);
    };
    es.onerror = () => setStream(false);
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data) as GreeterEvent;
      const key = ++seq.current;
      if (ev.kind === "here") setHere(ev.names.map((name, i) => ({ name, id: ev.ids?.[i] })));
      else if (ev.kind === "people") setRoster(ev.known);
      else if (ev.kind === "who") {
        // Only a fresh greeting takes the panel: the replay a newly opened page gets is history, and a
        // group's other members are greeted without taking it from the person in front.
        const fresh = Date.now() / 1000 - ev.t < 15;
        const bystander = ev.id !== activeId.current && activeMembers.current.has(ev.id);
        if (fresh && !bystander) setSeen({ id: ev.id, t: Date.now() });
      }
      else if (ev.kind === "active") {
        // Whoever just stepped up (again) isn't leaving; whoever walked away gets a follow-up if they stay gone.
        const back = [ev.id, ...(ev.members ?? []).map((m) => m.id)].filter((x): x is string => !!x);
        for (const id of back) {
          clearTimeout(leaving.current.get(id));
          leaving.current.delete(id);
        }
        const prev = activeId.current;
        if (prev && prev !== ev.id && autoFollow.current)
          for (const id of new Set([prev, ...activeMembers.current])) {
            if (back.includes(id) || id.startsWith("guest-") || (spoke.current.get(id) ?? 0) < SPOKE_AT_LEAST) continue;
            leaving.current.set(
              id,
              setTimeout(() => {
                leaving.current.delete(id);
                spoke.current.delete(id);
                followUpFor(id);
              }, LEFT_AFTER),
            );
          }
        // someone else stepped up: cut off whatever was being said to the last person, right away
        if (ev.id !== activeId.current) {
          speaker.stop();
          setSeen(null);
        }
        activeId.current = ev.id;
        const members = ev.members ?? (ev.id ? [{ id: ev.id, name: ev.name }] : []);
        activeMembers.current = new Set(members.map((m) => m.id));
        setActive({ id: ev.id, name: ev.name, members });
        if (!ev.id) setConvo({ id: null, lines: [] });
      } else if (ev.kind === "history") {
        if (known.current.size > 5000) known.current.clear();
        ev.lines.forEach((l) => known.current.add(lineKey(l)));
        if (ev.id === activeId.current)
          setConvo({ id: ev.id, lines: ev.lines.map((l) => ({ who: l.who, text: l.text, t: l.t, key: ++seq.current, fresh: false })) });
      } else if (ev.kind === "line") {
        const k = lineKey(ev);
        if (known.current.has(k)) return;
        known.current.add(k);
        if (ev.who === "person") spoke.current.set(ev.id, (spoke.current.get(ev.id) ?? 0) + 1);
        // Every greeter line is heard, even a greeting to someone who isn't the active person.
        if (ev.who === "greeter" && !voiceOn.current) speaker.say(ev.text);
        // A group's transcript also shows what was said to one of its members on their own.
        const party = activeId.current;
        if (!party || (ev.id !== party && !activeMembers.current.has(ev.id))) return;
        const line: Shown = { who: ev.who, text: ev.text, t: ev.t, key, fresh: true };
        setConvo((c) => (c.id === party ? { id: c.id, lines: [...c.lines, line].slice(-80) } : { id: party, lines: [line] }));
      }
    };
    return () => es.close();
  }, [speaker, followUpFor]);

  // A photo greeting takes the panel for 45 seconds (or until someone else steps up), then it goes back to the camera.
  useEffect(() => {
    if (!seen) return;
    const t = setTimeout(() => setSeen(null), 45_000);
    return () => clearTimeout(t);
  }, [seen]);

  // ?demo exposes window.greeterDemo to stage the panel by hand (recording, or no mic at the venue).
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("demo")) return;
    const w = window as unknown as { greeterDemo?: unknown };
    w.greeterDemo = { set: (d: Demo | null) => setDemo(d), show: screen.show, clear: screen.clear };
    return () => void delete w.greeterDemo;
  }, [screen.show, screen.clear]);

  // A note over the camera (the face moved, the greeter is down) fades after a few seconds.
  useEffect(() => {
    if (!camNote) return;
    const t = setTimeout(() => setCamNote(""), 3500);
    return () => clearTimeout(t);
  }, [camNote]);

  // Clicking an unknown face holds that face on the greeter, then asks who it is.
  const grabFace = async (frame: number, i: number) => {
    if (grabbing !== null) return;
    setGrabbing(i);
    setCamNote("");
    try {
      const r = await post("/grab", { seq: frame, i });
      const data = (await r.json().catch(() => ({}))) as Partial<Grab> & { message?: string };
      if (r.status === 404) setCamNote("They moved. Click the face again.");
      else if (!r.ok || !data.token) setCamNote(data.message ?? "Couldn't hold that face. Try again.");
      else setGrab({ token: data.token, score: data.score ?? 0, candidates: data.candidates ?? [] });
    } catch {
      setCamNote("Couldn't reach the greeter.");
    } finally {
      setGrabbing(null);
    }
  };

  // Dropping a photo on the camera still works, for testing without anyone in front of it.
  const see = useCallback((body: Blob) => {
    fetch(API + "/see", { method: "POST", body });
  }, []);

  const status =
    video === "live" ? { label: "Live", tone: "var(--green)" } : video === "lost" ? { label: "Reconnecting", tone: "var(--orange)" } : { label: "Connecting", tone: "var(--label-3)" };

  const guest = !!active.id?.startsWith("guest-");
  const livePerson = seen?.id ?? (active.id && !guest ? active.id : null);
  // the manual follow-up goes to whoever is talking now, falling back to the last face greeted
  // (?demo staging picks the person, the same as for the panel)
  const followTarget =
    demo && demo.person !== undefined
      ? demo.person && !demo.person.startsWith("guest-") ? demo.person : null
      : ((active.id && !guest ? active.id : null) ?? seen?.id ?? null);
  const personId = demo && demo.person !== undefined ? demo.person : livePerson;
  const gate = followTarget ? consents[followTarget] : undefined;
  const declined = gate?.status === "declined";
  const waitingPhone = !!gate?.needConsent && gate.status === "waiting";
  // The follow-up QR, for whoever the greeter knows in front of it (both people of a pair, no guests).
  const qrIds = !personId || personId.startsWith("guest-")
    ? []
    : personId.includes("+")
      ? active.members.map((m) => m.id).filter((id) => !id.startsWith("guest-") && !id.includes("+")).slice(0, 2)
      : [personId];
  const shownVoice = demo?.voice ? { ...voice, ...demo.voice } : voice;
  const lines: PanelLine[] = demo?.lines ?? convo.lines.map((l) => ({ key: l.key, who: l.who, text: l.text }));
  const blocked = !voice.on && sound && speakState === "blocked";

  return (
    <main className="flex min-h-full flex-col gap-3 p-3 lg:h-dvh lg:flex-row lg:gap-4 lg:p-4 2xl:gap-5 2xl:p-5">
      {/* Camera */}
      <section
        className="@container relative isolate min-h-[56vh] flex-1 overflow-hidden rounded-[28px] bg-[#0b0b0c] lg:min-h-0"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f) see(f);
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={view} alt="What the greeter sees" className="absolute inset-0 h-full w-full object-contain" />

        {video === "live" && !grab && <FaceFocus store={faceStore} img={view} grabbing={grabbing} onPick={grabFace} />}

        <AnimatePresence>
          {video !== "live" && (
            <motion.div
              key="wait"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 grid place-items-center text-center"
            >
              <div>
                <p className="title text-[22px] font-semibold">{video === "lost" ? "The camera feed dropped" : "Starting the camera"}</p>
                <p className="mt-1 text-[15px] text-label-2">
                  {video === "lost" ? "Retrying every second." : "Waiting for the greeter on port 8080."}
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Top bar floats over the picture */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-4">
          <div className="glass flex items-center gap-2 rounded-full px-3.5 py-2 text-[13px] font-semibold tracking-[0.01em]">
            <span className="relative grid size-2 place-items-center">
              {video === "live" && !reduce && (
                <span className="absolute size-2 animate-ping rounded-full opacity-60" style={{ background: status.tone }} />
              )}
              <span className="size-2 rounded-full" style={{ background: status.tone }} />
            </span>
            {status.label}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <AnimatePresence initial={false}>
              {here.map((p) => (
                <motion.div
                  key={p.id ?? p.name}
                  layout={!reduce}
                  initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9, filter: "blur(6px)" }}
                  animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9, filter: "blur(6px)" }}
                  transition={SPRING}
                  className="glass flex items-center gap-2 rounded-full py-1 pl-1 pr-3.5 text-[14px] font-semibold"
                >
                  <Avatar id={p.id} name={p.name} size={28} />
                  {p.name}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>

        {/* Bottom: the voice, like ChatGPT voice */}
        <VoiceDock
          voice={shownVoice}
          guest={guest}
          avatar={voice.person ? <Avatars people={voice.person.members.length ? voice.person.members : [voice.person]} size={36} /> : null}
          reduce={!!reduce}
        />

        <AnimatePresence>
          {camNote && (
            <motion.p
              key={camNote}
              role="status"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: -8, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, filter: "blur(4px)" }}
              transition={SPRING}
              className="glass pointer-events-none absolute left-1/2 top-16 z-10 -translate-x-1/2 whitespace-nowrap rounded-full px-4 py-2 text-[14px] font-semibold"
            >
              {camNote}
            </motion.p>
          )}
        </AnimatePresence>

        <AnimatePresence>{grab && <WhoSheet key={grab.token} grab={grab} onClose={closeGrab} reduce={!!reduce} />}</AnimatePresence>

        {/* The follow-up for whoever just left, running while the next visitor walks up. A solid sheet above the
            face tags, so the camera and the name chips never show through it. */}
        <AnimatePresence>
          {followSheet && (followUp.message || followUp.error) && (
            <motion.aside
              key="followup"
              aria-label="Booth follow-up"
              initial={reduce ? { opacity: 0 } : { opacity: 0, x: -24, filter: "blur(8px)" }}
              animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, x: -24, filter: "blur(8px)" }}
              transition={SPRING}
              className="no-scrollbar absolute bottom-28 left-4 top-16 z-[15] w-[min(460px,calc(100%-2rem))] overflow-y-auto overscroll-contain rounded-[28px] bg-[#101012]/[0.97] p-3 shadow-[0_30px_80px_-24px_rgba(0,0,0,0.9)] ring-1 ring-white/[0.09]"
            >
              <FollowUpView compact message={followUp.message} status={followUp.status} error={followUp.error} onClose={() => setFollowSheet(false)} />
            </motion.aside>
          )}
        </AnimatePresence>
        <AnimatePresence>
          {!followSheet && (followUp.message || followUp.error) && (
            <motion.button
              key="followup-pill"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={SPRING}
              onClick={() => setFollowSheet(true)}
              className="press absolute left-4 top-16 z-[15] flex items-center gap-2 rounded-full bg-[#141416]/[0.97] px-3.5 py-2 text-[13px] font-semibold shadow-[0_8px_30px_rgba(0,0,0,0.45)] ring-1 ring-white/[0.09]"
            >
              <span className="size-2 rounded-full" style={{ background: followUp.running ? "var(--orange)" : followUp.error ? "var(--red)" : "var(--green)" }} />
              {followUp.running ? "Following up" : followUp.error ? "Follow-up stopped" : "Follow-up done"}
            </motion.button>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {dragging && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="pointer-events-none absolute inset-3 grid place-items-center rounded-[22px] border-2 border-dashed border-white/40 bg-black/50 backdrop-blur-sm"
            >
              <p className="title text-[22px] font-semibold">Drop to show the greeter</p>
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      {/* Who is in front of the camera, building itself as their profile streams in */}
      <Panel
        // on a big booth screen the whole panel scales up, so it reads from a few steps back
        className="lg:w-[440px] xl:w-[500px] 2xl:w-[600px] min-[2200px]:w-[620px] min-[2200px]:[zoom:1.25]"
        personId={personId}
        guest={!demo?.person && guest}
        members={active.members}
        looking={demo?.looking ?? looking}
        known={roster}
        connected={stream}
        voice={shownVoice}
        screen={screen}
        lines={lines}
        footer={
          <>
            {/* Scan to get your follow-up: up as soon as the greeter knows who is in front of it, here in the panel
                so it never covers the camera. Both people of a pair get one. */}
            {!teaching && qrIds.length > 0 && (
              <div className="mb-3 flex flex-col gap-2">
                <AnimatePresence initial={false}>
                  {qrIds.map((id) => (
                    <ConfirmCard key={id} personId={id} small={qrIds.length > 1} onStatus={onConsent} />
                  ))}
                </AnimatePresence>
              </div>
            )}
            <AnimatePresence>{teaching && <TeachSheet onClose={closeTeach} reduce={!!reduce} />}</AnimatePresence>
            {blocked && <p className="px-1 pb-2 text-[12.5px] text-orange">Click anywhere to hear the greeter.</p>}
            <div className="flex gap-2">
              <button
                onClick={() => setTeaching((t) => !t)}
                aria-expanded={teaching}
                className="press flex-1 rounded-[14px] bg-white/[0.06] py-2.5 text-[14px] font-semibold text-label-2 hover:bg-white/10 hover:text-label"
              >
                {teaching ? "Done" : "Teach a face"}
              </button>
              {followTarget && (
                <button
                  onClick={() => followUpFor(followTarget, true)}
                  disabled={waitingPhone || declined}
                  title={
                    declined
                      ? "They said no thanks on their phone"
                      : waitingPhone
                        ? "Waiting for them to approve their email on their phone"
                        : "Research roles for this visitor and email them now"
                  }
                  className="press flex-1 rounded-[14px] bg-white/[0.06] py-2.5 text-[14px] font-semibold text-label-2 hover:bg-white/10 hover:text-label disabled:pointer-events-none disabled:opacity-45"
                >
                  {declined ? "Opted out" : waitingPhone ? "Waiting for approval" : "Follow up"}
                </button>
              )}
              {!voice.on && (
                <button
                  onClick={() => {
                    soundStore.set(!sound);
                    if (!sound) speaker.unlock();
                  }}
                  aria-pressed={sound}
                  aria-label={sound ? "Mute the greeter" : "Unmute the greeter"}
                  className={"press grid size-[42px] shrink-0 place-items-center rounded-[14px] bg-white/[0.06] hover:bg-white/10 " + (sound ? "text-label" : "text-label-3")}
                >
                  <SpeakerIcon on={sound} />
                </button>
              )}
            </div>
          </>
        }
      />
    </main>
  );
}

function Avatar({ id, name, size }: { id?: string; name: string; size: number }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size };
  if (!id || broken)
    return (
      <span style={{ ...style, fontSize: size * 0.38 }} className="grid shrink-0 place-items-center rounded-full bg-raised-2 font-semibold text-label-2">
        {initials(name)}
      </span>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={API + "/face?id=" + encodeURIComponent(id)}
      alt=""
      style={style}
      onError={() => setBroken(true)}
      className="shrink-0 rounded-full bg-raised-2 object-cover"
    />
  );
}

// Everyone in the conversation, overlapping a little.
function Avatars({ people, size }: { people: Member[]; size: number }) {
  return (
    <span className="flex -space-x-2.5">
      {people.slice(0, 4).map((p) => (
        <span key={p.id} title={p.name} className="rounded-full ring-2 ring-black/50">
          <Avatar id={p.id.startsWith("guest-") ? undefined : p.id} name={p.name} size={size} />
        </span>
      ))}
    </span>
  );
}

// One focus box, on the face the greeter is talking with: green corner brackets and a name tag when it
// knows them, white scanning brackets and "Who is this?" (click to add them) when it isn't sure. Mapped from
// frame pixels onto the picture as it is letterboxed inside the camera panel, gliding as the face moves.
function FaceFocus({
  store,
  img,
  grabbing,
  onPick,
}: {
  store: FaceStore;
  img: RefObject<HTMLImageElement | null>;
  grabbing: number | null;
  onPick: (seq: number, i: number) => void;
}) {
  const faces = useSyncExternalStore(store.subscribe, store.get, () => null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = img.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [img]);

  const f = faces?.faces[0];
  if (!faces || !f || !box.w || !faces.w || !faces.h) return null;
  const s = Math.min(box.w / faces.nw, box.h / faces.nh);
  const ox = (box.w - faces.nw * s) / 2;
  const oy = (box.h - faces.nh * s) / 2;
  const kx = (faces.nw * s) / faces.w;
  const ky = (faces.nh * s) / faces.h;
  const pad = Math.max(f.w * kx, f.h * ky) * 0.16;
  const left = ox + f.x * kx - pad;
  const top = oy + f.y * ky - pad;
  const width = f.w * kx + pad * 2;
  const height = f.h * ky + pad * 2;
  // The tag sits under the face; on top when there's no room below; inside the box when there's room for neither.
  const roomBelow = top + height + 52 <= oy + faces.nh * s;
  const roomAbove = top - 52 >= oy;
  const place = roomBelow ? "" : roomAbove ? "lock-tag-above" : "lock-tag-inside";
  // and slides along so it never runs off the side of the picture
  const edge = Math.min(110, box.w / 2);
  const tagX = Math.min(Math.max(left + width / 2, edge), box.w - edge) - left;
  const arm = Math.round(Math.min(46, Math.max(14, Math.min(width, height) * 0.26)));
  const known = !!f.id;
  const busy = grabbing === f.i;
  const pick = () => onPick(faces.seq, f.i);
  const lockStyle = { left, top, width, height, "--arm": arm + "px", "--tag-x": tagX + "px" } as CSSProperties;
  return (
    <div className="pointer-events-none absolute inset-0">
      <div className={"lock " + (known ? "lock-known" : "lock-unknown")} style={lockStyle}>
        {/* a new person locks in: the brackets snap in from a little wider */}
        <div key={f.id ?? "?"} className="lock-frame">
          <span className="lock-corner lock-tl" />
          <span className="lock-corner lock-tr" />
          <span className="lock-corner lock-bl" />
          <span className="lock-corner lock-br" />
          {!known && <span className="lock-scan" />}
        </div>
        {known ? (
          <div className={"lock-tag glass " + place}>
            <Avatar id={f.id!} name={f.name || "?"} size={26} />
            <span className="max-w-[16ch] truncate text-[14px] font-semibold">{f.name}</span>
          </div>
        ) : (
          <button
            // on press, not click: the frame (and this button) can be replaced between press and release
            onPointerDown={(e) => {
              if (e.button === 0) {
                e.preventDefault();
                pick();
              }
            }}
            onClick={(e) => {
              if (e.detail === 0) pick(); // keyboard
            }}
            disabled={grabbing !== null}
            aria-label="Who is this? Add this face"
            className="group pointer-events-auto absolute inset-0 cursor-pointer rounded-[18px] outline-none focus-visible:ring-2 focus-visible:ring-blue disabled:cursor-wait"
          >
            <span className={"lock-tag glass " + place}>
              <span className="lock-plus">+</span>
              <span className="text-[14px] font-semibold">{busy ? "Holding…" : "Who is this?"}</span>
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

// After a face is clicked: pick one of the closest people, or add them as someone new.
function WhoSheet({ grab, onClose, reduce }: { grab: Grab; onClose: () => void; reduce: boolean }) {
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    sheet.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("keydown", esc);
      if (closing.current) clearTimeout(closing.current);
    };
  }, [onClose]);

  const add = async (body: Record<string, string>) => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await post("/add", { token: grab.token, ...body });
      const data = (await r.json().catch(() => ({}))) as { message?: string };
      setMsg(data.message ?? (r.ok ? "Saved." : "Couldn't save that face."));
      if (r.ok) closing.current = setTimeout(onClose, 1200);
      else setBusy(false);
    } catch {
      setMsg("Couldn't reach the greeter.");
      setBusy(false);
    }
  };

  const input = "rounded-[12px] bg-raised-2 px-3.5 py-2.5 text-[15px] outline-none placeholder:text-label-3 focus:ring-2 focus:ring-blue";
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      className="absolute inset-0 z-20 grid place-items-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm"
    >
      <motion.div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="who-title"
        tabIndex={-1}
        initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 8, filter: "blur(6px)" }}
        animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 8, filter: "blur(6px)" }}
        transition={SPRING}
        className="flex w-full max-w-[380px] flex-col gap-3 rounded-[22px] border border-white/10 bg-raised p-4 shadow-[0_20px_60px_rgba(0,0,0,0.6)] outline-none"
      >
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={API + "/held?token=" + encodeURIComponent(grab.token)} alt="The face you clicked" className="size-16 shrink-0 rounded-[14px] bg-raised-2 object-cover" />
          <div className="min-w-0 flex-1">
            <p id="who-title" className="title text-[19px] font-semibold">
              Who is this?
            </p>
            <p className="text-[13px] text-label-2">Not a confident match, so the greeter didn&apos;t guess.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="press grid size-8 shrink-0 place-items-center self-start rounded-full bg-raised-2 text-label-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {grab.candidates.length > 0 && (
          <div>
            <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-label-3">Is it one of them?</p>
            <div className="flex flex-col gap-1.5">
              {grab.candidates.map((c) => (
                <button
                  key={c.id}
                  disabled={busy}
                  onClick={() => void add({ id: c.id })}
                  className="press flex items-center gap-3 rounded-[12px] bg-raised-2 px-2.5 py-2 text-left text-[15px] font-semibold hover:bg-white/10 disabled:opacity-50"
                >
                  <Avatar id={c.id} name={c.name} size={30} />
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void add({ name: name.trim(), about });
          }}
          className="flex flex-col gap-2.5"
        >
          <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-label-3">{grab.candidates.length ? "Or someone new" : "Someone new"}</p>
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Name" className={input} />
          <textarea
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            placeholder="About them, one fact per line (optional)"
            aria-label="About them"
            rows={2}
            className={"resize-none leading-[1.45] " + input}
          />
          <button disabled={busy || !name.trim()} className="press rounded-[12px] bg-blue py-2.5 text-[15px] font-semibold text-white disabled:opacity-50">
            {busy ? "Saving" : "Add them"}
          </button>
        </form>

        <p aria-live="polite" className="min-h-[1lh] text-[13px] text-label-2">
          {msg}
        </p>
      </motion.div>
    </motion.div>
  );
}

function TeachSheet({ onClose, reduce }: { onClose: () => void; reduce: boolean }) {
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [msg, setMsg] = useState("Add 3 to 5 photos per person, turning a little each time.");
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // In the stacked (narrow) layout, bring the whole panel up so the sheet sits over it, never over the camera.
    const aside = nameRef.current?.closest("aside");
    if (aside && !window.matchMedia("(min-width: 1024px)").matches) aside.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    nameRef.current?.focus({ preventScroll: true });
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose, reduce]);

  return (
    <motion.form
      // Grows out of the button that opened it, and goes back the same way.
      style={{ transformOrigin: "50% 100%" }}
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 8, filter: "blur(6px)" }}
      animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 8, filter: "blur(6px)" }}
      transition={SPRING}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const r = await fetch(API + "/add", { method: "POST", body: JSON.stringify({ name, about }) });
          setMsg(((await r.json()) as { message: string }).message);
        } catch {
          setMsg("Couldn't reach the greeter.");
        }
        setBusy(false);
      }}
      // sits just above the footer and casts its shadow upward, so the Done button underneath stays crisp
      className="absolute inset-x-3 bottom-[calc(100%+8px)] z-10 flex flex-col gap-2.5 rounded-[22px] border border-white/10 bg-raised p-4 shadow-[0_-16px_48px_rgba(0,0,0,0.55)]"
    >
      <p className="text-[17px] font-semibold">Teach the face in view</p>
      <input
        ref={nameRef}
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name"
        className="rounded-[12px] bg-raised-2 px-3.5 py-2.5 text-[15px] outline-none placeholder:text-label-3 focus:ring-2 focus:ring-blue"
      />
      <textarea
        value={about}
        onChange={(e) => setAbout(e.target.value)}
        placeholder="About them, one fact per line (optional)"
        rows={3}
        className="resize-none rounded-[12px] bg-raised-2 px-3.5 py-2.5 text-[15px] leading-[1.45] outline-none placeholder:text-label-3 focus:ring-2 focus:ring-blue"
      />
      <button disabled={busy} className="press rounded-[12px] bg-blue py-2.5 text-[15px] font-semibold text-white disabled:opacity-50">
        {busy ? "Saving" : "Save this face"}
      </button>
      <p aria-live="polite" className="text-[13px] text-label-2">
        {msg}
      </p>
    </motion.form>
  );
}


function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5 6 9H3v6h3l5 4V5z" />
      {on ? <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /> : <path d="M16 9l5 6M21 9l-5 6" />}
    </svg>
  );
}

