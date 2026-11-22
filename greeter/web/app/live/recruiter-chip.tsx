"use client";

// The booth header's sign-in for whoever is running the booth: "Recruiter sign-in" goes to Auth0, and once
// signed in it shows their name (click to sign out). Hidden when Auth0 isn't configured; gates nothing.
import { useEffect, useState } from "react";

type Me = { enabled: boolean; user?: { name: string; picture: string | null } | null };

export function RecruiterChip() {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/auth0", { cache: "no-store" })
      .then((r) => r.json() as Promise<Me>)
      .then((m) => live && setMe(m))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (!me?.enabled) return null;

  const chip = "press ml-auto flex items-center gap-1.5 rounded-full bg-white/[0.05] py-1 text-[11.5px] font-medium text-label-2 hover:bg-white/10 hover:text-label";
  if (!me.user)
    return (
      <a href="/auth/login?returnTo=%2F" className={chip + " px-2.5"}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="5" y="11" width="14" height="9" rx="2.5" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
        Recruiter sign-in
      </a>
    );
  const first = me.user.name.split(/[\s@]+/)[0];
  return (
    <button
      type="button"
      title={`Signed in as ${me.user.name}. Click to sign out.`}
      onClick={() => {
        window.location.assign(window.location.origin + "/auth/logout?returnTo=" + encodeURIComponent(window.location.origin + "/"));
      }}
      className={chip + " pl-1 pr-2.5"}
    >
      {me.user.picture ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={me.user.picture} alt="" className="size-[18px] rounded-full" referrerPolicy="no-referrer" />
      ) : (
        <span className="grid size-[18px] place-items-center rounded-full bg-[#a594ff] text-[10px] font-bold text-black">{first[0]?.toUpperCase()}</span>
      )}
      Rep · {first}
    </button>
  );
}

