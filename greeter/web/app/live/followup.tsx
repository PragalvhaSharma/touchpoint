"use client";

// The booth follow-up, shown while it happens. Once a visitor walks away the greeter does the recruiter's
// follow-up: it reads the conversation (listen), sends a TinyFish web agent to the sponsor's live careers site
// (research), writes the email (draft) and sends it (send). The server streams each of those as AI SDK data
// parts (see lib/followup/types.ts); parts with the same id update in place, so this view just reads the latest
// assistant message and draws what is there: the pipeline, the live browser and its steps, the roles, the email.
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type ChatStatus } from "ai";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Shimmer } from "@/components/ai-elements/shimmer";
import type { Action, Brief, Browser, Email, FollowupMessage, FollowupRequest, Roles, Step, StepId } from "@/lib/followup/types";
import { cn } from "@/lib/utils";
import { Face } from "../talk/genui/components/base";

const SPRING = { type: "spring", bounce: 0, duration: 0.5 } as const;
const RED = "#ff453a";

// ---------- the hook ----------

export type FollowUp = {
  /** Starts a fresh run. The request fields go at the top level of the POST body. */
  start: (req: FollowupRequest) => Promise<void>;
  /** The run so far: the latest assistant message. */
  message: FollowupMessage | undefined;
  status: ChatStatus;
  error: Error | undefined;
  /** True while the request is out or the stream is coming in. */
  running: boolean;
  stop: () => Promise<void>;
  reset: () => Promise<void>;
};

export function useFollowUp(opts?: { api?: string }): FollowUp {
  const api = opts?.api ?? "/api/followup";
  const transport = useMemo(
    () =>
      new DefaultChatTransport<FollowupMessage>({
        api,
        // The route reads personId / booth / to / send from the top of the body; the one user message rides along.
        prepareSendMessagesRequest: ({ id, messages, body }) => ({ body: { ...body, id, messages: messages.slice(-1) } }),
      }),
    [api],
  );
  const chat = useChat<FollowupMessage>({ id: "followup:" + api, transport });
  const { messages, status, error, sendMessage, setMessages, stop: chatStop, clearError } = chat;
  const running = status === "submitted" || status === "streaming";

  const stop = useCallback(async () => {
    await chatStop();
  }, [chatStop]);
  const reset = useCallback(async () => {
    await chatStop();
    setMessages([]);
    clearError();
  }, [chatStop, setMessages, clearError]);
  const start = useCallback(
    async (req: FollowupRequest) => {
      await chatStop();
      setMessages([]);
      clearError();
      await sendMessage({ text: "Follow up with " + req.personId }, { body: { ...req } });
    },
    [chatStop, setMessages, clearError, sendMessage],
  );

  const message = messages.findLast((m) => m.role === "assistant");
  return { start, message, status, error, running, stop, reset };
}

// ---------- reading the run ----------

type Run = {
  steps: Partial<Record<StepId, Step>>;
  brief?: Brief;
  browsers: Browser[];
  actions: Action[];
  roles?: Roles;
  email?: Email;
};

function readRun(message: FollowupMessage | undefined): Run {
  const run: Run = { steps: {}, browsers: [], actions: [] };
  for (const p of message?.parts ?? []) {
    if (p.type === "data-step") run.steps[p.data.id] = p.data;
    else if (p.type === "data-brief") run.brief = p.data;
    else if (p.type === "data-browser") run.browsers.push(p.data);
    else if (p.type === "data-action") run.actions.push(p.data);
    else if (p.type === "data-roles") run.roles = p.data;
    else if (p.type === "data-email") run.email = p.data;
  }
  return run;
}

const host = (u?: string) => {
  if (!u) return "";
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return u;
  }
};
const urlParts = (u?: string) => {
  try {
    const x = new URL(u ?? "");
    return { host: x.host.replace(/^www\./, ""), path: decodeURI(x.pathname + x.search).replace(/\/$/, "") };
  } catch {
    return { host: u ?? "", path: "" };
  }
};
const secs = (ms: number) => (ms < 60_000 ? (ms / 1000).toFixed(1) + " s" : Math.floor(ms / 60_000) + " m " + Math.round((ms % 60_000) / 1000) + " s");
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** A clock that ticks only while it is live; each one re-renders on its own. */
function useNow(live: boolean, every = 100) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [live, every]);
  return now;
}

function Elapsed({ from, to, live, className }: { from: number; to?: number; live: boolean; className?: string }) {
  const now = useNow(live && !to);
  return <span className={cn("tabular-nums", className)}>{secs(Math.max(0, (to ?? (live ? now : from)) - from))}</span>;
}

// ---------- the view ----------

type ViewProps = {
  message: FollowupMessage | undefined;
  status: ChatStatus;
  error?: Error;
  onClose?: () => void;
  /** Force one column (the side panel). Otherwise it goes two-column when its container is wide. */
  compact?: boolean;
  className?: string;
};

