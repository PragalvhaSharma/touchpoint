// Logos for organisations public/logos doesn't know, found live: TinyFish Search finds the organisation's own site,
// we keep it only when the domain matches the name, then take a sharp icon for that domain. Each answer (found or
// not) is cached under .data/logos (gitignored), so a name is looked up once and the booth never waits on it twice.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { search, tinyfishKey } from "@/lib/followup/tinyfish";

const DIR = process.env.LOGO_CACHE ?? path.join(process.cwd(), ".data", "logos");
const INDEX = path.join(DIR, "index.json");
type Hit = { domain: string | null; file: string | null; at: number };
let index: Record<string, Hit> | null = null;

const keyOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function idx(): Record<string, Hit> {
  if (index) return index;
  try {
    index = existsSync(INDEX) ? (JSON.parse(readFileSync(INDEX, "utf8")) as Record<string, Hit>) : {};
  } catch {
    index = {};
  }
  return index;
}
function save() {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(INDEX, JSON.stringify(idx(), null, 1));
  } catch {}
}

/** The served path of a cached logo, null when we looked and found none, undefined when we haven't looked yet. */
export function cachedLogo(name: string): string | null | undefined {
  const h = idx()[keyOf(name)];
  if (!h) return undefined;
  // an answer saved under older, looser matching rules doesn't count
  if (h.domain && !domainFits(name, h.domain)) return undefined;
  // a miss is retried after a day, in case search had a bad moment
  if (!h.file) return Date.now() - h.at > 86_400_000 ? undefined : null;
  return "/api/logo?f=" + h.file;
}

export function logoFile(f: string): { body: Buffer; type: string } | null {
  if (!/^[a-f0-9]{16}\.(png|ico|svg|jpg|webp)$/.test(f)) return null;
  const p = path.join(DIR, f);
  if (!existsSync(p)) return null;
  const ext = f.split(".").pop()!;
  const type = { png: "image/png", ico: "image/x-icon", svg: "image/svg+xml", jpg: "image/jpeg", webp: "image/webp" }[ext]!;
  return { body: readFileSync(p), type };
}

// Sites that are about an organisation rather than its own site.
const NOT_OWN =
  /(^|\.)(linkedin|wikipedia|facebook|instagram|twitter|x|youtube|tiktok|crunchbase|github|medium|glassdoor|indeed|devpost|reddit|pitchbook|zoominfo|bloomberg|google|apple|amazon|yelp|eventbrite|lu\.ma|notion|substack|wellfound|ycombinator|rocketreach|dnb|craft|owler|apollo|cbinsights|tracxn|levels|builtin|ratemyprofessors|wix|squarespace|linktr|discord)\.[a-z.]+$/i;
const STOP = new Set(["the", "and", "of", "for", "inc", "ltd", "llc", "corp", "co", "company", "group", "club", "society", "team", "labs", "lab", "ai", "tech", "technologies", "canada", "inc."]);

/** Does this domain plausibly belong to this name? "foundersnetwork.ca" for "Western Founders Network", yes. */
export function domainFits(name: string, host: string): boolean {
  // only the registrable label counts ("careers.acme.com" is acme), and only on the TLDs Canadian students' orgs use
  const labels = host.replace(/^www\./, "").split(".");
  if (!TLDS.has(labels[labels.length - 1])) return false;
  const base = (labels[labels.length - 2] ?? "").replace(/[^a-z0-9]/g, "");
  const words = keyOf(name).split(" ").filter(Boolean);
  const compact = words.join("");
  if (base.length < 3 || compact.length < 3) return false;
  if (compact === base) return true;
  // on a subdomain ("news.westernu.ca") only an exact name match counts
  if (labels.length > 2) return false;
  // "foundersnetwork" for "Western Founders Network"; "nimblerx" for "NimbleRx Inc" (close, not just a shared word)
  if (base.length >= 5 && compact.includes(base) && base.length >= compact.length * 0.6) return true;
  if (compact.length >= 5 && base.startsWith(compact) && base.length - compact.length <= 4) return true;
  const strong = words.filter((w) => w.length >= 4 && !STOP.has(w));
  if (strong.length >= 2 && strong.every((w) => base.includes(w)) && base.length <= compact.length + 6) return true;
  const initials = words.filter((w) => !STOP.has(w) || words.length <= 2).map((w) => w[0]).join("");
  return initials.length >= 3 && base === initials;
}
const TLDS = new Set(["com", "ca", "org", "net", "io", "ai", "co", "app", "dev", "tech", "xyz", "gg", "so", "me", "edu", "inc", "studio", "health", "us", "info", "club"]);

