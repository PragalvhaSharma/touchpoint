"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useRef, useState, type ReactNode, type Ref } from "react";
import { Face } from "../talk/genui/components/base";
import type { Visitor } from "@/lib/visitor";

const SPRING = { type: "spring", bounce: 0, duration: 0.5 } as const;

type User = { name: string | null; email: string | null; verified: boolean; picture: string | null };
type Decision = "confirmed" | "declined";

export function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-black px-6 pb-[max(28px,env(safe-area-inset-bottom))] pt-[max(18px,env(safe-area-inset-top))]">
      {/* the same violet wash as the booth panel, so the phone feels like part of it */}
      <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 -z-10 h-[520px] w-[720px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(165,148,255,0.28),rgba(107,92,255,0.08)_55%,transparent)]" />
      <header className="mx-auto flex w-full max-w-[440px] items-center gap-2.5">
        <span className="grid size-7 place-items-center rounded-[9px] bg-[linear-gradient(140deg,#b6a8ff,#6b5cff)] text-[13px] font-black tracking-[-0.04em] text-white shadow-[0_6px_18px_-6px_rgba(107,92,255,0.8)]">
          HW
        </span>
        <div className="leading-tight">
          <p className="text-[14px] font-semibold tracking-[-0.01em]">Touchpoint</p>
          <p className="text-[11.5px] font-medium text-label-3">Hack Western 13</p>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-[440px] flex-1 flex-col">{children}</div>
    </main>
  );
}

export function Note({ title, body, loading }: { title: string; body: string; loading?: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center pb-16 text-center">
      <span className="grid size-[72px] place-items-center rounded-full bg-white/[0.06] ring-1 ring-white/10">
        {loading ? <span className="size-6 animate-spin rounded-full border-2 border-white/20 border-t-white/80" /> : <FaceIdGlyph size={30} />}
      </span>
      <h1 className="title mt-5 text-[26px] font-bold">{title}</h1>
      <p className="mt-2 max-w-[300px] text-[16px] leading-[1.45] text-label-2">{body}</p>
    </div>
  );
}

type Decided = { status: Decision; email: string | null };
type Use = "account" | "directory" | "custom";

// the same rule as lib/consent isEmail, so the button only lights up for an address the server will take
const looksLikeEmail = (s: string) => s.length <= 254 && /^[^\s@<>(),;:"\[\]]+@[^\s@<>(),;:"\[\]]+\.[a-z]{2,}$/i.test(s);

export function ConfirmFlow({
  person,
  ticket,
  passkey,
  user,
  directory,
  decided,
}: {
  person: Visitor;
  ticket: string;
  /** Auth0 is on: sign in with a passkey before choosing */
  passkey: boolean;
  user: User | null;
  /** the directory email, masked, when it differs from the account's */
  directory: string | null;
  decided: Decided | null;
}) {
  const reduce = !!useReducedMotion();
  const [done, setDone] = useState<Decided | null>(decided);
  const [editing, setEditing] = useState(false);
  const [notMe, setNotMe] = useState(false);
  const here = "/confirm?pid=" + encodeURIComponent(person.id) + "&t=" + encodeURIComponent(ticket);

  const signOut = () => {
    window.location.assign(window.location.origin + "/auth/logout?returnTo=" + encodeURIComponent(window.location.origin + here));
  };

  const step = done && !editing ? done.status : notMe ? "declined" : passkey && !user ? "signin" : "ask";
  const enter = reduce ? { opacity: 0 } : { opacity: 0, y: 16, filter: "blur(8px)" };
  const leave = reduce ? { opacity: 0 } : { opacity: 0, y: -12, filter: "blur(8px)", transition: { duration: 0.18 } };

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.section key={step} initial={enter} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={leave} transition={SPRING} className="flex flex-1 flex-col">
        {step === "confirmed" ? (
          <Done
            tone="green"
            title={"You're all set, " + person.first}
            body={
              <>
                Your follow-up is on its way to <span className="break-all font-semibold text-label">{done?.email ?? "your email"}</span>. You can put your phone away.
              </>
            }
            footer={
              user ? (
                <div className="flex gap-1">
                  <TextButton onClick={signOut}>Sign out</TextButton>
                </div>
              ) : null
            }
          />
        ) : step === "declined" ? (
          <Done
            tone="muted"
            title="No follow-up, then"
            body="We won't send you anything. Thanks for stopping by the booth."
            footer={
              <div className="flex gap-1">
                <TextButton
                  onClick={() => {
                    setNotMe(false);
                    setEditing(true);
                  }}
                >
                  Changed my mind
                </TextButton>
                {user && <TextButton onClick={signOut}>Sign out</TextButton>}
              </div>
            }
          />
        ) : (
          <>
            <Who person={person} small={step === "ask"} />
            {step === "signin" ? (
              <div className="flex flex-col gap-3">
                <a href={"/auth/login?returnTo=" + encodeURIComponent(here)} className="press flex h-[58px] items-center justify-center gap-2.5 rounded-[18px] bg-white text-[17px] font-semibold text-black">
                  <FaceIdGlyph size={22} dark />
                  Continue with a passkey
                </a>
                <button onClick={() => setNotMe(true)} className="press h-[54px] rounded-[18px] bg-white/[0.08] text-[17px] font-semibold text-label hover:bg-white/[0.12]">
                  Not me
                </button>
                <p className="px-4 pt-1 text-center text-[13px] leading-[1.45] text-label-3">
                  Face ID or Touch ID, no password. Secured by Auth0. Then tap the email your follow-up goes to.
                </p>
              </div>
            ) : (
              <EmailSheet
                person={person}
                ticket={ticket}
                user={user}
                directory={directory}
                reduce={reduce}
                onDone={(d) => {
                  setDone(d);
                  setEditing(false);
                  setNotMe(false);
                }}
                onLogin={() => window.location.assign(window.location.origin + "/auth/login?returnTo=" + encodeURIComponent(here))}
              />
            )}
          </>
        )}
      </motion.section>
    </AnimatePresence>
  );
}