export function FollowUpView({ message, status, error, onClose, compact, className }: ViewProps) {
  const reduce = !!useReducedMotion();
  const live = status === "submitted" || status === "streaming";
  const run = useMemo(() => {
    const r = readRun(message);
    if (live || !message) return r;
    // The stream is over, so anything still marked running was cut off (Stop, a closed tab, an error).
    const why = error ? "Stopped: " + (error.message || "something went wrong") : "Stopped before it finished";
    for (const id of Object.keys(r.steps) as StepId[]) {
      const s = r.steps[id];
      if (s?.status === "running") r.steps[id] = { ...s, status: "failed", detail: why };
      else if (s?.status === "waiting") r.steps[id] = { ...s, status: "skipped" };
    }
    r.browsers = r.browsers.map((b) => (b.status === "starting" || b.status === "running" ? { ...b, status: "failed", note: why } : b));
    if (r.email?.status === "drafting") r.email = { ...r.email, status: "failed", error: why };
    else if (r.email?.status === "sending") r.email = { ...r.email, status: "held", error: "The page stopped watching while it sent. Check the booth's Sent folder." };
    return r;
  }, [message, live, error]);
  const steps = run.steps;
  const company = run.brief?.company ?? run.roles?.company;

  const starts = Object.values(steps).map((s) => s?.startedAt).filter((x): x is number => !!x);
  const ends = Object.values(steps).map((s) => s?.endedAt).filter((x): x is number => !!x);
  const from = starts.length ? Math.min(...starts) : undefined;
  const settled = !live && (!!message || !!error);
  const to = settled && ends.length ? Math.max(...ends) : undefined;
  const emailSent = run.email?.status === "sent";
  const outcome = live
    ? "Working"
    : !settled
      ? ""
      : emailSent
        ? "Sent"
        : error || Object.values(steps).some((s) => s?.status === "failed")
          ? "Stopped"
          : "Done";

  const vars = {
    "--accent": "#a594ff",
    "--accent-soft": "rgba(165,148,255,0.16)",
    "--color-background": "#ffffff",
    "--color-muted-foreground": "rgba(235,235,245,0.5)",
  } as CSSProperties;

  const wide = !compact;
  const col = wide ? "contents @4xl:flex @4xl:flex-col @4xl:gap-3" : "contents";

  return (
    <div style={vars} className={cn("@container w-full text-label", className)}>
      <div className="flex flex-col gap-3">
        <Header brief={run.brief} company={company} from={from} to={to} live={live} outcome={outcome} onClose={onClose} reduce={reduce} compact={compact} />
        <div className={cn("flex flex-col gap-3", wide && "@4xl:grid @4xl:grid-cols-[minmax(0,1.45fr)_minmax(400px,1fr)] @4xl:items-start @4xl:gap-4")}>
          <div className={cn(col, wide && "@4xl:sticky @4xl:top-4")}>
            <BrowserCard run={run} live={live} reduce={reduce} compact={compact} className="order-2" />
            <Switched run={run} reduce={reduce} className="order-3" />
          </div>
          <div className={col}>
            <Pipeline steps={steps} live={live} settled={settled} error={error} emailSent={emailSent} reduce={reduce} compact={compact} className="order-1" />
            <AnimatePresence initial={false}>
              {run.brief && <BriefCard key="brief" brief={run.brief} reduce={reduce} className={cn("order-4", compact && "p-4")} />}
              {run.roles && <RolesCard key="roles" roles={run.roles} reduce={reduce} className={cn("order-5", compact && "p-4")} />}
              {run.email && <EmailCard key="email" email={run.email} sendStep={steps.send} reduce={reduce} className="order-6" />}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- header ----------

function Header({
  brief,
  company,
  from,
  to,
  live,
  outcome,
  onClose,
  reduce,
  compact,
}: {
  brief?: Brief;
  company?: string;
  from?: number;
  to?: number;
  live: boolean;
  outcome: string;
  onClose?: () => void;
  reduce: boolean;
  compact?: boolean;
}) {
  const p = brief?.person;
  const avatar = (
    <AnimatePresence mode="popLayout" initial={false}>
      {p ? (
        <motion.span key={p.id} initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.8, filter: "blur(6px)" }} animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }} transition={SPRING}>
          <Face name={p.name} srcs={p.photo ? [p.photo] : []} size={compact ? 48 : 52} />
        </motion.span>
      ) : (
        <motion.span key="wait" exit={{ opacity: 0 }} className={cn("relative grid shrink-0 place-items-center rounded-full bg-white/[0.06]", compact ? "size-12" : "size-[52px]")}>
          {live && !reduce && <span className="absolute inset-0 animate-ping rounded-full bg-[var(--accent-soft)]" />}
          <Ear />
        </motion.span>
      )}
    </AnimatePresence>
  );
  const timer = from ? (
    <span className={cn("flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[12.5px]", live ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "bg-white/[0.06] text-label-2")}>
      {live && (
        <span className="relative grid size-1.5 place-items-center">
          {!reduce && <span className="absolute size-1.5 animate-ping rounded-full bg-[var(--accent)] opacity-60" />}
          <span className="size-1.5 rounded-full bg-[var(--accent)]" />
        </span>
      )}
      <Elapsed from={from} to={to} live={live} />
    </span>
  ) : null;
  const close = onClose && (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close the follow-up"
      className="press grid size-8 shrink-0 place-items-center self-start rounded-full bg-white/[0.08] text-label-2 hover:bg-white/15 hover:text-label"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  );

  // The side sheet is narrow: the name gets the whole width, and the timer and the outcome sit under it as pills.
  if (compact)
    return (
      <header className="flex items-start gap-3 rounded-[22px] bg-white/[0.04] p-3.5 ring-1 ring-white/[0.06]">
        {avatar}
        <div className="min-w-0 flex-1">
          <p className="text-[11.5px] font-semibold uppercase leading-snug tracking-[0.09em] text-[var(--accent)]">
            {company ? (brief?.match ? "Best fit · " : "Follow-up · ") + company : "Follow-up"}
          </p>
          {p ? (
            <h2 className="title mt-0.5 text-[21px] font-bold leading-tight">{p.name}</h2>
          ) : live ? (
            <Shimmer as="h2" duration={2.2} className="title mt-0.5 text-[21px] font-bold">
              Reading the conversation
            </Shimmer>
          ) : (
            <h2 className="title mt-0.5 text-[21px] font-bold text-label-2">Waiting for a visitor</h2>
          )}
          {p?.role && <p className="mt-0.5 truncate text-[13px] text-label-2">{p.role}</p>}
          {(timer || outcome) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {timer}
              {outcome && <Outcome outcome={outcome} />}
            </div>
          )}
        </div>
        {close}
      </header>
    );

  return (
    <header className="relative flex items-center gap-3.5 overflow-hidden rounded-[24px] bg-white/[0.035] p-4 pr-5 ring-1 ring-white/[0.06]">
      {avatar}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11.5px] font-semibold uppercase tracking-[0.09em] text-[var(--accent)]">
          {company ? (brief?.match ? "Best fit · " : "Following up for ") + company : "Follow-up"}
        </p>
        {p ? (
          <h2 className="title mt-0.5 truncate text-[22px] font-bold">{p.name}</h2>
        ) : live ? (
          <Shimmer as="h2" duration={2.2} className="title mt-0.5 text-[22px] font-bold">
            Reading the conversation
          </Shimmer>
        ) : (
          <h2 className="title mt-0.5 text-[22px] font-bold text-label-2">Waiting for a visitor</h2>
        )}
        {p?.role && <p className="truncate text-[13px] text-label-2">{p.role}</p>}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        {timer}
        {outcome && <Outcome outcome={outcome} />}
      </div>
      {close}
    </header>
  );
}

