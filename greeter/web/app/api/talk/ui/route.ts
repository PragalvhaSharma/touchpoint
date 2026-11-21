// POST /api/talk/ui {request, personId?, person?} -> text/plain stream of one OpenUI Lang program (no prose).
// Speed matters more than anything here (the screen has to keep up with the voice). With GEMINI_API_KEY set, in the
// environment or in greeter/.env, the Gemini API writes the screen (gemini-3-flash-preview through Google's
// OpenAI-compatible endpoint, minimal reasoning, a full screen in about 2 s). Else, with OPENAI_API_KEY set
// (next.config.ts loads ../.env), OpenAI with a fast model and no reasoning (default gpt-5.6-luna, first token in
// about half a second). Else Claude through the Anthropic Messages API when ANTHROPIC_API_KEY is set, else any
// OpenAI-compatible server at OCX_BASE_URL (OpenCodex by default). TALK_UI_PROVIDER=gemini|openai|anthropic|ocx
// forces one, TALK_UI_MODEL picks the model, and the X-Talk-UI-Model response header names the model that wrote it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { uiSystemPrompt } from "@/app/talk/genui/prompt";
import { load, meet, mentioned, repo, resolve } from "../data/store";

type Fact = { text: string; source: string | null; match: "confirmed" | "likely" };
type Page = { kind: string; title: string; url: string; photo: string | null };
type Person = { id: string; name: string; role: string; photo: string | null; headline: string | null; facts: Fact[]; pages: Page[] };

const MAX_TOKENS = 2048;
/** GitHub stats are a nice-to-have: the screen never waits on them for long (most are cached from the profile). */
const REPO_WAIT_MS = 600;

const GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai";
const GEMINI_MODEL = "gemini-3-flash-preview";

let envKey: string | undefined;
/** GEMINI_API_KEY from the environment, else from greeter/.env (the camera service's), so one key file serves both. */
function geminiKey(): string {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  if (envKey === undefined) {
    try {
      const line = readFileSync(path.resolve(process.cwd(), "../.env"), "utf8").match(/^GEMINI_API_KEY=(.*)$/m); // next runs from greeter/web
      envKey = line ? line[1].trim().replace(/^["']|["']$/g, "") : "";
    } catch {
      envKey = "";
    }
  }
  return envKey;
}

type Provider = "gemini" | "openai" | "anthropic" | "ocx";
function provider(): Provider {
  const forced = process.env.TALK_UI_PROVIDER;
  if (forced === "gemini" || forced === "openai" || forced === "anthropic" || forced === "ocx") return forced;
  return geminiKey() ? "gemini" : process.env.OPENAI_API_KEY ? "openai" : process.env.ANTHROPIC_API_KEY ? "anthropic" : "ocx";
}

function modelFor(via: Provider): string {
  const set = process.env.TALK_UI_MODEL;
  if (via === "gemini") return set?.startsWith("gemini") ? set : GEMINI_MODEL;
  if (via === "openai") return set && /^(gpt|o\d)/.test(set) ? set : "gpt-5.6-luna";
  if (via === "anthropic") return set || "claude-haiku-4-5";
  return set || "anthropic/claude-haiku-4-5";
}

export async function POST(req: Request) {
  let body: { request?: unknown; personId?: unknown; person?: Person | null };
  try {
    body = await req.json();
  } catch {
    return text("Send JSON: {request, person?}", 400);
  }
  const request = typeof body.request === "string" ? body.request.trim() : "";
  if (!request) return text("request is required", 400);

  // The people the request names, from our data, then the one the caller is talking with: the screen writer only
  // ever works from real records, whatever the wording of a typed or spoken request. Someone named in the request
  // comes first ("Parum Patel's project" while talking with Prag is about Parum, with Parum's links).
  const s = load();
  const caller = body.person ?? (typeof body.personId === "string" && body.personId ? resolve(s, body.personId)?.person ?? null : null);
  const people = [...mentioned(s, request), caller].filter(
    (p, i, all): p is Person => !!p && all.findIndex((q) => q?.id === p.id) === i,
  );
  // Everything a moment could need about the main person, gathered here rather than left to the caller: the people in
  // this room they should meet (for Faces) and their repos with live stats (for ProjectMoment).
  const main = people[0];
  const matches = main ? meet(s, main.id) : [];
  const repoUrls = main
    ? [...new Set(main.pages.filter((p) => p.kind === "repo" || /github\.com\/[^/]+\/[^/]+/.test(p.url)).map((p) => p.url))].slice(0, 2)
    : [];
  const repos = (
    await Promise.all(repoUrls.map((u) => Promise.race([repo(u), new Promise<null>((r) => setTimeout(() => r(null), REPO_WAIT_MS))])))
  ).filter(Boolean);
  const user =
    `Request: ${request}\n\n` +
    (people.length
      ? `People (the only facts you may use about them):\n${people.map((p) => JSON.stringify(p)).join("\n")}` +
        (matches.length ? `\n\nPeople here ${main.name} should meet (for Faces):\n${JSON.stringify(matches)}` : "") +
        (repos.length ? `\n\n${main.name}'s repos, live (for ProjectMoment):\n${JSON.stringify(repos)}` : "")
      : "No Person was given: use only what the request says.");

  const call = (v: Provider, m: string) =>
    // Gemini 3 is meant to run at its default temperature (lower can loop), so none is sent
    v === "gemini" ? openaiCompatible(GEMINI, geminiKey(), m, user, req.signal, { reasoning_effort: "minimal", temperature: undefined })
    : v === "openai" ? openai(m, user, req.signal)
    : v === "anthropic" ? anthropic(m, user, req.signal)
    : openaiCompatible(process.env.OCX_BASE_URL || "http://localhost:10100/v1", process.env.OCX_API_KEY || "unused", m, user, req.signal);
  const attempt = async (v: Provider, m: string): Promise<Response | string> => {
    try {
      const r = await call(v, m);
      if (r.ok && r.body) return r;
      return `Model error ${r.status} (${m}): ${(await r.text().catch(() => "")).slice(0, 400)}`;
    } catch (e) {
      return `Model unreachable (${m}): ${(e as Error).message}`;
    }
  };

  let via = provider();
  let model = modelFor(via);
  let got = await attempt(via, model);
  // Gemini's free tier rate-limits: before any text has streamed, fall back to OpenAI instead of showing an error.
  if (typeof got === "string" && via === "gemini" && !process.env.TALK_UI_PROVIDER && process.env.OPENAI_API_KEY && !req.signal.aborted) {
    const first = got;
    via = "openai";
    model = modelFor(via);
    got = await attempt(via, model);
    if (typeof got === "string") got = first + " | " + got;
  }
  if (typeof got === "string") return text(got, 502);
  const answer = got.body!; // attempt() only returns a Response that has a body

  const pick = via === "anthropic" ? anthropicDelta : openaiDelta;
  const stream = answer.pipeThrough(new TextDecoderStream()).pipeThrough(sseText(pick)).pipeThrough(dropFences()).pipeThrough(new TextEncoderStream());
  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no", "X-Talk-UI-Model": model },
  });
}

