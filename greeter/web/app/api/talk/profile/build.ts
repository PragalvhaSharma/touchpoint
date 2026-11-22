// One person's profile for the live panel, in the order the panel shows it: who they are, school, roles, projects,
// wins, talking points, then the slower parts (their code on GitHub, live; people here they should meet).
// Read from the same files as ../data/store.ts: the research sheet (hack-western-13-people-profiles.csv) for the
// structured columns, greeter.db for the scrubbed talking points the voice works from, people.db for their pages.
// Logos come from public/logos/index.json first; an organisation it doesn't know is looked up live once
// (live-logos.ts, TinyFish Search) and cached, so every person's roles get real logos, not just the curated ones.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { PROFILES, csv, load, meet, repo, resolve, type Meet, type Repo } from "../data/store";
import { cachedLogo, resolveLogo } from "./live-logos";

export type Org = { name: string; logo: string | null };
export type RoleItem = { title: string; org: Org | null; when: string | null; detail: string | null };
export type Project = { name: string; about: string | null; event: string | null };
export type Win = { event: string | null; prize: string };
export type School = { name: string; program: string | null; year: string | null; logo: string | null; ivey: Org | null };

export type Identity = {
  id: string; name: string; first: string; role: string; photo: string | null;
  headline: string | null;
  /** The mark on the right of their card: Ivey for Ivey students, else their school's, else their company's. */
  mark: Org | null;
};
export type Sections = {
  identity: Identity;
  school: School | null;
  roles: { now: RoleItem[]; past: RoleItem[]; leading: RoleItem[] };
  projects: Project[];
  wins: { wins: Win[]; awards: string[] };
  points: string[];
};
export type Slow = { repos: Repo[]; meet: Meet[] };

// ---------- words ----------

