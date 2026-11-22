"use client";

// Hands-free voice, like ChatGPT voice: an OpenAI Realtime session over WebRTC, speech to speech, which
// anyone can interrupt. The Python greeter mints a short-lived key already briefed with who the person is
// and everything they said before (GET /session); every finished line goes back to it (POST /log), which
// keeps each person's memory. When the camera turns to someone else the session is swapped for theirs.
// With a Cartesia key on the greeter, the session answers in text and Cartesia speaks it (./cartesia.ts).

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CartesiaSpeaker, loopback, type Tts } from "./cartesia";
import type { ScreenHandle } from "./talk/genui/screen";
import { handleScreenTool, screenTools } from "./talk/genui/tools";

const API = "/api/greeter";
const CALLS = "https://api.openai.com/v1/realtime/calls";
const SWITCH_MS = 150; // settle time before opening the next person's session (the old one is cut at once)
const CONNECT_MS = 15000; // a call that hasn't opened by now is dead (blocked network); try again
const CHECK_IN_MS = 10000; // tells the greeter the live voice is on, so it leaves the greeting to the voice
// Captions follow the voice word by word. The text arrives well ahead of the audio, so it is revealed at
// speaking pace, and only while the voice is actually making sound (pauses hold the caption too).
const CHARS_PER_MS = 0.0155;
const LOUD = 0.02;
const NUDGES = 2; // times in a row the greeter fills a silence before it waits for them to speak
const FINISH_MS = 1000; // quiet this long after the whole reply arrived means it has finished playing
// Half duplex: while the greeter speaks, the mic stream sent to OpenAI is paused, so its own voice from the
// speakers and the noise of the room can't cut it off mid-sentence (or get answered as if someone said it).
// It listens again a moment after its line ends. ?bargein on the page turns cutting in back on.
const TAIL_MS = 350; // the speakers' echo dies down
const DEAF_MAX_MS = 2500; // the greeter's audio has been quiet this long: listen again even if no "done" came
// When the greeter fills a silence, the transcriber sometimes "hears" its own prompt. That isn't speech.
const ECHO = "a conversation at hack western";
const echo = (t: string) => {
  const x = t.trim().toLowerCase();
  return x.length > 0 && (x.startsWith(ECHO) || ECHO.startsWith(x));
};
// Errors that only mean "a reply was already running" or "nothing to cancel"; not worth showing.
const QUIET_ERRORS = new Set(["conversation_already_has_active_response", "response_cancel_not_active"]);
// With a screen beside it, the voice shows what it talks about (tools in ./talk/genui/tools.ts).
const HANDS =
  "You have a screen beside you. Whenever you bring something up (a person, their project, a win, who they should meet), " +
  "call show for it, then keep talking while the screen builds: never wait for it, describe it or mention the tool.";

export type VoiceState = "off" | "starting" | "waiting" | "connecting" | "listening" | "hearing" | "thinking" | "speaking" | "error";
export type Member = { id: string; name: string };
type Person = { id: string; name: string; members: Member[] };
type Caption = { who: "person" | "greeter"; text: string; n: number } | null;
type Session = { id: string; dc: RTCDataChannel | null; stop: () => void; wake?: () => void; cutOff?: () => void };
type RealtimeEvent = {
  type: string;
  transcript?: string;
  text?: string;
  delta?: string;
  item_id?: string;
  error?: { message?: string; code?: string };
  response?: { status?: string; output?: { type: string; name?: string; call_id?: string; arguments?: string }[] };
};

// How loud a stream is right now, 0 to 1.
class Meter {
  private analyser: AnalyserNode;
  private data: Uint8Array<ArrayBuffer>;
  private source: MediaStreamAudioSourceNode;
  constructor(ctx: AudioContext, stream: MediaStream) {
    this.source = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.data = new Uint8Array(this.analyser.fftSize);
    this.source.connect(this.analyser);
  }
  level() {
    this.analyser.getByteTimeDomainData(this.data);
    let sum = 0;
    for (const v of this.data) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / this.data.length) * 4);
  }
  close() {
    this.source.disconnect();
  }
}

