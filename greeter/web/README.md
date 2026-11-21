# Greeter web

The Next.js front end for the Greeter: one page at `/` with the live camera, who is in view and what the agent says.

```
npm install
npm run build && npm start   # http://localhost:3000
npm run dev                  # while editing
```

The page talks to the Python greeter through `/api/greeter/*` (set `GREETER_API`, default http://127.0.0.1:8080).

Design follows Apple's dark system palette: glass bars over the camera, spring motion with no bounce, press feedback, and fallbacks for reduced motion, reduced transparency and higher contrast.

## Auth0: pick your follow-up email on your own phone

As soon as the greeter recognises someone (not a guest), a **Scan to get your follow-up** QR appears in the right panel, so they scan it while they are still at the booth. It opens `/confirm?pid=<id>&t=<ticket>` on their phone. With Auth0 keys set they first sign in with an **Auth0 passkey** (Face ID or Touch ID, no password). Then the sheet shows their Auth0 account email and the directory email (masked) as buttons: one tap picks where the follow-up goes. A typed email box only appears when no email is known, and **No thanks** opts out. The booth card flips to *You're set · follow-up goes to a•••@gmail.com*. The booth screen only ever gets a masked address; the full email stays on the server for the follow-up. `emailVerified` is true only when the chosen email is the Auth0 account's verified email.

Without Auth0 keys the same QR and sheet work with no sign-in step: the signed ticket in the QR is the proof they stood at the booth. Set `CONFIRM_QR=0` to hide the QR. The follow-up sends as soon as the chat ends, to the email the visitor tapped on their phone or, if they never scanned, their Slack directory email. The choice is rechecked right before sending, so a late "No thanks" or a new address still counts. A "No thanks" is final, and without Auth0 a QR confirmation can't be pointed at a different email by someone else scanning the TV. `FOLLOWUP_REQUIRE_CONSENT=1` holds every follow-up until the visitor picks an email on their phone.

If a visitor walks away before scanning, their follow-up is skipped and the server remembers them for two hours. When they confirm an email later, the booth (which polls `GET /api/confirm?ready=1`) starts their follow-up then.

A **Recruiter sign-in** chip in the panel header lets whoever runs the booth sign in with the same Auth0 app (it shows "Rep · <name>"). It gates nothing.

Without Auth0 keys the /auth routes do nothing and the recruiter chip stays hidden; the tunnel rules below still apply.

| Piece | Where |
| --- | --- |
| Auth0 client (on only when the four keys are set) | `lib/auth0.ts` |
| `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/profile` | `proxy.ts` (matcher `/auth/:path*` only) |
| Consent store, `.data/consent.json` (gitignored) | `lib/consent.ts` |
| Phone page | `app/confirm/page.tsx`, `app/confirm/flow.tsx` |
| Status (GET, masked), decision (POST, ticket, plus a passkey sign-in when Auth0 is on) and the ready list | `app/api/confirm/route.ts` |
| Booth card and header chip | `app/live/confirm-card.tsx`, `app/live/recruiter-chip.tsx` |

A follow-up sender gets the verified address with:

```ts
import { confirmedContact } from "@/lib/consent";
const contact = confirmedContact(personId); // { email, emailVerified, name, confirmedAt } | null
```

It returns null unless that person confirmed a valid email. `confirmedContact(id, { requireVerified: true })` also requires that it is their Auth0 account's verified email. A brand new passkey signup is unverified until the visitor clicks Auth0's verification email.

### Env (in `greeter/.env`, loaded by `next.config.ts`)

```
AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_CLIENT_ID=...
AUTH0_CLIENT_SECRET=...
AUTH0_SECRET=...            # openssl rand -hex 32
# optional
PUBLIC_URL=https://...      # where phones reach this app; see below
APP_BASE_URL=               # leave unset (see below)
```

Leave `APP_BASE_URL` unset. The SDK (v4) then builds the callback URL from the request's host and `x-forwarded-proto`, so one server works at `http://localhost:3000` on the booth laptop and at `https://<random>.trycloudflare.com` on a phone. A single value pins every login to that one URL, and the SDK does not accept a comma-separated value. `lib/auth0.ts` turns a comma-separated list into the SDK's allow-list array, which accepts only those origins.

With `APP_BASE_URL` unset, the SDK marks its cookies `Secure` under `next start`. Phones go through https, so that's fine. On the laptop, Chrome accepts Secure cookies on `http://localhost`, but Safari may not, so use Chrome for the recruiter sign-in or open the tunnel URL. `npm run dev` doesn't force Secure cookies.

### Auth0 dashboard

1. **Applications → Create Application → Regular Web Application.** Copy the domain, client ID and secret into `greeter/.env`.
2. **Allowed Callback URLs:** `http://localhost:3000/auth/callback, https://<tunnel>.trycloudflare.com/auth/callback`.
3. **Allowed Logout URLs:** `http://localhost:3000, http://localhost:3000/confirm, https://<tunnel>.trycloudflare.com, https://<tunnel>.trycloudflare.com/confirm`.
4. **Allowed Web Origins:** `http://localhost:3000, https://<tunnel>.trycloudflare.com`.

   A quick tunnel gets a new random hostname every time it starts, so start it once, paste its URL into these three fields and keep it running for the demo. Auth0 also takes `https://*.trycloudflare.com/...` wildcards, which save the re-paste, but `trycloudflare.com` is on the public suffix list, and if the dashboard refuses the wildcard, use the exact URL.
5. **Authentication → Database → Username-Password-Authentication → Authentication Methods → Passkey:** enable passkeys. Under **Authentication → Authentication Profile**, choose **Identifier First** so Universal Login offers "Continue with a passkey" and new visitors can sign up with one.
6. Make sure the connection is enabled for this application (the application's **Connections** tab).

The SDK's headless passkey API (`passkey.login()` in our own UI) needs an Auth0 custom domain, so this uses Universal Login, which runs the passkey ceremony on Auth0's page with no custom domain.

### Phones: a public tunnel

```
npm run build && npm start                                       # :3000, the phone tunnel starts with it
```

The app starts its own cloudflared quick tunnel (`lib/tunnel.ts`) as soon as the booth page opens, and restarts it if it drops. It looks for cloudflared at `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin` or `CLOUDFLARED`. The QR only appears once Cloudflare has registered the tunnel; until then the card says it is getting the link ready, so a phone never gets a dead link. Set `PUBLIC_URL` to use a fixed address instead (a named tunnel or a deployment), or `TUNNEL=0` to turn the tunnel off. A tunnel you start by hand is still found through cloudflared's metrics endpoint (`127.0.0.1:20241/quicktunnel`).

The laptop's own DNS can take minutes to resolve a brand new `trycloudflare.com` name, so test the link from a phone, or with `curl --doh-url https://1.1.1.1/dns-query <url>`.

What the tunnel exposes: \`proxy.ts\` treats any request that arrives through cloudflared (it adds \`Cf-Connecting-Ip\`) or on a host other than this laptop or the local network as coming from outside. Outside requests only reach \`/confirm\`, Auth0's \`/auth/*\` routes, \`POST /api/confirm\`, the page's own assets, and the face photo of the person named in a valid ticket. Everything else, including the camera, \`/talk\` and the people data APIs, returns 404.

Each QR carries a ticket for one person that lasts 20 minutes, signed with \`TICKET_SECRET\`, else \`AUTH0_SECRET\`, else a random key kept in \`.data/ticket-secret\`. The booth card fetches a fresh one every 10 minutes, and \`/confirm\` and \`POST /api/confirm\` reject a missing, forged or expired ticket. So only someone standing at the booth can choose the email. Once a person confirms with an Auth0 account, a different account can't overwrite it; a QR-only choice can be changed by scanning again.