const pngSize = (b: Buffer) => (b.length > 24 && b.readUInt32BE(0) === 0x89504e47 ? b.readUInt32BE(16) : 0);

async function grab(url: string): Promise<{ body: Buffer; ext: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { "user-agent": "Mozilla/5.0 Touchpoint" } });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length < 300) return null;
    if (/png/.test(type)) return pngSize(body) >= 48 ? { body, ext: "png" } : null;
    if (/svg/.test(type)) return { body, ext: "svg" };
    if (/jpe?g/.test(type)) return { body, ext: "jpg" };
    if (/webp/.test(type)) return { body, ext: "webp" };
    return null;
  } catch {
    return null;
  }
}

/** A sharp square icon for a domain: Google's favicon service at 256 px (only when it really has one), then the
 * site's own apple-touch-icon. Tiny or placeholder icons count as none, so the panel keeps its letter tile. */
async function iconFor(domain: string) {
  return (
    (await grab(`https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${domain}&size=256`)) ??
    (await grab(`https://${domain}/apple-touch-icon.png`))
  );
}

/** Words that are places, seasons or roles rather than organisations. */
const NOT_AN_ORG = /^(a |an |the )?(london|toronto|waterloo|ottawa|montreal|vancouver|canada|ontario|remote|online|autumn|summer|winter|spring|fall|speaker|self|freelance|independent|personal|various|unknown)\b|\b(ON|BC|QC|AB)$/i;

const inflight = new Map<string, Promise<string | null>>();
let running = 0;
const queue: (() => void)[] = [];
const slot = () => (running < 4 ? (running++, Promise.resolve()) : new Promise<void>((r) => queue.push(() => (running++, r()))));
const free = () => (running--, queue.shift()?.());

/** Look a name up (once; concurrent asks share the answer). Resolves to the served path, or null. */
export function resolveLogo(name: string): Promise<string | null> {
  const k = keyOf(name);
  const known = cachedLogo(name);
  if (known !== undefined) return Promise.resolve(known);
  // short acronyms ("CSSA", "WiCS") mean a different club at every school, so a web search can't tell which one
  const acronym = /^[A-Za-z]{2,5}$/.test(name.trim()) && /[A-Z].*[A-Z]/.test(name);
  if (!k || k.length < 3 || acronym || NOT_AN_ORG.test(name.trim()) || !/^[A-Z0-9]/.test(name.trim()) || !tinyfishKey()) return Promise.resolve(null);
  const had = inflight.get(k);
  if (had) return had;
  const job = (async () => {
    await slot();
    try {
      const hits = await search(`"${name}" official website`);
      let domain: string | null = null;
      for (const h of hits.slice(0, 8)) {
        let host = "";
        try {
          host = new URL(h.url).hostname.toLowerCase();
        } catch {
          continue;
        }
        if (NOT_OWN.test(host)) continue;
        // a one-word name ("Sheridan") also has to be what the result is titled, not just the domain
        const oneWord = !/\s/.test(name.trim());
        if (domainFits(name, host) && (!oneWord || h.title.toLowerCase().includes(name.trim().toLowerCase()))) {
          domain = host.replace(/^www\./, "");
          break;
        }
      }
      const icon = domain ? await iconFor(domain) : null;
      let file: string | null = null;
      if (icon) {
        file = createHash("sha1").update(k).digest("hex").slice(0, 16) + "." + icon.ext;
        mkdirSync(DIR, { recursive: true });
        writeFileSync(path.join(DIR, file), icon.body);
      }
      idx()[k] = { domain, file, at: Date.now() };
      save();
      return file ? "/api/logo?f=" + file : null;
    } catch {
      return null; // search down: don't cache, try again next time
    } finally {
      free();
      inflight.delete(k);
    }
  })();
  inflight.set(k, job);
  return job;
}

