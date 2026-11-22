import type { NextRequest } from "next/server";
import QRCode from "qrcode";
import { auth0Enabled, currentUser } from "@/lib/auth0";
import { isEmail } from "@/lib/consent";
import { addBoothRecruiter, approvalFor, approvals, isRecruiter, markSent, putApproval, sendMail } from "@/lib/followup/approvals";
import { env } from "@/lib/followup/env";
import { publicBaseUrl } from "@/lib/public-url";
import { fromOutside } from "@/lib/ticket";

// The recruiter's inbox (lib/followup/approvals): everyone the greeter followed up on, with the drafted email.
// GET  /api/recruiter          { enabled, user, items }; items only for a signed-in recruiter
// GET  /api/recruiter?link=1   (booth only) the phone link and QR for /recruiter
// POST /api/recruiter          { personId, ok, to? }: Yes sends it from the booth's Gmail, No drops it
// With Auth0 on, only a recruiter sees or decides anything: an account that signed in on the booth laptop, or a
// verified email in RECRUITER_EMAILS (lib/followup/approvals isRecruiter). Without Auth0, only the booth laptop.

const noStore = { "cache-control": "no-store" };

const onLaptop = (req: NextRequest) => {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  return !fromOutside(req.headers) && (host === "localhost" || host === "127.0.0.1" || host === "[::1]");
};

async function recruiter(req: NextRequest): Promise<{ name: string; picture: string | null; denied?: boolean } | null> {
  if (!auth0Enabled()) return onLaptop(req) ? { name: "Booth", picture: null } : null;
  const u = await currentUser();
  if (!u) return null;
  // signing in on the booth screen itself is what makes someone the recruiter
  if (onLaptop(req) && typeof u.sub === "string") addBoothRecruiter(u.sub);
  const me = { name: (u.name as string | undefined) ?? (u.email as string | undefined) ?? "Recruiter", picture: (u.picture as string | undefined) ?? null };
  return isRecruiter(u) ? me : { ...me, denied: true };
}

export async function GET(req: NextRequest) {
  const enabled = auth0Enabled();
  if (req.nextUrl.searchParams.has("link")) {
    if (fromOutside(req.headers)) return Response.json({ link: null }, { headers: noStore });
    const base = await publicBaseUrl(req);
    const url = base.url + "/recruiter";
    const svg = await QRCode.toString(url, { type: "svg", margin: 0, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });
    return Response.json({ link: url, reachable: base.reachable, qr: "data:image/svg+xml;utf8," + encodeURIComponent(svg) }, { headers: noStore });
  }
  const user = await recruiter(req);
  return Response.json({ enabled, user, items: user && !user.denied ? approvals().slice(0, 60) : [] }, { headers: noStore });
}

type Body = { personId?: unknown; ok?: unknown; to?: unknown };

export async function POST(req: NextRequest) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return new Response("Cross-site request refused", { status: 403 });
  const user = await recruiter(req);
  if (!user || user.denied) return Response.json({ message: "Sign in as the recruiter first" }, { status: 401 });
  const { personId: raw, ok, to: rawTo } = ((await req.json().catch(() => ({}))) ?? {}) as Body;
  const personId = typeof raw === "string" ? raw.trim() : "";
  const a = personId ? approvalFor(personId) : null;
  if (!a) return Response.json({ message: "Nothing waiting for that person" }, { status: 404 });
  if (a.status === "drafting" || a.status === "sending") return Response.json({ message: "Still working on it", item: a }, { status: 409 });
  if (a.status === "sent") return Response.json({ message: "Already sent", item: a }, { status: 409 });
  if (a.status === "failed" && !a.body) return Response.json({ message: "There's no finished email to send", item: a }, { status: 409 });
  const decided = { decidedBy: user.name, decidedAt: Date.now() };
  if (ok !== true) return Response.json({ item: putApproval(personId, { status: "skipped", error: undefined, ...decided }) }, { headers: noStore });

  const to = typeof rawTo === "string" && rawTo.trim() ? rawTo.trim() : a.to;
  if (!isEmail(to)) return Response.json({ message: "Add their email first" }, { status: 400 });
  if (!a.body) return Response.json({ message: "There's no email written for them" }, { status: 400 });
  const sending = env("FOLLOWUP_SEND") !== "0";
  putApproval(personId, { status: "sending", to, toSource: to === a.to ? a.toSource : "said", error: undefined, ...decided });
  try {
    await sendMail(to, a.subject, a.body, sending);
    if (sending) markSent(personId, Date.now());
    return Response.json({ item: putApproval(personId, { status: "sent", error: sending ? undefined : "Saved as a draft (sending is off)" }) }, { headers: noStore });
  } catch (e) {
    const error = e instanceof Error ? e.message.slice(0, 200) : "Send failed";
    return Response.json({ item: putApproval(personId, { status: "failed", error }), message: error }, { status: 502 });
  }
}

