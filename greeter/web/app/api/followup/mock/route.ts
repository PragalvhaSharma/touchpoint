// A scripted follow-up run with realistic timing (~25 s), for building the UI and as a fallback for recording the
// demo. It walks every state the real /api/followup streams: the brief, a TinyFish browser starting then running,
// one action per browser step, roles, the email written a few words at a time, then sent.
// POST /api/followup/mock          the happy path
// POST /api/followup/mock?fail=1   TinyFish fails partway through and the backup engine takes over
// ?speed=2 runs it twice as fast.
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { Action, Brief, Browser, Email, FollowupMessage, Roles, Step, StepId } from "@/lib/followup/types";


const SITE = "https://jobs.scotiabank.com/go/Students-&-New-Grads/2297117/";
const SEARCH = (q: string) => "https://jobs.scotiabank.com/search/?q=" + encodeURIComponent(q) + "&locationsearch=Canada";

const BRIEF: Brief = {
  person: { id: "U07MOCKMAYA", name: "Maya Chen", role: "Hacker", photo: null },
  company: "Scotiabank",
  summary: "Second-year Western CS student who builds ML side projects and came by to ask about machine learning internships for summer 2027.",
  interests: ["ML internships", "Summer 2027", "Fraud detection", "PyTorch", "Toronto or remote"],
  built: ["FraudLens: flags card fraud from transaction graphs", "SplitSnap: reads receipts with a small PyTorch OCR model"],
  match: "Scotiabank's risk teams build fraud models in Python and PyTorch, the same work as FraudLens.",
  asks: [
    "Are there ML roles for students, or only data analyst ones?",
    "When do summer 2027 applications close?",
    "Can you send me the links so I don't lose them?",
  ],
};

const ROLES: Roles = {
  company: "Scotiabank",
  engine: "tinyfish",
  source: SITE,
  roles: [
    {
      title: "Data Scientist Intern, Summer 2027",
      location: "Toronto, ON",
      team: "Global Risk Management",
      url: SEARCH("data scientist intern"),
      why: "Builds and validates fraud and credit models in Python and PyTorch, the same work as Maya's fraud-detection project.",
    },
    {
      title: "Machine Learning Engineer Co-op",
      location: "Toronto, ON · Hybrid",
      team: "Global AI & ML",
      url: SEARCH("machine learning co-op"),
      why: "Ships models to production with the platform team; she asked for ML work that goes past dashboards.",
    },
    {
      title: "Software Developer Intern, Global Technology",
      location: "Toronto, ON",
      team: "Global Technology",
      url: SEARCH("software developer intern"),
      why: "A strong backup that still touches data pipelines, for the same summer 2027 term.",
    },
  ],
};

const EMAIL_TO = "maya.chen@example.com";
const SUBJECT = "Great meeting you at Hack Western: 3 Scotiabank ML roles for summer 2027";
const BODY = [
  "Hi Maya,",
  "",
  "Thanks for stopping by the Scotiabank booth at Hack Western tonight. You mentioned you're a second-year CS student at Western looking for a machine learning internship for summer 2027, and that you want to work on models that actually ship. Here are three open roles from our careers site that fit:",
  "",
  "- **Data Scientist Intern, Summer 2027** (Toronto, Global Risk Management): fraud and credit models in Python and PyTorch. [View posting](" + ROLES.roles[0].url + ")",
  "- **Machine Learning Engineer Co-op** (Toronto, hybrid, Global AI & ML): putting models into production. [View posting](" + ROLES.roles[1].url + ")",
  "- **Software Developer Intern, Global Technology** (Toronto): a strong backup with data pipeline work. [View posting](" + ROLES.roles[2].url + ")",
  "",
  "When you apply, mention that you met us at Hack Western and link the fraud-detection project you showed us.",
  "",
  "Good luck with the rest of the hackathon!",
  "",
  "Scotiabank Campus Recruiting",
].join("\n");

const TINYFISH_STEPS = [
  "Opened jobs.scotiabank.com",
  "Closed the cookie banner",
  "Went to Students & New Grads",
  "Searched “machine learning intern”, location Canada",
  "Opened “Data Scientist Intern, Summer 2027” in Toronto",
  "Read the posting: Python, PyTorch, fraud and credit models, 4 month term",
  "Opened “Machine Learning Engineer Co-op” on the Global AI & ML team",
  "Opened “Software Developer Intern, Global Technology” as a backup",
  "Checked each posting is still open",
  "Picked the 3 roles that fit Maya best",
];
const BACKUP_STEPS = [
  "Fetched the Students & New Grads listing directly",
  "Read 24 open postings from the page",
  "Kept 6 that mention machine learning, data science or co-op",
  "Read the 3 strongest matches in full",
  "Checked each posting is still open",
  "Picked the 3 roles that fit Maya best",
];