/** Working, Sent, Done or Stopped. Stopped is red, so a run cut short never reads as finished. */
function Outcome({ outcome }: { outcome: string }) {
  return (
    <span
      className={cn(
        "whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] font-semibold",
        outcome === "Stopped"
          ? "bg-[rgba(255,69,58,0.14)] text-[#ff6961]"
          : outcome === "Sent"
            ? "bg-[rgba(48,209,88,0.14)] text-green"
            : outcome === "Working"
              ? "bg-white/[0.06] text-label-2"
              : "bg-white/[0.06] text-label",
      )}
    >
      {outcome}
    </span>
  );
}

// ---------- the pipeline ----------

const STEPS: { id: StepId; label: string }[] = [
  { id: "listen", label: "Listen" },
  { id: "research", label: "Research" },
  { id: "draft", label: "Draft" },
  { id: "send", label: "Send" },
];

function Pipeline({
  steps,
  live,
  settled,
  error,
  emailSent,
  reduce,
  compact,
  className,
}: {
  steps: Run["steps"];
  live: boolean;
  settled: boolean;
  error?: Error;
  emailSent: boolean;
  reduce: boolean;
  compact?: boolean;
  className?: string;
}) {
  const running = STEPS.map((s) => steps[s.id]).find((s) => s?.status === "running");
  const failed = STEPS.map((s) => steps[s.id]).find((s) => s?.status === "failed");
  const sendDone = steps.send?.status === "done";
  const now = error
    ? { text: error.message || "The follow-up stopped", tone: "bad" as const }
    : running
      ? { text: running.detail ?? running.title, tone: "live" as const }
      : failed
        ? { text: failed.title + (failed.detail ? ": " + failed.detail : " failed"), tone: "bad" as const }
        : sendDone
          ? { text: emailSent ? "Follow-up sent. Nothing left for the recruiter to do." : steps.send?.detail ?? "Draft saved", tone: "good" as const }
          : settled
            ? { text: steps.send?.detail ?? "Follow-up finished", tone: "idle" as const }
            : live
              ? { text: "Starting the follow-up", tone: "live" as const }
              : { text: "Ready when a visitor walks away", tone: "idle" as const };

  return (
    <section className={cn("rounded-[24px] bg-white/[0.035] p-3 ring-1 ring-white/[0.06]", className)}>
      {/* four across is too tight for "Research" in the side sheet, so there it is two by two */}
      <ol className={cn("grid gap-1.5", compact ? "grid-cols-2" : "grid-cols-4")}>
        {STEPS.map((s, i) => (
          <StepPill key={s.id} n={i + 1} label={s.label} step={steps[s.id]} live={live} reduce={reduce} row={compact} />
        ))}
      </ol>
      <div className="mt-2.5 flex min-h-[22px] items-center gap-2 px-1.5 text-[13.5px] font-medium" aria-live="polite">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={now.text}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 6, filter: "blur(3px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={SPRING}
            className="flex min-w-0 items-start gap-2"
          >
            <span
              className={cn(
                "mt-[7px] size-1.5 shrink-0 rounded-full",
                now.tone === "live" ? "bg-[var(--accent)]" : now.tone === "good" ? "bg-green" : now.tone === "bad" ? "bg-[#ff453a]" : "bg-white/30",
              )}
            />
            {now.tone === "live" ? (
              <Shimmer as="span" duration={2.2} className="leading-snug">
                {now.text}
              </Shimmer>
            ) : (
              <span className={cn("leading-snug", now.tone === "bad" ? "text-[#ff6961]" : now.tone === "good" ? "text-label" : "text-label-2")}>{now.text}</span>
            )}
          </motion.span>
        </AnimatePresence>
      </div>
    </section>
  );
}

function StepPill({ n, label, step, live, reduce, row }: { n: number; label: string; step?: Step; live: boolean; reduce: boolean; row?: boolean }) {
  const st = step?.status ?? "waiting";
  const on = st === "running";
  const time =
    st === "done" && step?.startedAt && step.endedAt ? (
      <span className="text-label-2">{secs(step.endedAt - step.startedAt)}</span>
    ) : on && step?.startedAt ? (
      <Elapsed from={step.startedAt} live={live} className="text-[var(--accent)]" />
    ) : st === "failed" ? (
      <span className="text-[#ff6961]">Failed</span>
    ) : st === "skipped" ? (
      "Skipped"
    ) : on ? (
      <span className="text-[var(--accent)]">Running</span>
    ) : (
      "Waiting"
    );
  return (
    <li
      className={cn(
        "relative overflow-hidden rounded-[16px] ring-1 transition-[background-color,box-shadow] duration-500",
        row ? "flex items-center gap-2 px-3 py-2.5" : "px-2.5 pb-2.5 pt-2",
        on
          ? "bg-[rgba(165,148,255,0.1)] shadow-[0_0_0_1px_rgba(165,148,255,0.5),0_14px_36px_-18px_rgba(165,148,255,0.7)] ring-transparent"
          : st === "done"
            ? "bg-white/[0.04] ring-white/[0.06]"
            : st === "failed"
              ? "bg-[rgba(255,69,58,0.08)] ring-[rgba(255,69,58,0.35)]"
              : "bg-transparent ring-white/[0.05]",
      )}
    >
      {row ? (
        <>
          <StepIcon status={st} n={n} reduce={reduce} />
          <span className={cn("min-w-0 flex-1 text-[14px] font-semibold", st === "waiting" || st === "skipped" ? "text-label-3" : "text-label")}>{label}</span>
          <span className="shrink-0 font-mono text-[11.5px] text-label-3">{time}</span>
        </>
      ) : (
        <>
          <div className="flex items-center gap-1.5">
            <StepIcon status={st} n={n} reduce={reduce} />
            <span className={cn("truncate text-[13.5px] font-semibold", st === "waiting" || st === "skipped" ? "text-label-3" : "text-label")}>{label}</span>
          </div>
          <p className="mt-1 truncate font-mono text-[11.5px] text-label-3">{time}</p>
        </>
      )}
      {on && !reduce && (
        <motion.span
          aria-hidden
          className="absolute bottom-0 left-0 h-[2px] w-1/2 bg-[linear-gradient(90deg,transparent,var(--accent),transparent)]"
          initial={{ x: "-100%" }}
          animate={{ x: "200%" }}
          transition={{ duration: 1.4, ease: "easeInOut", repeat: Infinity }}
        />
      )}
    </li>
  );
}

