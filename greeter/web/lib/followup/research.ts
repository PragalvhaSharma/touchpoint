// Step 2 of the follow-up: find live roles at the sponsor that fit what the visitor said.
// Primary: a TinyFish web agent browses the sponsor's careers site (live view streamed to the UI).
// Backup: TinyFish Search + Fetch + an OpenAI model, then OpenAI web search (see backup.ts).
import { backupRoles, hostOf } from "./backup";
import { env } from "./env";
import { runAgent, tinyfishKey } from "./tinyfish";
import type { Action, Booth, Brief, Browser, Role, Roles } from "./types";

// A visitor just walked away: past this the backup's roles (already found in parallel) are used instead.
const MAX_SECONDS = Number(env("FOLLOWUP_AGENT_SECONDS")) || 150;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    roles: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string" },
          location: { type: "string", nullable: true },
          team: { type: "string", nullable: true },
          why: { type: "string" },
        },
        required: ["title", "url", "why"],
        propertyOrdering: ["title", "url", "location", "team", "why"],
      },
    },
    blocked: { type: "boolean" },
    note: { type: "string", nullable: true },
  },
  required: ["roles", "blocked"],
  propertyOrdering: ["roles", "blocked", "note"],
};

export function buildGoal(booth: Booth, brief: Brief): string {
  const student =
    /student|intern|co-?op|new grad|undergrad|university|summer 20\d\d/i.test(
      [
        brief.person.role,
        brief.summary,
        ...brief.interests,
        ...brief.asks,
      ].join(" "),
    );
  return [
    `You are helping ${booth.company}'s recruiters follow up with a hackathon visitor. Find 2 to 4 open ${booth.company} job postings on this careers site that fit them.`,
    `Visitor: ${brief.person.name}, ${brief.person.role}. ${brief.summary}`,
    `Their interests: ${brief.interests.join("; ") || "not stated"}.`,
    `What they asked for: ${brief.asks.join("; ") || "not stated"}.`,
    `What they have built: ${brief.built?.join("; ") || "not known"}. Prefer roles doing the same kind of work.`,
    student
      ? "They are a student: look for internships, co-op and new grad roles first (search terms like intern, co-op, student, new grad plus their interests), preferring the term or year they mentioned and locations in Canada."
      : "Look for roles at their level that match their interests.",
    booth.searchUrl && brief.query
      ? `You start on the site's search results for "${brief.query}". Read those first. If they already include 2 or more relevant roles, return them right away without searching again.`
      : "",
    "How: dismiss any cookie banner, then use the site's job search box. Speed matters, the visitor is waiting: read titles, locations and links straight from the search results list and only open a posting when its link or title is unclear. Stop as soon as you have 2 to 4 good matches. Try at most 3 different searches.",
    "Never sign in, create an account, create a job alert, apply, upload anything, join a talent community, or submit any form other than the job search box. Ignore sign-in prompts and pop-ups.",
    "For each role return: the exact posting title, its location, the team if shown, the full absolute https URL of the individual posting page (not a search results page), and why: one short sentence to the visitor in second person tying the role to what they said, e.g. 'Fits your interest in ML infra' (never he or she).",
    "If the site blocks you (CAPTCHA, access denied) set blocked to true and explain in note. If nothing relevant exists, return an empty roles list and explain in note.",
  ].filter(Boolean).join("\n");
}

const short = (s: string, n = 180) =>
  s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;

function parseResult(
  result: unknown,
): { roles: unknown[]; blocked?: boolean; note?: string } | null {
  let r = result;
  if (typeof r === "string") {
    const m = r.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      r = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  const inner = (
    o.result && typeof o.result === "object" ? o.result : o
  ) as Record<string, unknown>;
  const roles = Array.isArray(inner.roles)
    ? inner.roles
    : Array.isArray(r)
      ? (r as unknown[])
      : null;
  if (!roles) return null;
  return {
    roles,
    blocked: inner.blocked === true,
    note: typeof inner.note === "string" ? inner.note : undefined,
  };
}

function cleanRoles(raw: unknown[], careersUrl: string): Role[] {
  const real = (v: unknown) =>
    typeof v === "string" &&
    v.trim() !== "" &&
    !/^(n\/?a|none|null|unknown|not (specified|shown|listed))$/i.test(v.trim());
  const out: Role[] = [];
  const seen = new Set<string>();
  const start = careersUrl.replace(/\/$/, "");
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title.trim() : "";
    let url =
      typeof r.url === "string" ? r.url.trim().replace(/&amp;/g, "&") : "";
    if (url.startsWith("/")) {
      try {
        url = new URL(url, careersUrl).href;
      } catch {}
    }
    if (
      !title ||
      !/^https?:\/\/[^\s]+$/.test(url) ||
      url.replace(/\/$/, "") === start ||
      seen.has(url)
    )
      continue;
    seen.add(url);
    out.push({
      title,
      url,
      ...(real(r.location) ? { location: (r.location as string).trim() } : {}),
      ...(real(r.team) ? { team: (r.team as string).trim() } : {}),
      why:
        typeof r.why === "string" && r.why.trim()
          ? r.why.trim()
          : "Matches what you told us at the booth.",
    });
  }
  return out.slice(0, 4);
}

