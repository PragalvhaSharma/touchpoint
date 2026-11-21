// What the talking orb knows about people, read only from the greeter's files:
//   ?op=person&q=<Slack id or name>  -> Person | null
//   ?op=search&q=<words>             -> who built / won / studied it (up to 8)
//   ?op=meet&id=<id>                 -> the 5 people they should meet, each with one plain reason
//   ?op=repo&url=<github url>        -> one repository, live from GitHub (a user or org URL gives their top repo)
// greeter/greeter.db holds everyone the greeter knows and their talking points (already privacy-scrubbed);
// people.db at the repo root holds the pages and facts the lookup agents found, keyed by name, which give
// each talking point its source. Both are parsed once and kept until a file changes.
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type Fact = { text: string; source: string | null; match: "confirmed" | "likely" };
export type Page = { kind: string; title: string; url: string; photo: string | null };
export type Person = {
  id: string; name: string; role: string; photo: string | null; headline: string | null;
  facts: Fact[]; pages: Page[];
  /** Photos and page images from their confirmed pages, sharpest faces first. */
  images: string[];
};
export type Found = { id: string; name: string; role: string; photo: string | null; why: string };
export type Meet = { id: string; name: string; role: string; photo: string | null; reason: string; shared: string[] };

const REPO = path.resolve(process.cwd(), "../.."); // next runs from greeter/web
const GREETER_DB = process.env.GREETER_DB ?? path.join(REPO, "greeter", "greeter.db");
const PEOPLE_DB = process.env.PEOPLE_DB ?? path.join(REPO, "people.db");
const HW_DATA = process.env.HW_DATA ?? path.join(REPO, "hack-western-13-people");
export const PROFILES = path.join(HW_DATA, "hack-western-13-people-profiles.csv");
const LINKEDIN = path.join(HW_DATA, "hack-western-13-linkedin.csv");

// ---------- words ----------

const STOP = new Set(
  ("a an and or but the of to in on at for from by with as is are was were be been being it its this that these those " +
    "he she him her his hers they them their you your yours we our i me my who whom what which when where why how " +
    "ask asks about also both just like into onto over under than then there here so if not no yes do does did done " +
    "has have had can could would should will may might more most some any all each every one two first last new " +
    "very really much many good great nice fun cool well way thing things lot get got make made making " +
    "built build builds building work works worked working job role team teams year years student students " +
    "people person someone something whether while after before during through out up down off since until " +
    "show me tell find search anyone anybody went goes going ran runs run running wants want curious " +
    "interested check fellow guaranteed opener chat talk him").split(" "),
);

