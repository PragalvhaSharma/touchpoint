import { connection } from "next/server";
import { auth0Enabled, currentUser } from "@/lib/auth0";

// For the booth header: is Auth0 on, and which recruiter (if any) is signed in on this screen.
export async function GET() {
  await connection(); // per request: Auth0 keys and the session cookie are runtime facts, never prerendered
  if (!auth0Enabled()) return Response.json({ enabled: false }, { headers: { "cache-control": "no-store" } });
  const u = await currentUser();
  const user = u ? { name: (u.name as string | undefined) ?? (u.email as string | undefined) ?? "Signed in", picture: (u.picture as string | undefined) ?? null } : null;
  return Response.json({ enabled: true, user }, { headers: { "cache-control": "no-store" } });
}

