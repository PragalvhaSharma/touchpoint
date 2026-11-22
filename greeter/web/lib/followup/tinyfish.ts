// Thin TinyFish REST clients: the TinyAgent SSE run (live browser), plus the free Search and Fetch APIs.
import { env } from "./env";

const AGENT = "https://agent.tinyfish.ai/v1";

export type AgentEvent =
  | { type: "STARTED"; run_id: string }
  | { type: "STREAMING_URL"; run_id: string; streaming_url: string }
  | { type: "PROGRESS"; run_id: string; purpose: string }
  | { type: "HEARTBEAT" }
  | {
      type: "COMPLETE";
      run_id: string;
      status: string;
      result?: unknown;
      error?: unknown;
    };

export type AgentRun = {
  runId?: string;
  streamingUrl?: string;
  status: string; // COMPLETE.status, or ABORTED / TIMEOUT / STREAM_ENDED
  result?: unknown;
  error?: string;
  steps: number;
  ms: number;
};

export function tinyfishKey(): string | undefined {
  return env("TINYFISH_API_KEY");
}

function errText(e: unknown): string {
  if (!e) return "";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export async function cancelRun(runId: string): Promise<void> {
  const key = tinyfishKey();
  if (!key) return;
  try {
    await fetch(`${AGENT}/runs/${runId}/cancel`, {
      method: "POST",
      headers: { "X-API-Key": key },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {}
}

// One TinyAgent run over SSE. Never retries; on abort or client timeout the run is cancelled server-side.
export async function runAgent(
  req: {
    url: string;
    goal: string;
    outputSchema?: object;
    maxDurationSeconds: number;
    signal?: AbortSignal;
  },
  onEvent: (e: AgentEvent) => void,
): Promise<AgentRun> {
  const key = tinyfishKey();
  if (!key) throw new Error("TINYFISH_API_KEY is not set");
  const t0 = Date.now();
  // The agent can overrun max_duration_seconds by ~20-30s while it writes its answer; leave headroom.
  const graceSeconds = 30;
  const timeout = AbortSignal.timeout(
    (req.maxDurationSeconds + graceSeconds) * 1000,
  );
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  const run: AgentRun = { status: "STREAM_ENDED", steps: 0, ms: 0 };

  const post = (withSchema: boolean) =>
    fetch(`${AGENT}/automation/run-sse`, {
      method: "POST",
      headers: {
        "X-API-Key": key,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        url: req.url,
        goal: req.goal,
        browser_profile: "lite",
        agent_config: { max_duration_seconds: req.maxDurationSeconds },
        ...(withSchema && req.outputSchema
          ? { output_schema: req.outputSchema }
          : {}),
      }),
      signal,
    });

  let res = await post(true);
  if (!res.ok && req.outputSchema) {
    // A rejected request never starts a run, so dropping the schema here is not a retry of a run.
    const body = await res.text().catch(() => "");
    if (/output_schema/i.test(body)) res = await post(false);
    else
      throw new Error(`TinyFish run-sse ${res.status}: ${body.slice(0, 300)}`);
  }
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`TinyFish run-sse ${res.status}: ${body.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const handle = (line: string) => {
    if (!line.startsWith("data:")) return;
    let ev: AgentEvent;
    try {
      ev = JSON.parse(line.slice(5).trim());
    } catch {
      return;
    }
    if (ev.type === "STARTED") run.runId = ev.run_id;
    else if (ev.type === "STREAMING_URL") run.streamingUrl = ev.streaming_url;
    else if (ev.type === "PROGRESS") run.steps++;
    else if (ev.type === "COMPLETE") {
      run.status = ev.status;
      run.result = ev.result;
      if (ev.error) run.error = errText(ev.error);
    }
    onEvent(ev);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        handle(buf.slice(0, i).trim());
        buf = buf.slice(i + 1);
      }
    }
    if (buf.trim()) handle(buf.trim());
  } catch (e) {
    if (!signal.aborted) {
      // the stream broke but the run may still be going (and billing): stop it
      if (run.runId) await cancelRun(run.runId);
      throw e;
    }
  }
  if (signal.aborted && run.status === "STREAM_ENDED") {
    run.status = req.signal?.aborted ? "ABORTED" : "TIMEOUT";
    run.error =
      run.status === "ABORTED"
        ? "cancelled"
        : `no result after ${req.maxDurationSeconds + graceSeconds}s`;
    if (run.runId) await cancelRun(run.runId);
  }
  // the stream closed without a result: the run may still be going (and billing)
  else if (run.status === "STREAM_ENDED" && run.runId) await cancelRun(run.runId);
  run.ms = Date.now() - t0;
  return run;
}

export type SearchHit = { title: string; url: string; snippet: string };

export function decodeUrl(u: string): string {
  return u.replace(/&amp;/g, "&").trim();
}

export async function search(
  query: string,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const key = tinyfishKey();
  if (!key) throw new Error("TINYFISH_API_KEY is not set");
  const q = new URLSearchParams({ query, location: "CA", language: "en" });
  const res = await fetch(`https://api.search.tinyfish.ai?${q}`, {
    headers: { "X-API-Key": key },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`TinyFish search ${res.status}`);
  const d = (await res.json()) as {
    results?: { title?: string; url?: string; snippet?: string }[];
  };
  return (d.results ?? [])
    .filter((r) => r.url && /^https?:\/\//.test(r.url))
    .map((r) => ({
      title: r.title ?? "",
      url: decodeUrl(r.url!),
      snippet: r.snippet ?? "",
    }));
}

export type FetchedPage = {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
};

export async function fetchPages(
  urls: string[],
  purpose: string,
  signal?: AbortSignal,
): Promise<FetchedPage[]> {
  const key = tinyfishKey();
  if (!key) throw new Error("TINYFISH_API_KEY is not set");
  const res = await fetch("https://api.fetch.tinyfish.ai", {
    method: "POST",
    headers: { "X-API-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      urls: urls.slice(0, 10),
      purpose,
      format: "markdown",
      per_url_timeout_ms: 25_000,
    }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(40_000)])
      : AbortSignal.timeout(40_000),
  });
  if (!res.ok) throw new Error(`TinyFish fetch ${res.status}`);
  const d = (await res.json()) as {
    results?: {
      url: string;
      final_url?: string;
      title?: string;
      text?: string;
    }[];
  };
  return (d.results ?? []).map((r) => ({
    url: r.url,
    finalUrl: r.final_url ?? r.url,
    title: r.title ?? "",
    text: r.text ?? "",
  }));
}
