import { Auth0Client } from "@auth0/nextjs-auth0/server";

// Auth0 is optional: with no keys the app runs exactly as before, the proxy passes every request through,
// and the confirm card and recruiter chip stay hidden. Keys come from greeter/.env (loaded by next.config.ts).
const REQUIRED = ["AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_SECRET"] as const;

export const auth0Enabled = () => REQUIRED.every((k) => !!process.env[k]?.trim());

// APP_BASE_URL is left unset on purpose: the SDK then builds the callback URL from the request host, so the
// same server works at http://localhost:3000 and through a cloudflared tunnel a phone opens. If it is set to
// a comma-separated list, the SDK treats it as an allow-list and only accepts requests from those origins.
function appBaseUrl(): string | string[] | undefined {
  const raw = process.env.APP_BASE_URL?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  return raw.length === 0 ? undefined : raw.length === 1 ? raw[0] : raw;
}

let client: Auth0Client | null = null;

/** The Auth0 client, or null when Auth0 isn't configured. */
export function getAuth0(): Auth0Client | null {
  if (!auth0Enabled()) return null;
  client ??= new Auth0Client({
    appBaseUrl: appBaseUrl(),
    // openid profile email: the booth needs a verified email to send the follow-up to
    authorizationParameters: { scope: "openid profile email" },
    session: { rolling: true, absoluteDuration: 60 * 60 * 24 * 3 },
  });
  return client;
}

/** The signed-in user, or null (also null when Auth0 is off or the session can't be read). */
export async function currentUser() {
  const auth0 = getAuth0();
  if (!auth0) return null;
  try {
    return (await auth0.getSession())?.user ?? null;
  } catch {
    return null;
  }
}

