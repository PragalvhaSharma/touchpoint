// Backup research engine: used when TinyFish's live agent is unavailable, fails, or finds nothing useful.
// 1) TinyFish Search finds real postings on the sponsor's careers domain, TinyFish Fetch reads them,
//    and an OpenAI model picks the ones that fit the visitor.
// 2) If that fails, OpenAI web search (Responses API) restricted to the sponsor's domain does the same.
// Only URLs that appeared in search results, fetched pages, or web search sources are returned.
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, Output } from "ai";
import { z } from "zod";
import { env } from "./env";
import { fetchPages, search, tinyfishKey, type SearchHit } from "./tinyfish";
import type { Action, Booth, Brief, Browser, Role, Roles } from "./types";

type On = { browser(b: Browser): void; action(a: Action): void };

const RoleList = z.object({
  roles: z
    .array(
      z.object({
        title: z.string(),
        url: z.string(),
        location: z.string().nullable(),
        team: z.string().nullable(),
        why: z.string(),
      }),
    )
    .max(4),
});

function model() {
  const apiKey = env("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  return createOpenAI({ apiKey })(env("FOLLOWUP_MODEL") ?? "gpt-4.1-mini");
}

export function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
}

// "jobs.scotiabank.com" -> "scotiabank.com" (good enough for .com/.ca sponsor domains)
export function rootDomain(u: string): string {
  const parts = hostOf(u).split(".");
  return parts.slice(-2).join(".");
}

// Shared job boards host many companies: a sponsor there is only its own path (jobs.ashbyhq.com/commure).
const BOARDS = ["ashbyhq.com", "dover.com", "greenhouse.io", "lever.co"];
// Suffixes shared by many organizations, where only the exact host is the sponsor (autodesk.wd1.myworkdayjobs.com).
const SHARED = ["myworkdayjobs.com", "gc.ca"];
const under = (h: string, d: string) => h === d || h.endsWith("." + d);

function boardSlug(careersUrl: string): string | undefined {
  try {
    const c = new URL(careersUrl);
    if (!BOARDS.some((b) => under(hostOf(careersUrl), b))) return undefined;
    return c.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
  } catch {
    return undefined;
  }
}

/** What to put after site: in a search: the board path for a shared board, else the careers host. */
export function siteOf(booth: Booth): string {
  const slug = boardSlug(booth.careersUrl);
  return hostOf(booth.careersUrl) + (slug ? "/" + slug : "");
}

/** Is this link the sponsor's own: its page on a shared board, its exact host on a shared suffix, its own domain, or its company site? */
export function onSponsorSite(u: string, booth: Booth): boolean {
  let path: string[];
  try {
    path = new URL(u).pathname.toLowerCase().split("/").filter(Boolean);
  } catch {
    return false;
  }
  const h = hostOf(u);
  const ch = hostOf(booth.careersUrl);
  if (booth.site && under(h, booth.site)) return true;
  const board = BOARDS.find((b) => under(ch, b));
  if (board) {
    const slug = boardSlug(booth.careersUrl);
    return !!slug && under(h, board) && path.slice(0, 2).includes(slug);
  }
  if (SHARED.some((d) => under(ch, d))) return h === ch;
  return under(h, rootDomain(booth.careersUrl));
}