function StepIcon({ status, n, reduce }: { status: Step["status"]; n: number; reduce: boolean }) {
  const box = "grid size-[18px] shrink-0 place-items-center rounded-full";
  if (status === "done")
    return (
      <motion.span initial={reduce ? false : { scale: 0.4 }} animate={{ scale: 1 }} transition={SPRING} className={cn(box, "bg-green")}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </motion.span>
    );
  if (status === "failed")
    return (
      <span className={cn(box, "bg-[#ff453a]")}>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="4" strokeLinecap="round" aria-hidden>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </span>
    );
  if (status === "running") return <Spinner size={18} reduce={reduce} />;
  if (status === "skipped") return <span className={cn(box, "bg-white/[0.06] text-[11px] font-bold text-label-3")}>–</span>;
  return <span className={cn(box, "text-[10.5px] font-bold text-label-3 ring-1 ring-white/15")}>{n}</span>;
}

function Spinner({ size = 16, reduce, color = "var(--accent)" }: { size?: number; reduce: boolean; color?: string }) {
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="shrink-0"
      animate={reduce ? undefined : { rotate: 360 }}
      transition={{ duration: 0.9, ease: "linear", repeat: Infinity }}
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,0.14)" strokeWidth="3" />
      <path d="M12 3a9 9 0 0 1 9 9" stroke={color} strokeWidth="3" strokeLinecap="round" />
    </motion.svg>
  );
}

// ---------- the live browser ----------

function BrowserCard({ run, live, reduce, compact, className }: { run: Run; live: boolean; reduce: boolean; compact?: boolean; className?: string }) {
  const b = run.browsers.at(-1);
  const research = run.steps.research;
  const site = urlParts(b?.site);
  const engineLabel = b?.engine === "backup" ? "Backup engine" : "TinyFish web agent";
  const working = !!b && (b.status === "starting" || b.status === "running") && live;
  const finished = b?.status === "done";
  const actions = run.actions;
  const own = b ? actions.filter((a) => a.engine === b.engine).length : 0;
  const last = actions.at(-1);
  // Keep the live view mounted after the run so the frame stays put under the "Run finished" glass.
  // about:blank (the mock) has nothing to show, so it gets the working placeholder instead.
  const frame =
    b?.streamingUrl && b.streamingUrl !== "about:blank" && (b.status === "running" || b.status === "starting" || b.status === "done") ? b.streamingUrl : undefined;
  // In the side sheet the viewport is a slim status strip until there is a live frame to watch, then it opens up.
  const row = !!compact && !frame;

  return (
    <section className={cn("overflow-hidden rounded-[24px] bg-[#141416] ring-1 ring-white/[0.07] shadow-[0_30px_80px_-40px_rgba(0,0,0,0.9)]", className)}>
      {/* window chrome */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] bg-[#1c1c1e] px-3.5 py-2.5">
        <span className="flex shrink-0 gap-1.5" aria-hidden>
          <span className="size-3 rounded-full bg-[#ff5f57]" />
          <span className="size-3 rounded-full bg-[#febc2e]" />
          <span className="size-3 rounded-full bg-[#28c840]" />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[9px] bg-black/40 px-2.5 py-1.5 ring-1 ring-white/[0.05]">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0 text-label-3" aria-hidden>
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
          <span className="min-w-0 truncate font-mono text-[12px]">
            {b ? (
              <>
                <span className="text-label">{site.host}</span>
                <span className="text-label-3">{site.path}</span>
              </>
            ) : (
              <span className="text-label-3">about:blank</span>
            )}
          </span>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          {b && (
            <span
              className={cn(
                "hidden items-center gap-1.5 rounded-full px-2 py-1 text-[11.5px] font-semibold @md:flex",
                b.engine === "backup" ? "bg-[rgba(255,159,10,0.14)] text-orange" : "bg-[var(--accent-soft)] text-[var(--accent)]",
              )}
            >
              {b.engine === "backup" ? <Gear /> : <Fish />}
              <span className="@xl:hidden">{b.engine === "backup" ? "Backup" : "TinyFish"}</span>
              <span className="hidden @xl:inline">{engineLabel}</span>
            </span>
          )}
          <LiveBadge state={!b ? "idle" : working ? "live" : b.status === "failed" ? "failed" : finished ? "done" : "idle"} reduce={reduce} />
        </span>
      </div>

      {/* the viewport */}
      <div
        className={cn(
          "relative w-full overflow-hidden bg-[#0b0b0d]",
          compact ? "transition-[height] duration-500 ease-out " + (frame ? "h-[clamp(220px,32vh,300px)]" : "h-[104px]") : "aspect-[16/10] @4xl:aspect-auto @4xl:h-[min(54vh,600px)]",
        )}
      >
        {frame && (
          <iframe
            key={frame}
            src={frame}
            title={engineLabel + " live view"}
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
            className={cn("absolute inset-0 size-full border-0 bg-[#0b0b0d] transition-[filter,opacity] duration-700", finished && "opacity-60 blur-[2px]")}
          />
        )}
        <AnimatePresence initial={false} mode="popLayout">
          {!b ? (
            <Overlay
              key="idle"
              reduce={reduce}
              row={row}
              icon={<Idle />}
              title="The web agent is standing by"
              note={<>It opens the sponsor&apos;s live careers site as soon as the conversation is read.</>}
            />
          ) : b.status === "failed" ? (
            <Overlay
              key="failed"
              reduce={reduce}
              row={row}
              tint="rgba(255,69,58,0.08)"
              icon={
                <span className="grid size-11 shrink-0 place-items-center rounded-full bg-[rgba(255,69,58,0.16)] text-[#ff6961]">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                    <path d="M12 8v5M12 16.5v.5" />
                    <circle cx="12" cy="12" r="9" />
                  </svg>
                </span>
              }
              title={engineLabel + " stopped"}
              note={b.note}
            />
          ) : finished ? (
            <Overlay
              key="done"
              reduce={reduce}
              row={row}
              glass={!!frame}
              icon={
                <span className="grid size-11 shrink-0 place-items-center rounded-full bg-green text-black">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M5 12.5l4.5 4.5L19 7.5" />
                  </svg>
                </span>
              }
              title="Run finished"
              note={
                <>
                  {own} steps on {site.host}
                  {run.roles ? " · " + run.roles.roles.length + " roles found" : ""}
                  {research?.startedAt && research.endedAt ? " · " + secs(research.endedAt - research.startedAt) : ""}
                </>
              }
            />
          ) : !frame ? (
            <Overlay
              key={"wait-" + b.engine}
              reduce={reduce}
              row={row}
              plain
              backdrop={<Wireframe reduce={reduce} />}
              icon={<Spinner size={26} reduce={reduce} color={b.engine === "backup" ? "var(--orange)" : "var(--accent)"} />}
              title={
                <Shimmer as="span" duration={2} className={cn("font-semibold", !row && "@md:text-[17px]")}>
                  {b.status === "starting"
                    ? b.engine === "backup"
                      ? "Starting the backup engine"
                      : "Launching a cloud browser"
                    : b.engine === "backup"
                      ? "Reading " + site.host
                      : b.streamingUrl
                        ? "TinyFish is browsing " + site.host
                        : "Connecting to the live view"}
                </Shimmer>
              }
              note={
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={last && b.status === "running" ? last.text : "note"}
                    initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8, filter: "blur(4px)" }}
                    animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                    exit={{ opacity: 0, transition: { duration: 0.12 } }}
                    transition={SPRING}
                    className={cn("block", row ? "line-clamp-2" : "@md:text-[14.5px]")}
                  >
                    {last && b.status === "running" ? last.text : b.note ?? "Opening " + site.host}
                  </motion.span>
                </AnimatePresence>
              }
            />
          ) : null}
        </AnimatePresence>
      </div>

      <Ticker actions={actions} live={working} base={research?.startedAt} reduce={reduce} compact={compact} />
    </section>
  );
}