function Who({ person, small }: { person: Visitor; small: boolean }) {
  return (
    <div className={"flex flex-col items-center text-center " + (small ? "pb-6 pt-6" : "flex-1 justify-center py-8")}>
      <div className="relative">
        <div aria-hidden className="absolute -inset-2.5 rounded-full bg-[conic-gradient(from_180deg,rgba(165,148,255,0.55),rgba(107,92,255,0.05),rgba(165,148,255,0.55))] opacity-70 blur-[2px]" />
        <Face name={person.name} srcs={[person.photo]} size={small ? 88 : 132} className="relative ring-4 ring-black" />
      </div>
      <p className={"text-[12px] font-semibold uppercase tracking-[0.12em] text-[#a594ff] " + (small ? "mt-5" : "mt-7")}>{small ? "Your booth follow-up" : "Is this you?"}</p>
      <h1 className={"title mt-1.5 font-bold " + (small ? "text-[28px]" : "text-[34px]")}>{person.name}</h1>
      {!small && (person.headline || person.role) && (
        <p className="mt-2 line-clamp-2 max-w-[320px] text-[16px] leading-[1.4] text-label-2">{person.headline || person.role}</p>
      )}
    </div>
  );
}

function EmailSheet({
  person,
  ticket,
  user,
  directory,
  reduce,
  onDone,
  onLogin,
}: {
  person: Visitor;
  ticket: string;
  user: User | null;
  directory: string | null;
  reduce: boolean;
  onDone: (d: Decided) => void;
  onLogin: () => void;
}) {
  const account = user?.email ?? null;
  const [typed, setTyped] = useState("");
  // which button is sending: an email (its "use") or "no"
  const [busy, setBusy] = useState<Use | "no" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // tapping an email sends to it at once; the typed box is only for someone with no email to tap
  const onlyTyped = !account && !directory;
  const typedOk = looksLikeEmail(typed.trim());

  async function decide(use: Use | "no") {
    if (busy) return;
    if (use === "custom" && !typedOk) {
      setError("Enter an email like name@example.com");
      input.current?.focus();
      return;
    }
    setBusy(use);
    setError(null);
    try {
      const res = await fetch("/api/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          use === "no"
            ? { pid: person.id, t: ticket, decision: "no" }
            : { pid: person.id, t: ticket, decision: "yes", use, email: use === "custom" ? typed.trim() : undefined },
        ),
      });
      if (res.status === 401) return onLogin(); // the session ran out: sign in again, then come back here
      const data = (await res.json().catch(() => null)) as { message?: string; status?: Decision; email?: string | null } | null;
      if (!res.ok || !data?.status) throw new Error(data?.message ?? "Something went wrong.");
      onDone({ status: data.status, email: data.email ?? null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <motion.div
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 48 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...SPRING, delay: reduce ? 0 : 0.12 }}
      role="dialog"
      aria-labelledby="send-to"
      className="-mx-2 mt-auto rounded-[28px] bg-[#1c1c1e] p-5 shadow-[0_-20px_60px_-20px_rgba(0,0,0,0.9)] ring-1 ring-white/[0.08]"
    >
      <h2 id="send-to" className="title text-[22px] font-bold">
        {onlyTyped ? "Where should your follow-up go?" : "Tap where your follow-up goes"}
      </h2>
      <p className="mt-1 text-[14px] leading-[1.45] text-label-2">One email from the booth with the roles we talked about. Nothing else.</p>

      {onlyTyped ? (
        <label className="mt-4 block">
          <span className="sr-only">Your email</span>
          <EmailInput ref={input} value={typed} onChange={setTyped} autoFocus onEnter={() => void decide("custom")} />
        </label>
      ) : (
        <div className="mt-4 flex flex-col gap-2">
          {account && (
            <EmailButton
              email={account}
              note={user?.verified ? "Your account · verified" : "Your account"}
              busy={busy === "account"}
              disabled={!!busy}
              onTap={() => void decide("account")}
            />
          )}
          {directory && (
            <EmailButton email={directory} note="The email Hack Western has on file" busy={busy === "directory"} disabled={!!busy} onTap={() => void decide("directory")} />
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-[14px] text-orange">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-col gap-2.5">
        {onlyTyped && (
          <button
            onClick={() => void decide("custom")}
            disabled={!!busy || !typedOk}
            className="press flex h-[56px] items-center justify-center gap-2 rounded-[18px] bg-white text-[17px] font-semibold text-black disabled:opacity-40"
          >
            {busy === "custom" ? <Spinner /> : null}
            Send it here
          </button>
        )}
        <button
          onClick={() => void decide("no")}
          disabled={!!busy}
          className="press flex h-[50px] items-center justify-center gap-2 rounded-[18px] bg-white/[0.08] text-[16px] font-semibold text-label hover:bg-white/[0.12] disabled:opacity-60"
        >
          {busy === "no" ? <Spinner light /> : null}
          No thanks
        </button>
      </div>
    </motion.div>
  );
}

// One tap sends the follow-up to this email.
function EmailButton({ email, note, busy, disabled, onTap }: { email: string; note: string; busy: boolean; disabled: boolean; onTap: () => void }) {
  return (
    <button
      type="button"
      onClick={onTap}
      disabled={disabled}
      aria-label={"Send my follow-up to " + email}
      className={
        "press flex w-full items-center gap-3 rounded-[18px] px-4 py-3.5 text-left ring-1 transition-[background-color,box-shadow,opacity] duration-200 " +
        (busy ? "bg-[rgba(165,148,255,0.16)] ring-[rgba(165,148,255,0.7)]" : "bg-white/[0.06] ring-white/[0.08] hover:bg-white/[0.1] disabled:opacity-50")
      }
    >
      <span className="min-w-0 flex-1">
        <span className="block break-all text-[16px] font-semibold leading-snug">{email}</span>
        <span className="mt-0.5 block text-[13px] text-label-3">{note}</span>
      </span>
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-white text-black">
        {busy ? (
          <Spinner />
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        )}
      </span>
    </button>
  );
}

function EmailInput({
  ref,
  value,
  onChange,
  onEnter,
  autoFocus,
}: {
  ref: Ref<HTMLInputElement>;
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
  autoFocus?: boolean;
}) {
  return (
    <input
      ref={ref}
      type="email"
      inputMode="email"
      autoComplete="email"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      enterKeyHint="send"
      autoFocus={autoFocus}
      placeholder="you@example.com"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.key === "Enter" && onEnter()}
      // 16px so iOS Safari doesn't zoom the page when it focuses
      className="h-[52px] w-full rounded-[14px] bg-black/50 px-4 text-[16px] text-label outline-none ring-1 ring-white/10 placeholder:text-label-3 focus:ring-2 focus:ring-[#a594ff]"
    />
  );
}

function Done({ tone, title, body, footer }: { tone: "green" | "muted"; title: string; body: ReactNode; footer: ReactNode }) {
  const reduce = !!useReducedMotion();
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center pb-10 text-center">
        <motion.span
          initial={reduce ? { opacity: 0 } : { scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", bounce: 0.35, duration: 0.6 }}
          className={"grid size-[92px] place-items-center rounded-full " + (tone === "green" ? "bg-green shadow-[0_18px_60px_-12px_rgba(48,209,88,0.65)]" : "bg-white/[0.08] ring-1 ring-white/10")}
        >
          {tone === "green" ? (
            <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="black" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <motion.path d="M5 12.5l4.5 4.5L19 7.5" initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: 0.2, duration: 0.45 }} />
            </svg>
          ) : (
            <FaceIdGlyph size={36} />
          )}
        </motion.span>
        <h1 className="title mt-6 text-[30px] font-bold">{title}</h1>
        <p className="mt-2 max-w-[320px] text-[16px] leading-[1.45] text-label-2">{body}</p>
      </div>
      <div className="flex justify-center">{footer}</div>
    </div>
  );
}

function TextButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className="press rounded-full px-4 py-2 text-[15px] font-semibold text-label-2 hover:text-label">
      {children}
    </button>
  );
}

function Spinner({ light }: { light?: boolean }) {
  return <span className={"size-4 animate-spin rounded-full border-2 " + (light ? "border-white/25 border-t-white" : "border-black/20 border-t-black")} />;
}

function FaceIdGlyph({ size, dark }: { size: number; dark?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={dark ? "#000" : "rgba(235,235,245,0.85)"} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <path d="M9 9.5v1M15 9.5v1M12 9.5V13h-1M9.5 15.5a3.5 3.5 0 0 0 5 0" />
    </svg>
  );
}