async function viaAgent(
  booth: Booth,
  brief: Brief,
  signal: AbortSignal | undefined,
  on: { browser(b: Browser): void; action(a: Action): void },
): Promise<Roles> {
  const site =
    booth.searchUrl && brief.query ? booth.searchUrl.replace("{q}", encodeURIComponent(brief.query)) : booth.careersUrl;
  const b: Browser = {
    engine: "tinyfish",
    site,
    status: "starting",
    note: "Launching a TinyFish browser",
  };
  on.browser({ ...b });
  let run: Awaited<ReturnType<typeof runAgent>>;
  try {
    run = await runAgent(
      {
        url: site,
        goal: buildGoal(booth, brief),
        outputSchema: OUTPUT_SCHEMA,
        maxDurationSeconds: MAX_SECONDS,
        signal,
      },
      (ev) => {
        if (ev.type === "STARTED") {
          b.runId = ev.run_id;
          b.status = "running";
          b.note = `Agent started on ${hostOf(site)}`;
          on.browser({ ...b });
        } else if (ev.type === "STREAMING_URL") {
          b.streamingUrl = ev.streaming_url;
          b.status = "running";
          on.browser({ ...b });
        } else if (ev.type === "PROGRESS" && ev.purpose) {
          on.action({ engine: "tinyfish", text: ev.purpose, t: Date.now() });
        }
      },
    );
  } catch (e) {
    on.browser({ ...b, status: "failed", note: short((e as Error).message) });
    throw e;
  }
  const parsed = parseResult(run.result);
  const roles = parsed ? cleanRoles(parsed.roles, site) : [];
  let why = "";
  if (run.status !== "COMPLETED")
    why = `run ${run.status.toLowerCase()}${run.error ? `: ${short(run.error)}` : ""}`;
  else if (!parsed) why = "agent returned no structured result";
  else if (!roles.length && parsed.blocked)
    why = `agent was blocked${parsed.note ? `: ${short(parsed.note)}` : ""}`;
  else if (!roles.length)
    why = `no usable roles${parsed.note ? `: ${short(parsed.note)}` : ""}`;
  const meta = `${run.steps} steps, ${Math.round(run.ms / 1000)}s`;
  if (why) {
    on.browser({ ...b, status: "failed", note: `${why} (${meta})` });
    throw new Error(why);
  }
  on.browser({
    ...b,
    status: "done",
    note: `Found ${roles.length} roles (${meta})`,
  });
  return {
    company: booth.company,
    engine: "tinyfish",
    source: `TinyFish agent on ${hostOf(site)}`,
    roles,
  };
}

export async function findRoles(
  input: { booth: Booth; brief: Brief; signal?: AbortSignal },
  on: { browser(b: Browser): void; action(a: Action): void },
): Promise<Roles> {
  const { booth, brief, signal } = input;
  const force = env("FOLLOWUP_FORCE_BACKUP") === "1";
  // The backup starts now, quietly, so if the agent runs out of time its roles are ready (or nearly) right away.
  const spare = new AbortController();
  const hedge = quietBackup(booth, brief, signal ? AbortSignal.any([signal, spare.signal]) : spare.signal);
  let agentError = "";
  if (!tinyfishKey()) agentError = "no TinyFish key";
  else if (force) agentError = "FOLLOWUP_FORCE_BACKUP=1";
  else {
    try {
      const roles = await viaAgent(booth, brief, signal, on);
      spare.abort();
      return roles;
    } catch (e) {
      if (signal?.aborted) {
        spare.abort();
        throw e;
      }
      agentError = (e as Error).message;
    }
  }
  on.browser({
    engine: "backup",
    site: booth.careersUrl,
    status: "starting",
    note: `Backup research (${agentError.startsWith("FOLLOWUP") || agentError.startsWith("no TinyFish") ? agentError : "TinyFish agent did not finish"})`,
  });
  try {
    return await hedge.attach(on);
  } catch (e) {
    throw new Error(
      `Could not find roles at ${booth.company}: TinyFish agent: ${agentError}; ${(e as Error).message}`,
    );
  }
}

type On = { browser(b: Browser): void; action(a: Action): void };

// Runs the backup without showing it; attach() replays what it did so far to the UI and follows it from there.
function quietBackup(booth: Booth, brief: Brief, signal: AbortSignal) {
  const held: ((on: On) => void)[] = [];
  let live: On | null = null;
  const relay: On = {
    browser: (b) => (live ? live.browser(b) : held.push((on) => on.browser(b))),
    action: (a) => (live ? live.action(a) : held.push((on) => on.action(a))),
  };
  const result = backupRoles({ booth, brief, signal }, relay);
  result.catch(() => {}); // unused when the agent succeeds
  return {
    attach(on: On): Promise<Roles> {
      for (const f of held.splice(0)) f(on);
      live = on;
      return result;
    },
  };
}