/** What the viewport says when there is no frame to show (or over the last frame): an icon, a title, a note.
 *  row lays it out side by side for the slim strip in the side sheet. */
function Overlay({
  icon,
  title,
  note,
  backdrop,
  row,
  reduce,
  tint,
  glass,
  plain,
}: {
  icon: ReactNode;
  title: ReactNode;
  note?: ReactNode;
  backdrop?: ReactNode;
  row?: boolean;
  reduce: boolean;
  tint?: string;
  glass?: boolean;
  plain?: boolean;
}) {
  return (
    <motion.div
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.985, filter: "blur(6px)" }}
      animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
      transition={SPRING}
      style={tint ? { background: tint } : undefined}
      className={cn(
        "absolute inset-0 flex",
        row ? "flex-row items-center gap-3.5 px-4 py-3 text-left" : "flex-col items-center justify-center p-6 text-center",
        glass && "bg-black/45 backdrop-blur-md",
        !plain && !glass && !tint && "bg-[radial-gradient(ellipse_at_center,rgba(165,148,255,0.07),transparent_65%)]",
      )}
    >
      {backdrop}
      <span className="relative flex shrink-0">{icon}</span>
      <div className={cn("relative min-w-0", !row && "mt-3 flex flex-col items-center")}>
        <p className={cn("font-semibold leading-snug", row ? "text-[15px]" : "text-[15px] @md:text-[16px]")}>{title}</p>
        {note && <p className={cn("mt-1 text-[13px] leading-snug text-label-2", !row && "max-w-[44ch]")}>{note}</p>}
      </div>
    </motion.div>
  );
}

/** A faint page sketch while the browser loads, with a light sweeping across it. */
function Wireframe({ reduce }: { reduce: boolean }) {
  return (
    <div className="absolute inset-0 overflow-hidden p-[5%] opacity-60" aria-hidden>
      <div className="flex items-center justify-between">
        <div className="h-[6%] min-h-3 w-[18%] rounded bg-white/[0.06]" />
        <div className="flex w-[30%] gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-2.5 flex-1 rounded bg-white/[0.05]" />
          ))}
        </div>
      </div>
      <div className="mt-[6%] h-[11%] w-[56%] rounded-lg bg-white/[0.05]" />
      <div className="mt-[3%] grid grid-cols-3 gap-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-16 rounded-lg bg-white/[0.04] ring-1 ring-white/[0.03]" />
        ))}
      </div>
      {!reduce && (
        <motion.div
          className="absolute inset-y-0 w-1/3 bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.05),transparent)]"
          initial={{ x: "-120%" }}
          animate={{ x: "380%" }}
          transition={{ duration: 2.2, ease: "easeInOut", repeat: Infinity }}
        />
      )}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(11,11,13,0.55),#0b0b0d_75%)]" />
    </div>
  );
}

function LiveBadge({ state, reduce }: { state: "idle" | "live" | "done" | "failed"; reduce: boolean }) {
  if (state === "live")
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-[rgba(255,69,58,0.16)] px-2 py-1 text-[11px] font-bold tracking-[0.08em] text-[#ff6961]">
        <span className="relative grid size-1.5 place-items-center">
          {!reduce && <span className="absolute size-1.5 animate-ping rounded-full opacity-70" style={{ background: RED }} />}
          <span className="size-1.5 rounded-full" style={{ background: RED }} />
        </span>
        LIVE
      </span>
    );
  const label = state === "done" ? "Finished" : state === "failed" ? "Stopped" : "Idle";
  return (
    <span className={cn("rounded-full px-2 py-1 text-[11px] font-semibold", state === "failed" ? "bg-[rgba(255,69,58,0.12)] text-[#ff6961]" : "bg-white/[0.06] text-label-3")}>
      {label}
    </span>
  );
}

// ---------- what the agent did, step by step ----------

