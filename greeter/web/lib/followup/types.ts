// The booth follow-up: once a visitor walks away, the greeter does the recruiter's follow-up for them.
// 1 listen   read the conversation and work out what the visitor wants (Brief)
// 2 research a TinyFish web agent goes to the sponsor's live careers site and finds roles that fit (Roles);
//            if TinyFish fails or has no key, the backup engine does the same research another way
// 3 draft    write the follow-up email from the brief and the roles (Email, streamed as it is written)
// 4 send     send it from the booth's Gmail through gws, right away
//
// The server streams these as AI SDK UI message data parts (`data-<key>`); parts with the same id are updated
// in place on the client, so each step, the browser, the roles and the email are one part that changes.
import type { UIMessage } from "ai";

export type StepId = "listen" | "research" | "draft" | "send";
export type StepStatus = "waiting" | "running" | "done" | "failed" | "skipped";
// part id: `step-${id}`
export type Step = { id: StepId; status: StepStatus; title: string; detail?: string; startedAt?: number; endedAt?: number };

export type Engine = "tinyfish" | "backup";
// part id: `browser-${engine}` (a backup run after a failed TinyFish run is a second part)
export type Browser = {
  engine: Engine;
  site: string; // the URL the agent starts on
  status: "starting" | "running" | "done" | "failed";
  runId?: string;
  streamingUrl?: string; // TinyFish live view, embeddable in an iframe
  note?: string; // why it failed, or what the backup is doing
};
// part id: `action-${n}`, one per browser step, in order
export type Action = { engine: Engine; text: string; t: number };

export type Role = { title: string; url: string; location?: string; team?: string; why: string };
// part id: "roles"
export type Roles = { company: string; engine: Engine; source: string; roles: Role[] };

export type Person = { id: string; name: string; role: string; photo: string | null };
// part id: "brief"
export type Brief = {
  person: Person;
  company: string;
  summary: string; // one sentence: who they are and what they came to the booth for
  interests: string[]; // short tags, e.g. "ML infra", "co-op summer 2027"
  asks: string[]; // what they asked for or were promised, in their words where possible
  query?: string; // 2 to 4 job-search words for them, e.g. "data intern co-op"
  built?: string[]; // what they have built or are building, "Name: what it does"
  match?: string; // with no single booth: why this sponsor (company) fits them best
};

// part id: "email"
export type Email = {
  to: string;
  subject: string;
  body: string; // plain text with light markdown (gws_email.py format), grows while drafting
  status: "drafting" | "approval" | "sending" | "sent" | "failed" | "held"; // approval: waiting for the recruiter's yes
  messageId?: string;
  error?: string;
};

export type FollowupData = {
  step: Step;
  browser: Browser;
  action: Action;
  roles: Roles;
  brief: Brief;
  email: Email;
};
export type FollowupMessage = UIMessage<never, FollowupData>;

// The sponsor to research. Set BOOTH_COMPANY (and optionally BOOTH_CAREERS_URL / BOOTH_RECRUITER) for one sponsor's
// booth; leave it unset and the greeter matches each visitor to the best-fitting Hack Western sponsor (lib/followup/sponsors).
// searchUrl (optional) is the careers site's search results page with {q} for the query: the agent starts there.
// site: the company's own domain when its jobs live on a shared board (commure.com for jobs.ashbyhq.com/commure).
export type Booth = { company: string; careersUrl: string; recruiter: string; searchUrl?: string; site?: string };

// POST /api/followup body. The person is looked up by id; their email comes from the Slack export unless `to` is given.
// force: send even if this visitor was already emailed in the last few hours (the manual button).
export type FollowupRequest = { personId: string; booth?: Partial<Booth>; to?: string; send?: boolean; force?: boolean };