function norm(u: string): string {
  try {
    const x = new URL(u.replace(/&amp;/g, "&"));
    x.hash = "";
    x.search = "";
    return decodeURIComponent(x.href).replace(/\/$/, "").toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

function visitor(brief: Brief): string {
  return [
    `Visitor: ${brief.person.name} (${brief.person.role}).`,
    `Summary: ${brief.summary}`,
    `Interests: ${brief.interests.join("; ") || "none stated"}`,
    `Asks: ${brief.asks.join("; ") || "none stated"}`,
    `What they built: ${brief.built?.join("; ") || "not known"}`,
  ].join("\n");
}

function isStudent(brief: Brief): boolean {
  return /student|intern|co-?op|new grad|undergrad|university|hacker|summer 20\d\d/i.test(
    [brief.person.role, brief.summary, ...brief.interests, ...brief.asks].join(
      " ",
    ),
  );
}

function keywords(brief: Brief): string[] {
  const words = [...brief.interests, ...brief.asks]
    .join(" ")
    .replace(/[^\w\s+#/-]/g, " ")
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 1 &&
        !/^(the|and|for|with|roles?|any|what|are|there|you|your|in|on|of|to|a)$/i.test(
          w,
        ),
    );
  return [...new Set(words)];
}

function queries(booth: Booth, brief: Brief): string[] {
  const host = siteOf(booth);
  const student = isStudent(brief);
  const all = brief.interests.concat(brief.asks).join(" ");
  const kind = student ? "internship co-op" : "";
  const year = all.match(/20\d\d/)?.[0] ?? (student ? "2027" : "");
  // Interests like "internship summer 2027" describe the term, not the topic.
  let topics = brief.interests
    .filter((t) => !/intern|co-?op|new grad|summer|winter|fall|20\d\d/i.test(t))
    .slice(0, 2);
  if (!topics.length) topics = keywords(brief).slice(0, 2);
  const sq = (s: string) => s.replace(/\s+/g, " ").trim();
  const qs = topics.map((t) => sq(`site:${host} ${t} ${kind} ${year}`));
  qs.push(sq(`site:${host} ${student ? "student intern" : "jobs"} ${year}`));
  qs.push(
    sq(
      `site:myworkdayjobs.com ${booth.company} ${topics[0] ?? ""} ${student ? "intern" : ""} ${year}`,
    ),
  );
  qs.push(
    sq(`${booth.company} ${topics.join(" ")} ${kind} ${year} job posting`),
  );
  return [...new Set(qs)].slice(0, 5);
}

// Careers sites often live on an ATS host that carries the company name (sunlife.wd3.myworkdayjobs.com).
// Where a posting may come from: the careers site itself (the company's marketing site has no postings).
function companyHost(u: string, booth: Booth): boolean {
  if (onSponsorSite(u, { ...booth, site: undefined })) return true;
  const ch = hostOf(booth.careersUrl);
  if ([...BOARDS, ...SHARED].some((d) => under(ch, d))) return false;
  const h = hostOf(u);
  const slug = rootDomain(booth.careersUrl).split(".")[0];
  // an ATS subdomain named after them (scotiabank.wd3.myworkdayjobs.com)
  return slug.length > 3 && h.split(".").slice(0, -2).includes(slug);
}

function act(on: On, text: string) {
  on.action({ engine: "backup", text, t: Date.now() });
}

// Keep only roles whose URL was actually seen, mapped to the exact seen URL, de-duplicated, at most 4.
function keepSeen(
  roles: z.infer<typeof RoleList>["roles"],
  seen: Map<string, string>,
): Role[] {
  const out: Role[] = [];
  const used = new Set<string>();
  for (const r of roles) {
    const real = seen.get(norm(r.url));
    if (!real || used.has(real) || !r.title.trim()) continue;
    used.add(real);
    out.push({
      title: r.title.trim(),
      url: real,
      ...(r.location ? { location: r.location } : {}),
      ...(r.team ? { team: r.team } : {}),
      why: r.why.trim(),
    });
  }
  return out.slice(0, 4);
}

// URLs that look like one job posting rather than a category or landing page.
const POSTING =
  /\/(job|jobs|details|posting|requisition)s?\/|[?&](job_?id|jobid|gh_jid|req)=|\/[A-Z]?[_-]?\d{5,}\/?$/i;

const PICK_RULES = (booth: Booth, brief: Brief) =>
  `You are picking ${booth.company} job postings to send a hackathon visitor after a chat, matched to what they build and want.
${visitor(brief)}

Pick 2 to 4 real, individual job postings from the material below that best fit this visitor.${
    isStudent(brief)
      ? " They are a student: prefer internships, co-op and new grad roles, ideally matching the term they mentioned."
      : ""
  }
Rules: use only postings that appear below, copy each URL exactly as given, never invent a URL, skip search pages and generic career pages.
For each, give title, location (null if unknown), team (null if unknown), and "why": one short sentence to the visitor in second person tying the role to what they built or said, e.g. "Fits your interest in ML infra" (never he or she).
If nothing fits at all, return an empty list.`;

async function viaSearchAndFetch(
  booth: Booth,
  brief: Brief,
  on: On,
  signal?: AbortSignal,
): Promise<Roles> {
  if (!tinyfishKey()) throw new Error("no TinyFish key for search");
  const domain = siteOf(booth);
  const qs = queries(booth, brief);
  for (const q of qs) act(on, `Search: ${q}`);
  const lists = await Promise.allSettled(qs.map((q) => search(q, signal)));
  const hits = new Map<string, SearchHit>();
  for (const l of lists) {
    if (l.status !== "fulfilled") continue;
    for (const h of l.value) {
      if (!companyHost(h.url, booth)) continue;
      if (
        !/job|career|posting|position|requisition|opening/i.test(
          h.url + " " + h.title,
        )
      )
        continue;
      if (!hits.has(norm(h.url))) hits.set(norm(h.url), h);
    }
  }
  if (!hits.size) throw new Error(`search found no postings on ${domain}`);
  act(on, `Found ${hits.size} candidate postings on ${domain}`);

  const top = [...hits.values()].slice(0, 8);
  act(on, `Reading ${top.length} postings`);
  const pages = await fetchPages(
    top.map((h) => h.url),
    `Match ${booth.company} job postings to a hackathon visitor interested in ${brief.interests.join(", ")}`,
    signal,
  ).catch(() => []);
  const textOf = new Map(pages.map((p) => [norm(p.url), p.text]));
  const seen = new Map<string, string>();
  for (const h of hits.values()) seen.set(norm(h.url), h.url);
  for (const p of pages)
    if (p.finalUrl)
      seen.set(norm(p.finalUrl), hits.get(norm(p.url))?.url ?? p.finalUrl);

  const material = [...hits.values()]
    .map((h, i) => {
      const body = (textOf.get(norm(h.url)) ?? "").replace(/\s+/g, " ");
      const start = Math.max(
        0,
        body.search(
          /Requisition ID|Job Description|About the role|Purpose|Responsibilit/i,
        ),
      );
      return `[${i + 1}] ${h.title}\nURL: ${h.url}\nSnippet: ${h.snippet.replace(/\s+/g, " ")}${
        body ? `\nPosting: ${body.slice(start, start + 1800)}` : ""
      }`;
    })
    .join("\n\n");

  act(on, "Matching postings to the conversation");
  const { output } = await generateText({
    model: model(),
    output: Output.object({ schema: RoleList }),
    prompt: `${PICK_RULES(booth, brief)}\n\nPostings:\n${material}`,
    abortSignal: signal,
  });
  const roles = keepSeen(output.roles, seen);
  if (!roles.length) throw new Error("no matching postings in search results");
  return {
    company: booth.company,
    engine: "backup",
    source: `TinyFish Search + Fetch on ${domain}`,
    roles,
  };
}

export async function viaOpenAIWebSearch(
  booth: Booth,
  brief: Brief,
  on: On,
  signal?: AbortSignal,
): Promise<Roles> {
  const domain = siteOf(booth);
  const apiKey = env("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const openai = createOpenAI({ apiKey });
  act(
    on,
    `Web search on ${domain} for ${brief.interests.slice(0, 3).join(", ")}`,
  );
  const found = await generateText({
    model: openai(env("FOLLOWUP_MODEL") ?? "gpt-4.1-mini"),
    // Domain filters are not supported on every model (gpt-4.1-mini rejects them), so the domain is in the
    // prompt and enforced below, where only links on the sponsor's domain are kept.
    tools: {
      web_search: openai.tools.webSearch({ searchContextSize: "medium" }),
    },
    toolChoice: { type: "tool", toolName: "web_search" },
    prompt: `Find current ${booth.company} job postings (${isStudent(brief) ? "internships, co-op, new grad first" : "any level"}) that fit this person. Search only site:${siteOf(booth)}${booth.site ? " and " + booth.site : ""}:
${visitor(brief)}
List each posting with its exact title, location and direct posting URL.`,
    abortSignal: signal,
  });
  const seen = new Map<string, string>();
  const add = (u: string) => {
    if (/^https?:\/\//.test(u) && companyHost(u, booth))
      seen.set(norm(u), u.replace(/[?&]utm_source=openai/, ""));
  };
  for (const s of found.sources) if (s.sourceType === "url") add(s.url);
  for (const m of found.text.matchAll(/https?:\/\/[^\s)\]>"']+/g)) add(m[0]);
  for (const r of found.toolResults) {
    const out = r.output as
      { sources?: { type: string; url?: string }[] } | undefined;
    for (const s of out?.sources ?? []) if (s.url) add(s.url);
  }
  if (!seen.size) throw new Error(`web search returned no ${domain} sources`);
  act(on, `Web search returned ${seen.size} ${domain} links`);
  const { output } = await generateText({
    model: model(),
    output: Output.object({ schema: RoleList }),
    prompt: `${PICK_RULES(booth, brief)}\n\nSearch findings:\n${found.text}\n\nSource URLs:\n${[...seen.values()].join("\n")}`,
    abortSignal: signal,
  });
  // Web search often surfaces category pages; when any individual postings are present, keep only those.
  const all = keepSeen(output.roles, seen);
  const postings = all.filter((r) => POSTING.test(r.url));
  const roles = postings.length ? postings : all;
  if (!roles.length) throw new Error("web search found no matching postings");
  return {
    company: booth.company,
    engine: "backup",
    source: `OpenAI web search on ${domain}`,
    roles,
  };
}

export async function backupRoles(
  input: { booth: Booth; brief: Brief; signal?: AbortSignal },
  on: On,
): Promise<Roles> {
  const { booth, brief, signal } = input;
  const site = booth.careersUrl;
  const errors: string[] = [];
  let weak: Roles | undefined; // only landing pages, no individual postings
  on.browser({
    engine: "backup",
    site,
    status: "running",
    note: "Searching the careers site with TinyFish Search and reading postings",
  });
  try {
    const r = await viaSearchAndFetch(booth, brief, on, signal);
    if (r.roles.some((x) => POSTING.test(x.url))) {
      on.browser({
        engine: "backup",
        site,
        status: "done",
        note: `Found ${r.roles.length} roles via ${r.source}`,
      });
      return r;
    }
    weak = r;
    act(
      on,
      "Search found only general career pages; trying web search for individual postings",
    );
  } catch (e) {
    if (signal?.aborted) throw e;
    errors.push(`search+fetch: ${(e as Error).message}`);
    act(
      on,
      `Search and fetch failed (${(e as Error).message}); trying web search`,
    );
  }
  on.browser({
    engine: "backup",
    site,
    status: "running",
    note: "Trying OpenAI web search on the sponsor's domain",
  });
  try {
    const r = await viaOpenAIWebSearch(booth, brief, on, signal);
    on.browser({
      engine: "backup",
      site,
      status: "done",
      note: `Found ${r.roles.length} roles via ${r.source}`,
    });
    return r;
  } catch (e) {
    errors.push(`web search: ${(e as Error).message}`);
    if (weak) {
      on.browser({
        engine: "backup",
        site,
        status: "done",
        note: `Found ${weak.roles.length} career pages via ${weak.source}`,
      });
      return weak;
    }
    on.browser({
      engine: "backup",
      site,
      status: "failed",
      note: errors.join("; "),
    });
    throw new Error(`Backup research failed: ${errors.join("; ")}`);
  }
}
