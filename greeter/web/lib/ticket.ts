import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// A QR ticket: proof that whoever opens /confirm?pid=...&t=... read the code off the booth screen in the last
// 20 minutes. The booth signs the person id and an expiry, and the phone hands the ticket back with its answer,
// so nobody can confirm someone else (and take their follow-up) by guessing their id.
// The key is TICKET_SECRET, else AUTH0_SECRET, else a random one kept in .data/ticket-secret (gitignored), so
// the QR works without Auth0 too and a restart doesn't void the codes on screen.
const TTL_MS = 20 * 60 * 1000;
const SECRET_FILE = path.join(process.cwd(), ".data", "ticket-secret");
const cache = globalThis as unknown as { __ticketSecret?: string };

function secret(): string {
  const set = process.env.TICKET_SECRET?.trim() || process.env.AUTH0_SECRET?.trim();
  if (set) return set;
  if (cache.__ticketSecret) return cache.__ticketSecret;
  let s = "";
  try {
    s = readFileSync(/*turbopackIgnore: true*/ SECRET_FILE, "utf8").trim();
  } catch {}
  if (s.length < 32) {
    s = randomBytes(32).toString("base64url");
    try {
      mkdirSync(/*turbopackIgnore: true*/ path.dirname(SECRET_FILE), { recursive: true });
      writeFileSync(/*turbopackIgnore: true*/ SECRET_FILE, s, { mode: 0o600 });
    } catch {}
  }
  return (cache.__ticketSecret = s);
}

const sign = (pid: string, exp: number) => createHmac("sha256", secret()).update(`${pid}.${exp}`).digest("base64url");

export function ticketFor(pid: string): string {
  const exp = Date.now() + TTL_MS;
  return `${exp.toString(36)}.${sign(pid, exp)}`;
}

export function validTicket(pid: string, t: unknown): boolean {
  if (typeof t !== "string" || !pid) return false;
  const [e, mac] = t.split(".");
  const exp = parseInt(e ?? "", 36);
  if (!mac || !Number.isFinite(exp) || exp < Date.now()) return false;
  const want = Buffer.from(sign(pid, exp));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * Whether a request came from outside the booth: through the cloudflared tunnel (which adds Cf-Connecting-Ip)
 * or on any host that isn't this laptop or the local network. Those only get the phone's confirm flow.
 */
export function fromOutside(headers: Headers): boolean {
  if (headers.get("cf-connecting-ip")) return true;
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0].trim().toLowerCase();
  const h = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return !(
    h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".local") ||
    /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}
