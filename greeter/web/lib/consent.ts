import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { auth0Enabled } from "./auth0";

/** Whether a follow-up waits for the visitor to approve an email on their phone. On whenever the booth shows the QR
 * or Auth0 is set up; FOLLOWUP_REQUIRE_CONSENT=0 sends to the Slack directory email without asking, =1 always waits. */
export function consentRequired(): boolean {
  const v = process.env.FOLLOWUP_REQUIRE_CONSENT?.trim();
  if (v === "1") return true;
  if (v === "0") return false;
  return auth0Enabled() || process.env.CONFIRM_QR !== "0";
}

// Who confirmed "yes, send my follow-up" on their own phone, and the email they chose for it: their Auth0
// account's, the directory one, or one they typed. Kept in greeter/web/.data/consent.json (gitignored).
// A follow-up pipeline only needs confirmedContact(personId).

export type Consent = {
  status: "confirmed" | "declined";
  email: string | null;
  emailVerified: boolean; // true only when email is the Auth0 account's verified address
  name: string | null;
  sub: string; // the Auth0 user id, or QR_SUB when the booth runs without Auth0
  at: string; // ISO time of the decision
};

/** Who decided when there is no Auth0: whoever holds a fresh QR ticket from the booth screen. */
export const QR_SUB = "booth-qr";

/** A plain, sendable address: one @, a dotted domain, no spaces or angle brackets, at most 254 characters. */
export function isEmail(s: unknown): s is string {
  return typeof s === "string" && s.length <= 254 && /^[^\s@<>(),;:"\[\]]+@[^\s@<>(),;:"\[\]]+\.[a-z]{2,}$/i.test(s);
}

const FILE = process.env.CONSENT_FILE ?? path.join(process.cwd(), ".data", "consent.json");

function readAll(): Record<string, Consent> {
  try {
    return JSON.parse(readFileSync(/*turbopackIgnore: true*/ FILE, "utf8")) as Record<string, Consent>;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Consent>) {
  mkdirSync(/*turbopackIgnore: true*/ path.dirname(FILE), { recursive: true });
  const tmp = FILE + "." + process.pid + ".tmp";
  writeFileSync(/*turbopackIgnore: true*/ tmp, JSON.stringify(all, null, 2));
  renameSync(/*turbopackIgnore: true*/ tmp, FILE);
}

/**
 * Saves a decision, or returns null when it may not replace the one on file:
 * - a "No thanks" is final, except for the same signed-in Auth0 account changing its mind;
 * - a different Auth0 account can't replace a confirmation;
 * - without Auth0 anyone holding the QR from the TV could be a bystander, so a QR confirmation can only be
 *   turned into a "No thanks" (or re-confirmed with the same address), never pointed at a new email.
 * A passkey sign-in may replace a QR-only confirmation.
 */
export function record(personId: string, c: Omit<Consent, "at">): Consent | null {
  const all = readAll();
  const prev = all[personId];
  if (prev) {
    if (prev.status === "declined" && (prev.sub === QR_SUB || prev.sub !== c.sub)) return null;
    if (prev.status === "confirmed" && prev.sub !== QR_SUB && prev.sub !== c.sub) return null;
    const qrChange = prev.status === "confirmed" && prev.sub === QR_SUB && c.sub === QR_SUB;
    if (qrChange && c.status === "confirmed" && (c.email ?? "").toLowerCase() !== (prev.email ?? "").toLowerCase()) return null;
  }
  const saved = { ...c, at: new Date().toISOString() };
  all[personId] = saved;
  writeAll(all);
  return saved;
}

export function consentFor(personId: string): Consent | null {
  return readAll()[personId] ?? null;
}

/**
 * Who a follow-up may go to: the email from the Auth0 account that confirmed "yes, that's me", or null.
 * requireVerified also demands Auth0's email_verified (a brand new passkey signup is unverified until the
 * visitor clicks Auth0's verification email).
 */
export function confirmedContact(
  personId: string,
  opts: { requireVerified?: boolean } = {},
): { email: string; emailVerified: boolean; name: string | null; confirmedAt: string } | null {
  const c = consentFor(personId);
  if (!c || c.status !== "confirmed" || !isEmail(c.email)) return null;
  if (opts.requireVerified && !c.emailVerified) return null;
  return { email: c.email, emailVerified: c.emailVerified, name: c.name, confirmedAt: c.at };
}

// Visitors whose follow-up was skipped because there was no address yet (no consent, or no email on file).
// If they confirm on their phone later, the booth starts their follow-up then (GET /api/confirm?ready=1).
// Process memory on globalThis, so every route sees the same list; it only has to outlive a booth visit.
const WAIT_MS = 2 * 60 * 60_000;
const store = globalThis as unknown as { __awaitingConsent?: Map<string, number> };
const awaiting = () => (store.__awaitingConsent ??= new Map());

export function awaitConsent(personId: string) {
  awaiting().set(personId, Date.now());
}

export function stopAwaiting(personId: string) {
  awaiting().delete(personId);
}

/** Skipped visitors who have since confirmed an address, ready for their follow-up. */
export function readyAfterConsent(): string[] {
  const ready: string[] = [];
  for (const [id, at] of awaiting()) {
    if (Date.now() - at > WAIT_MS) awaiting().delete(id);
    else if (consentFor(id)?.status === "declined") awaiting().delete(id);
    else if (confirmedContact(id)) ready.push(id);
  }
  return ready;
}

/** m•••@gmail.com: enough for the booth screen to show who it goes to, without putting the address on a TV. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  return email[0] + "•••" + email.slice(at);
}