function anthropic(model: string, user: string, signal: AbortSignal) {
  const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "").replace(/\/v1$/, "");
  return fetch(base + "/v1/messages", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS, temperature: 0,
      stream: true,
      system: [{ type: "text", text: uiSystemPrompt(), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    }),
  });
}

function openai(model: string, user: string, signal: AbortSignal) {
  // GPT-5 family: no temperature, reasoning off for the first token as soon as possible. Older models: temperature 0.
  const reasoning = /^(gpt-5|gpt-6|o\d)/.test(model);
  return fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model,
      max_completion_tokens: MAX_TOKENS,
      ...(reasoning ? { reasoning_effort: process.env.TALK_UI_EFFORT || "none" } : { temperature: 0 }),
      stream: true,
      messages: [
        { role: "system", content: uiSystemPrompt() },
        { role: "user", content: user },
      ],
    }),
  });
}

/** Any OpenAI-compatible chat completions server: Gemini's /v1beta/openai endpoint, or OpenCodex. */
function openaiCompatible(base: string, key: string, model: string, user: string, signal: AbortSignal, extra: Record<string, unknown> = {}) {
  return fetch(base.replace(/\/+$/, "") + "/chat/completions", {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS, temperature: 0,
      ...extra,
      stream: true,
      messages: [
        { role: "system", content: uiSystemPrompt() },
        { role: "user", content: user },
      ],
    }),
  });
}

type Pick = (event: unknown) => string | undefined;

const anthropicDelta: Pick = (e) => {
  const ev = e as { type?: string; delta?: { type?: string; text?: string }; error?: { message?: string } };
  if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") return ev.delta.text;
  if (ev.type === "error") throw new Error(ev.error?.message ?? "stream error");
};

const openaiDelta: Pick = (e) => (e as { choices?: { delta?: { content?: string | null } }[] }).choices?.[0]?.delta?.content ?? undefined;

/** Server-sent events in, the model's text deltas out. */
function sseText(pick: Pick) {
  let buf = "";
  const lines = (chunk: string, out: TransformStreamDefaultController<string>) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let ev: unknown;
      try {
        ev = JSON.parse(data);
      } catch {
        continue;
      }
      const t = pick(ev);
      if (t) out.enqueue(t);
    }
  };
  return new TransformStream<string, string>({
    transform: (chunk, out) => lines(chunk, out),
    flush: (out) => lines("\n", out),
  });
}

/**
 * Passes text through as it comes, except markdown fence lines (```openui-lang ... ```) a model may add
 * despite the prompt: a line is held back only while it could still turn out to be a fence.
 */
function dropFences() {
  let line = "";
  const fence = (s: string) => /^\s*```/.test(s);
  const maybe = (s: string) => /^\s*`{0,3}$/.test(s) || fence(s);
  let held = false;
  return new TransformStream<string, string>({
    transform(chunk, out) {
      for (const ch of chunk) {
        if (ch === "\n") {
          if (!(held && fence(line))) out.enqueue((held ? line : "") + "\n");
          line = "";
          held = false;
          continue;
        }
        if (!held && line === "") held = true;
        line += ch;
        if (held && !maybe(line)) {
          out.enqueue(line);
          held = false;
        } else if (!held) out.enqueue(ch);
      }
    },
    flush(out) {
      if (held && !fence(line)) out.enqueue(line);
    },
  });
}

const text = (s: string, status: number) => new Response(s, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
