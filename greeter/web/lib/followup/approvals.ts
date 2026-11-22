// The recruiter's inbox. The greeter talks with everyone at the booth; once someone leaves, the follow-up drafts
// their email and parks it here instead of sending it. The recruiter, signed in with Auth0 (on the booth screen
// or at /recruiter on their phone), taps Yes and it goes out from the booth's Gmail, or No and nothing is sent.
// Kept in greeter/web/.data/approvals.json (gitignored), so a restart keeps the queue.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { env } from "./env";

export type ApprovalStatus = "drafting" | "waiting" | "sending" | "sent" | "skipped" | "failed";
export type Approval = {
  personId: string;
  name: string;
  role: string;
  photo: string | null;
  company: string; // the sponsor they were matched to
  why?: string; // why that sponsor fits them
  summary?: string;
  to: string; // where it goes: the email they gave out loud, else the one on file ("" when neither)
  toSource: "said" | "file" | "none";
  subject: string;
  body: string;
  roles: { title: string; url: string }[];
  status: ApprovalStatus;
  error?: string;
  at: number; // when the follow-up for this visit started
  decidedBy?: string;
  decidedAt?: number;
};

const REPO = path.resolve(process.cwd(), "../..");
const FILE = process.env.APPROVALS_FILE ?? path.join(process.cwd(), ".data", "approvals.json");
const GWS_EMAIL = env("GWS_EMAIL_SCRIPT") ?? path.join(process.env.HOME ?? "", ".codex/skills/gws-email/scripts/gws_email.py");
// Who was emailed when, so a restart doesn't email someone twice (gitignored).
const SENT_FILE = process.env.FOLLOWUP_SENT_FILE ?? path.join(REPO, "greeter", "followup-sent.json");

/** The recruiter approves every email unless FOLLOWUP_APPROVAL=0 (then it sends straight away, as before). */
export const approvalOn = () => env("FOLLOWUP_APPROVAL") !== "0";

function readAll(): Record<string, Approval> {
  try {
    return JSON.parse(readFileSync(/*turbopackIgnore: true*/ FILE, "utf8")) as Record<string, Approval>;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Approval>) {
  mkdirSync(/*turbopackIgnore: true*/ path.dirname(FILE), { recursive: true });
  const tmp = FILE + "." + process.pid + ".tmp";
  writeFileSync(/*turbopackIgnore: true*/ tmp, JSON.stringify(all, null, 1));
  renameSync(/*turbopackIgnore: true*/ tmp, FILE);
}

/** Everyone the greeter followed up on, newest first. */
export function approvals(): Approval[] {
  const all = readAll();
  let changed = false;
  for (const a of Object.values(all)) {
    // a run that died (page closed, server restarted) or a send that never came back must not block the card forever
    if (a.status === "drafting" && Date.now() - a.at > 8 * 60_000) {
      Object.assign(a, { status: "failed", body: "", error: "The follow-up stopped before the email was written" });
      changed = true;
    } else if (a.status === "sending" && Date.now() - (a.decidedAt ?? a.at) > 3 * 60_000) {
      Object.assign(a, { status: "failed", error: "Unclear if it sent. Check the booth's Sent folder before trying again." });
      changed = true;
    }
  }
  if (changed) writeAll(all);
  return Object.values(all).sort((a, b) => b.at - a.at);
}

export function approvalFor(personId: string): Approval | null {
  return approvals().find((a) => a.personId === personId) ?? null;
}

// Who may act as the recruiter: anyone who signed in on the booth laptop itself (by Auth0 user id), plus the
// verified emails in RECRUITER_EMAILS. A phone through the tunnel only gets in with one of those accounts, so a
// hacker who finds the link and signs up can't read the inbox.
const RECRUITERS_FILE = path.join(process.cwd(), ".data", "recruiters.json");

function boothRecruiters(): string[] {
  try {
    return JSON.parse(readFileSync(/*turbopackIgnore: true*/ RECRUITERS_FILE, "utf8")) as string[];
  } catch {
    return [];
  }
}

export function addBoothRecruiter(sub: string) {
  const all = boothRecruiters();
  if (all.includes(sub)) return;
  mkdirSync(/*turbopackIgnore: true*/ path.dirname(RECRUITERS_FILE), { recursive: true });
  writeFileSync(/*turbopackIgnore: true*/ RECRUITERS_FILE, JSON.stringify([...all, sub]));
}

export function isRecruiter(u: { sub?: unknown; email?: unknown; email_verified?: unknown }): boolean {
  if (typeof u.sub === "string" && boothRecruiters().includes(u.sub)) return true;
  const listed = (env("RECRUITER_EMAILS") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return u.email_verified === true && typeof u.email === "string" && listed.includes(u.email.toLowerCase());
}

/** Adds or updates this person's entry. */
export function putApproval(personId: string, patch: Partial<Approval>): Approval {
  const all = readAll();
  const base: Approval = {
    personId, name: "Visitor", role: "Hacker", photo: null, company: "", to: "", toSource: "none",
    subject: "", body: "", roles: [], status: "drafting", at: Date.now(),
  };
  const next: Approval = { ...base, ...all[personId], ...patch, personId };
  all[personId] = next;
  writeAll(all);
  return next;
}

export function dropApproval(personId: string) {
  const all = readAll();
  if (!all[personId]) return;
  delete all[personId];
  writeAll(all);
}

export function sentLog(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(/*turbopackIgnore: true*/ SENT_FILE, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

export function markSent(personId: string, t: number | undefined) {
  const all = sentLog();
  if (t) all[personId] = t;
  else delete all[personId];
  try {
    writeFileSync(/*turbopackIgnore: true*/ SENT_FILE, JSON.stringify(all, null, 1));
  } catch {}
}

/** Sends (or with send=false saves a draft) from the booth's Gmail through gws; resolves to the message id.
 * No abort signal on purpose: once gws starts sending, closing the page must not kill it halfway. */
export function sendMail(to: string, subject: string, body: string, send: boolean): Promise<string | undefined> {
  const dir = mkdtempSync(path.join(tmpdir(), "followup-"));
  const file = path.join(dir, "body.md");
  writeFileSync(file, body);
  const args = [GWS_EMAIL, "new", "--to", to, "--subject", subject, "--body-file", file];
  if (send) args.push("--send");
  return new Promise((ok, fail) => {
    const p = spawn("python3", args);
    // gws stuck on a token refresh or the network: give up so the card can be retried
    const kill = setTimeout(() => p.kill("SIGKILL"), 90_000);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(kill); rmSync(dir, { recursive: true, force: true }); fail(e); });
    p.on("close", (code) => {
      clearTimeout(kill);
      rmSync(dir, { recursive: true, force: true });
      if (code === 0) ok(out.match(/"id"\s*:\s*"([^"]+)"/)?.[1]);
      else fail(new Error((err || out).trim().split("\n").slice(-3).join(" ") || "gws exited " + code));
    });
  });
}

