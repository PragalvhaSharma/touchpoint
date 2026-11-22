"use client";

// The recruiter's side of the booth. They sign in once with Auth0 when the booth starts (RecruiterGate), then
// every person the greeter talks with lands in their inbox with a drafted follow-up email. They tap Yes and it
// goes out from the booth's Gmail, or No and nothing is sent. The same inbox is a drawer on the booth screen
// and a page on their phone (/recruiter). One poller feeds every piece through a small shared store.
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Approval } from "@/lib/followup/approvals";

const SPRING = { type: "spring", bounce: 0, duration: 0.45 } as const;
type User = { name: string; picture: string | null; denied?: boolean };
type State = { loaded: boolean; enabled: boolean; user: User | null; items: Approval[]; open: boolean };

let state: State = { loaded: false, enabled: false, user: null, items: [], open: false };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
const emit = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

async function refresh() {
  try {
    const res = await fetch("/api/recruiter", { cache: "no-store" });
    if (!res.ok) return;
    const j = (await res.json()) as { enabled: boolean; user: User | null; items: Approval[] };
    emit({ loaded: true, enabled: j.enabled, user: j.user, items: j.items });
  } catch {
    // the server restarting; the next tick tries again
  }
}

function loop() {
  clearTimeout(timer);
  void refresh().finally(() => {
    if (listeners.size) timer = setTimeout(loop, 2500);
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  if (listeners.size === 1) loop();
  return () => {
    listeners.delete(l);
    if (!listeners.size) clearTimeout(timer);
  };
}

export function useRecruiter(): State {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

export const recruiter = {
  open: (open: boolean) => emit({ open }),
  refresh,
  async decide(personId: string, ok: boolean, to?: string): Promise<string | null> {
    // show it right away; the server's answer replaces it
    emit({ items: state.items.map((a) => (a.personId === personId ? { ...a, status: ok ? "sending" : "skipped" } : a)) });
    try {
      const res = await fetch("/api/recruiter", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ personId, ok, to }),
      });
      const j = (await res.json().catch(() => ({}))) as { message?: string };
      await refresh();
      return res.ok ? null : j.message ?? "That didn't go through";
    } catch {
      await refresh();
      return "Couldn't reach the booth";
    }
  },
};

const signIn = (returnTo: string) => "/auth/login?returnTo=" + encodeURIComponent(returnTo);
const signOut = () => window.location.assign(window.location.origin + "/auth/logout?returnTo=" + encodeURIComponent(window.location.href));
const waitingCount = (items: Approval[]) => items.filter((a) => a.status === "waiting").length;

// ---------- the booth: sign in at the start ----------

