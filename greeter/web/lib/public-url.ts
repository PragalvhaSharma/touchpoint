import type { NextRequest } from "next/server";
import { boothTunnel } from "./tunnel";

// Where a phone can reach this app: the QR on the booth screen points here.
// 1. PUBLIC_URL, if set (a named tunnel or a deployed URL).
// 2. The booth's own cloudflared quick tunnel (lib/tunnel.ts), started on demand for the port this page is
//    served on and restarted if it drops, so the QR always opens on a phone.
// 3. A cloudflared quick tunnel someone started by hand, found on its local metrics port (/quicktunnel).
// 4. The address the booth page was opened at: reachable from a phone on the same wifi when that is a LAN
//    address (192.168.x.x, 10.x, 172.16-31.x, *.local), never when it is localhost.
const METRICS_PORTS = [20241, 20242, 20243, 20244, 20245];
let manual: { url: string | null; at: number } | null = null;

async function manualTunnel(): Promise<string | null> {
  if (manual && Date.now() - manual.at < 15_000) return manual.url;
  const found = await Promise.all(
    METRICS_PORTS.map(async (port) => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/quicktunnel`, { cache: "no-store", signal: AbortSignal.timeout(300) });
        const host = res.ok ? ((await res.json()) as { hostname?: string }).hostname : null;
        return host ? "https://" + host : null;
      } catch {
        return null;
      }
    }),
  );
  manual = { url: found.find(Boolean) ?? null, at: Date.now() };
  return manual.url;
}

const first = (v: string | null) => v?.split(",")[0]?.trim() || null;

function requestOrigin(req: NextRequest): string {
  const host = first(req.headers.get("x-forwarded-host")) ?? first(req.headers.get("host")) ?? req.nextUrl.host;
  const proto = first(req.headers.get("x-forwarded-proto")) ?? req.nextUrl.protocol.replace(":", "");
  return `${proto}://${host}`;
}

/** The port this server listens on, for the tunnel to point at. */
function serverPort(req: NextRequest): number {
  const env = parseInt(process.env.PORT ?? "", 10);
  if (Number.isFinite(env) && env > 0) return env;
  const host = first(req.headers.get("host")) ?? req.nextUrl.host;
  const m = host.match(/:(\d+)$/);
  return m ? parseInt(m[1], 10) : req.nextUrl.protocol === "https:" ? 443 : 80;
}

function onLan(origin: string): boolean {
  try {
    const h = new URL(origin).hostname;
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.endsWith(".local");
  } catch {
    return false;
  }
}

/** The base URL for the QR, and whether a phone off the local network can open it. */
export async function publicBaseUrl(req: NextRequest, waitMs = 12_000): Promise<{ url: string; reachable: boolean }> {
  const set = process.env.PUBLIC_URL?.trim();
  if (set) return { url: set.replace(/\/+$/, ""), reachable: true };
  const own = await boothTunnel(serverPort(req), waitMs);
  if (own) return { url: own, reachable: true };
  const hand = await manualTunnel();
  if (hand) return { url: hand, reachable: true };
  const origin = requestOrigin(req);
  return { url: origin, reachable: onLan(origin) };
}