const TITLES: Record<StepId, string> = {
  listen: "Reading the conversation",
  research: "Finding roles on the careers site",
  draft: "Writing the follow-up",
  send: "Sending from Gmail",
};

export async function POST(req: Request) {
  const url = new URL(req.url);
  const fail = url.searchParams.get("fail") === "1";
  const speed = Math.min(8, Math.max(0.25, Number(url.searchParams.get("speed")) || 1));
  const signal = req.signal;
  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("aborted"));
      const t = setTimeout(resolve, ms / speed);
      signal.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))), { once: true });
    });

  const stream = createUIMessageStream<FollowupMessage>({
    execute: async ({ writer }) => {
      const steps = new Map<StepId, Step>();
      const step = (id: StepId, patch: Partial<Step>) => {
        const prev = steps.get(id) ?? { id, status: "waiting", title: TITLES[id] };
        const next: Step = { ...prev, ...patch };
        if (patch.status === "running" && !prev.startedAt) next.startedAt = Date.now();
        if (patch.status && ["done", "failed", "skipped"].includes(patch.status)) next.endedAt = Date.now();
        steps.set(id, next);
        writer.write({ type: "data-step", id: "step-" + id, data: next });
      };
      const browser = (b: Browser) => writer.write({ type: "data-browser", id: "browser-" + b.engine, data: b });
      let n = 0;
      const action = (a: Omit<Action, "t">) => writer.write({ type: "data-action", id: "action-" + n++, data: { ...a, t: Date.now() } });
      const email = (e: Email) => writer.write({ type: "data-email", id: "email", data: e });

      writer.write({ type: "start" });
      for (const id of ["listen", "research", "draft", "send"] as StepId[]) step(id, { status: "waiting" });

      // 1 listen
      step("listen", { status: "running", detail: "3 min 40 s with Maya at the booth" });
      await sleep(2400);
      writer.write({ type: "data-brief", id: "brief", data: BRIEF });
      step("listen", { status: "done", detail: "ML internships, summer 2027" });
      await sleep(500);

      // 2 research
      step("research", { status: "running", detail: "TinyFish is opening jobs.scotiabank.com" });
      let tf: Browser = { engine: "tinyfish", site: SITE, status: "starting", runId: "run_8f3a21c9" };
      browser(tf);
      await sleep(2300);
      tf = { ...tf, status: "running", streamingUrl: "about:blank" };
      browser(tf);
      step("research", { detail: "TinyFish is browsing the careers site" });

      const list = fail ? TINYFISH_STEPS.slice(0, 4) : TINYFISH_STEPS;
      for (const text of list) {
        await sleep(1150 + Math.random() * 400);
        action({ engine: "tinyfish", text });
      }
      let engine: Browser["engine"] = "tinyfish";
      if (fail) {
        await sleep(1600);
        browser({ ...tf, status: "failed", note: "The careers site stopped responding behind a bot check after 40 s" });
        step("research", { detail: "TinyFish stopped, switching to the backup engine" });
        await sleep(1200);
        engine = "backup";
        let bk: Browser = { engine: "backup", site: SITE, status: "starting", note: "Reading the listing pages directly" };
        browser(bk);
        await sleep(900);
        bk = { ...bk, status: "running" };
        browser(bk);
        step("research", { detail: "Backup engine is reading the listings" });
        for (const text of BACKUP_STEPS) {
          await sleep(900 + Math.random() * 300);
          action({ engine: "backup", text });
        }
        await sleep(600);
        browser({ ...bk, status: "done" });
      } else {
        await sleep(700);
        browser({ ...tf, status: "done" });
      }
      writer.write({ type: "data-roles", id: "roles", data: { ...ROLES, engine } });
      step("research", { status: "done", detail: "3 roles found" });
      await sleep(500);

      // 3 draft, a few words at a time
      step("draft", { status: "running", detail: "Writing to Maya" });
      const draft: Email = { to: EMAIL_TO, subject: SUBJECT, body: "", status: "drafting" };
      email(draft);
      const tokens = BODY.match(/\S+\s*|\s+/g) ?? [];
      for (let i = 0; i < tokens.length; ) {
        const k = 2 + Math.floor(Math.random() * 3);
        draft.body += tokens.slice(i, i + k).join("");
        i += k;
        email({ ...draft });
        await sleep(55 + Math.random() * 45);
      }
      step("draft", { status: "done", detail: draft.body.split(/\s+/).length + " words" });

      // 4 send
      step("send", { status: "running", detail: "From the booth's Gmail" });
      email({ ...draft, status: "sending" });
      await sleep(1600);
      email({ ...draft, status: "sent", messageId: "19a8c2f1e4b7d3a0" });
      step("send", { status: "done", detail: "Delivered to " + EMAIL_TO });
    },
    onError: (e) => (e instanceof Error ? e.message : "The mock run failed"),
  });

  return createUIMessageStreamResponse({ stream });
}