export function useVoice(active: { id: string | null; name: string; members?: Member[] }, screen?: ScreenHandle) {
  const [on, setOn] = useState(false);
  const [state, setState] = useState<VoiceState>("off");
  const [muted, setMuted] = useState(false);
  const [caption, setCaption] = useState<Caption>(null);
  const [error, setError] = useState("");
  const [person, setPerson] = useState<Person | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const mouth = useRef<HTMLAudioElement | null>(null); // plays Cartesia's voice
  const bus = useRef<{ node: GainNode; stream: MediaStream; close: () => void } | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const micMeter = useRef<Meter | null>(null);
  const outMeter = useRef<Meter | null>(null);
  const session = useRef<Session | null>(null);
  const gen = useRef(0);
  const stateRef = useRef<VoiceState>("off");
  const said = useRef("");
  const again = useRef<(id: string) => void>(() => {});
  const activeRef = useRef(active.id);
  const membersRef = useRef<Member[]>(active.members ?? []);
  const responding = useRef(false);
  // Caption pacing: how much of the greeter's line has been shown, and whether its audio is playing.
  const shown = useRef(0);
  const budget = useRef(0);
  const playing = useRef(false);
  const lastTick = useRef(0);
  const lastLoud = useRef(0);
  const lineNo = useRef(0);
  const textDone = useRef(false); // the whole of the greeter's current line has arrived
  const finish = useRef<(() => void) | null>(null); // wraps up the line once its audio has played out
  // Half duplex (TAIL_MS): the copy of the mic track the session hears, and whether it is paused for the greeter.
  const sendTrack = useRef<MediaStreamTrack | null>(null);
  const mutedRef = useRef(false);
  const deaf = useRef(false);
  const tail = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastOut = useRef(0); // when the greeter's audio was last loud
  const bargeIn = useRef(false);

  useEffect(() => {
    activeRef.current = active.id;
    membersRef.current = active.members ?? [];
  }, [active.id, active.members]);
  const hands = useRef(screen);
  useEffect(() => {
    hands.current = screen;
  }, [screen]);

  const go = useCallback((s: VoiceState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  const applyMic = useCallback(() => {
    if (sendTrack.current) sendTrack.current.enabled = !mutedRef.current && !deaf.current;
  }, []);

  // The greeter started (true) or stopped (false) making sound: stop listening now, listen again after the tail.
  const deafen = useCallback(
    (speaking: boolean) => {
      if (tail.current) clearTimeout(tail.current);
      tail.current = null;
      if (bargeIn.current) return;
      if (speaking) {
        deaf.current = true;
        lastOut.current = performance.now();
        applyMic();
        return;
      }
      if (!deaf.current) return;
      tail.current = setTimeout(() => {
        tail.current = null;
        deaf.current = false;
        applyMic();
      }, TAIL_MS);
    },
    [applyMic],
  );

  const hangUp = useCallback(() => {
    gen.current++;
    session.current?.stop();
    session.current = null;
    if (tail.current) clearTimeout(tail.current);
    tail.current = null;
    deaf.current = false;
    outMeter.current?.close();
    outMeter.current = null;
    playing.current = false;
    said.current = "";
    shown.current = budget.current = 0;
    finish.current = null;
    setCaption(null);
  }, []);

  const connect = useCallback(
    async (id: string, name = "", members: Member[] = []) => {
      hangUp();
      const my = gen.current;
      const stream = mic.current;
      if (!stream) return;
      go("connecting");
      setError("");
      setPerson({ id, name, members });
      // Try again later, but only while the same person is still the one in front of the camera.
      const retry = (ms: number) =>
        setTimeout(() => {
          if (my === gen.current && activeRef.current === id) again.current(id);
        }, ms);
      try {
        const r = await fetch(API + "/session?id=" + encodeURIComponent(id), { cache: "no-store" });
        const s = (await r.json().catch(() => ({}))) as {
          id?: string;
          name?: string;
          members?: Member[];
          key?: string;
          opener?: boolean;
          message?: string;
        };
        const turn = (s as { turn?: Record<string, unknown> }).turn;
        const tts = (s as { tts?: Tts | null }).tts ?? null;
        if (!r.ok || !s.key || !s.id) throw new Error(s.message || "The voice couldn't start.");
        if (my !== gen.current) return;
        const sid = s.id;
        setPerson({ id: sid, name: s.name ?? "", members: s.members ?? members });
        // A fresh Cartesia token for when the socket has to reopen after the first one runs out.
        const renew = async () => {
          const t = await fetch(API + "/tts", { cache: "no-store" });
          return t.ok ? ((await t.json()) as Tts) : null;
        };
        const speaker = tts && ctx.current && bus.current ? new CartesiaSpeaker(ctx.current, tts, bus.current.node, renew) : null;
        if (speaker && ctx.current && bus.current) {
          outMeter.current?.close();
          outMeter.current = new Meter(ctx.current, bus.current.stream);
        }

        const pc = new RTCPeerConnection();
        const dc = pc.createDataChannel("oai-events");
        // Its own copy of the mic, so pausing it while the greeter talks leaves the mute button and the orb alone.
        const send = stream.getAudioTracks()[0].clone();
        sendTrack.current = send;
        applyMic();
        let opened = false;
        const deadline = setTimeout(() => {
          if (opened || session.current !== me) return;
          me.stop();
          session.current = null;
          setError("The voice couldn't connect. Trying again.");
          go("error");
          retry(1000);
        }, CONNECT_MS);
        const me: Session = {
          id: sid,
          dc,
          stop() {
            clearTimeout(deadline);
            speaker?.close();
            dc.close();
            pc.close();
            send.stop();
            if (sendTrack.current === send) sendTrack.current = null;
          },
        };
        session.current = me;
        pc.ontrack = (e) => {
          if (speaker) return; // Cartesia speaks; the session only sends text
          const a = audio.current;
          if (!a || !ctx.current) return;
          a.srcObject = e.streams[0];
          a.play().catch(() => setError("Tap anywhere to hear the greeter."));
          outMeter.current?.close();
          outMeter.current = new Meter(ctx.current, e.streams[0]);
        };
        pc.addTrack(send, stream);

        const log = (who: "person" | "greeter", text?: string) => {
          const t = (text ?? "").trim();
          if (!t) return;
          fetch(API + "/log?id=" + encodeURIComponent(sid), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ who, text: t }),
          }).catch(() => {});
        };
        // A greeter line is kept once it has been heard: in full when its audio plays out, marked when cut off.
        let line = "";
        let played = false;
        let cut = false;
        let heard = "";
        // Filling silences: after a couple of nudges with no answer, it waits until they speak again.
        let nudges = 0;
        let idleOff = false;
        let talking = false; // Cartesia is speaking: the session can't tell, so its silence timer is held off
        let earlier = ""; // a line still playing when the next reply began; the caption keeps it in front
        const silent = new Set<string>(); // silences the greeter filled; their "transcripts" are made up
        const dropHeard = () => setCaption((c) => (c?.who === "person" ? null : c));
        const idle = () => {
          const off = talking || nudges >= NUDGES;
          if (!turn || idleOff === off) return;
          idleOff = off;
          const td = off ? { ...turn, idle_timeout_ms: null } : turn;
          dc.send(JSON.stringify({ type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: td } } } }));
        };
        me.wake = () => {
          nudges = 0;
          idle();
        };
        const keep = () => {
          if (!line || !(played || cut)) return;
          // Cut off: keep only what they actually heard.
          const heardPart = said.current.slice(0, shown.current).replace(/[.!?,\s]*$/, "");
          if (!cut) log("greeter", line);
          else if (heardPart) log("greeter", heardPart + "…");
          line = "";
        };
        // Played out in full: show the rest of the line and go back to listening.
        const wrapUp = () => {
          if (!playing.current && played) return;
          playing.current = false;
          if (said.current.trim()) setCaption({ who: "greeter", text: said.current.trim(), n: lineNo.current });
          shown.current = said.current.length;
          played = true;
          keep();
          deafen(false);
          if (stateRef.current === "speaking") go("listening");
        };
        // The quiet-second fallback; Cartesia says when it's done itself, so a network stall doesn't end the line.
        finish.current = () => {
          if (!speaker?.busy) wrapUp();
        };
        // Cut off while Cartesia speaks (they cut in, or typed): what output_audio_buffer.cleared does for OpenAI's voice.
        const cutOff = () => {
          if (!speaker?.busy) return;
          speaker.stop();
          playing.current = false;
          cut = true;
          keep();
          talking = false;
          idle();
          deafen(false);
          if (stateRef.current === "speaking") go("listening");
        };
        if (speaker) me.cutOff = cutOff;
        if (speaker) {
          speaker.onStart = () => {
            if (session.current !== me) return;
            playing.current = true;
            lastTick.current = lastLoud.current = performance.now();
            talking = true;
            idle();
            deafen(true);
            go("speaking");
          };
          speaker.onEnd = () => {
            if (session.current !== me) return;
            talking = false;
            idle();
            earlier = "";
            deafen(false);
            wrapUp();
          };
          speaker.onError = (message) => {
            if (session.current === me) setError(message);
          };
        }
        dc.onopen = () => {
          opened = true;
          clearTimeout(deadline);
          go("listening");
          if (hands.current) {
            dc.send(JSON.stringify({ type: "session.update", session: { type: "realtime", tools: screenTools, tool_choice: "auto" } }));
            dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: HANDS }] } }));
          }
          if (s.opener) dc.send(JSON.stringify({ type: "response.create" }));
        };
        dc.onmessage = (m) => {
          if (session.current !== me) return;
          const e = JSON.parse(m.data) as RealtimeEvent;
          switch (e.type) {
            case "input_audio_buffer.speech_started":
              cutOff();
              playing.current = false; // they cut in; that audio is being dropped
              go("hearing");
              setCaption(null);
              setError("");
              heard = "";
              nudges = 0;
              idle();
              break;
            case "input_audio_buffer.speech_stopped":
              go("thinking");
              break;
            case "input_audio_buffer.timeout_triggered":
              if (e.item_id) silent.add(e.item_id);
              nudges++;
              idle();
              break;
            case "conversation.item.input_audio_transcription.delta":
              if (e.item_id && silent.has(e.item_id)) break;
              heard += e.delta ?? "";
              if (echo(heard)) dropHeard();
              else if (heard.trim() && stateRef.current !== "speaking") setCaption({ who: "person", text: heard.trim(), n: lineNo.current });
              break;
            case "conversation.item.input_audio_transcription.completed":
              if ((e.item_id && silent.has(e.item_id)) || echo(e.transcript ?? "")) {
                dropHeard();
                break;
              }
              log("person", e.transcript);
              if (e.transcript?.trim() && stateRef.current !== "speaking") setCaption({ who: "person", text: e.transcript.trim(), n: lineNo.current });
              break;
            case "response.created":
              // Cartesia can still be saying the last line (a reply right after a tool call): that line is
              // kept as heard, and the caption carries on from it instead of starting over mid-sentence.
              if (speaker?.busy && said.current.trim()) {
                if (line) log("greeter", line);
                earlier = said.current.trim() + " ";
                said.current = earlier;
              } else {
                earlier = "";
                said.current = "";
                shown.current = 0;
                budget.current = 0;
                playing.current = false;
              }
              textDone.current = false;
              if (!earlier) lineNo.current++;
              responding.current = true;
              line = "";
              played = cut = false;
              setError("");
              speaker?.begin();
              break;
            case "response.output_audio_transcript.delta":
              said.current += e.delta ?? "";
              break;
            case "response.output_text.delta":
              said.current += e.delta ?? "";
              speaker?.push(e.delta ?? "");
              break;
            case "response.output_text.done":
              line = (e.text ?? "").trim();
              if (line) said.current = earlier + line;
              textDone.current = true;
              speaker?.end();
              keep();
              break;
            case "response.output_audio_transcript.done":
              line = (e.transcript ?? "").trim();
              if (line) said.current = line;
              textDone.current = true;
              keep();
              break;
            case "output_audio_buffer.started":
              playing.current = true;
              lastTick.current = lastLoud.current = performance.now();
              deafen(true);
              go("speaking");
              break;
            case "output_audio_buffer.stopped":
              deafen(false);
              wrapUp();
              break;
            case "output_audio_buffer.cleared":
              // Cut off: the caption stops where the voice stopped.
              playing.current = false;
              cut = true;
              keep();
              deafen(false);
              if (stateRef.current === "speaking") go("listening");
              break;
            case "response.done": {
              responding.current = false;
              speaker?.end();
              if (e.response?.status === "failed") setError("The voice lost its train of thought. Say that again?");
              if (stateRef.current === "thinking") go("listening");
              // Its hands: run each function call, hand back the results, and let it go on. A show on its own
              // needs no follow-up when it already said its line; anything it looked up, it then talks about.
              const out = e.response?.output ?? [];
              const calls = out.filter((o) => o.type === "function_call" && o.call_id);
              const sc = hands.current;
              if (!calls.length || !sc) break;
              const spoke = out.some((o) => o.type === "message");
              const done = e.response?.status === "completed";
              void Promise.all(
                calls.map(async (c) => {
                  const result = await handleScreenTool(c.name ?? "", c.arguments ?? "{}", sc, sid.startsWith("guest-") ? undefined : sid);
                  if (session.current !== me) return;
                  dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.call_id, output: JSON.stringify(result) } }));
                }),
              ).then(() => {
                if (session.current === me && done && (!spoke || calls.some((c) => c.name !== "show"))) dc.send(JSON.stringify({ type: "response.create" }));
              });
              break;
            }
            case "error":
              if (e.error?.message && !QUIET_ERRORS.has(e.error.code ?? "")) setError(e.error.message);
              break;
          }
        };
        pc.onconnectionstatechange = () => {
          if (session.current !== me) return;
          if (pc.connectionState === "failed" || pc.connectionState === "closed") {
            me.stop();
            session.current = null;
            go("connecting");
            retry(1000);
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const answer = await fetch(CALLS, {
          method: "POST",
          body: offer.sdp,
          headers: { Authorization: "Bearer " + s.key, "Content-Type": "application/sdp" },
        });
        if (!answer.ok) throw new Error("OpenAI said " + answer.status + " to the voice call.");
        const sdp = await answer.text();
        if (my !== gen.current) return;
        await pc.setRemoteDescription({ type: "answer", sdp });
      } catch (err) {
        if (my !== gen.current) return;
        session.current?.stop();
        session.current = null;
        setError(err instanceof Error ? err.message : "The voice couldn't start.");
        go("error");
        retry(5000);
      }
    },
    [go, hangUp, applyMic, deafen],
  );

  useEffect(() => {
    again.current = (id: string) => void connect(id, "", membersRef.current);
  }, [connect]);

  // Call from a tap: the mic and sound both need one.
  const start = useCallback(async () => {
    if (on) return;
    go("starting");
    setError("");
    bargeIn.current = new URLSearchParams(window.location.search).has("bargein");
    try {
      if (!navigator.mediaDevices) throw new Error("The mic only works on localhost or https.");
      const stream = await navigator.mediaDevices.getUserMedia({
        // no auto gain: it would turn up quiet voices across the room until they sound like the person here
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      });
      mic.current = stream;
      ctx.current ??= new AudioContext();
      await ctx.current.resume();
      micMeter.current = new Meter(ctx.current, stream);
      audio.current ??= Object.assign(new Audio(), { autoplay: true });
      // Cartesia's voice: Web Audio into one bus, played through a WebRTC hop so echo cancellation covers it.
      if (!bus.current) {
        const node = ctx.current.createGain();
        const dest = ctx.current.createMediaStreamDestination();
        node.connect(dest);
        let close = () => {};
        try {
          const hop = await loopback(dest.stream);
          mouth.current ??= Object.assign(new Audio(), { autoplay: true });
          mouth.current.srcObject = hop.stream;
          void mouth.current.play().catch(() => setError("Tap anywhere to hear the greeter."));
          close = hop.close;
        } catch {
          node.connect(ctx.current.destination); // no hop: still audible, just without echo cancellation
        }
        bus.current = { node, stream: dest.stream, close };
      }
      setMuted(false);
      mutedRef.current = false;
      setOn(true);
      go("waiting");
    } catch (err) {
      setError(err instanceof Error && err.message.includes("https") ? err.message : "Allow the microphone to talk with the greeter.");
      go("error");
    }
  }, [on, go]);

  const end = useCallback(() => {
    hangUp();
    fetch(API + "/talk?voice=0", { cache: "no-store" }).catch(() => {});
    micMeter.current?.close();
    micMeter.current = null;
    mic.current?.getTracks().forEach((t) => t.stop());
    mic.current = null;
    setOn(false);
    setPerson(null);
    setError("");
    go("off");
  }, [go, hangUp]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      mic.current?.getAudioTracks().forEach((t) => (t.enabled = m));
      mutedRef.current = !m;
      applyMic();
      return !m;
    });
  }, [applyMic]);

  // A typed message, answered out loud. False when no session is open.
  const send = useCallback((text: string) => {
    const s = session.current;
    if (!s?.dc || s.dc.readyState !== "open") return false;
    s.wake?.(); // typing counts as talking: the greeter may fill silences again
    // Typing while it talks works like cutting in: stop the current reply first.
    if (responding.current) s.dc.send(JSON.stringify({ type: "response.cancel" }));
    if (s.cutOff) s.cutOff();
    else if (stateRef.current === "speaking") s.dc.send(JSON.stringify({ type: "output_audio_buffer.clear" }));
    s.dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } }));
    s.dc.send(JSON.stringify({ type: "response.create" }));
    fetch(API + "/log?id=" + encodeURIComponent(s.id), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ who: "person", text }),
    }).catch(() => {});
    return true;
  }, []);

  // Follow whoever the camera says the greeter is talking with.
  useEffect(() => {
    if (!on) return;
    // a different person (or nobody): stop talking to the last one now, before anything else
    if (session.current?.id !== active.id || stateRef.current === "error") hangUp();
    if (active.id) {
      if (session.current) return; // still the same person's session
      const id = active.id;
      const name = active.name;
      const t = setTimeout(() => void connect(id, name, membersRef.current), SWITCH_MS);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      setPerson(null); // the greeter already waited for them to be gone (conversation.py ONE_CLEAR)
      go("waiting");
    }, 0);
    return () => clearTimeout(t);
  }, [on, active.id, active.name, connect, hangUp, go]);

  // Reveal the greeter's line as it is spoken: a word at a time at speaking pace, holding during pauses.
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => {
      const now = performance.now();
      // Safety for half duplex: if the greeter has been silent a while and no "done" arrived, listen again.
      if ((outMeter.current?.level() ?? 0) > LOUD) lastOut.current = now;
      if (deaf.current && !tail.current && now - lastOut.current > DEAF_MAX_MS) deafen(false);
      if (!playing.current) return;
      const dt = now - lastTick.current;
      lastTick.current = now;
      if ((outMeter.current?.level() ?? 1) > LOUD) lastLoud.current = now;
      if (now - lastLoud.current < 280) budget.current += dt * CHARS_PER_MS;
      // The "audio finished" event can come late or not at all; a quiet second after the whole reply is enough.
      if (textDone.current && !responding.current && now - lastLoud.current > FINISH_MS) {
        finish.current?.();
        return;
      }
      const text = said.current;
      let end = Math.min(text.length, Math.ceil(budget.current));
      while (end < text.length && !/\s/.test(text[end])) end++; // whole words only
      if (end === text.length && !textDone.current) end = Math.max(text.search(/\s\S*$/), 0); // that word may still be arriving
      if (end > shown.current) {
        shown.current = end;
        setCaption({ who: "greeter", text: text.slice(0, end).trim(), n: lineNo.current });
      }
    }, 40);
    return () => clearInterval(t);
  }, [on, deafen]);

  // While the voice is on, the greeter leaves greetings to it (and keeps them out of the record).
  useEffect(() => {
    if (!on) return;
    const ping = () => fetch(API + "/talk?voice=1", { cache: "no-store" }).catch(() => {});
    ping();
    const t = setInterval(ping, CHECK_IN_MS);
    return () => clearInterval(t);
  }, [on]);

  // A tap resumes sound the browser refused to autoplay.
  useEffect(() => {
    const resume = () => {
      void ctx.current?.resume();
      if (audio.current?.srcObject && audio.current.paused) audio.current.play().then(() => setError("")).catch(() => {});
      if (mouth.current?.srcObject && mouth.current.paused) mouth.current.play().catch(() => {});
    };
    window.addEventListener("pointerdown", resume);
    return () => window.removeEventListener("pointerdown", resume);
  }, []);

  useEffect(
    () => () => {
      session.current?.stop();
      bus.current?.close();
      mic.current?.getTracks().forEach((t) => t.stop());
      void ctx.current?.close();
    },
    [],
  );

  const levels = useCallback(
    () => ({ mic: muted ? 0 : (micMeter.current?.level() ?? 0), out: outMeter.current?.level() ?? 0 }),
    [muted],
  );

  return { on, state, muted, caption, error, person, start, end, toggleMute, send, levels };
}

