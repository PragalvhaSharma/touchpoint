import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { auth0Enabled, currentUser } from "@/lib/auth0";
import { consentFor, isEmail, maskEmail, QR_SUB } from "@/lib/consent";
import { validTicket } from "@/lib/ticket";
import { directoryContact, visitor } from "@/lib/visitor";
import { ConfirmFlow, Frame, Note } from "./flow";

// The visitor's side of the booth QR, on their own phone. With Auth0 on they sign in with a passkey (Face ID /
// Touch ID) first; without it the signed, 20-minute ticket in the QR is the proof they were at the booth.
// Then one tap picks where the follow-up goes: their account email or the one on file (masked here, since
// whoever holds the ticket may not own it); they type one only when neither exists. "No thanks" means nothing is sent.

export const metadata: Metadata = {
  title: "Get your follow-up",
  description: "Choose where the booth sends your follow-up.",
};

export default function Page({ searchParams }: PageProps<"/confirm">) {
  return (
    <Frame>
      <Suspense fallback={<Note loading title="One moment" body="Looking up your badge." />}>
        <Confirm searchParams={searchParams} />
      </Suspense>
    </Frame>
  );
}

async function Confirm({ searchParams }: { searchParams: PageProps<"/confirm">["searchParams"] }) {
  await connection(); // tickets expire, so this always renders per request
  const sp = await searchParams;
  const pid = typeof sp.pid === "string" ? sp.pid.trim() : "";
  const t = typeof sp.t === "string" ? sp.t : "";
  if (process.env.CONFIRM_QR === "0") return <Note title="Follow-ups are off" body="This booth isn't sending follow-ups right now." />;
  if (!pid) return <Note title="Scan the code on the booth screen" body="It shows up next to you on the camera while you talk with the greeter." />;
  const found = visitor(pid);
  if (!found) return <Note title="We couldn't find that badge" body="Scan the code on the booth screen again." />;
  if (!validTicket(pid, t)) return <Note title="This code has expired" body="Scan the code on the booth screen again. Each one works for 20 minutes." />;
  // the booth's own face photos are only served through the tunnel with this person's ticket (proxy.ts)
  const person = found.photo.startsWith("/api/greeter/face") ? { ...found, photo: `${found.photo}&t=${encodeURIComponent(t)}` } : found;

  const passkey = auth0Enabled();
  const user = passkey ? await currentUser() : null;
  const account = user && isEmail(user.email) ? user.email : null;
  const signedIn = user
    ? {
        name: typeof user.name === "string" ? user.name : null,
        email: account,
        verified: user.email_verified === true,
        picture: typeof user.picture === "string" ? user.picture : null,
      }
    : null;
  const dir = directoryContact(pid)?.email || null;
  const directory = dir && dir.toLowerCase() !== account?.toLowerCase() ? maskEmail(dir) : null;
  // a decision only counts as theirs if this same account (or, without Auth0, a booth QR) made it
  const consent = consentFor(pid);
  const mine = consent && (user ? consent.sub === user.sub : !passkey && consent.sub === QR_SUB);
  const decided = mine
    ? { status: consent.status, email: consent.email && consent.email.toLowerCase() === account?.toLowerCase() ? consent.email : maskEmail(consent.email) }
    : null;
  return <ConfirmFlow person={person} ticket={t} passkey={passkey} user={signedIn} directory={directory} decided={decided} />;
}
