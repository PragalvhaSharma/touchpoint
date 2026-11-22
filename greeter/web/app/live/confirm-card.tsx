"use client";

// The booth QR: as soon as the greeter recognises someone, this card shows in the side panel, just above the
// buttons, so it never covers the camera or the profile. Their phone opens /confirm (app/confirm), where they
// pick the email their follow-up goes to (after an Auth0 passkey sign-in when Auth0 is configured). The card then
// flips to "You're set", showing only a masked email: the full address never reaches the booth screen.
// The QR only appears once its link works from a phone (lib/tunnel.ts); until then it says it is getting ready.
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

const SPRING = { type: "spring", bounce: 0, duration: 0.5 } as const;
const POLL_MS = 2000;

type Status = {
  enabled: boolean;
  passkey?: boolean;
  /** follow-ups wait for this visitor to approve an email on their phone */
  needConsent?: boolean;
  first?: string | null;
  status?: "waiting" | "confirmed" | "declined";
  email?: string | null;
  verified?: boolean | null;
  /** the base address the QR should use right now (changes if the tunnel restarts) */
  link?: string;
  reachable?: boolean;
  url?: string;
  qr?: string;
};

type Code = { url: string; qr: string; link: string; at: number };

export type ConsentState = { status: "waiting" | "confirmed" | "declined"; needConsent: boolean };

