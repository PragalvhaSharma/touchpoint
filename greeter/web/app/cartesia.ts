// The greeter's mouth when Cartesia speaks: the Realtime session thinks in text, and each line is streamed to
// Cartesia over a WebSocket as it arrives, a clause at a time, and played through Web Audio. The token is
// short-lived and minted by the Python greeter (GET /session, renewed with GET /tts), so the API key never
// reaches the page. Cartesia drops a socket after 5 idle minutes; the next line just opens a new one.

export type Tts = { token: string; version: string; model: string; voice: string; speed: number; rate: number };

const ENDPOINT = "wss://api.cartesia.ai/tts/websocket";
const LEAD = 0.04; // seconds of headroom before a line's first audio, so it doesn't start clipped
const TOKEN_MS = 540_000; // tokens last 600 s; ask for a new one a minute early
// Text goes out at a sentence end, or a comma-like pause after a few words; long runs go at a space.
const SENTENCE = /[.!?…]["')\]]?\s/g;
const PAUSE = /[,;:—–]\s/g;

function lastEnd(re: RegExp, s: string, from = 0) {
  let end = -1;
  re.lastIndex = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) if (m.index + m[0].length > from) end = m.index + m[0].length;
  return end;
}

// One reply. Replies play one after another: a later one's audio waits until the earlier one is done.
type Line = { rest: Uint8Array; held: AudioBuffer[]; done: boolean; sent: boolean; heard: boolean };

export class CartesiaSpeaker {
  onStart?: () => void; // a line's first audio started playing
  onEnd?: () => void; // everything has played out
  onError?: (message: string) => void;
  private ws: WebSocket | null = null;
  private opened = false; // the current socket got as far as open
  private opening = false;
  private closed = false;
  private born = Date.now(); // when the token was minted
  private queue: string[] = []; // messages waiting for a socket
  private sources = new Set<AudioBufferSourceNode>();
  private lines = new Map<string, Line>(); // lines not yet fully received, oldest (the one playing) first
  private heard = false; // some audio played since the last time it went quiet
  private at = 0; // when the next chunk plays, in AudioContext time
  private n = 0;
  private id = ""; // the line text is going to
  private buf = "";
  private ended = true;

  constructor(
    private ctx: AudioContext,
    private tts: Tts,
    private out: AudioNode,
    private renew?: () => Promise<Tts | null>,
  ) {
    this.connect();
  }

  /** Speaking, or about to. */
  get busy() {
    return this.lines.size > 0 || this.sources.size > 0;
  }

  /** A new line; it plays after whatever is still playing. */
  begin() {
    if (!this.ended) this.end();
    this.id = "line-" + ++this.n + "-" + Date.now();
    this.lines.set(this.id, { rest: new Uint8Array(0), held: [], done: false, sent: false, heard: false });
    this.buf = "";
    this.ended = false;
  }

  /** More of the line's text, as it arrives. */
  push(text: string) {
    if (this.ended) return;
    this.buf += text;
    let end = lastEnd(SENTENCE, this.buf);
    if (end < 0 && this.buf.length >= 28) end = lastEnd(PAUSE, this.buf, 20);
    if (end < 0 && this.buf.length >= 110) end = this.buf.lastIndexOf(" ") + 1;
    if (end > 0) {
      this.send(this.buf.slice(0, end), true);
      this.buf = this.buf.slice(end);
    }
  }

  /** All of the line's text is in (or there was none: a reply that only called a tool). */
  end() {
    if (this.ended) return;
    this.ended = true;
    const line = this.lines.get(this.id);
    if (line && (line.sent || this.buf.trim())) this.send(this.buf, false);
    else this.done(this.id);
    this.buf = "";
  }