const NOISE = [
  /\s*\((?:self-reported )?(?:on |per |via )?linkedin(?: [a-z ]+)?\)/gi,
  /\s*\(per [^)]*\)/gi,
  /\s*\(title not public\)/gi,
  /\s*\(you\)/gi,
  /\s*\[email omitted\]/gi,
  /\s*\(listed [^)]*\)/gi,
  // research notes, not facts about them
  /\s*\([^()]*\b(?:likely|not stated|per input|per resume|unverified|unconfirmed|inferred)\b[^()]*\)/gi,
  /,?\s+per (?:linkedin|devpost|github|input|resume|her|his|their|the (?:site|website|linkedin|profile|resume))\b[^,;()]*/gi,
  /[;,]\s*likely\b[^;()]*/gi,
  /[,;]?\s*(?:but )?unverified\b[^;,()]*$/gi,
  /[\w.+-]+@[\w-]+\.[\w.-]+/g,
];
export function tidy(s: string | null | undefined): string {
  let t = (s ?? "").trim();
  for (const re of NOISE) t = t.replace(re, "");
  return t.replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").replace(/,\s*;/g, ";").replace(/^[,;:\s]+|[,;:\s]+$/g, "").trim();
}
/** Split a cell on its separators, but never inside brackets ("Coinbase (Bay Area; since May)" stays whole). */
function parts(s: string | null | undefined, seps = "|"): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s ?? "") {
    if (ch === "(" || ch === "[") depth++;
    else if ((ch === ")" || ch === "]") && depth > 0) depth--;
    if (depth === 0 && seps.includes(ch)) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map(tidy).filter(Boolean);
}
/** Split on ", " outside brackets ("Modern Engineering (Delta, Tesla)" stays whole; "$100,000" too). */
function commas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(" || ch === "[") depth++;
    else if ((ch === ")" || ch === "]") && depth > 0) depth--;
    if (depth === 0 && ch === "," && s[i + 1] === " ") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}
const DATEISH = /\b(19|20)\d\d\b|\b(summer|winter|fall|spring|autumn|present|current|now|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b/i;
const escape = (s: string) => s.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");

// ---------- logos ----------

type LogoEntry = { slug: string; name: string; file: string; aliases?: string[]; kind?: string; shape?: string };
const LOGOS = path.join(process.cwd(), "public", "logos", "index.json");
let logos: { at: number; list: { a: string; re: RegExp; entry: LogoEntry }[] } | null = null;

function logoList() {
  const at = statSync(LOGOS, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  if (logos?.at === at) return logos.list;
  let raw: LogoEntry[] = [];
  try {
    if (existsSync(LOGOS)) raw = JSON.parse(readFileSync(LOGOS, "utf8")) as LogoEntry[];
  } catch {
    raw = [];
  }
  // longest alias first, so "ivey business school" wins over a shorter, looser name
  const list = raw
    .flatMap((entry) => [entry.name, ...(entry.aliases ?? [])].filter(Boolean).map((a) => ({ a: a.toLowerCase().trim(), entry })))
    .filter(({ a }) => a.length >= 2)
    .sort((x, y) => y.a.length - x.a.length)
    .map(({ a, entry }) => ({ a, re: new RegExp("(^|[^a-z0-9])" + escape(a) + "($|[^a-z0-9])", "i"), entry }));
  logos = { at, list };
  return list;
}

const fileOf = (e: LogoEntry) => (e.file.startsWith("/") ? e.file : "/logos/" + e.file.replace(/^.*\//, ""));

// A bare "Western" or "Waterloo" is that school only for its own clubs and teams ("Western AI", "Waterloo Aerial
// Robotics"). Other schools, boards, places and companies that share the word ("Western Michigan University",
// "Waterloo Region District School Board", "Western Digital") keep their own tile.
const BARE_SCHOOL = new Set(["western", "waterloo"]);
const NOT_THE_SCHOOL =
  /\b(university|universities|college|collegiate|institute|polytechnic|school|board|dsb|district|catholic|region|regional|canada|ontario|michigan|washington|colorado|governors|sydney|australia|digital|union|financial|alliance|energy|maple|bank|brewing|ventures|capital|insurance|inc|ltd|llc|corp)\b/i;

/** `square` asks for the school's crest instead of its wordmark, for the small tiles beside a role. */
export function logoFor(text: string | null | undefined, square = false): string | null {
  if (!text) return null;
  // The name has to lead ("RBC Capital Markets", not "OpenAI Student Collective at Western" or "... Stripe billing").
  const t = text.replace(/\s*[([][^)\]]*[)\]]/g, "").trim();
  const hit = logoList().find((l) => {
    const m = t.match(l.re);
    if (!m || m.index !== 0) return false;
    const rest = t.slice(m[0].length).trim();
    if (BARE_SCHOOL.has(l.a) && NOT_THE_SCHOOL.test(rest)) return false;
    // "Western University of Health Sciences" is a different school
    if (l.a === "western university" && /^of\b/i.test(rest)) return false;
    // a school's clubs wear the school's mark; a company's name on a student group or a role doesn't make it the company
    if (l.entry.kind === "school") return true;
    return rest.split(/\s+/).filter(Boolean).length <= 2 && !/\b(student|students|collective|club|campus|leader|participant|chapter|society|organi[sz]ing|team|ambassador|at)\b/i.test(rest);
  });
  if (!hit) return null;
  if (square && hit.entry.shape === "wide" && !hit.entry.slug.endsWith("-mark")) return logoBySlug(hit.entry.slug + "-mark") ?? fileOf(hit.entry);
  return fileOf(hit.entry);
}
function logoBySlug(slug: string): string | null {
  const hit = logoList().find((l) => l.entry.slug === slug);
  return hit ? fileOf(hit.entry) : null;
}

const org = (name: string | null | undefined): Org | null => {
  const n = tidy(name);
  return n ? { name: n, logo: logoFor(n, true) ?? cachedLogo(n) ?? null } : null;
};

// ---------- the sheet ----------

let sheet: { at: number; byId: Map<string, Record<string, string>> } | null = null;
function rows() {
  const at = statSync(PROFILES, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  if (sheet?.at === at) return sheet.byId;
  const byId = new Map<string, Record<string, string>>();
  for (const r of csv(PROFILES)) if (r["Slack user ID"]) byId.set(r["Slack user ID"], r);
  sheet = { at, byId };
  return byId;
}

const TITLE = /\b(intern|engineer|developer|founder|co-?founder|lead|manager|director|president|vp|analyst|assistant|researcher|scientist|designer|consultant|associate|fellow|organi[sz]er|coordinator|captain|chair|head|officer|advisor|tutor|instructor|coach|member|executive|specialist|representative|contributor|mentor|ambassador|cto|ceo|coo|pm|swe|sde|co-?op|volunteer)\b/i;
const short = (s: string | null, n = 96) => (s && s.length > n ? s.slice(0, n - 1).replace(/[\s,;:]+\S*$/, "") + "…" : s);

/** Pull one trailing "(...)" off s: a date goes to when, anything else to detail. */
function peel(s: string): { s: string; when: string | null; detail: string | null } {
  const tail = s.match(/\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/);
  if (!tail || tail.index === undefined || tail.index === 0) return { s, when: null, detail: null };
  const inner = tail[1].trim();
  const rest = s.slice(0, tail.index).trim();
  return DATEISH.test(inner) && inner.length <= 40 ? { s: rest, when: inner, detail: null } : { s: rest, when: null, detail: inner };
}

/**
 * One line of the sheet's roles, which come in many shapes:
 * "Software Engineering Intern, Travelers (Summer 2026)", "AI Engineer at IBM", "Autodesk - Full-Stack SWE Intern (Jan-May 2026), ...",
 * "CIBC (2025): worked on the mobile app", "Cloudflare (intern)", "Caterpillar". Org may be null; title may be "" when only the org is known.
 */
function role(raw: string): RoleItem | null {
  let s = tidy(raw);
  if (!s || /^unverified\b/i.test(s)) return null;
  let detail: string | null = null;
  let when: string | null = null;
  let where: string | null = null;
  // "head: detail" (a colon outside any brackets, near the start)
  const colon = s.search(/:\s/);
  if (colon > 0 && colon <= 90 && (s.slice(0, colon).match(/\(/g)?.length ?? 0) === (s.slice(0, colon).match(/\)/g)?.length ?? 0)) {
    detail = s.slice(colon + 1).trim();
    s = s.slice(0, colon).trim();
  }
  // "Autodesk - Full-Stack SWE Intern ...": the organisation first
  const lead = s.match(/^([^,():]{2,40}?) [-\u2013] (.+)$/);
  if (lead && !TITLE.test(lead[1]) && TITLE.test(lead[2].split(/[,(]/)[0])) {
    where = lead[1];
    s = lead[2];
  }
  // "... (May 2026-present) - what they did"
  const after = s.match(/^(.*\))\s+[-\u2013]\s+(.+)$/);
  if (after) {
    s = after[1];
    detail = detail ?? after[2];
  }
  // the first dated "(...)" is when; what follows it is the organisation or more detail
  const paren = [...s.matchAll(/\s*\(([^()]{2,40})\)/g)].find((m) => DATEISH.test(m[1]));
  if (paren && paren.index !== undefined && paren.index > 0) {
    when = paren[1].trim();
    const rest = s.slice(paren.index + paren[0].length).replace(/^[\s,;]+/, "").trim();
    s = s.slice(0, paren.index).trim();
    if (rest) {
      if (!where && !s.includes(", ") && !TITLE.test(rest)) where = rest;
      else detail = detail ?? rest;
    }
  }
  const p = peel(s);
  s = p.s;
  when = when ?? p.when;
  if (p.detail) detail = detail ?? p.detail;
  // a trailing ", May-Aug 2026" is a date too
  const dated = s.match(/,\s*([^,]{3,30})$/);
  if (!when && dated && dated.index !== undefined && DATEISH.test(dated[1]) && !TITLE.test(dated[1])) {
    when = dated[1].trim();
    s = s.slice(0, dated.index).trim();
  }
  let title = s;
  const segs = commas(s);
  const at = s.match(/^(.{3,70}?) at (.{2,80})$/i);
  const dash = s.match(/^(.{2,60}?) [-\u2013] (.{2,80})$/);
  if (where) {
    if (segs.length > 1) {
      title = segs[0];
      detail = detail ?? segs.slice(1).join(", ");
    }
  } else if (segs.length > 1) {
    // "Incoming SWE Intern, Platform Engineering, Wealthsimple": the company is the part we have a logo for
    title = segs[0];
    const more = segs.slice(1);
    const k = Math.max(0, more.findIndex((x) => logoFor(x)));
    where = more[k];
    const rest = more.filter((_, i) => i !== k);
    if (rest.length) detail = detail ?? rest.join(", ");
  } else if (at) {
    title = at[1];
    where = at[2];
  } else if (dash) {
    [title, where] = TITLE.test(dash[1]) && !TITLE.test(dash[2]) ? [dash[1], dash[2]] : [dash[2], dash[1]];
  } else if (!TITLE.test(s) && s.length <= 40) {
    // just an organisation ("Caterpillar", "Cloudflare (intern)")
    title = detail && detail.length <= 30 && TITLE.test(detail) ? detail : "";
    if (title) detail = null;
    where = s;
  }
  title = tidy(title);
  if (/^per\b/i.test(title)) title = "";
  if (title.length > 80) return null; // prose, not a role
  return { title: title ? title[0].toUpperCase() + title.slice(1) : "", org: org(where), when, detail: short(detail) };
}

function project(raw: string): Project | null {
  const s = tidy(raw);
  if (!s) return null;
  const colon = s.indexOf(": ");
  const named = colon > 0 && colon <= 60;
  let name = named ? s.slice(0, colon) : s.length <= 48 ? s : s.slice(0, 46).trim() + "…";
  let about = named ? s.slice(colon + 2) : s.length > 48 ? s : null;
  let event: string | null = null;
  const m = (about ?? name).match(/\(([^()]*(?:hack|thon|devpost|won|winner|mlh)[^()]*)\)\s*$/i);
  if (m && m.index !== undefined) {
    event = m[1];
    if (about) about = about.slice(0, m.index).trim();
    else name = name.slice(0, m.index).trim();
  }
  return { name, about: about ? about.replace(/[.;]\s*$/, "") : null, event };
}

function win(raw: string): Win | null {
  const s = tidy(raw);
  if (!s) return null;
  const colon = s.indexOf(": ");
  if (!(colon > 0 && colon < 50)) return { event: null, prize: s };
  const event = s.slice(0, colon);
  return { event: /^unverified$/i.test(event) ? null : event, prize: s.slice(colon + 2) };
}

const SCHOOLS: [RegExp, string][] = [
  [/western university|university of western ontario|\bwestern\b|\buwo\b|\bivey\b/i, "Western University"],
  [/university of waterloo|\bwaterloo\b|uwaterloo/i, "University of Waterloo"],
  [/university of toronto|\buoft\b|u of t\b/i, "University of Toronto"],
  [/mcmaster/i, "McMaster University"],
  [/queen'?s university|\bqueen'?s\b/i, "Queen's University"],
  [/toronto metropolitan|\btmu\b|ryerson/i, "Toronto Metropolitan University"],
  [/york university/i, "York University"],
  [/wilfrid laurier|\blaurier\b/i, "Wilfrid Laurier University"],
  [/university of guelph|\bguelph\b/i, "University of Guelph"],
  [/university of ottawa|\buottawa\b/i, "University of Ottawa"],
  [/carleton/i, "Carleton University"],
  [/fanshawe/i, "Fanshawe College"],
];

function school(raw: string, grad: string): School | null {
  // where they were before isn't where they are ("Waterloo CS (previously Western University)")
  const s = tidy(tidy(raw).replace(/\s*\(\s*(?:previously|formerly|transferred from)\b[^()]*\)|[;,]?\s*\b(?:previously|formerly|transferred from)\b[^;,()]*/gi, ""));
  if (!s) return null;
  const ivey = /\bivey\b|\bhba\b/i.test(s);
  // the school named first in the line, else the line's own lead if it names an institution
  const found = SCHOOLS.map(([re, n]) => ({ n, i: s.search(re) }))
    .filter((x) => x.i >= 0)
    .sort((a, b) => a.i - b.i)[0]?.n;
  const lead = s.split(/,| \(| - /)[0].trim();
  const name = found ?? (/universit|college|institute|school|polytechnic|academy/i.test(lead) ? lead : "");
  // the program is whatever the line says besides the school's name and the years
  let program = s
    .replace(/\b(at|from)\s+(the\s+)?(western university|university of western ontario)\b/gi, "")
    .replace(/\bwestern university\b|\buniversity of western ontario\b/gi, "")
    .replace(name ? new RegExp(escape(name), "gi") : /$^/, "")
    .replace(/\s*\(([^)]*\b(19|20)\d\d[^)]*)\)/g, "")
    .replace(/\s{2,}/g, " ");
  program = tidy(program.replace(/^[,\s-]+|[,\s-]+$/g, "").replace(/\s*,\s*,/g, ","));
  if (program.length > 110) program = program.slice(0, 108).trim() + "…";
  if (!name && !program) return null;
  const year = (grad.match(/\b20\d\d\b/) ?? [null])[0];
  const aeo = /\baeo\b|advanced entry/i.test(s);
  return {
    name,
    program: program || null,
    year,
    logo: (name === "Western University" ? logoBySlug("western") : null) ?? logoFor(name),
    ivey: ivey ? { name: aeo && !/\bhba\b/i.test(s) ? "Ivey AEO" : "Ivey HBA", logo: logoBySlug("ivey") ?? logoFor("ivey business school") } : null,
  };
}

const GENERIC_NOW = /hack western|participant|organi[sz]er|volunteer|mentor\b|linkedin lists|current employer|^student$|^(engineering|computer science|business|science) student|\bstudent \(/i;

/** Everything except the slow parts, at once (all from disk). Null when we don't know this id. */
export function sections(id: string): Sections | null {
  const s = load();
  const entry = s.byId.get(id) ?? resolve(s, id);
  if (!entry) return null;
  const p = entry.person;
  const r = rows().get(p.id) ?? {};
  const name = tidy(p.name);

  const sch = school(r["School / program"] ?? "", r["Grad year"] ?? "");
  const now = parts(r["Current role"], ";|")
    .filter((x) => !GENERIC_NOW.test(x))
    .map(role)
    .filter((x): x is RoleItem => !!x && !!x.title);
  if (!now.length && p.headline && !GENERIC_NOW.test(p.headline) && !/universit|college|school|student|\bhba\b/i.test(p.headline)) {
    // the LinkedIn headline is often just where they work now ("RBC")
    const h = tidy(p.headline);
    const comma = h.indexOf(", ");
    now.push(comma > 0 ? { title: h.slice(0, comma), org: org(h.slice(comma + 2)), when: null, detail: null } : { title: "Currently", org: org(h), when: null, detail: null });
  }
  const past = parts(r["Past roles"]).map(role).filter((x): x is RoleItem => !!x && !!(x.title || x.org)).slice(0, 5);
  const leading = parts(r["Clubs / leadership"]).map(role).filter((x): x is RoleItem => !!x && !!(x.title || x.org)).slice(0, 3);
  const projects = parts(r["Projects"]).map(project).filter((x): x is Project => !!x).slice(0, 4);
  const wins = parts(r["Hackathon wins"]).map(win).filter((x): x is Win => !!x).slice(0, 3);
  const awards = parts(r["Awards"]).filter((a) => a.length <= 140 && !/^unverified\b/i.test(a)).slice(0, 3);
  const points = p.facts
    .filter((f) => !/^about:|\[email omitted\]|^works with |^studies at |^volunteers:/i.test(f.text))
    .sort((a, b) => (a.match === b.match ? 0 : a.match === "confirmed" ? -1 : 1))
    .map((f) => tidy(f.text))
    .filter(Boolean)
    .slice(0, 5);

  const lead = now.find((x) => x.org) ?? now[0];
  const headline = lead
    ? lead.title === "Currently" ? lead.org?.name ?? null : [lead.title, lead.org?.name].filter(Boolean).join(", ")
    : sch ? [sch.program, sch.name].filter(Boolean).join(", ") : null;
  const mark: Org | null = sch?.ivey?.logo ? sch.ivey : sch?.logo ? { name: sch.name, logo: sch.logo } : lead?.org?.logo ? lead.org : null;

  return {
    identity: { id: p.id, name, first: name.split(/\s+/)[0] ?? name, role: tidy(p.role.split(",")[0]) || "Hacker", photo: p.photo, headline, mark },
    school: sch,
    roles: { now, past, leading },
    projects,
    wins: { wins, awards },
    points,
  };
}

/** The parts that take a moment: their code on GitHub (live, 1.5 s at most) and who here they should meet. */
export async function slow(id: string): Promise<Slow> {
  const s = load();
  const entry = s.byId.get(id) ?? resolve(s, id);
  if (!entry) return { repos: [], meet: [] };
  const urls = [...new Set(entry.person.pages.filter((p) => p.kind === "repo" || /github\.com\/[^/]+\/[^/]+/.test(p.url)).map((p) => p.url))].slice(0, 2);
  const timeout = new Promise<null>((done) => setTimeout(() => done(null), 1500));
  const found = await Promise.all(urls.map((u) => Promise.race([repo(u), timeout])));
  return { repos: found.filter((x): x is Repo => !!x), meet: meet(s, entry.person.id).slice(0, 3) };
}


/**
 * Fills in logos for this person's organisations that public/logos doesn't have, looked up live (at most `ms`;
 * lookups still running keep going in the background and are cached for next time). True when anything changed.
 */
export async function liveLogos(s: Sections, ms: number): Promise<boolean> {
  // a role or a team that landed in the org column ("Web developer", "Dev team") isn't something with a logo
  const orgs = [...s.roles.now, ...s.roles.past, ...s.roles.leading]
    .map((r) => r.org)
    .filter((o): o is Org => !!o && !o.logo && !TITLE.test(o.name) && !/\b(team|careers|department|committee|council|division)\b/i.test(o.name));
  if (!orgs.length) return false;
  const stop = new Promise<null>((done) => setTimeout(() => done(null), ms));
  const found = await Promise.all(orgs.map((o) => Promise.race([resolveLogo(o.name), stop])));
  let changed = false;
  orgs.forEach((o, i) => {
    if (found[i]) {
      o.logo = found[i];
      changed = true;
    }
  });
  if (changed && !s.identity.mark) {
    const lead = s.roles.now.find((r) => r.org?.logo)?.org;
    if (lead) s.identity.mark = lead;
  }
  return changed;
}