/** Over the whole booth until a recruiter signs in (or taps Not now for this session). */
export function RecruiterGate() {
  const r = useRecruiter();
  const [skipped, setSkipped] = useState(true);
  useEffect(() => {
    // sessionStorage is only readable after mount
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSkipped(sessionStorage.getItem("recruiter-gate") === "skip");
  }, []);
  const show = r.loaded && r.enabled && !r.user && !skipped;
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key="gate"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-[80] grid place-items-center bg-black/80 p-6 backdrop-blur-xl"
        >
          <motion.div
            initial={{ y: 16, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            transition={SPRING}
            className="w-full max-w-[640px] rounded-[30px] bg-[#141416] p-8 shadow-[0_40px_120px_rgba(0,0,0,0.6)] ring-1 ring-white/[0.08]"
          >
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-[12px] bg-[linear-gradient(140deg,#b6a8ff,#6b5cff)] text-[17px] font-black tracking-[-0.04em] text-white">HW</span>
              <div className="leading-tight">
                <p className="text-[13px] font-semibold uppercase tracking-[0.09em] text-[#a594ff]">Greeter · Hack Western 13</p>
                <p className="title text-[26px] font-semibold tracking-[-0.02em]">Recruiter sign-in</p>
              </div>
            </div>
            <p className="mt-4 text-[15.5px] leading-relaxed text-label-2">
              Sign in once to run the booth. The greeter talks with every hacker and writes their follow-up. You get a ping for each one, and
              nothing is emailed until you tap Yes. Once you&apos;re in, you can approve from your phone too.
            </p>
            <div className="mt-6 flex flex-col gap-2.5">
                <a
                  href={signIn(typeof window === "undefined" ? "/" : window.location.pathname + window.location.search)}
                  className="press grid h-12 place-items-center rounded-[14px] bg-white text-[15px] font-semibold text-black hover:bg-white/90"
                >
                  Sign in with Auth0
                </a>
                <button
                  type="button"
                  onClick={() => {
                    sessionStorage.setItem("recruiter-gate", "skip");
                    setSkipped(true);
                  }}
                  className="press h-10 rounded-[14px] text-[13.5px] font-medium text-label-3 hover:text-label-2"
                >
                  Not now
                </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------- the booth: header chip, ping and drawer ----------

/** Header chip: Recruiter sign-in, or who is signed in with how many emails wait for a yes (opens the inbox). */
export function RecruiterChip() {
  const r = useRecruiter();
  if (!r.loaded) return null;
  const chip = "press ml-auto flex items-center gap-1.5 rounded-full bg-white/[0.05] py-1 text-[11.5px] font-medium text-label-2 hover:bg-white/10 hover:text-label";
  if (r.enabled && r.user?.denied)
    return (
      <button type="button" onClick={signOut} title={r.user.name + " isn't a recruiter for this booth. Click to sign out."} className={chip + " px-2.5"}>
        <Lock />
        Not a recruiter · sign out
      </button>
    );
  if (r.enabled && !r.user)
    return (
      <a href={signIn("/")} className={chip + " px-2.5"}>
        <Lock />
        Recruiter sign-in
      </a>
    );
  const n = waitingCount(r.items);
  const first = (r.user?.name ?? "Inbox").split(/[\s@]+/)[0];
  return (
    <button type="button" onClick={() => recruiter.open(true)} title="Open the recruiter inbox" className={chip + " pl-1 pr-2"}>
      <Avatar name={r.user?.name ?? "Inbox"} photo={r.user?.picture ?? null} size={18} />
      {r.enabled ? "Rep · " + first : "Inbox"}
      {n > 0 && <span className="grid h-[17px] min-w-[17px] place-items-center rounded-full bg-orange px-1 text-[10.5px] font-bold text-black">{n}</span>}
    </button>
  );
}

/** A ping for each new draft that is ready for a yes, and the inbox drawer it opens. */
export function RecruiterInbox() {
  const r = useRecruiter();
  const seen = useRef<Set<string> | null>(null);
  const [ping, setPing] = useState<Approval | null>(null);
  useEffect(() => {
    if (!r.loaded || !r.user) return;
    const key = (a: Approval) => a.personId + ":" + a.at;
    const ready = r.items.filter((a) => a.status === "waiting");
    // the first load is history: only drafts that arrive while the booth is open ping
    if (!seen.current) {
      seen.current = new Set(ready.map(key));
      return;
    }
    const fresh = ready.find((a) => !seen.current!.has(key(a)));
    ready.forEach((a) => seen.current!.add(key(a)));
    if (fresh && !r.open) setPing(fresh);
  }, [r.items, r.loaded, r.user, r.open]);
  useEffect(() => {
    if (!ping) return;
    const t = setTimeout(() => setPing(null), 12_000);
    return () => clearTimeout(t);
  }, [ping]);

  return (
    <>
      <AnimatePresence>
        {ping && !r.open && (
          <motion.button
            key={"ping-" + ping.personId + ping.at}
            type="button"
            initial={{ opacity: 0, y: -14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10 }}
            transition={SPRING}
            onClick={() => {
              setPing(null);
              recruiter.open(true);
            }}
            className="press fixed left-1/2 top-4 z-[70] flex -translate-x-1/2 items-center gap-3 rounded-full bg-[#1c1c1e]/[0.97] py-2 pl-2 pr-4 text-left shadow-[0_14px_40px_rgba(0,0,0,0.55)] ring-1 ring-white/[0.1] backdrop-blur"
          >
            <Avatar name={ping.name} photo={ping.photo} size={34} />
            <span className="leading-tight">
              <span className="block text-[13.5px] font-semibold">{ping.name.split(/\s+/)[0]}&apos;s follow-up is ready</span>
              <span className="block text-[12px] text-label-2">Matched to {ping.company}. Tap to approve.</span>
            </span>
            <span className="ml-1 size-2 animate-pulse rounded-full bg-orange" />
          </motion.button>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {r.open && (
          <motion.div key="inbox" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} className="fixed inset-0 z-[75] bg-black/50" onClick={() => recruiter.open(false)}>
            <motion.aside
              initial={{ x: 40, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 40, opacity: 0 }}
              transition={SPRING}
              onClick={(e) => e.stopPropagation()}
              className="absolute bottom-4 right-4 top-4 flex w-[min(520px,calc(100vw-2rem))] flex-col overflow-hidden rounded-[26px] bg-[#111113] shadow-[0_40px_120px_rgba(0,0,0,0.6)] ring-1 ring-white/[0.08]"
            >
              <InboxHeader onClose={() => recruiter.open(false)} />
              <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-4 pb-4">
                <RecruiterQueue />
                <PhoneLink />
              </div>
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

export function InboxHeader({ onClose }: { onClose?: () => void }) {
  const r = useRecruiter();
  const n = waitingCount(r.items);
  return (
    <header className="flex items-center gap-3 px-5 pb-3 pt-5">
      <div className="min-w-0 flex-1 leading-tight">
        <p className="text-[12px] font-semibold uppercase tracking-[0.09em] text-[#a594ff]">Recruiter inbox</p>
        <p className="title text-[21px] font-semibold tracking-[-0.02em]">{n ? n + " waiting for your yes" : "All caught up"}</p>
      </div>
      {r.enabled && r.user && (
        <button type="button" onClick={signOut} className="press rounded-full bg-white/[0.06] px-3 py-1.5 text-[12px] font-medium text-label-2 hover:bg-white/10" title={"Signed in as " + r.user.name}>
          Sign out
        </button>
      )}
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Close" className="press grid size-9 place-items-center rounded-full bg-white/[0.06] text-label-2 hover:bg-white/10">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      )}
    </header>
  );
}

// ---------- the list ----------

/** In the booth drawer: the same inbox on the recruiter's phone (they sign in there with the same account). */
function PhoneLink() {
  const [link, setLink] = useState<{ link: string; qr: string } | null>(null);
  useEffect(() => {
    fetch("/api/recruiter?link=1", { cache: "no-store" })
      .then((res) => res.json() as Promise<{ link: string | null; qr?: string }>)
      .then((j) => j.link && j.qr && setLink({ link: j.link, qr: j.qr }))
      .catch(() => {});
  }, []);
  if (!link) return null;
  return (
    <div className="mt-4 flex items-center gap-4 rounded-[18px] bg-white/[0.04] p-3 ring-1 ring-white/[0.06]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={link.qr} alt="Open this inbox on your phone" className="size-[96px] shrink-0 rounded-[10px] bg-white p-1.5" />
      <p className="text-[13px] leading-snug text-label-2">
        <span className="block font-semibold text-label">Approve from your phone</span>
        Scan and sign in with the same account you used here.
      </p>
    </div>
  );
}

const ORDER: Record<Approval["status"], number> = { waiting: 0, failed: 1, drafting: 2, sending: 3, sent: 4, skipped: 5 };

export function RecruiterQueue() {
  const r = useRecruiter();
  const items = [...r.items].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.at - a.at);
  if (!r.loaded) return <p className="px-2 py-8 text-center text-[14px] text-label-3">Loading</p>;
  if (!items.length)
    return (
      <p className="px-4 py-10 text-center text-[14px] leading-relaxed text-label-3">
        Nobody yet. Each person the greeter talks with shows up here once they walk away, with their email ready for your yes.
      </p>
    );
  return (
    <div className="flex flex-col gap-3">
      <AnimatePresence initial={false}>
        {items.map((a) => (
          <Item key={a.personId} a={a} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function Item({ a }: { a: Approval }) {
  const [to, setTo] = useState(a.to);
  const [editing, setEditing] = useState(!a.to);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // a fresh draft (or a new address from the server) resets the field
  const [shownTo, setShownTo] = useState(a.to);
  if (shownTo !== a.to) {
    setShownTo(a.to);
    setTo(a.to);
    setEditing(!a.to);
  }
  const decide = async (ok: boolean) => {
    setBusy(true);
    setErr(null);
    setErr(await recruiter.decide(a.personId, ok, ok ? to.trim() : undefined));
    setBusy(false);
  };
  const canDecide = a.status === "waiting" || a.status === "failed" || a.status === "skipped";
  const first = a.name.split(/\s+/)[0];
  return (
    <motion.article
      layout="position"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={SPRING}
      className={
        "rounded-[20px] bg-[#1c1c1e] p-4 ring-1 " + (a.status === "waiting" ? "ring-[rgba(255,159,10,0.35)]" : a.status === "sent" ? "ring-[rgba(48,209,88,0.35)]" : "ring-white/[0.07]")
      }
    >
      <div className="flex items-start gap-3">
        <Avatar name={a.name} photo={a.photo} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-[15.5px] font-semibold">{a.name}</p>
            <Status s={a.status} />
          </div>
          <p className="truncate text-[12.5px] text-label-3">
            {a.role} · {ago(a.at)}
          </p>
        </div>
      </div>
      {a.company && (
        <p className="mt-3 text-[13.5px] leading-snug text-label-2">
          <span className="font-semibold text-label">Matched to {a.company}</span>
          {a.why ? ". " + a.why : a.summary ? ". " + a.summary : ""}
        </p>
      )}

      {a.status === "drafting" ? (
        <p className="mt-3 text-[13px] text-label-3">Writing {first}&apos;s email…</p>
      ) : a.body ? (
        <>
          <div className="mt-3 flex items-center gap-2 text-[13px]">
            <span className="w-9 shrink-0 text-label-3">To</span>
            {editing && canDecide ? (
              <input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                type="email"
                inputMode="email"
                autoCapitalize="off"
                autoCorrect="off"
                placeholder={"Add " + first + "'s email"}
                className="h-8 min-w-0 flex-1 rounded-[10px] bg-white/[0.07] px-2.5 text-[13px] text-label outline-none ring-1 ring-white/10 focus:ring-[#a594ff]"
              />
            ) : (
              <button type="button" disabled={!canDecide} onClick={() => setEditing(true)} className="min-w-0 truncate rounded-full bg-white/[0.07] px-2.5 py-1 text-left text-label enabled:hover:bg-white/10" title={canDecide ? "Change" : undefined}>
                {a.to || "No email"}
              </button>
            )}
            {!editing && a.toSource !== "none" && <span className="shrink-0 text-[11.5px] text-label-3">{a.toSource === "said" ? "they said" : "on file"}</span>}
          </div>
          <button type="button" onClick={() => setOpen((o) => !o)} className="mt-2 block w-full text-left">
            <p className="text-[13px] font-semibold leading-snug">{a.subject}</p>
            <p className={"mt-1 whitespace-pre-wrap text-[13px] leading-[1.5] text-label-2 " + (open ? "" : "line-clamp-3")}>{a.body}</p>
            <span className="mt-1 inline-block text-[12px] font-medium text-[#a594ff]">{open ? "Show less" : "Read the email"}</span>
          </button>
        </>
      ) : null}

      {(err || a.error) && <p className={"mt-2 text-[12.5px] " + (a.status === "failed" || err ? "text-[#ff6961]" : "text-orange")}>{err ?? a.error}</p>}

      {a.status === "sent" ? (
        <p className="mt-3 text-[13px] font-medium text-green">
          Sent to {a.to}
          {a.decidedAt ? " at " + clock(a.decidedAt) : ""}
          {a.decidedBy ? " · approved by " + a.decidedBy.split(/[\s@]+/)[0] : ""}
        </p>
      ) : a.status === "sending" ? (
        <p className="mt-3 text-[13px] font-medium text-label-2">Sending…</p>
      ) : canDecide && a.body ? (
        <div className="mt-3 flex gap-2">
          {a.status !== "skipped" && (
            <button type="button" disabled={busy} onClick={() => decide(false)} className="press h-11 flex-1 rounded-[13px] bg-white/[0.07] text-[14.5px] font-semibold text-label-2 hover:bg-white/10 disabled:opacity-50">
              No
            </button>
          )}
          <button
            type="button"
            disabled={busy || !to.trim()}
            onClick={() => decide(true)}
            className="press h-11 flex-[2] rounded-[13px] bg-green text-[14.5px] font-semibold text-black hover:brightness-110 disabled:opacity-40"
          >
            {a.status === "skipped" ? "Send it anyway" : a.status === "failed" ? "Try again" : "Yes, send it"}
          </button>
        </div>
      ) : null}
    </motion.article>
  );
}

function Status({ s }: { s: Approval["status"] }) {
  const [label, cls] =
    s === "waiting" ? ["Needs your yes", "bg-orange/15 text-orange"]
    : s === "drafting" ? ["Drafting", "bg-white/[0.07] text-label-2"]
    : s === "sending" ? ["Sending", "bg-white/[0.07] text-label-2"]
    : s === "sent" ? ["Sent", "bg-green/15 text-green"]
    : s === "skipped" ? ["Not sent", "bg-white/[0.07] text-label-3"]
    : ["Didn't send", "bg-[#ff453a]/15 text-[#ff6961]"];
  return <span className={"shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold " + cls}>{label}</span>;
}

function Avatar({ name, photo, size }: { name: string; photo: string | null; size: number }) {
  const [broken, setBroken] = useState(false);
  const letters = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("") || "?";
  if (!photo || broken)
    return (
      <span style={{ width: size, height: size, fontSize: size * 0.4 }} className="grid shrink-0 place-items-center rounded-full bg-[#a594ff] font-bold text-black">
        {letters}
      </span>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={photo} alt="" onError={() => setBroken(true)} referrerPolicy="no-referrer" style={{ width: size, height: size }} className="shrink-0 rounded-full bg-raised-2 object-cover" />
  );
}

function Lock() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="5" y="11" width="14" height="9" rx="2.5" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

const clock = (t: number) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
function ago(t: number) {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? "just now" : m < 60 ? m + " min ago" : clock(t);
}