function Ticker({ actions, live, base, reduce, compact }: { actions: Action[]; live: boolean; base?: number; reduce: boolean; compact?: boolean }) {
  const box = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [actions.length, reduce]);
  const t0 = base ?? actions[0]?.t ?? 0;
  const rel = (t: number) => (t > 1e11 ? Math.max(0, t - t0) : t);

  return (
    <div className="border-t border-white/[0.06]">
      <div className="flex items-center justify-between px-4 pb-1 pt-3">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.09em] text-label-3">Agent steps</p>
        <p className="font-mono text-[11.5px] text-label-3">{actions.length || ""}</p>
      </div>
      <ol
        ref={box}
        className={cn(
          "no-scrollbar relative flex min-h-[52px] flex-col gap-0.5 overflow-y-auto px-2 pb-2.5 [mask-image:linear-gradient(to_bottom,transparent,black_14px)]",
          compact ? "max-h-[148px]" : "max-h-[200px]",
        )}
      >
        {actions.length === 0 && <li className="px-2 py-2 text-[13px] text-label-3">Each click and page the agent reads shows up here.</li>}
        <AnimatePresence initial={false}>
          {actions.map((a, i) => {
            const newest = i === actions.length - 1;
            const prev = actions[i - 1];
            const switched = prev && prev.engine !== a.engine;
            return (
              <Fragment key={i}>
                {switched && (
                  <li className="mx-2 my-1 flex items-center gap-2 text-[11.5px] font-semibold text-orange">
                    <span className="h-px flex-1 bg-[rgba(255,159,10,0.3)]" />
                    Backup engine takes over
                    <span className="h-px flex-1 bg-[rgba(255,159,10,0.3)]" />
                  </li>
                )}
                <motion.li
                  initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10, filter: "blur(4px)" }}
                  animate={{ opacity: newest ? 1 : 0.7, y: 0, filter: "blur(0px)" }}
                  transition={SPRING}
                  className={cn(
                    "flex items-start gap-2.5 rounded-[12px] px-2 py-1.5 transition-colors duration-500",
                    newest && live ? "bg-[var(--accent-soft)]" : "",
                  )}
                >
                  <span
                    className={cn(
                      "mt-[3px] grid size-[15px] shrink-0 place-items-center rounded-full font-mono text-[9px] font-bold",
                      newest && live ? "bg-[var(--accent)] text-black" : a.engine === "backup" ? "bg-[rgba(255,159,10,0.18)] text-orange" : "bg-white/[0.08] text-label-2",
                    )}
                  >
                    {i + 1}
                  </span>
                  <span className={cn("min-w-0 flex-1 text-[13.5px] leading-snug", newest ? "text-label" : "text-label-2")}>{a.text}</span>
                  <span className="mt-[2px] shrink-0 font-mono text-[11px] text-label-3">+{secs(rel(a.t)).replace(" s", "s")}</span>
                </motion.li>
              </Fragment>
            );
          })}
        </AnimatePresence>
      </ol>
    </div>
  );
}

// ---------- the switch to the backup ----------

function Switched({ run, reduce, className }: { run: Run; reduce: boolean; className?: string }) {
  const tf = run.browsers.find((b) => b.engine === "tinyfish");
  const backup = run.browsers.find((b) => b.engine === "backup");
  const show = !!backup && (tf?.status === "failed" || !tf);
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: -8, filter: "blur(4px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={SPRING}
          className={cn("flex items-start gap-3 rounded-[20px] bg-[rgba(255,159,10,0.08)] p-3.5 ring-1 ring-[rgba(255,159,10,0.28)]", className)}
        >
          <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-[rgba(255,159,10,0.18)] text-orange">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 7h13l-3-3M20 17H7l3 3" />
            </svg>
          </span>
          <div className="min-w-0 text-[13.5px] leading-snug">
            <p className="font-semibold text-label">{tf ? "TinyFish couldn't finish, so the backup engine took over" : "TinyFish isn't available, so the backup engine is doing the research"}</p>
            <p className="mt-0.5 text-label-2">
              {tf?.note ? tf.note + ". " : ""}
              {backup?.note ?? "It reads the same careers site another way."}
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------- cards ----------

function Card({ label, aside, reduce, className, children }: { label: string; aside?: ReactNode; reduce: boolean; className?: string; children: ReactNode }) {
  return (
    <motion.section
      layout={reduce ? false : "position"}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.98, filter: "blur(8px)" }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      transition={SPRING}
      className={cn("relative rounded-[24px] bg-white/[0.035] p-5 ring-1 ring-white/[0.06]", className)}
    >
      <header className="mb-3 flex items-center justify-between gap-3">
        <p className="shrink-0 whitespace-nowrap text-[11.5px] font-semibold uppercase tracking-[0.09em] text-label-3">{label}</p>
        {aside}
      </header>
      {children}
    </motion.section>
  );
}