  /** Cut off: stop playing now and drop everything still coming. */
  stop() {
    for (const [id, line] of this.lines) {
      if (line.sent && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ context_id: id, cancel: true }));
    }
    this.lines.clear();
    this.queue = [];
    this.heard = false;
    this.ended = true;
    this.buf = "";
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {}
    }
    this.sources.clear();
    this.at = 0;
  }

  close() {
    this.closed = true;
    this.stop();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onmessage = ws.onerror = ws.onopen = ws.onclose = null;
      ws.close();
    }
  }

  private connect() {
    const q = "?access_token=" + encodeURIComponent(this.tts.token) + "&cartesia_version=" + encodeURIComponent(this.tts.version);
    const ws = new WebSocket(ENDPOINT + q);
    this.ws = ws;
    this.opened = false;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.opened = true;
      for (const m of this.queue) ws.send(m);
      this.queue = [];
    };
    ws.onmessage = (m) => {
      if (this.ws === ws) this.receive(String(m.data));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // Lines Cartesia was partway through are gone with the socket; the one still being written goes on.
      for (const [id, line] of [...this.lines]) if (line.sent && (this.ended || id !== this.id)) this.done(id);
      if (!this.opened) {
        // It never connected (no network, or a bad token): give up on what was waiting rather than loop.
        this.queue = [];
        for (const id of [...this.lines.keys()]) this.done(id);
        this.onError?.("The voice couldn't reach Cartesia.");
      } else if (this.queue.length) void this.reopen();
    };
  }

  /** A fresh socket, with a fresh token if this one is about to run out. */
  private async reopen() {
    if (this.opening || this.closed || this.ws) return;
    this.opening = true;
    try {
      if (this.renew && Date.now() - this.born > TOKEN_MS) {
        const t = await this.renew();
        if (t) {
          this.tts = t;
          this.born = Date.now();
        }
      }
    } catch {}
    this.opening = false;
    if (!this.closed && !this.ws) this.connect();
  }

  private send(transcript: string, more: boolean) {
    if (!transcript && more) return;
    const line = this.lines.get(this.id);
    if (line) line.sent = true;
    this.post({
      model_id: this.tts.model,
      voice: { mode: "id", id: this.tts.voice },
      language: "en",
      context_id: this.id,
      transcript,
      continue: more,
      max_buffer_delay_ms: 0, // it already gets whole clauses
      generation_config: { speed: this.tts.speed },
      output_format: { container: "raw", encoding: "pcm_f32le", sample_rate: this.tts.rate },
    });
  }

  private post(m: object) {
    const s = JSON.stringify(m);
    if (this.ws?.readyState === WebSocket.OPEN) return this.ws.send(s);
    this.queue.push(s);
    if (!this.ws) void this.reopen();
  }

  private receive(data: string) {
    let m: { type?: string; context_id?: string; data?: string; done?: boolean; error?: string; message?: string };
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    const id = m.context_id;
    const line = id ? this.lines.get(id) : undefined;
    if (m.type === "error" && (line || !id)) this.onError?.(m.error || m.message || "Cartesia couldn't say that.");
    if (!id || !line) return; // a line that was cut off
    if (m.type === "chunk" && m.data) this.chunk(id, line, m.data);
    if (m.done || m.type === "error") this.done(id);
  }

  private chunk(id: string, line: Line, b64: string) {
    const raw = atob(b64);
    const bytes = new Uint8Array(line.rest.length + raw.length);
    bytes.set(line.rest);
    for (let i = 0; i < raw.length; i++) bytes[line.rest.length + i] = raw.charCodeAt(i);
    const whole = bytes.length - (bytes.length % 4);
    line.rest = bytes.slice(whole);
    if (!whole) return;
    const samples = new Float32Array(bytes.buffer.slice(0, whole));
    const buffer = this.ctx.createBuffer(1, samples.length, this.tts.rate);
    buffer.copyToChannel(samples, 0);
    if (this.lines.keys().next().value === id) this.play(line, buffer);
    else line.held.push(buffer);
  }

  /** Cartesia has sent all of a line. If it was the one playing, the next one's waiting audio goes on. */
  private done(id: string) {
    const line = this.lines.get(id);
    if (line) line.done = true;
    for (let head = this.lines.entries().next().value; head && head[1].done; head = this.lines.entries().next().value) {
      this.lines.delete(head[0]);
      const next = this.lines.values().next().value;
      if (next) for (const b of next.held.splice(0)) this.play(next, b);
    }
    this.finishIfQuiet();
  }

  private play(line: Line, buffer: AudioBuffer) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.out);
    this.at = Math.max(this.at, this.ctx.currentTime + LEAD);
    src.start(this.at);
    this.at += buffer.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      this.finishIfQuiet();
    };
    this.heard = true;
    if (!line.heard) {
      line.heard = true;
      this.onStart?.();
    }
  }

  private finishIfQuiet() {
    if (this.busy) return;
    this.at = 0;
    if (this.heard) {
      this.heard = false;
      this.onEnd?.();
    }
  }
}

/** Plays a Web Audio stream through a local WebRTC hop, so the browser's echo canceller hears it and the mic
 *  doesn't take the greeter's own voice for the person talking (Chrome only cancels echo of WebRTC audio). */
export async function loopback(stream: MediaStream): Promise<{ stream: MediaStream; close: () => void }> {
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  a.onicecandidate = (e) => void (e.candidate && b.addIceCandidate(e.candidate));
  b.onicecandidate = (e) => void (e.candidate && a.addIceCandidate(e.candidate));
  const got = new Promise<MediaStream>((resolve) => (b.ontrack = (e) => resolve(e.streams[0])));
  stream.getTracks().forEach((t) => a.addTrack(t, stream));
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription!);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription!);
  const out = await Promise.race([got, new Promise<never>((_, no) => setTimeout(() => no(new Error("no loopback")), 3000))]);
  return { stream: out, close: () => (a.close(), b.close()) };
}
