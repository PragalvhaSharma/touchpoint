import type { NextRequest } from "next/server";
import QRCode from "qrcode";
import { auth0Enabled, currentUser } from "@/lib/auth0";
import { awaitConsent, consentFor, consentRequired, isEmail, maskEmail, QR_SUB, readyAfterConsent, record, stopAwaiting } from "@/lib/consent";
import { publicBaseUrl } from "@/lib/public-url";
import { fromOutside, ticketFor, validTicket } from "@/lib/ticket";
import { directoryContact, visitor } from "@/lib/visitor";

// GET  /api/confirm?pid=<id>[&qr=1]  the booth screen's view: has this person confirmed, to a masked email.
//                                    Never returns the full address. With qr=1 it adds the QR to scan.
//                                    The QR carries a 20-minute ticket for this person (lib/ticket.ts).
// GET  /api/confirm?ready=1          visitors whose follow-up was skipped for want of an address and who have
//                                    since confirmed one: the booth starts their follow-up now.
// POST /api/confirm {pid, t, decision, use?, email?}  from the visitor's phone: "yes" with the address to use
//                                    (use: "account" | "directory" | "custom", email for custom) or "no".
//                                    With Auth0 on it needs the passkey sign-in; without it the ticket is the proof.
// From outside the booth (the tunnel), proxy.ts only lets the POST through. CONFIRM_QR=0 turns the QR off.

const noStore = { "cache-control": "no-store" };
const qrOn = () => process.env.CONFIRM_QR !== "0";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  if (sp.has("ready")) {
    if (fromOutside(req.headers)) return Response.json({ ready: [] }, { headers: noStore });
    // the booth page polls this from the moment it opens: start the phone link now, so the first QR is instant
    if (qrOn()) void publicBaseUrl(req, 0);
    return Response.json({ ready: readyAfterConsent() }, { headers: noStore });
  }
  if (!qrOn()) return Response.json({ enabled: false }, { headers: noStore });
  const pid = sp.get("pid")?.trim();
  if (!pid) return Response.json({ message: "pid is required" }, { status: 400 });
  const c = consentFor(pid);
  const body: Record<string, unknown> = {
    enabled: true,
    passkey: auth0Enabled(),
    // the booth keeps its Follow up button off until this visitor approves an email
    needConsent: consentRequired(),
    first: visitor(pid)?.first ?? null,
    status: c?.status ?? "waiting",
    email: c?.status === "confirmed" ? maskEmail(c.email) : null,
    verified: c?.status === "confirmed" ? c.emailVerified : null,
    at: c?.at ?? null,
  };
  // where the QR points right now, without waiting, so the booth card notices a restarted tunnel
  if (!fromOutside(req.headers) && !sp.has("qr")) body.link = (await publicBaseUrl(req, 0)).url;
  if (sp.has("qr") && !fromOutside(req.headers)) {
    const base = await publicBaseUrl(req);
    const url = `${base.url}/confirm?pid=${encodeURIComponent(pid)}&t=${encodeURIComponent(ticketFor(pid))}`;
    // until the phone link answers, the card shows a placeholder and asks again (a laptop-only link would fail)
    body.reachable = base.reachable;
    body.link = base.url;
    const svg = await QRCode.toString(url, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });
    body.url = url;
    body.qr = "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  }
  return Response.json(body, { headers: noStore });
}

type Body = { pid?: unknown; t?: unknown; decision?: unknown; use?: unknown; email?: unknown };

export async function POST(req: NextRequest) {
  if (!qrOn()) return Response.json({ message: "The follow-up QR is turned off" }, { status: 404 });
  const { pid: rawPid, t, decision, use, email } = ((await req.json().catch(() => ({}))) ?? {}) as Body;
  const pid = typeof rawPid === "string" ? rawPid.trim() : "";
  if (!pid || (decision !== "yes" && decision !== "no")) return Response.json({ message: "pid and decision (yes|no) are required" }, { status: 400 });
  if (!validTicket(pid, t)) return Response.json({ message: "This code has expired. Scan the code on the booth screen again." }, { status: 403 });
  if (!visitor(pid)) return Response.json({ message: "Unknown person" }, { status: 404 });
  const passkey = auth0Enabled();
  const user = passkey ? await currentUser() : null;
  if (passkey && !user) return Response.json({ message: "Sign in first" }, { status: 401 });
  const account = user && isEmail(user.email) ? user.email : null;

  // a "no" keeps no address
  let chosen: string | null = null;
  if (decision === "yes") {
    chosen =
      use === "account" ? account
      : use === "directory" ? directoryContact(pid)?.email || null
      : use === "custom" && typeof email === "string" ? email.trim()
      : null;
    if (!isEmail(chosen)) return Response.json({ message: "Enter an email like name@example.com" }, { status: 400 });
  }
  const saved = record(pid, {
    status: decision === "yes" ? "confirmed" : "declined",
    email: chosen,
    // verified only when it is the very address Auth0 verified for this account
    emailVerified: !!chosen && !!account && user?.email_verified === true && chosen.toLowerCase() === account.toLowerCase(),
    name: user && typeof user.name === "string" ? user.name : null,
    sub: user?.sub ?? QR_SUB,
  });
  if (!saved) return Response.json({ message: "This follow-up is already decided. Ask at the booth to change it." }, { status: 409 });
  // Picking an email on the phone means they're done: the booth polls ready=1 and starts their follow-up now,
  // without waiting for them to walk out of frame. A follow-up already sent in the last few hours isn't repeated.
  if (saved.status === "confirmed") awaitConsent(pid);
  else stopAwaiting(pid);
  // the directory address stays masked on the phone too: whoever holds the ticket may not be its owner
  const shown = use === "directory" ? maskEmail(saved.email) : saved.email;
  return Response.json({ status: saved.status, email: shown, verified: saved.emailVerified }, { headers: noStore });
}
