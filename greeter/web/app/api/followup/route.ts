// POST /api/followup -> the booth follow-up as an AI SDK UI message stream (SSE).
// Body (top level, useChat's messages are ignored): { personId, booth?, to?, send? }.
// listen   -> the visitor's conversation with the greeter (greeter.db talk table) becomes a Brief
// research -> a TinyFish web agent reads the sponsor's live careers site for roles that fit (backup engine if it fails)
// draft    -> the email is written from the brief and the roles, streamed into the card as it is written
// send     -> parked for the recruiter: they approve it (Yes) from the booth screen or /recruiter, and only then does
//             it go out from the booth's Gmail (lib/followup/approvals). FOLLOWUP_APPROVAL=0 sends right away.
// Every step, browser, action, the roles, the brief and the email are data parts with stable ids, so the client
// updates one card per thing instead of appending.
import { createUIMessageStream, createUIMessageStreamResponse, generateObject, streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { load, resolve } from "@/app/api/talk/data/store";
import { env } from "@/lib/followup/env";
import { findRoles } from "@/lib/followup/research";
import { isEmail, maskEmail } from "@/lib/consent";
import { approvalFor, approvalOn, markSent, putApproval, sendMail, sentLog } from "@/lib/followup/approvals";
import { directoryContact } from "@/lib/visitor";
import { onSponsorSite, siteOf } from "@/lib/followup/backup";
import { tinyfishKey } from "@/lib/followup/tinyfish";
import { SPONSORS, SPONSOR_NAMES, sponsor, type Sponsor } from "@/lib/followup/sponsors";
import type { Booth, Brief, Email, FollowupMessage, FollowupRequest, Roles, Step, StepId } from "@/lib/followup/types";

export const maxDuration = 300;

const REPO = path.resolve(process.cwd(), "../..");
const GREETER_DB = process.env.GREETER_DB ?? path.join(REPO, "greeter", "greeter.db");
const SESSION_GAP = 20 * 60; // seconds of silence that end one visit
const AGAIN_AFTER = 6 * 60 * 60_000; // one email per visitor every 6 hours, however often they walk past
// Visitors with a run going right now (force skips the 6 hour rule, never this).
const inFlight = new Set<string>();

const TITLES: Record<StepId, string> = {
  listen: "Read the conversation",
  research: "Find roles that fit",
  draft: "Write the follow-up",
  send: "Recruiter approves",
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

const BriefOut = z.object({
  summary: z.string().describe("One sentence: who they are and what they came to the booth for."),
  interests: z.array(z.string()).max(5).describe("Short tags for what they care about, e.g. 'ML infra', 'summer 2027 co-op'."),
  asks: z.array(z.string()).max(4).describe("What they asked for or were promised, in their words where possible."),
  query: z.string().describe("2 to 4 job-search keywords for them on a careers site, e.g. 'data intern co-op' or 'software engineer new grad'. Include intern/co-op if they are a student."),
  built: z.array(z.string()).max(4).describe("What they have built or are building (projects, hackathon builds, products, research), each as 'Name: what it does' in under 12 words. Only from the conversation and profile; empty if nothing is known."),
  email: z.string().describe(
    "The email address they told the greeter to send the follow-up to, only if they gave a new one or corrected the one on file out loud. " +
      "Rebuild spelled-out speech into an address ('jay dot doe at gmail dot com' -> jay.doe@gmail.com). Empty string if they gave none or said the one on file is fine.",
  ),
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
  // already emailed lately, or the recruiter is sending theirs right now: don't draft a second one
  const decided = approvalOn() ? approvalFor(personId) : null;
  // (a recruiter's No also stands for the same 6 hours, unless the run is forced)
  const recent =
    !req.force &&
    sending &&
    ((!!before && Date.now() - before < AGAIN_AFTER) ||
      decided?.status === "sending" ||
      decided?.status === "sent" ||
      (decided?.status === "skipped" && Date.now() - (decided.decidedAt ?? 0) < AGAIN_AFTER));
  // Claim the visitor before any paid research, so a second trigger while this one runs is held too.
  const claim = Date.now();
  if (sending && !recent) markSent(personId, claim);

  const store = load();
  const entry = resolve(store, personId);
  const contact = directoryContact(personId);
  const known = entry?.person.name ?? contact?.name;
  const name = known ?? "Visitor";
  const first = known ? known.split(/\s+/)[0] : "this visitor";
  const who = known ? first : "Visitor";
  // Who it goes to: the email they gave the greeter out loud (read from the conversation below), else the one on
  // file from the Hack Western Slack directory. The greeter always asks before they leave whether the one on file
  // is right. Nothing goes out until the recruiter says yes (lib/followup/approvals).
  const onFile = contact?.email ?? "";
  const testTo = env("FOLLOWUP_TEST_TO");
  const override = overrides && isEmail(req.to) ? req.to : "";
  const noAddress = "No email for " + first + " yet. Add one before saying yes.";
  inFlight.add(personId);

  const stream = createUIMessageStream<FollowupMessage>({
    execute: async ({ writer }) => {
      let email: Email | undefined;
      try {
        email = await run();
      } finally {
        inFlight.delete(personId);
        // Only a real send keeps the claim; anything else frees the visitor for the next try (unless the
        // recruiter's Yes has written a newer time meanwhile).
        if (sending && !recent && email?.status !== "sent" && sentLog()[personId] === claim) markSent(personId, before);
        // the run died before the email was written: the recruiter's card must not wait forever
        const mine = approvalOn() ? approvalFor(personId) : null;
        if (mine?.status === "drafting" && mine.at === claim) putApproval(personId, { status: "failed", body: "", error: "The follow-up stopped before the email was written" });
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

      if (recent) {
        const at = before ? new Date(before).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Toronto" }) : "just now";
        const why = decided?.status === "skipped" ? "The recruiter passed on " + first + " earlier." : "Already emailed " + first + " at " + at + ".";
        writer.write({
          type: "data-brief",
          id: "brief",
          data: {
            person: { id: personId, name, role: entry?.person.role ?? "Hacker", photo: entry?.person.photo ?? null },
            company: label,
            summary: "Already followed up with " + first + " at " + at + ".",
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
      // the recruiter sees them right away, while their email is still being worked on
      const photo = entry?.person.photo ?? "/api/greeter/face?id=" + encodeURIComponent(personId);
      if (approvalOn())
        putApproval(personId, {
          name, role: entry?.person.role ?? "Hacker", photo, company: "", why: undefined, summary: undefined, to: "", toSource: "none",
          subject: "", body: "", roles: [], status: "drafting", error: undefined, at: claim, decidedAt: undefined, decidedBy: undefined,
        });
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
      // the address they said out loud wins over the one on file; the test inbox and overrides redirect either
      const spoken = isEmail(got.email?.trim()) ? got.email.trim() : "";
      const real = spoken || onFile;
      const toSource = spoken ? "said" : onFile ? "file" : "none";
      const to = testTo || override || real;
      console.info(
        `[followup] ${personId}: ${real ? maskEmail(real) + (spoken ? " (said out loud)" : " (on file)") : "no address"}` +
          (testTo ? `, test address ${maskEmail(testTo)} instead` : override ? `, overridden to ${maskEmail(override)}` : ""),
      );
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
      if (approvalOn()) putApproval(personId, { company: b.company, why: brief.match, summary: brief.summary, to, toSource });
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
        // never offer a cut-off draft for sending
        if (approvalOn()) putApproval(personId, { status: "failed", error: mail.error, body: "", subject });
        writer.write({ type: "finish" });
        return mail;
      }
      put();
      step("draft", { status: "done", detail: mail.body.split(/\s+/).length + " words" });

      // 4 send
      email = mail;
      const stray = strayLinks(mail.body, roles, b);
      if (approvalOn()) {
        // parked for the recruiter: they see it on the booth screen or /recruiter and tap Yes or No
        putApproval(personId, {
          to: mail.to, subject: mail.subject, body: mail.body, status: "waiting",
          roles: (roles?.roles ?? []).slice(0, 4).map((r) => ({ title: r.title, url: r.url })),
          error: stray.length ? "Has a link that isn't from " + siteOf(b) + " (" + new URL(stray[0]).hostname + ")" : !mail.to ? noAddress : undefined,
        });
        mail.status = "approval";
        put();
        step("send", { status: "done", detail: "With the recruiter for a yes" + (mail.to ? "" : ", no email yet") });
      } else if (stray.length) {
        mail.status = "held";
        mail.error = "Held for the recruiter: a link isn't from " + siteOf(b) + " (" + new URL(stray[0]).hostname + ")";
        put();
        step("send", { status: "skipped", detail: mail.error });
      } else {
        await send(mail, put, step, sending, signal, noAddress);
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