function BriefCard({ brief, reduce, className }: { brief: Brief; reduce: boolean; className?: string }) {
  return (
    <Card label="What they build" reduce={reduce} className={className}>
      <p className="text-[15.5px] leading-snug">{brief.summary}</p>
      {!!brief.built?.length && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {brief.built.map((x) => {
            const [name, ...rest] = x.split(": ");
            return (
              <li key={x} className="flex gap-2.5 text-[13.5px] leading-snug">
                <span aria-hidden className="mt-[6px] size-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
                <span>
                  <span className="font-semibold text-label">{rest.length ? name : x}</span>
                  {rest.length > 0 && <span className="text-label-2">: {rest.join(": ")}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {brief.match && (
        <p className="mt-3 rounded-[14px] bg-[var(--accent-soft)] px-3 py-2 text-[13.5px] leading-snug text-[#d9d1ff]">
          <span className="font-semibold text-white">Best fit: {brief.company}.</span> {brief.match}
        </p>
      )}
      {brief.interests.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {brief.interests.map((x) => (
            <li key={x} className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[12.5px] font-medium text-[#c9bfff]">
              {x}
            </li>
          ))}
        </ul>
      )}
      {brief.asks.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2 border-t border-white/[0.06] pt-3.5">
          {brief.asks.map((a) => (
            <li key={a} className="flex gap-2.5 text-[13.5px] leading-snug text-label-2">
              <span className="mt-[1px] shrink-0 font-serif text-[18px] leading-none text-[var(--accent)]">“</span>
              <span>{a}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RolesCard({ roles, reduce, className }: { roles: Roles; reduce: boolean; className?: string }) {
  return (
    <Card
      label="Roles that fit"
      reduce={reduce}
      className={className}
      aside={
        <span className={cn("flex min-w-0 items-center gap-1.5 text-[11.5px] font-medium", roles.engine === "backup" ? "text-orange" : "text-[var(--accent)]")}>
          {roles.engine === "backup" ? <Gear /> : <Fish />}
          <span className="truncate">
            {roles.engine === "backup" ? "Backup engine" : "TinyFish"} · {host(roles.source)}
          </span>
        </span>
      }
    >
      <ul className="flex flex-col gap-2">
        {roles.roles.map((r, i) => (
          <motion.li
            key={r.url + r.title}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...SPRING, delay: reduce ? 0 : i * 0.08 }}
          >
            <a
              href={r.url}
              target="_blank"
              rel="noopener noreferrer"
              className="press group block rounded-[16px] bg-white/[0.04] p-3.5 ring-1 ring-white/[0.05] hover:bg-white/[0.07]"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="text-[15px] font-semibold leading-snug">{r.title}</p>
                <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-white/[0.07] text-label-2 transition-colors group-hover:bg-blue group-hover:text-white">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M7 17L17 7M9 7h8v8" />
                  </svg>
                </span>
              </div>
              {(r.location || r.team) && <p className="mt-0.5 text-[12.5px] font-medium text-label-3">{[r.team, r.location].filter(Boolean).join(" · ")}</p>}
              <p className="mt-1.5 text-[13.5px] leading-snug text-label-2">{r.why}</p>
            </a>
          </motion.li>
        ))}
      </ul>
    </Card>
  );
}

// ---------- the email ----------

function EmailCard({ email, sendStep, reduce, className }: { email: Email; sendStep?: Step; reduce: boolean; className?: string }) {
  const drafting = email.status === "drafting";
  const sent = email.status === "sent";
  const bad = email.status === "failed" || email.status === "held";
  const [seen] = useState(() => Date.now());
  const sentAt = sendStep?.endedAt ?? seen;
  // Bring the email into view once, as it starts being written: it is the payoff.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const t = setTimeout(() => ref.current?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" }), 250);
    return () => clearTimeout(t);
  }, [reduce]);
  // ...and once it is sent, make sure the Sent line at the bottom is in view.
  useEffect(() => {
    if (!sent && !bad) return;
    const t = setTimeout(() => ref.current?.scrollIntoView({ block: "end", behavior: reduce ? "auto" : "smooth" }), 300);
    return () => clearTimeout(t);
  }, [sent, bad, reduce]);
  return (
    <motion.section
      ref={ref}
      layout={reduce ? false : "position"}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.98, filter: "blur(8px)" }}
      animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      transition={SPRING}
      className={cn(
        "relative scroll-mt-4 overflow-hidden rounded-[24px] bg-[#1c1c1e] ring-1 transition-[box-shadow] duration-700",
        sent
          ? "shadow-[0_0_0_1px_rgba(48,209,88,0.55),0_30px_70px_-30px_rgba(48,209,88,0.45)] ring-transparent"
          : bad
            ? "ring-[rgba(255,69,58,0.4)]"
            : "ring-white/[0.08]",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 px-5 pb-3 pt-4">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.09em] text-label-3">Follow-up email</p>
        <span className="flex items-center gap-1.5 text-[11.5px] font-medium text-label-3">
          <Mail /> Gmail
        </span>
      </div>
      <dl className="mx-5 border-y border-white/[0.07] text-[13.5px]">
        <div className="flex gap-3 py-2">
          <dt className="w-14 shrink-0 text-label-3">To</dt>
          <dd className="min-w-0 truncate">
            <span className="rounded-full bg-white/[0.07] px-2 py-0.5 text-label">{email.to}</span>
          </dd>
        </div>
        <div className="flex gap-3 border-t border-white/[0.07] py-2">
          <dt className="w-14 shrink-0 text-label-3">Subject</dt>
          <dd className="min-w-0 font-semibold leading-snug">{email.subject}</dd>
        </div>
      </dl>
      <div className="px-5 pb-5 pt-4 text-[14.5px] leading-[1.55] text-[rgba(235,235,245,0.86)]">
        <Markdown text={email.body} caret={drafting} reduce={reduce} />
      </div>
      <SendBar email={email} sentAt={sentAt} reduce={reduce} />
    </motion.section>
  );
}

function SendBar({ email, sentAt, reduce }: { email: Email; sentAt: number; reduce: boolean }) {
  const s = email.status;
  return (
    <div
      className={cn(
        "flex min-h-[52px] items-center gap-2.5 border-t px-5 py-3 text-[13.5px] font-medium transition-colors duration-500",
        s === "sent"
          ? "border-[rgba(48,209,88,0.25)] bg-[rgba(48,209,88,0.1)]"
          : s === "failed"
            ? "border-[rgba(255,69,58,0.25)] bg-[rgba(255,69,58,0.08)]"
            : s === "held"
              ? "border-[rgba(255,159,10,0.25)] bg-[rgba(255,159,10,0.08)]"
              : "border-white/[0.06] bg-white/[0.02]",
      )}
      aria-live="polite"
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={s}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: 0.1 } }}
          transition={SPRING}
          className="flex min-w-0 flex-1 items-center gap-2.5"
        >
          {s === "drafting" && (
            <>
              <Pen />
              <Shimmer as="span" duration={2} className="truncate">
                Writing the email
              </Shimmer>
            </>
          )}
          {s === "sending" && (
            <>
              <Spinner size={18} reduce={reduce} color="var(--blue)" />
              <span className="truncate text-label">Sending from the booth&apos;s Gmail</span>
            </>
          )}
          {s === "sent" && (
            <>
              <span className="grid size-[26px] shrink-0 place-items-center rounded-full bg-green">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <motion.path
                    d="M5 12.5l4.5 4.5L19 7.5"
                    initial={reduce ? false : { pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ duration: 0.45, ease: [0.23, 1, 0.32, 1], delay: 0.1 }}
                  />
                </svg>
              </span>
              <span className="min-w-0 truncate">
                <span className="font-semibold text-label">Sent</span>
                <span className="text-label-2">
                  {" "}
                  to {email.to} at {clock(sentAt)}
                </span>
              </span>
            </>
          )}
          {(s === "failed" || s === "held") && (
            <>
              <span className={cn("grid size-[26px] shrink-0 place-items-center rounded-full", s === "failed" ? "bg-[#ff453a] text-white" : "bg-orange text-black")}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" aria-hidden>
                  {s === "failed" ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M9 6v12M15 6v12" />}
                </svg>
              </span>
              <span className="min-w-0 leading-snug">
                <span className="font-semibold text-label">{s === "failed" ? "Didn't send" : "Held, not sent"}</span>
                {email.error && <span className="text-label-2">: {email.error}</span>}
              </span>
            </>
          )}
        </motion.div>
      </AnimatePresence>
      {s === "sent" && email.messageId && <span className="hidden shrink-0 font-mono text-[11px] text-label-3 @md:inline">id {email.messageId.slice(0, 10)}</span>}
    </div>
  );
}

// ---------- light markdown: paragraphs, - bullets, [label](url), **bold** ----------

type Block = { kind: "p"; lines: string[] } | { kind: "ul"; items: string[] };

function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const last = out.at(-1);
    if (!line.trim()) {
      out.push({ kind: "p", lines: [] });
      continue;
    }
    const bullet = line.match(/^\s*[-*•]\s+(.*)$/);
    if (bullet) {
      if (last?.kind === "ul") last.items.push(bullet[1]);
      else out.push({ kind: "ul", items: [bullet[1]] });
    } else if (last?.kind === "p") last.lines.push(line);
    else out.push({ kind: "p", lines: [line] });
  }
  return out.filter((b) => (b.kind === "p" ? b.lines.length > 0 : b.items.length > 0));
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s)]+)/g;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > i) out.push(text.slice(i, m.index));
    if (m[1]) out.push(<strong key={m.index} className="font-semibold text-label">{m[1]}</strong>);
    else if (m[2])
      out.push(
        <a key={m.index} href={m[3]} target="_blank" rel="noopener noreferrer" className="font-medium text-[#4aa3ff] underline decoration-[#4aa3ff]/40 underline-offset-2 hover:decoration-[#4aa3ff]">
          {m[2]}
        </a>,
      );
    else if (m[4])
      out.push(
        <a key={m.index} href={m[4]} target="_blank" rel="noopener noreferrer" className="break-all text-[#4aa3ff] underline decoration-[#4aa3ff]/40 underline-offset-2">
          {m[4]}
        </a>,
      );
    i = m.index + m[0].length;
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}

