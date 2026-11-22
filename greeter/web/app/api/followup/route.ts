// POST /api/followup -> the booth follow-up as an AI SDK UI message stream (SSE).
// Body (top level, useChat's messages are ignored): { personId, booth?, to?, send? }.
// listen   -> the visitor's conversation with the greeter (greeter.db talk table) becomes a Brief
// research -> a TinyFish web agent reads the sponsor's live careers site for roles that fit (backup engine if it fails)
// draft    -> the email is written from the brief and the roles, streamed into the card as it is written
// send     -> sent from the booth's Gmail through gws right away (or held when sending is off)
// Every step, browser, action, the roles, the brief and the email are data parts with stable ids, so the client
// updates one card per thing instead of appending.
import { createUIMessageStream, createUIMessageStreamResponse, generateObject, streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { load, resolve } from "@/app/api/talk/data/store";
import { env } from "@/lib/followup/env";
import { findRoles } from "@/lib/followup/research";
import { awaitConsent, confirmedContact, consentFor, consentRequired, isEmail, maskEmail, stopAwaiting } from "@/lib/consent";
import { directoryContact } from "@/lib/visitor";
import { onSponsorSite, siteOf } from "@/lib/followup/backup";
import { tinyfishKey } from "@/lib/followup/tinyfish";
import { SPONSORS, SPONSOR_NAMES, sponsor, type Sponsor } from "@/lib/followup/sponsors";
import type { Booth, Brief, Email, FollowupMessage, FollowupRequest, Roles, Step, StepId } from "@/lib/followup/types";

export const maxDuration = 300;

const REPO = path.resolve(process.cwd(), "../..");
const GREETER_DB = process.env.GREETER_DB ?? path.join(REPO, "greeter", "greeter.db");
const GWS_EMAIL = env("GWS_EMAIL_SCRIPT") ?? path.join(process.env.HOME ?? "", ".codex/skills/gws-email/scripts/gws_email.py");
const SESSION_GAP = 20 * 60; // seconds of silence that end one visit
const AGAIN_AFTER = 6 * 60 * 60_000; // one email per visitor every 6 hours, however often they walk past
// Who was emailed when, on disk so a restart doesn't email someone twice (gitignored).
const SENT_FILE = process.env.FOLLOWUP_SENT_FILE ?? path.join(REPO, "greeter", "followup-sent.json");
// Visitors with a run going right now (force skips the 6 hour rule, never this).
const inFlight = new Set<string>();

function sentLog(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(SENT_FILE, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}
function markSent(personId: string, t: number | undefined) {
  const all = sentLog();
  if (t) all[personId] = t;
  else delete all[personId];
  try {
    writeFileSync(SENT_FILE, JSON.stringify(all, null, 1));
  } catch {}
}

const TITLES: Record<StepId, string> = {
  listen: "Read the conversation",
  research: "Find roles that fit",
  draft: "Write the follow-up",
  send: "Send it",
};

// Who signs the email when the greeter matched the visitor to a sponsor (no single booth set).
const GREETER = env("FOLLOWUP_FROM") || "Touchpoint, the Hack Western 13 greeter";

// A single sponsor's booth, when BOOTH_COMPANY (or a test override) names one. Unset (the default), the greeter
// is the event's table: it reads what the visitor builds and matches them to the sponsor that fits best.
function fixedBooth(over?: Partial<Booth>): Booth | null {
  const company = over?.company || env("BOOTH_COMPANY");
  if (!company) return null;
  const known = sponsor(company);
  const custom = over?.careersUrl || env("BOOTH_CAREERS_URL");
  let careersUrl = custom || known?.careersUrl;
  if (!careersUrl) {
    console.warn("[followup] BOOTH_COMPANY=" + company + " is not a known sponsor and BOOTH_CAREERS_URL is unset, so each visitor is matched to a sponsor instead");
    return null;
  }
  if (!/^https?:\/\//i.test(careersUrl)) careersUrl = "https://" + careersUrl;
  return {
    company,
    careersUrl,
    // the agent starts on search results for this visitor, which saves it most of its steps
    searchUrl: over?.searchUrl || env("BOOTH_SEARCH_URL") || (custom ? undefined : known?.searchUrl),
    site: custom ? undefined : known?.site,
    recruiter: over?.recruiter || env("BOOTH_RECRUITER") || "The " + company + " recruiting team",
  };
}

function asBooth(s: Sponsor): Booth {
  return { company: s.company, careersUrl: s.careersUrl, searchUrl: s.searchUrl, site: s.site, recruiter: GREETER };
}

// Every link in the email must be a role we found or a page on the sponsor's own site.
function strayLinks(body: string, roles: Roles | null, b: Booth): string[] {
  const found = new Set((roles?.roles ?? []).map((r) => r.url));
  return (body.match(/https?:\/\/[^\s)\]>"']+/g) ?? [])
    .map((u) => u.replace(/[.,;:!?]+$/, ""))
    .filter((u) => !found.has(u) && !onSponsorSite(u, b));
}

// The last visit: lines from this person's most recent stretch of talk with no gap longer than SESSION_GAP.
function transcript(personId: string): { who: string; text: string }[] {
  const db = new DatabaseSync(GREETER_DB, { readOnly: true });
  try {
    const rows = db.prepare("select who, text, t from talk where person_id = ? order by n desc limit 80").all(personId) as { who: string; text: string; t: number }[];
    const visit: typeof rows = [];
    for (const r of rows) {
      if (visit.length && visit[visit.length - 1].t - r.t > SESSION_GAP) break;
      visit.push(r);
    }
    return visit.reverse().map(({ who, text }) => ({ who, text }));
  } finally {
    db.close();
  }
}

// No abort signal on purpose: once gws starts sending, closing the page must not kill it halfway.
function sendMail(to: string, subject: string, body: string, send: boolean): Promise<string | undefined> {
  const dir = mkdtempSync(path.join(tmpdir(), "followup-"));
  const file = path.join(dir, "body.md");
  writeFileSync(file, body);
  const args = [GWS_EMAIL, "new", "--to", to, "--subject", subject, "--body-file", file];
  if (send) args.push("--send");
  return new Promise((ok, fail) => {
    const p = spawn("python3", args);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { rmSync(dir, { recursive: true, force: true }); fail(e); });
    p.on("close", (code) => {
      rmSync(dir, { recursive: true, force: true });
      if (code === 0) ok(out.match(/"id"\s*:\s*"([^"]+)"/)?.[1]);
      else fail(new Error((err || out).trim().split("\n").slice(-3).join(" ") || "gws exited " + code));
    });
  });
}

const BriefOut = z.object({
  summary: z.string().describe("One sentence: who they are and what they came to the booth for."),
  interests: z.array(z.string()).max(5).describe("Short tags for what they care about, e.g. 'ML infra', 'summer 2027 co-op'."),
  asks: z.array(z.string()).max(4).describe("What they asked for or were promised, in their words where possible."),
  query: z.string().describe("2 to 4 job-search keywords for them on a careers site, e.g. 'data intern co-op' or 'software engineer new grad'. Include intern/co-op if they are a student."),
  built: z.array(z.string()).max(4).describe("What they have built or are building (projects, hackathon builds, products, research), each as 'Name: what it does' in under 12 words. Only from the conversation and profile; empty if nothing is known."),
});
// With no single booth set, the same call also picks the sponsor whose roles fit what they build.
const MatchedOut = BriefOut.extend({
  sponsor: z.enum(SPONSOR_NAMES).describe("The one Hack Western sponsor whose roles best fit what they build and want."),
  why: z.string().describe("One sentence on why that sponsor fits them, naming what they built when known."),
});
const SPONSOR_LIST = SPONSORS.map((x) => "- " + x.company + ": " + x.hires).join("\n");

export async function POST(request: Request) {
  // Only the greeter's own page may start a follow-up: no cross-site form posts, no other origins.
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return new Response("Cross-site request refused", { status: 403 });
  if (!request.headers.get("content-type")?.includes("application/json")) return new Response("JSON body required", { status: 415 });
  let req: FollowupRequest;
  try {
    req = (await request.json()) as FollowupRequest;
  } catch {
    return Response.json({ error: "JSON body required" }, { status: 400 });
  }
  const personId = req.personId?.trim();
  if (!personId) return Response.json({ error: "personId is required" }, { status: 400 });
  if (inFlight.has(personId)) return new Response("Already following up with this visitor", { status: 409 });
  const key = env("OPENAI_API_KEY");
  if (!key) return Response.json({ error: "OPENAI_API_KEY is not set" }, { status: 500 });
  const openai = createOpenAI({ apiKey: key });
  const model = openai(env("FOLLOWUP_MODEL") ?? "gpt-4.1-mini");
  // Overriding the recipient or the sponsor from the request is for local testing only.
  const overrides = env("FOLLOWUP_ALLOW_OVERRIDES") === "1";
  const fixed = fixedBooth(overrides ? req.booth : undefined);
  const label = fixed?.company ?? "Hack Western sponsors";
  const signal = request.signal;
  const before = sentLog()[personId];
  const sending = req.send !== false && env("FOLLOWUP_SEND") !== "0";
  const recent = !req.force && sending && !!before && Date.now() - before < AGAIN_AFTER;
  // Claim the visitor before any paid research, so a second trigger while this one runs is held too.
  if (sending && !recent) markSent(personId, Date.now());

  const store = load();
  const entry = resolve(store, personId);
  const contact = directoryContact(personId);
  const known = entry?.person.name ?? contact?.name;
  const name = known ?? "Visitor";
  const first = known ? known.split(/\s+/)[0] : "this visitor";
  const who = known ? first : "Visitor";
  // Who it goes to: the email the visitor approved on their own phone after scanning the booth QR and signing in
  // with their Auth0 passkey (see lib/consent). Until they approve one nothing is researched or sent; approving
  // starts the follow-up straight away (app/api/confirm). A "No thanks" is final. consentRequired() is off only
  // with FOLLOWUP_REQUIRE_CONSENT=0, which falls back to the Slack directory email.
  const consent = consentFor(personId);
  const needConsent = consentRequired();
  const chosen = confirmedContact(personId)?.email;
  const allowed = consent?.status === "declined" ? "" : chosen ?? (needConsent ? "" : contact?.email ?? "");
  const testTo = env("FOLLOWUP_TEST_TO");
  const override = overrides && isEmail(req.to) ? req.to : "";
  // the test inbox and overrides redirect a follow-up that may go out; they never stand in for a visitor's yes
  const to = allowed || (override && !needConsent) ? testTo || override || allowed : "";
  console.info(
    `[followup] ${personId}: ${allowed ? "resolved " + maskEmail(allowed) + (chosen ? " (chosen on their phone)" : " (directory)") : "no address"}` +
      (testTo ? `, sending to the test address ${maskEmail(testTo)} instead` : override ? `, overridden to ${maskEmail(override)}` : ""),
  );
  const noAddress =
    consent?.status === "declined"
      ? first + " said no to a follow-up, so nothing was researched or sent."
      : needConsent && !allowed
        ? first + " hasn't picked an email on their phone yet. Their follow-up starts as soon as they scan the booth QR."
        : "No email on file for " + first + "." + (env("CONFIRM_QR") === "0" ? "" : " Their follow-up sends as soon as they add one from the booth QR.");
  // No address and no manual push: research would cost money for an email that can't go anywhere.
  // A declined visitor stays skipped even on the manual button.
  const nowhere = !to && (!req.force || consent?.status === "declined");
  if (sending && !recent && nowhere) markSent(personId, before);
  // No address yet: if they confirm one on their phone later, the booth runs this follow-up then.
  if (!to && consent?.status !== "declined") awaitConsent(personId);
  else stopAwaiting(personId);
  inFlight.add(personId);

  const stream = createUIMessageStream<FollowupMessage>({
    execute: async ({ writer }) => {
      let email: Email | undefined;
      try {
        email = await run();
      } finally {
        inFlight.delete(personId);
        // Only a real send keeps the claim; anything else frees the visitor for the next try.
        if (sending && !recent && !nowhere && email?.status !== "sent") markSent(personId, before);
      }

      async function run(): Promise<Email | undefined> {
      const steps = new Map<StepId, Step>();
      const step = (id: StepId, patch: Partial<Step>) => {
        const now = Date.now();
        const prev = steps.get(id) ?? { id, status: "waiting", title: TITLES[id] };
        const next: Step = { ...prev, ...patch };
        if (patch.status === "running" && !prev.startedAt) next.startedAt = now;
        if (patch.status && ["done", "failed", "skipped"].includes(patch.status)) next.endedAt = now;
        steps.set(id, next);
        writer.write({ type: "data-step", id: "step-" + id, data: next });
      };
      writer.write({ type: "start" });
      for (const id of Object.keys(TITLES) as StepId[]) step(id, { status: "waiting" });

      if (recent || nowhere) {
        const at = before ? new Date(before).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" }) : "";
        const why = recent ? "Already emailed " + first + " at " + at + ". Press Follow up to send again." : noAddress;
        writer.write({
          type: "data-brief",
          id: "brief",
          data: {
            person: { id: personId, name, role: entry?.person.role ?? "Hacker", photo: entry?.person.photo ?? null },
            company: label,
            summary: recent ? "Already followed up with " + first + " at " + at + "." : noAddress,
            interests: [],
            asks: [],
            built: [],
          },
        });
        for (const id of ["listen", "research", "draft"] as StepId[]) step(id, { status: "skipped" });
        step("send", { status: "skipped", detail: why });
        writer.write({ type: "finish" });
        return undefined;
      }

      // 1 listen
      step("listen", { status: "running", detail: "Reading what they said at the booth" });
      const lines = transcript(personId);
      const facts = (entry?.person.facts ?? []).slice(0, 10).map((f) => "- " + f.text).join("\n");
      const repos = (entry?.person.pages ?? []).filter((p) => p.kind === "repo").slice(0, 4).map((p) => "- " + p.title + " (" + p.url + ")").join("\n");
      const said = lines.map((l) => (l.who === "person" ? who : "Booth") + ": " + l.text).join("\n");
      if (!lines.length && !facts) {
        step("listen", { status: "failed", detail: "Nothing recorded with " + first + " yet" });
        for (const id of ["research", "draft", "send"] as StepId[]) step(id, { status: "skipped" });
        writer.write({ type: "finish" });
        return undefined;
      }
      const { object: got } = await generateObject({
        model,
        // with a fixed booth the plain brief comes back and sponsor/why stay undefined
        schema: (fixed ? BriefOut : MatchedOut) as typeof MatchedOut,
        abortSignal: signal,
        system: fixed
          ? "You are a recruiter's assistant at a hackathon sponsor booth. Summarize a visitor for the follow-up. Use only what is in the conversation and profile; never invent facts. Refer to them by first name or 'they', never he or she."
          : "You are the greeter at Hack Western 13. It recognizes each hacker, talks with them about what they are building, then matches them to roles at the event's sponsors. " +
            "Summarize the visitor, list what they have built, and pick the one sponsor whose roles fit them best, weighing what they build first and what they said they want second. " +
            "Most hackers use AI, so using an LLM is not a reason on its own: match the domain and the kind of work (fintech or data -> a bank or insurer, commerce or web apps -> Shopify, 3D or design tools -> Autodesk, health -> Commure, web agents or scraping -> TinyFish, security -> CSE, hardware -> StarTech, logistics or mobile -> DoorDash, consulting or business -> Accenture). " +
            "Prefer sponsors that hire students in Canada when they are a student. " +
            "Use only what is in the conversation and profile; never invent facts. Refer to them by first name or 'they', never he or she.",
        prompt: (fixed ? "Booth: " + fixed.company : "Hack Western sponsors and what they hire for:\n" + SPONSOR_LIST) +
          "\n\nVisitor: " + (known ?? "name unknown") + (entry?.person.role ? " (" + entry.person.role + ")" : "") +
          (entry?.person.headline ? "\nHeadline: " + entry.person.headline : "") +
          (facts ? "\nProfile:\n" + facts : "") +
          (repos ? "\nTheir GitHub repos:\n" + repos : "") +
          "\n\nConversation with the greeter:\n" + (said || "(no words recorded, only the profile)"),
      });
      const b: Booth = fixed ?? asBooth(sponsor(got.sponsor) ?? SPONSORS[0]);
      const brief: Brief = {
        person: { id: personId, name, role: entry?.person.role ?? "Hacker", photo: entry?.person.photo ?? null },
        company: b.company,
        summary: got.summary,
        interests: got.interests,
        asks: got.asks,
        query: got.query,
        built: got.built,
        ...(fixed ? {} : { match: got.why }),
      };
      writer.write({ type: "data-brief", id: "brief", data: brief });
      step("listen", {
        status: "done",
        detail: (lines.length ? lines.length + " lines from the visit" : "From their profile") + (fixed ? "" : ", best fit " + b.company),
      });

      // 2 research
      const agentOn = !!tinyfishKey() && env("FOLLOWUP_FORCE_BACKUP") !== "1";
      step("research", { status: "running", detail: (agentOn ? "TinyFish is opening " : "The backup engine is reading ") + new URL(b.careersUrl).host });
      let n = 0;
      let roles: Roles | null = null;
      try {
        roles = await findRoles(
          { booth: b, brief, signal },
          {
            browser: (br) => {
              writer.write({ type: "data-browser", id: "browser-" + br.engine, data: br });
              if (br.engine === "backup" && br.status === "starting")
                step("research", { detail: "TinyFish didn't finish, the backup engine is on it" });
            },
            action: (a) => {
              writer.write({ type: "data-action", id: "action-" + n++, data: a });
              step("research", { detail: (a.engine === "tinyfish" ? "TinyFish: " : "Backup: ") + a.text });
            },
          },
        );
        writer.write({ type: "data-roles", id: "roles", data: roles });
        step("research", {
          status: roles.roles.length ? "done" : "failed",
          detail: roles.roles.length ? roles.roles.length + " open roles via " + (roles.engine === "tinyfish" ? "TinyFish" : "the backup") : "No open roles found",
        });
      } catch (e) {
        if (signal.aborted) throw e;
        step("research", { status: "failed", detail: e instanceof Error ? e.message.slice(0, 140) : "Research failed" });
      }

      // 3 draft
      const subject = fixed ? "Following up from the " + b.company + " booth at Hack Western" : "Roles at " + b.company + " for what you're building, from Hack Western";
      const mail: Email = { to, subject, body: "", status: "drafting" };
      const put = () => writer.write({ type: "data-email", id: "email", data: { ...mail } });
      step("draft", { status: "running", detail: "Writing to " + first });
      put();
      const list = (roles?.roles ?? []).slice(0, 4).map((r) => "- " + r.title + (r.location ? " (" + r.location + ")" : "") + ": " + r.url + "\n  Fit: " + r.why).join("\n");
      let draftError: unknown;
      const res = streamText({
        model,
        abortSignal: signal,
        onError: ({ error }) => {
          draftError = error;
        },
        system:
          (fixed
            ? "You write short, warm follow-up emails from a recruiter at a hackathon sponsor booth. Plain text only. "
            : "You write short, warm follow-up emails from the Hack Western 13 greeter, which talked with a hacker about what they are building and matched them to one of the event's sponsors. Plain text only. ") +
          "Format: greeting line, 1 short paragraph that recalls something specific they built or said" + (fixed ? "" : " and why " + b.company + " fits it") + ", then the roles as a list " +
          "where each item is '- [Role title](url): one line on why it fits them', then one line with a next step, then a sign-off. " +
          "Under 160 words. No em dashes. No subject line. Never use he or she for the visitor. Never invent roles, links or facts; if there are no roles, point them to the careers site.",
        prompt:
          "Visitor: " + (known ?? "name unknown, greet them without a name") + "\nWhat we know: " + brief.summary + "\nInterests: " + brief.interests.join(", ") +
          "\nThey asked: " + (brief.asks.join("; ") || "nothing specific") +
          "\nWhat they built: " + (brief.built?.join("; ") || "nothing known") +
          (brief.match ? "\nWhy " + b.company + ": " + brief.match : "") +
          "\n\nConversation:\n" + (said || "(none)") +
          "\n\nRoles found on " + b.company + "'s live careers site (" + (roles?.source ?? b.careersUrl) + "):\n" + (list || "(none found)") +
          "\n\nCareers site: " + b.careersUrl + "\nSign off as: " + (!fixed || b.recruiter.includes(b.company) ? b.recruiter : b.recruiter + ", " + b.company),
      });
      let last = 0;
      for await (const chunk of res.textStream) {
        mail.body += chunk;
        if (Date.now() - last > 80) {
          put();
          last = Date.now();
        }
      }
      mail.body = mail.body.trim();
      const finish = await Promise.resolve(res.finishReason).catch((e: unknown) => {
        draftError ??= e;
        return "error";
      });
      if (signal.aborted) throw new Error("The follow-up was stopped");
      if (draftError || finish !== "stop" || !mail.body) {
        // never send a blank or half-written email
        mail.status = "failed";
        mail.error = draftError instanceof Error ? "Writing failed: " + draftError.message.slice(0, 160) : !mail.body ? "The draft came back empty" : "The draft was cut off (" + finish + ")";
        put();
        step("draft", { status: "failed", detail: mail.error });
        step("send", { status: "skipped", detail: "Nothing sent" });
        writer.write({ type: "finish" });
        return mail;
      }
      put();
      step("draft", { status: "done", detail: mail.body.split(/\s+/).length + " words" });

      // 4 send
      email = mail;
      const stray = strayLinks(mail.body, roles, b);
      if (stray.length) {
        mail.status = "held";
        mail.error = "Held for the recruiter: a link isn't from " + siteOf(b) + " (" + new URL(stray[0]).hostname + ")";
        put();
        step("send", { status: "skipped", detail: mail.error });
      } else {
        // they may have tapped "No thanks", or picked another address, on their phone while this was running
        const latest = consentFor(personId);
        const nowTo = latest?.status === "declined" ? "" : confirmedContact(personId)?.email;
        if (latest?.status === "declined") {
          mail.status = "held";
          mail.error = first + " said no on their phone";
          put();
          step("send", { status: "skipped", detail: mail.error + ", nothing sent" });
        } else {
          if (nowTo && !testTo && !override) mail.to = nowTo;
          await send(mail, put, step, sending, signal, noAddress);
        }
      }
      writer.write({ type: "finish" });
      return mail;
      }
    },
    onError: (e) => (e instanceof Error ? e.message : "The follow-up stopped."),
  });
  return createUIMessageStreamResponse({ stream, headers: { "cache-control": "no-store" } });
}

async function send(
  email: Email,
  put: () => void,
  step: (id: StepId, patch: Partial<Step>) => void,
  sending: boolean,
  signal: AbortSignal,
  why: string,
) {
  if (!email.to) {
    email.status = "held";
    email.error = why.replace(/\.$/, "");
    put();
    step("send", { status: "skipped", detail: why });
    return;
  }
  step("send", { status: "running", detail: sending ? "Sending from the booth's Gmail" : "Saving a draft in the booth's Gmail" });
  email.status = "sending";
  put();
  try {
    email.messageId = await sendMail(email.to, email.subject, email.body, sending);
    email.status = sending ? "sent" : "held";
    put();
    step("send", { status: "done", detail: sending ? "Sent to " + email.to : "Draft saved for " + email.to });
  } catch (e) {
    if (signal.aborted) throw e;
    email.status = "failed";
    email.error = e instanceof Error ? e.message.slice(0, 200) : "Send failed";
    put();
    step("send", { status: "failed", detail: email.error });
  }
}

