import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { auth0Enabled, currentUser } from "@/lib/auth0";
import { isRecruiter } from "@/lib/followup/approvals";
import { InboxHeader, RecruiterQueue } from "../live/recruiter";

// The recruiter's inbox on their own phone (also reachable through the booth's tunnel). Auth0 sign-in first;
// then everyone the greeter talked with, each with a drafted follow-up to approve (Yes) or drop (No).

export const metadata: Metadata = { title: "Recruiter inbox", description: "Approve the greeter's follow-ups." };

export default function Page() {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-[640px] px-3 pb-10 pt-3">
      <Suspense fallback={null}>
        <Inbox />
      </Suspense>
    </main>
  );
}

async function Inbox() {
  await connection(); // the session cookie is a per-request fact
  const user = auth0Enabled() ? await currentUser() : null;
  if (user && !isRecruiter(user))
    return (
      <section className="mt-[18vh] rounded-[28px] bg-[#141416] p-7 ring-1 ring-white/[0.08]">
        <h1 className="title text-[24px] font-semibold tracking-[-0.02em]">This account isn&apos;t the booth&apos;s recruiter</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-label-2">
          Sign in on the booth screen first with this account, then come back here. Or sign in with the account you used at the booth.
        </p>
        <a href="/auth/logout?returnTo=%2Frecruiter" className="press mt-6 grid h-12 place-items-center rounded-[14px] bg-white/[0.08] text-[15px] font-semibold">
          Sign out
        </a>
      </section>
    );
  if (auth0Enabled() && !user)
    return (
      <section className="mt-[18vh] rounded-[28px] bg-[#141416] p-7 ring-1 ring-white/[0.08]">
        <p className="text-[12px] font-semibold uppercase tracking-[0.09em] text-[#a594ff]">Greeter · Hack Western 13</p>
        <h1 className="title mt-1 text-[26px] font-semibold tracking-[-0.02em]">Recruiter sign-in</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-label-2">Sign in to see everyone the greeter talked with and approve their follow-up emails.</p>
        <a href="/auth/login?returnTo=%2Frecruiter" className="press mt-6 grid h-12 place-items-center rounded-[14px] bg-white text-[15px] font-semibold text-black">
          Sign in with Auth0
        </a>
      </section>
    );
  return (
    <section className="rounded-[26px] bg-[#111113] pb-4 ring-1 ring-white/[0.06]">
      <InboxHeader />
      <div className="px-3">
        <RecruiterQueue />
      </div>
    </section>
  );
}