/** The typing caret while the email is being written. */
function Caret({ reduce }: { reduce: boolean }) {
  return (
    <motion.span
      aria-hidden
      className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px] rounded-full bg-[var(--accent)]"
      animate={reduce ? undefined : { opacity: [1, 1, 0, 0] }}
      transition={{ duration: 1, repeat: Infinity, times: [0, 0.5, 0.5, 1] }}
    />
  );
}

function Markdown({ text, caret, reduce }: { text: string; caret: boolean; reduce: boolean }) {
  const list = blocks(text);
  const mark = caret ? <Caret reduce={reduce} /> : null;
  if (!list.length) return <p className="text-label-3">{mark ?? "Empty email"}</p>;
  return (
    <div className="flex flex-col gap-3">
      {list.map((b, i) => {
        const end = i === list.length - 1;
        if (b.kind === "ul")
          return (
            <ul key={i} className="flex flex-col gap-1.5">
              {b.items.map((it, j) => (
                <li key={j} className="flex gap-2.5">
                  <span className="mt-[0.62em] size-1.5 shrink-0 rounded-full bg-label-3" />
                  <span className="min-w-0">
                    {inline(it)}
                    {end && j === b.items.length - 1 && mark}
                  </span>
                </li>
              ))}
            </ul>
          );
        return (
          <p key={i}>
            {b.lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
            {end && mark}
          </p>
        );
      })}
    </div>
  );
}

// ---------- icons ----------

function Fish() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12c3-4.5 7-6 11-6 3 0 5.5 2.5 7 6-1.5 3.5-4 6-7 6-4 0-8-1.5-11-6zM3 12l-1.5-3M3 12l-1.5 3" />
      <circle cx="16.5" cy="11" r="1" fill="currentColor" />
    </svg>
  );
}
function Gear() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1" />
    </svg>
  );
}
function Mail() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M3.5 6.5l8.5 6.5 8.5-6.5" />
    </svg>
  );
}
function Pen() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
      <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />
    </svg>
  );
}
function Ear() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 9a6 6 0 1 1 12 0c0 3-2 4-3 5.5S14 18 12 19.5 8 20 8 18" />
      <path d="M9.5 9.5a2.5 2.5 0 0 1 5 0c0 1.5-1.5 2-1.5 3" />
    </svg>
  );
}
function Idle() {
  return (
    <span className="grid size-12 place-items-center rounded-[14px] bg-white/[0.05] text-label-3 ring-1 ring-white/[0.06]">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M3 9h18M7 6.5h.01M10 6.5h.01" />
      </svg>
    </span>
  );
}

// ---------- the full page (/followup) ----------

export function FollowUpScreen({ mock, fail, person, to, send, speed }: { mock: boolean; fail: boolean; person?: string; to?: string; send?: boolean; speed?: number }) {
  const q = new URLSearchParams();
  if (fail) q.set("fail", "1");
  if (speed) q.set("speed", String(speed));
  const api = mock ? "/api/followup/mock" + (q.size ? "?" + q : "") : "/api/followup";
  const fu = useFollowUp({ api });
  const personId = person ?? (mock ? "U07MOCKMAYA" : undefined);
  const req = useMemo<FollowupRequest | null>(() => (personId ? { personId, ...(to ? { to } : {}), ...(send !== undefined ? { send } : {}) } : null), [personId, to, send]);
  const { start } = fu;

  // The mock starts by itself (it sends nothing); a real run waits for the button, since it sends a real email.
  const began = useRef(false);
  useEffect(() => {
    if (!mock || !req || began.current) return;
    began.current = true;
    void start(req);
  }, [mock, req, start]);

  return (
    <main className="min-h-full bg-bg">
      <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
        <nav className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-[linear-gradient(140deg,#b6a8ff,#6b5cff)] text-[13px] font-black tracking-[-0.04em] text-white shadow-[0_6px_18px_-6px_rgba(107,92,255,0.8)]">
              HW
            </span>
            <div className="min-w-0 leading-tight">
              <p className="truncate text-[15px] font-semibold tracking-[-0.01em]">Touchpoint</p>
              <p className="truncate text-[12px] font-medium text-label-3">Booth follow-up · Hack Western 13</p>
            </div>
            {mock && <span className="ml-1 hidden whitespace-nowrap rounded-full sm:inline bg-white/[0.06] px-2 py-0.5 text-[11px] font-semibold text-label-3">{fail ? "Mock · TinyFish fails" : "Mock run"}</span>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {fu.running && (
              <button type="button" onClick={() => void fu.stop()} className="press rounded-full bg-white/[0.08] px-3.5 py-2 text-[13.5px] font-semibold text-label hover:bg-white/15">
                Stop
              </button>
            )}
            <button
              type="button"
              disabled={!req}
              onClick={() => req && void start(req)}
              className="press rounded-full bg-white px-4 py-2 text-[13.5px] font-semibold text-black hover:bg-white/90 disabled:opacity-40"
            >
              {fu.message || fu.running ? "Restart" : "Start follow-up"}
            </button>
          </div>
        </nav>
        {!req ? (
          <p className="rounded-[24px] bg-white/[0.035] p-6 text-[15px] text-label-2 ring-1 ring-white/[0.06]">
            Open this page with <span className="font-mono text-label">?person=&lt;Slack user id&gt;</span> to follow up with someone, or{" "}
            <span className="font-mono text-label">?mock</span> for a scripted run.
          </p>
        ) : (
          <FollowUpView message={fu.message} status={fu.status} error={fu.error} />
        )}
      </div>
    </main>
  );
}