export function ConfirmCard({
  personId,
  small = false,
  corner = false,
  onStatus,
}: {
  personId: string;
  small?: boolean;
  /** The compact version for the top right of the panel: just the QR and a word under it. */
  corner?: boolean;
  /** tells the booth whether this visitor has approved an email yet, so Follow up can wait for it */
  onStatus?: (personId: string, s: ConsentState) => void;
}) {
  const reduce = !!useReducedMotion();
  const [state, setState] = useState<{ pid: string; s: Status } | null>(null);

  useEffect(() => {
    if (personId.startsWith("guest-")) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let code: Code | null = null;
    let link: string | undefined;
    const tick = async () => {
      try {
        // a fresh code every 10 minutes (the ticket lasts 20), or as soon as the public link changes
        const stale = !code || Date.now() - code.at > 10 * 60_000 || (link && link !== code.link);
        const res = await fetch("/api/confirm?pid=" + encodeURIComponent(personId) + (stale ? "&qr=1" : ""), { cache: "no-store" });
        const s = (await res.json()) as Status;
        if (stop) return;
        link = s.link ?? link;
        if (s.qr && s.url) code = s.reachable ? { url: s.url, qr: s.qr, link: s.link ?? "", at: Date.now() } : null;
        setState({ pid: personId, s: { ...s, url: code?.url, qr: code?.qr } });
        if (s.enabled) onStatus?.(personId, { status: s.status ?? "waiting", needConsent: !!s.needConsent });
        if (!s.enabled) return; // the QR is turned off (CONFIRM_QR=0): stay hidden, stop asking
      } catch {
        // the server restarting; try again on the next tick
      }
      if (!stop) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [personId, onStatus]);

  const s = state?.pid === personId ? state.s : null;
  if (!s?.enabled) return null;
  const status = s.status ?? "waiting";
  const first = s.first || "you";
  const size = small ? "size-[92px]" : "size-[clamp(112px,9vw,150px)]";
  if (corner) return <Corner s={s} status={status} first={first} small={small} reduce={reduce} />;

  return (
    <motion.section
      layout={reduce ? false : "position"}
      aria-label="Scan to get your follow-up"
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12, filter: "blur(8px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: 12, filter: "blur(8px)", transition: { duration: 0.2 } }}
      transition={SPRING}
      className={
        "w-full overflow-hidden rounded-[20px] bg-white/[0.045] ring-1 transition-[box-shadow] duration-500 " +
        (status === "confirmed" ? "ring-[rgba(48,209,88,0.55)]" : "ring-white/[0.08]")
      }
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {status === "confirmed" ? (
          <motion.div
            key="confirmed"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10, filter: "blur(6px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0 }}
            transition={SPRING}
            className="flex items-center gap-3.5 p-3.5"
          >
            <motion.span
              initial={reduce ? false : { scale: 0.5 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", bounce: 0.4, duration: 0.6 }}
              className="grid size-11 shrink-0 place-items-center rounded-full bg-green shadow-[0_12px_36px_-10px_rgba(48,209,88,0.8)]"
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            </motion.span>
            <div className="min-w-0">
              <p className="title text-balance text-[17px] font-semibold leading-tight">Email approved and saved</p>
              <p className="mt-0.5 text-[13.5px] leading-snug text-label-2">
                {first === "you" ? "Your" : first + "'s"} follow-up goes to <span className="font-semibold text-label [overflow-wrap:anywhere]">{s.email ?? "your email"}</span>
              </p>
              <p className="mt-0.5 text-[12px] font-medium text-green">{s.verified ? "Authenticated with an Auth0 passkey" : "Approved on their phone"}</p>
            </div>
          </motion.div>
        ) : status === "declined" ? (
          <motion.div key="declined" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-3.5 p-3.5">
            <QR qr={s.qr} url={s.url} className="size-[72px] rounded-[12px] p-1.5" />
            <div className="min-w-0">
              <p className="title text-[16px] font-semibold">No follow-up</p>
              <p className="mt-0.5 text-[13px] leading-snug text-label-2">Nothing will be sent. Scan again to change your mind.</p>
            </div>
          </motion.div>
        ) : (
          <motion.div key="waiting" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-4 p-3">
            <QR qr={s.qr} url={s.url} className={size + " rounded-[14px] p-2"} />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold uppercase tracking-[0.09em] text-[#a594ff]">
                {small ? first + "'s follow-up" : "Your follow-up"}
                {s.passkey && (
                  <span className="flex items-center gap-1 rounded-full bg-white/[0.07] px-2 py-0.5 text-[10.5px] normal-case tracking-normal text-label-2">
                    <Shield />
                    Auth0 passkey
                  </span>
                )}
              </p>
              <p className={"title mt-1.5 text-balance font-bold leading-tight [hyphens:none] " + (small ? "text-[16px]" : "text-[clamp(17px,1.3vw,21px)]")}>
                {s.qr ? "Scan to get your follow-up" : "Getting your link ready"}
              </p>
              {!small && (
                <p className="mt-1 text-[13px] leading-snug text-label-2">
                  {s.passkey ? "Confirm with Face ID, then pick the email it goes to." : "Point your phone camera here and pick the email it goes to."}
                </p>
              )}
              <p className="mt-2 flex items-center gap-1.5 text-[12px] font-medium text-label-3">
                <span className="relative grid size-1.5 place-items-center">
                  {!reduce && <span className="absolute size-1.5 animate-ping rounded-full bg-[#a594ff] opacity-70" />}
                  <span className="size-1.5 rounded-full bg-[#a594ff]" />
                </span>
                {s.qr ? "Waiting for " + (first === "you" ? "your phone" : first + "'s phone") : "One moment"}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.section>
  );
}

function QR({ qr, url, className }: { qr?: string; url?: string; className: string }) {
  return (
    <span className={"grid shrink-0 place-items-center bg-white " + className}>
      {qr ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={qr} alt={"QR code for " + (url ?? "the follow-up page")} className="size-full [image-rendering:pixelated]" />
      ) : (
        <span className="size-full animate-pulse rounded-[8px] bg-black/10" />
      )}
    </span>
  );
}

/** The top-right QR: scan it, approve on the phone, and it turns green. The follow-up then runs on the left. */
function Corner({ s, status, first, small, reduce }: { s: Status; status: string; first: string; small: boolean; reduce: boolean }) {
  const box = small ? "size-[78px]" : "size-[clamp(96px,7vw,124px)]";
  const label =
    status === "confirmed" ? "Email approved"
    : status === "declined" ? "No follow-up"
    : !s.qr ? "Getting ready"
    : small ? (first === "you" ? "Scan me" : first)
    : "Scan for your follow-up";
  return (
    <motion.section
      layout={reduce ? false : "position"}
      aria-label="Scan to get your follow-up"
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: -8, filter: "blur(6px)" }}
      animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, filter: "blur(6px)", transition: { duration: 0.2 } }}
      transition={SPRING}
      className={
        "flex flex-col items-center gap-1.5 rounded-[18px] p-2 ring-1 transition-colors duration-500 " +
        (status === "confirmed" ? "bg-[rgba(48,209,88,0.08)] ring-[rgba(48,209,88,0.55)]" : "bg-white/[0.045] ring-white/[0.08]")
      }
    >
      {status === "confirmed" ? (
        <span className={box + " grid place-items-center"}>
          <motion.span
            initial={reduce ? false : { scale: 0.5 }}
            animate={{ scale: 1 }}
            transition={{ type: "spring", bounce: 0.4, duration: 0.6 }}
            className="grid size-12 place-items-center rounded-full bg-green shadow-[0_12px_36px_-10px_rgba(48,209,88,0.8)]"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          </motion.span>
        </span>
      ) : (
        <QR qr={s.qr} url={s.url} className={box + " rounded-[12px] p-1.5" + (status === "declined" ? " opacity-40" : "")} />
      )}
      <p
        className={
          "w-0 min-w-full text-balance text-center text-[11.5px] font-semibold leading-tight " +
          (status === "confirmed" ? "text-green" : "text-label-2")
        }
      >
        {label}
      </p>
    </motion.section>
  );
}

function Shield() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
    </svg>
  );
}