export type Voice = ReturnType<typeof useVoice>;

const first = (name: string) => name.split(/\s+/)[0] ?? "";

// "Prag", "Prag and Parum", "Prag, Parum and Emily": first names, guests as "a guest".
export function together(members: Member[]) {
  const names = members.map((m) => (m.id.startsWith("guest-") ? "a guest" : first(m.name)));
  if (names.length < 2) return names[0] ?? "";
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

function label(v: Voice, guest: boolean) {
  const name = !v.person || guest ? "" : v.person.members.length > 1 ? together(v.person.members) : first(v.person.name);
  switch (v.state) {
    case "off":
      return "Talk with the greeter";
    case "starting":
      return "Turning on the mic";
    case "waiting":
      return "Waiting for someone";
    case "connecting":
      return name ? "Saying hi to " + name : "Saying hi";
    case "hearing":
      return "Listening";
    case "thinking":
      return "Thinking";
    case "speaking":
      return "Speaking";
    case "error":
      return "Voice paused";
    default:
      return v.muted ? "Muted" : name ? "Talking with " + name : "Listening";
  }
}

// The orb breathes with whoever is talking: the person's mic while they speak, the greeter's voice after.
function Orb({ voice, reduce, size }: { voice: Voice; reduce: boolean; size: number }) {
  const el = useRef<HTMLSpanElement>(null);
  const { levels, state, on } = voice;
  useEffect(() => {
    if (reduce || !on) return;
    let raf = 0;
    let shown = 0;
    const tick = () => {
      const { mic, out } = levels();
      const target = state === "speaking" ? out : state === "thinking" || state === "connecting" ? 0.12 : mic;
      shown += (target - shown) * 0.25;
      if (el.current) el.current.style.transform = "scale(" + (1 + shown * 0.32).toFixed(3) + ")";
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [levels, state, on, reduce]);

  const busy = state === "thinking" || state === "connecting" || state === "starting";
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <span
        ref={el}
        className="absolute inset-0 rounded-full transition-[filter] duration-300"
        style={{
          background:
            "radial-gradient(circle at 34% 28%, #ffffff 0%, #d9ecff 22%, #6cb6ff 52%, #1a6dff 78%, #0b3fd1 100%)",
          boxShadow: on ? "0 0 28px rgba(80,160,255,0.55)" : "none",
          filter: on ? (voice.muted ? "grayscale(1) brightness(0.7)" : "none") : "saturate(0.6) brightness(0.85)",
        }}
      />
      {!reduce && on && (
        <motion.span
          aria-hidden
          className="absolute inset-[12%] rounded-full mix-blend-screen"
          style={{ background: "conic-gradient(from 0deg, transparent, rgba(255,255,255,0.55), transparent 40%)" }}
          animate={{ rotate: 360 }}
          transition={{ duration: busy ? 1.2 : 6, repeat: Infinity, ease: "linear" }}
        />
      )}
    </span>
  );
}

export function VoiceDock({ voice, avatar, guest, reduce }: { voice: Voice; avatar: ReactNode; guest: boolean; reduce: boolean }) {
  const spring = { type: "spring", bounce: 0, duration: 0.4 } as const;
  const caption = voice.on ? voice.caption : null;
  // Subtitles roll: only the last couple of lines stay up, and each new word fades in as it is said.
  const words = caption?.text.split(/\s+/).filter(Boolean) ?? [];
  let from = 0;
  for (let len = words.join(" ").length; len > 170 && from < words.length - 1; from++) len -= words[from].length + 1;
  const note = voice.error;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 px-4 pb-5 pt-16">
      {/* Captions, like subtitles: what the greeter is saying, or what it just heard. */}
      <div className="flex min-h-[3.2em] w-full max-w-[680px] items-end justify-center">
        <AnimatePresence mode="popLayout" initial={false}>
          {caption?.text && (
            <motion.p
              key={caption.who + caption.n}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8, filter: "blur(6px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, filter: "blur(6px)" }}
              transition={spring}
              className={"title line-clamp-3 text-balance text-center text-[19px] font-medium leading-[1.35] [text-shadow:0_2px_12px_rgba(0,0,0,0.8)] " +
                (caption.who === "greeter" ? "text-white" : "text-white/70")}
            >
              {from > 0 && "… "}
              {words.slice(from).map((w, i) => (
                <motion.span
                  key={from + i}
                  initial={reduce ? { opacity: 0 } : { opacity: 0, filter: "blur(3px)" }}
                  animate={{ opacity: 1, filter: "blur(0px)" }}
                  transition={{ duration: 0.22, ease: "easeOut" }}
                >
                  {w + " "}
                </motion.span>
              ))}
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      <motion.div layout={!reduce} transition={spring} className="glass pointer-events-auto flex items-center gap-3 rounded-full p-2">
        <Orb voice={voice} reduce={reduce} size={44} />
        <div className="min-w-[150px] pr-1">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.p
              key={label(voice, guest)}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
              transition={spring}
              className="max-w-[260px] truncate text-[15px] font-semibold"
            >
              {label(voice, guest)}
            </motion.p>
          </AnimatePresence>
          <p className="max-w-[260px] truncate text-[12px] text-label-2">
            {note || (voice.on ? (voice.state === "waiting" ? "Step in front of the camera" : "Just talk.") : "Hands free, like a real chat")}
          </p>
        </div>
        {voice.on && voice.person && <span className="hidden sm:block">{avatar}</span>}
        {voice.on ? (
          <>
            <button
              onClick={voice.toggleMute}
              aria-pressed={voice.muted}
              aria-label={voice.muted ? "Unmute the mic" : "Mute the mic"}
              className={"press grid size-11 place-items-center rounded-full " + (voice.muted ? "bg-white text-black" : "bg-white/12 text-white hover:bg-white/20")}
            >
              <MicIcon off={voice.muted} />
            </button>
            <button
              onClick={voice.end}
              aria-label="End the voice chat"
              className="press grid size-11 place-items-center rounded-full bg-[#ff453a] text-white"
            >
              <CloseIcon />
            </button>
          </>
        ) : (
          <button
            onClick={() => void voice.start()}
            disabled={voice.state === "starting"}
            className="press flex h-11 items-center gap-2 rounded-full bg-white px-4 text-[15px] font-semibold text-black disabled:opacity-60"
          >
            <WaveIcon />
            Start talking
          </button>
        )}
      </motion.div>
    </div>
  );
}

function MicIcon({ off }: { off: boolean }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function WaveIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
    </svg>
  );
}