const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9+#]+/).filter((t) => t.length >= 2 && !STOP.has(t));
const squash = (s: string) => s.toLowerCase().replace(/['’]s\b/g, "").replace(/[^a-z0-9+#]/g, "");

const SCHOOL_RE = /universit|college|polytechnic|institute|academy|school|^(western|waterloo|mcmaster|uoft|uoftoronto|queens|ivey|laurier|york|tmu|ubc|mit|stanford|harvard|berkeley|guelph|ottawa|carleton|uwo|uwaterloo|fanshawe|sheridan|conestoga)$/;
const SCHOOL_ALIAS: Record<string, string> = {
  westernuniversity: "western", westernu: "western", uwo: "western", universityofwesternontario: "western",
  universityofwaterloo: "waterloo", uwaterloo: "waterloo",
  universityoftoronto: "uoft", uoftoronto: "uoft", uoft: "uoft",
  queensuniversity: "queens", mcmasteruniversity: "mcmaster", yorkuniversity: "york",
  ivey: "ivey", iveybusinessschool: "ivey",
};
const HACK_RE = /hack|thon$/;
const WIN_RE = /\b(won|win|wins|winner|winners|winning|1st|2nd|3rd|first place|second place|prize|prizes|finalist|top \d+)\b/i;
const HERE_EVENT = /^(hackwestern|hw)\d*$/; // everyone here shares the event itself
const GENERIC = new Set("ai cs ml swe sde ceo cto coo cfo vp pm hw api app apps it ece eng ta phd msc bsc ba bs ms mba co op coop".split(" "));
const CONNECT = new Set(["of", "the", "de"]);
const SENTENCE_END = /[.!?:;]$/;

// lowercase words that name a field, mapped to how we say it
const TOPICS: Record<string, string> = {};
for (const [label, words] of Object.entries({
  robotics: "robotics robot robots robotic", hardware: "hardware", "embedded systems": "embedded firmware microcontroller",
  "chip design": "fpga verilog systemverilog asic chip chips semiconductor semiconductors accelerator accelerators",
  "machine learning": "ml pytorch tensorflow", "LLMs": "llm llms", "NLP": "nlp", "computer vision": "vision opencv yolo",
  fintech: "fintech", finance: "finance investing banking", trading: "trading quant", "private equity": "pe",
  healthcare: "healthcare health medical medtech", biotech: "biotech bioinformatics", neuroscience: "neuroscience neurotech",
  security: "cybersecurity security infosec", blockchain: "blockchain crypto web3 ethereum solana",
  "game dev": "game games gamedev unity", design: "design ux ui figma", startups: "startup startups founder founding cofounder",
  Rust: "rust", Python: "python", "C++": "c++", React: "react nextjs", "iOS": "ios swift", Android: "android kotlin",
  mobile: "mobile", backend: "backend", frontend: "frontend", "distributed systems": "distributed",
  GPUs: "gpu gpus cuda", compilers: "compiler compilers", quantum: "quantum", climate: "climate sustainability",
  education: "education edtech", music: "music", aerospace: "aerospace rocketry rocket drones drone",
  automotive: "automotive formula", research: "research paper papers publication", "open source": "opensource",
  "data science": "analytics", "AI agents": "agent agents agentic",
})) for (const w of words.split(" ")) TOPICS[w] = label;

type Kind = "school" | "org" | "win" | "hackathon" | "person" | "topic";
const KIND_WEIGHT: Record<Kind, number> = { win: 2, org: 1.5, person: 1.5, hackathon: 1.2, school: 1, topic: 1 };
type Feature = { key: string; kind: Kind; label: string };

/** The capitalized names in a text (schools, companies, hackathons, projects, people), and its field words. */
function features(text: string, fromRole = false): Feature[] {
  const out: Feature[] = [];
  const win = WIN_RE.test(text);
  const words = text.split(/\s+/).filter(Boolean);
  let run: string[] = [];
  let before = "";
  const flush = () => {
    while (run.length && CONNECT.has(run[run.length - 1].toLowerCase())) run.pop();
    while (run.length && /^\d+$/.test(run[run.length - 1])) run.pop(); // "Hack the North 2026" -> "Hack the North"
    if (run.length) {
      const label = run.join(" ");
      let key = squash(label);
      if (key.length >= 2 && !STOP.has(key) && !GENERIC.has(key) && !TOPICS[key] && !HERE_EVENT.test(key)) {
        let kind: Kind = "topic";
        if (SCHOOL_RE.test(label.toLowerCase()) || SCHOOL_RE.test(key) || SCHOOL_ALIAS[key]) {
          kind = "school"; key = SCHOOL_ALIAS[key] ?? key;
        } else if (HACK_RE.test(key)) kind = win ? "win" : "hackathon";
        else if (fromRole || /^(at|for|joined|join|joining|with|from|to)$/i.test(before)) kind = "org";
        out.push({ key: kind + ":" + key, kind, label });
      }
    }
    run = [];
  };
  let start = true;
  for (let i = 0; i < words.length; i++) {
    const raw = words[i];
    const w = raw.replace(/^[("'“‘\[]+/, "").replace(/(['’]s)?[)"'”’\],.;:!?]*$/, "");
    const ends = raw !== w && /[,.;:!?)"”’]$|['’]s$/.test(raw);
    const capital = /^[A-Z0-9]/.test(w) && /[A-Za-z]/.test(w);
    const marked = /[A-Z].*[A-Z0-9]|[0-9]/.test(w.slice(1)) || /^[A-Z0-9+#]{2,}$/.test(w); // TinyTPU, ESP32, NVIDIA
    const nextCapital = i + 1 < words.length && /^[("'“]*[A-Z]/.test(words[i + 1]);
    const keep = capital && (!start || marked || (nextCapital && !STOP.has(w.toLowerCase()) && !SENTENCE_END.test(raw)));
    if (keep) {
      if (!run.length) before = i > 0 ? words[i - 1].toLowerCase() : "";
      run.push(w);
    } else if (run.length && CONNECT.has(w.toLowerCase()) && nextCapital) run.push(w);
    else flush();
    if (ends) flush();
    start = SENTENCE_END.test(raw) || raw === "-" || raw === "|";
    for (const t of w.toLowerCase().split(/[^a-z0-9+#]+/)) {
      const topic = TOPICS[t];
      if (topic) out.push({ key: "topic:" + squash(topic), kind: "topic", label: topic });
    }
  }
  flush();
  if (/machine learning|deep learning/i.test(text)) out.push({ key: "topic:machinelearning", kind: "topic", label: "machine learning" });
  if (/computer vision/i.test(text)) out.push({ key: "topic:computervision", kind: "topic", label: "computer vision" });
  if (/open[- ]source/i.test(text)) out.push({ key: "topic:opensource", kind: "topic", label: "open source" });
  return out;
}

// ---------- the files ----------

export function csv(file: string): Record<string, string>[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}


type DbFact = { fact: string; source: string | null; match: string; words: Set<string> };
type Entry = {
  person: Person;
  names: string[]; // lowercase names people.db may use for them
  words: Set<string>; // search tokens
  texts: string[]; // what search can quote as "why"
  feats: Map<string, Feature>;
};
type Store = { key: string; all: Entry[]; byId: Map<string, Entry>; byName: Map<string, Entry>; df: Map<string, number> };

let store: Store | null = null;

function mtimes() {
  const at = (f: string) => statSync(f, { throwIfNoEntry: false });
  // opening people.db touches its WAL even read only, so the WAL counts by size: writes grow it, a checkpoint moves people.db
  return [GREETER_DB, PEOPLE_DB, LINKEDIN].map((f) => at(f)?.mtimeMs ?? 0).join(",") + "," + (at(PEOPLE_DB + "-wal")?.size ?? 0);
}

function similar(a: Set<string>, b: Set<string>) {
  let both = 0;
  for (const t of a) if (b.has(t)) both++;
  return both / (a.size + b.size - both || 1);
}

export function load(): Store {
  const key = mtimes();
  if (store?.key === key) return store;

  const g = new DatabaseSync(GREETER_DB, { readOnly: true });
  let rows: { id: string; name: string; role: string | null; facts: string | null }[];
  const faced = new Set<string>();
  const aliases = new Map<string, Set<string>>();
  const owners = new Map<string, { id: string; confidence: string }>();
  const recordKey = (name: string, source: string | null, match: string) => JSON.stringify([name, source ?? "", match]);
  try {
    rows = g.prepare("select id, name, role, facts from people").all() as typeof rows;
    for (const r of rows) aliases.set(r.id, new Set([r.name.trim().toLowerCase()]));
    // Older caches get these ownership tables the next time the booth syncs.
    const tables = new Set(g.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name));
    if (tables.has("directory_aliases")) {
      for (const r of g.prepare("select person_id, alias from directory_aliases").all() as { person_id: string; alias: string }[])
        aliases.get(r.person_id)?.add(r.alias);
    }
    if (tables.has("research_owners")) {
      type Owner = { name: string; source: string; source_match: string; person_id: string; confidence: string };
      for (const r of g.prepare("select * from research_owners").all() as Owner[])
        owners.set(recordKey(r.name, r.source, r.source_match), { id: r.person_id, confidence: r.confidence });
    }
    // The Python booth builds this ordinary table during sync, including on the first launch with an older cache.
    // A greeter started before that update has no such table yet; its face photos (the same pictures
    // /api/greeter/face serves) are in \`photos\`, so every profile still gets its face.
    const portraitTable = tables.has("display_portraits") ? "display_portraits" : tables.has("photos") ? "photos" : null;
    if (portraitTable) {
      const order = portraitTable === "display_portraits" ? "person_id, priority" : "person_id";
      const portraits = g.prepare(`select person_id, path from ${portraitTable} where person_id is not null order by ${order}`).all() as { person_id: string; path: string }[];
      for (const r of portraits)
        if (!faced.has(r.person_id) && statSync(r.path, { throwIfNoEntry: false })?.isFile()) faced.add(r.person_id);
    }
  } finally {
    g.close();
  }

  const dbFacts = new Map<string, DbFact[]>();
  const dbPages = new Map<string, Page[]>();
  if (existsSync(PEOPLE_DB)) {
    const p = new DatabaseSync(PEOPLE_DB, { readOnly: true });
    try {
      for (const r of p.prepare("select person, fact, source, match from facts order by t").all() as { person: string; fact: string; source: string | null; match: string }[]) {
        const owner = owners.get(recordKey(r.person, r.source, r.match));
        if (!owner) continue;
        const k = owner.id;
        if (!dbFacts.has(k)) dbFacts.set(k, []);
        dbFacts.get(k)!.push({ fact: r.fact, source: r.source || null, match: owner.confidence, words: new Set(tokens(r.fact)) });
      }
      for (const r of p.prepare("select person, url, kind, title, photo, links from pages where match = 'confirmed' order by t").all() as { person: string; url: string; kind: string; title: string | null; photo: string | null; links: string | null }[]) {
        const owner = owners.get(recordKey(r.person, r.url, "confirmed"));
        if (owner?.confidence !== "confirmed") continue;
        const k = owner.id;
        if (!dbPages.has(k)) dbPages.set(k, []);
        dbPages.get(k)!.push({ kind: r.kind, title: r.title || r.url, url: r.url, photo: r.photo || null });
        // code their own pages point to (tinytpu.com -> github.com/tiny-tpu-v2): a repo the screen can show live
        for (const link of linksOf(r.links)) {
          const gh = github(link);
          if (gh && gh.owner.toLowerCase() !== "sponsors")
            dbPages.get(k)!.push({ kind: "repo", title: gh.repo ? `${gh.owner}/${gh.repo}` : gh.owner, url: gh.repo ? `https://github.com/${gh.owner}/${gh.repo}` : `https://github.com/${gh.owner}`, photo: null });
        }
      }
    } finally {
      p.close();
    }
  }

  const headline = new Map<string, string>();
  for (const r of csv(LINKEDIN)) {
    const id = r["Slack user ID"];
    if (!aliases.has(id)) continue;
    const h = (r["Headline / current work"] ?? "").replace(/\s*\(per [^)]*\)\s*$/, "").trim();
    if (r["LinkedIn match"] === "Confirmed" && h) headline.set(id, h);
  }

  const order = ["linkedin", "github", "web", "devpost", "x", "substack", "medium", "youtube", "instagram", "threads", "gravatar"];
  const rank = (k: string) => (k === "post" ? 98 : order.indexOf(k) < 0 ? 97 : order.indexOf(k));

  const all: Entry[] = rows.map((r) => {
    const names = [...aliases.get(r.id)!];
    const known = dbFacts.get(r.id) ?? [];
    const facts: Fact[] = (JSON.parse(r.facts || "[]") as string[]).map((text) => {
      const lower = text.trim().toLowerCase();
      const words = new Set(tokens(text));
      let best = known.find((f) => f.fact.trim().toLowerCase() === lower);
      if (!best) {
        let score = 0.5; // a scrubbed fact still shares most of its words with the original
        for (const f of known) { const s = similar(words, f.words); if (s >= score) { score = s; best = f; } }
      }
      return { text, source: best?.source ?? null, match: best?.match === "confirmed" ? "confirmed" : "likely" };
    });
    const seen = new Set<string>();
    let linked = 0;
    const pages = (dbPages.get(r.id) ?? [])
      .sort((a, b) => rank(a.kind) - rank(b.kind))
      .filter((p) => !seen.has(p.url.toLowerCase().replace(/\/+$/, "")) && seen.add(p.url.toLowerCase().replace(/\/+$/, "")))
      .filter((p) => p.kind !== "repo" || ++linked <= 4);
    const person: Person = {
      id: r.id, name: r.name, role: r.role ?? "", photo: faced.has(r.id) ? `/api/greeter/face?id=${encodeURIComponent(r.id)}` : null,
      headline: headline.get(r.id) ?? null, facts, pages, images: images(pages),
    };
    const texts = [...facts.map((f) => f.text), person.headline ?? "", person.role].filter(Boolean);
    const feats = new Map<string, Feature>();
    const own = squash(r.name);
    const add = (f: Feature) => { if (!feats.has(f.key) && !f.key.endsWith(":" + own)) feats.set(f.key, f); };
    facts.forEach((f) => features(f.text).forEach(add));
    if (person.headline) features(person.headline, true).forEach(add);
    const org = person.role.split(",").slice(1).join(",").trim(); // "Participant, Western University"
    if (org) features(org, true).forEach(add);
    return { person, names, words: new Set(texts.flatMap(tokens).concat(tokens(r.name))), texts, feats };
  });

  const byName = new Map<string, Entry>();
  const repeated = new Set<string>();
  for (const e of all) for (const n of e.names) {
    if (byName.has(n)) repeated.add(n);
    else byName.set(n, e);
  }
  for (const name of repeated) byName.delete(name);
  // a shared capitalized phrase that is someone's name is a person they both know
  const nameKeys = new Set(all.map((e) => squash(e.person.name)));
  const df = new Map<string, number>();
  for (const e of all) {
    for (const [k, f] of [...e.feats]) {
      const bare = k.slice(k.indexOf(":") + 1);
      if ((f.kind === "topic" || f.kind === "org") && nameKeys.has(bare) && f.label.includes(" ")) {
        e.feats.delete(k);
        const p: Feature = { key: "person:" + bare, kind: "person", label: f.label };
        e.feats.set(p.key, p);
      }
    }
    for (const k of e.feats.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  }
  store = { key, all, byId: new Map(all.map((e) => [e.person.id, e])), byName, df };
  return store;
}

// ---------- images ----------

function linksOf(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Site logos and placeholders, not them.
const GENERIC_IMAGE = /devpost_social_icon|default_profile|gravatar\.com\/avatar\/[0-9a-f]+\?.*d=(mp|identicon|blank)|static\.licdn\.com\/aero|opengraph\.githubassets\.com/i;
// Sharpest faces first: X keeps the original upload, GitHub scales on request, LinkedIn's is 200 px.
const IMAGE_RANK: Record<string, number> = { x: 0, github: 1, linkedin: 2, gravatar: 3 };

/** The largest copy a CDN will give of the same picture. */
function sharpen(url: string): string {
  if (/pbs\.twimg\.com\/profile_images\//.test(url)) return url.replace(/_(normal|bigger|mini|\d+x\d+)(\.\w+)$/, "$2");
  if (/avatars\.githubusercontent\.com\//.test(url)) return url.replace(/([?&])s=\d+&?/, "$1").replace(/[?&]$/, "") + (url.includes("?") ? "&" : "?") + "s=640";
  if (/gravatar\.com\/avatar\//.test(url)) return url.replace(/([?&])s=\d+/, "$1s=640");
  return url;
}

function images(pages: Page[]): string[] {
  const seen = new Set<string>();
  return pages
    .filter((p) => p.photo && /^https?:\/\//.test(p.photo) && !GENERIC_IMAGE.test(p.photo))
    .map((p, i) => ({ url: sharpen(p.photo!), rank: (IMAGE_RANK[p.kind] ?? 10) * 100 + i }))
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.url)
    .filter((u) => !seen.has(u) && seen.add(u))
    .slice(0, 8);
}

// ---------- repositories, live from GitHub ----------

export type Repo = {
  owner: string; name: string; url: string; description: string | null; stars: number; language: string | null;
  pushedAt: string | null;
  /** Commits a week, the last 12 weeks, oldest first. */
  weeks: number[];
  /** Commits a week, the last 52 weeks, oldest first (the same series, longer). */
  year: number[];
  /** The picture that shows it best: its own social image, else the first README image, else its site's. */
  image: string | null;
  /** "readme" images are diagrams and screenshots (show whole); "social" ones are made to be cropped. */
  imageKind: "social" | "readme" | null;
  homepage: string | null;
};

const RESERVED = new Set("about orgs topics features marketplace explore settings login join pricing enterprise collections trending apps sponsors notifications search site users".split(" "));

/** owner and repo from any GitHub URL (or "owner/repo"). */
export function github(raw: string): { owner: string; repo: string | null } | null {
  const t = raw.trim();
  const m = t.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+)(?:\/([A-Za-z0-9._-]+))?/i) ?? t.match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/);
  if (!m || RESERVED.has(m[1].toLowerCase())) return null;
  const repo = m[2]?.replace(/\.git$/, "") || null;
  return { owner: m[1], repo: repo && !/^(repositories|followers|following|stars)$/.test(repo) ? repo : null };
}

type GhRepo = {
  name: string; owner: { login: string }; html_url: string; description: string | null; stargazers_count: number;
  language: string | null; pushed_at: string | null; homepage: string | null; fork: boolean; default_branch: string;
};

async function gh<T>(path: string): Promise<{ status: number; body: T | null }> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "hack-western-greeter", "x-github-api-version": "2022-11-28" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch("https://api.github.com" + path, { headers, signal: AbortSignal.timeout(6000) });
  return { status: r.status, body: r.status === 200 ? ((await r.json()) as T) : null };
}

async function page(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "user-agent": "hack-western-greeter" }, signal: AbortSignal.timeout(5000), redirect: "follow" });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}

const meta = (html: string, prop: string) =>
  html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1] ??
  html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, "i"))?.[1] ??
  null;

const BADGE = /badge|shields\.io|badgen|codecov|travis-ci|circleci|actions\/workflows|star-history|img\.youtube|vercel\.com\/button|deploy-button|contrib\.rocks/i;

/** The first real picture in the README: a diagram, screenshot or photo, never a badge. */
async function readmeImage(owner: string, repo: string, branch: string): Promise<string | null> {
  const base = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/`;
  const md = (await page(base + "README.md")) ?? (await page(base + "readme.md"));
  if (!md) return null;
  const found = [...md.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<img[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1] ?? m[2]);
  for (const src of found) {
    if (!src || BADGE.test(src)) continue;
    if (/^https?:\/\//.test(src)) return src.replace(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\//, "https://raw.githubusercontent.com/$1/$2/");
    if (src.startsWith("data:")) continue;
    return new URL(src.replace(/^\.?\//, ""), base).toString();
  }
  return null;
}

async function socialImage(url: string): Promise<string | null> {
  const html = await page(url);
  const img = html && meta(html, "og:image");
  if (!img || GENERIC_IMAGE.test(img)) return null; // GitHub's own generated card says nothing a name doesn't
  try {
    return new URL(img, url).toString();
  } catch {
    return null;
  }
}

async function participation(owner: string, repo: string): Promise<number[]> {
  for (let i = 0; i < 2; i++) {
    const r = await gh<{ all: number[] }>(`/repos/${owner}/${repo}/stats/participation`);
    if (r.body?.all) return r.body.all;
    if (r.status !== 202) return []; // 202: GitHub is counting; asked again once
    await new Promise((done) => setTimeout(done, 1500));
  }
  return [];
}

async function fetchRepo(raw: string): Promise<Repo | null> {
  const at = github(raw);
  if (!at) return null;
  let info: GhRepo | null = null;
  if (at.repo) info = (await gh<GhRepo>(`/repos/${at.owner}/${at.repo}`)).body;
  else {
    // a person or an org: the repo of theirs people starred most
    const list = (await gh<GhRepo[]>(`/users/${at.owner}/repos?per_page=100&type=owner&sort=pushed`)).body ?? [];
    info = list.filter((r) => !r.fork).sort((a, b) => b.stargazers_count - a.stargazers_count)[0] ?? null;
  }
  if (!info) return null;
  const owner = info.owner.login, name = info.name;
  const homepage = info.homepage && /^https?:\/\//.test(info.homepage) ? info.homepage : null;
  const [year, social, readme, site] = await Promise.all([
    participation(owner, name),
    socialImage(info.html_url),
    readmeImage(owner, name, info.default_branch || "HEAD"),
    homepage ? socialImage(homepage) : Promise.resolve(null),
  ]);
  const image = social ?? readme ?? site;
  return {
    owner, name, url: info.html_url, description: info.description, stars: info.stargazers_count, language: info.language,
    pushedAt: info.pushed_at, weeks: year.slice(-12), year, image, imageKind: social || (!readme && site) ? "social" : readme ? "readme" : null,
    homepage,
  };
}

// GitHub allows 60 calls an hour without a token: each repo is kept 30 minutes (a miss, 2).
const repos = new Map<string, { at: number; ttl: number; value: Promise<Repo | null> }>();

export function repo(url: string): Promise<Repo | null> {
  const key = url.trim().toLowerCase().replace(/\/+$/, "");
  const hit = repos.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const value = fetchRepo(url).catch(() => null);
  const entry = { at: Date.now(), ttl: 30 * 60_000, value };
  repos.set(key, entry);
  value.then((v) => { if (!v) entry.ttl = 2 * 60_000; });
  return value;
}

// ---------- the three questions ----------

export function resolve(s: Store, q: string): Entry | null {
  const t = q.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  const hit = s.byId.get(t) ?? s.byName.get(lower);
  if (hit) return hit;
  const part = s.all.filter((e) => e.names.some((n) => n.includes(lower)));
  return part.length === 1 ? part[0] : null;
}

export function search(s: Store, q: string): Found[] {
  let want = tokens(q);
  if (!want.length) want = q.toLowerCase().split(/[^a-z0-9+#]+/).filter(Boolean);
  if (!want.length) return [];
  const hits = (word: string, t: string) => t === word || (word.length >= 3 && t.startsWith(word)) || (word.length > 3 && word.endsWith("s") && t === word.slice(0, -1));
  const has = (e: Entry, word: string) => { for (const t of e.words) if (hits(word, t)) return true; return false; };
  const idf = new Map(want.map((w) => [w, Math.log((s.all.length + 1) / (1 + s.all.filter((e) => has(e, w)).length))]));
  const out: { e: Entry; n: number; score: number; why: string }[] = [];
  for (const e of s.all) {
    const matched = want.filter((w) => has(e, w));
    if (!matched.length) continue;
    let why = "", most = 0;
    for (const text of e.texts) {
      const ts = tokens(text);
      const n = matched.filter((w) => ts.some((t) => hits(w, t))).length;
      if (n > most) { most = n; why = text; }
    }
    if (!why) why = e.person.role || e.person.name; // matched on their name
    out.push({ e, n: matched.length, score: matched.reduce((a, w) => a + idf.get(w)!, 0), why });
  }
  return out
    .sort((a, b) => b.n - a.n || b.score - a.score)
    .slice(0, 8)
    .map(({ e, why }) => ({ id: e.person.id, name: e.person.name, role: e.person.role, photo: e.person.photo, why }));
}

const SAY: Record<Kind, string> = {
  school: "study at", org: "have been at", win: "won at", hackathon: "hacked at", person: "know", topic: "are into",
};

function listed(xs: string[]) {
  return xs.length < 3 ? xs.join(" and ") : xs.slice(0, -1).join(", ") + ", and " + xs[xs.length - 1];
}

function reason(shared: Feature[]): string {
  const groups = new Map<Kind, string[]>();
  for (const f of shared) {
    if (!groups.has(f.kind)) groups.set(f.kind, []);
    groups.get(f.kind)!.push(f.label);
  }
  return "Both " + listed([...groups].map(([k, labels]) => `${SAY[k]} ${listed(labels)}`)) + ".";
}

export function meet(s: Store, id: string): Meet[] {
  const me = s.byId.get(id) ?? resolve(s, id);
  if (!me) return [];
  const n = s.all.length;
  const weight = (f: Feature) => {
    const df = s.df.get(f.key) ?? 1;
    return df > n * 0.25 ? 0 : Math.log(n / df) * KIND_WEIGHT[f.kind]; // what nearly everyone shares says nothing
  };
  const scored: { e: Entry; score: number; shared: Feature[] }[] = [];
  for (const e of s.all) {
    if (e === me) continue;
    const shared: Feature[] = [];
    for (const [k, f] of me.feats) if (e.feats.has(k) && weight(f) > 0) shared.push(f);
    if (!shared.length) continue;
    shared.sort((a, b) => weight(b) - weight(a));
    scored.push({ e, score: shared.reduce((a, f) => a + weight(f), 0), shared });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ e, shared }) => ({
      id: e.person.id, name: e.person.name, role: e.person.role, photo: e.person.photo,
      reason: reason(shared.slice(0, 3)), shared: shared.slice(0, 6).map((f) => f.label),
    }));
}


// Everyone a request names by full name ("show me Evan Lin and Surya Sure"), longest names first, so a typed or
// spoken request reaches the screen writer with their real data whatever its wording.
export function mentioned(s: Store, text: string, limit = 3): Person[] {
  const hay = " " + text.toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
  const out: Person[] = [];
  const seen = new Set<string>();
  const entries = s.all
    .flatMap((e) => e.names.filter((n) => n.includes(" ") && n.length >= 5).map((n) => [n, e] as const))
    .sort((a, b) => b[0].length - a[0].length);
  for (const [n, e] of entries) {
    const key = " " + n.replace(/[^a-z0-9]+/g, " ").trim() + " ";
    if (s.byName.get(n) === e && !seen.has(e.person.id) && hay.includes(key)) {
      seen.add(e.person.id);
      out.push(e.person);
      if (out.length >= limit) break;
    }
  }
  return out;
}
