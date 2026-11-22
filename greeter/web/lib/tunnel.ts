import { spawn, type ChildProcess } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The booth's own public link, so a phone can always open the QR. The first time the booth asks for a QR, this
// starts a cloudflared quick tunnel to this server's port, reads its random https://*.trycloudflare.com address
// from cloudflared's log, and hands it out once Cloudflare has the tunnel (cloudflared logs "Registered tunnel
// connection") or the address answers a probe from here. The probe alone is not enough: the laptop's own DNS
// often caches a miss for a brand new trycloudflare name for minutes, while phones resolve it at once.
// If cloudflared exits, it starts again a few seconds later (a new address; the QR picks it up on its next refresh).
// TUNNEL=0 turns this off; PUBLIC_URL (lib/public-url.ts) skips it for a fixed address.

type Tunnel = {
  port: number;
  child: ChildProcess | null;
  url: string | null; // the address cloudflared printed
  ready: boolean; // that address answered through Cloudflare
  missing: boolean; // no cloudflared binary: stop trying
  restarts: number;
  retryAt: number; // after an exit, no restart before this time (backoff)
  waiters: Set<() => void>;
};

// one per port, kept across hot reloads in dev
const g = globalThis as typeof globalThis & { __boothTunnels?: Map<number, Tunnel> };
const tunnels = (g.__boothTunnels ??= new Map<number, Tunnel>());

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const REGISTERED_RE = /Registered tunnel connection/;
// after the edge registers the tunnel, a moment for the new name to propagate before a phone tries it
const SETTLE_MS = 1500;
// Cloudflare sometimes drops a quick tunnel's name while cloudflared keeps running, and phones then get "site can't
// be reached". Every minute the name is looked up on public DNS (the laptop's own DNS caches); two misses in a row
// restart cloudflared, which brings a new address that the QR picks up on its next refresh.
const HEALTH_MS = 60_000;

/** False only when public DNS says the name doesn't exist; a timeout or no network counts as fine. */
async function nameExists(url: string): Promise<boolean> {
  const r = new Resolver({ timeout: 4000, tries: 2 });
  r.setServers(["1.1.1.1", "8.8.8.8"]);
  try {
    await r.resolve4(new URL(url).host);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return !(code === "ENOTFOUND" || code === "ENODATA");
  }
}

function binary(): string | null {
  const set = process.env.CLOUDFLARED?.trim();
  if (set) return set;
  const home = os.homedir();
  const found = [path.join(home, ".local/bin/cloudflared"), "/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"].find((p) => existsSync(p));
  return found ?? "cloudflared"; // last resort: whatever is on PATH
}

const wake = (t: Tunnel) => {
  for (const w of t.waiters) w();
  t.waiters.clear();
};

const markReady = (t: Tunnel, url: string) => {
  if (t.url !== url || t.ready) return;
  t.ready = true;
  t.restarts = 0;
  wake(t);
};

/** Polls the new address until Cloudflare routes it here (a fresh quick tunnel takes a few seconds). */
async function probe(t: Tunnel, url: string) {
  for (let i = 0; i < 40 && t.url === url && !t.ready; i++) {
    try {
      const res = await fetch(url + "/favicon.ico", { cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(4000) });
      if (res.status < 500) {
        markReady(t, url);
        return;
      }
    } catch {
      // not resolving yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  wake(t);
}

function start(t: Tunnel) {
  const bin = binary();
  if (!bin) {
    t.missing = true;
    return;
  }
  // --metrics on a random port: the default 20241-20245 is where lib/public-url.ts looks for a tunnel started by
  // hand, and it must not find this one there before it is ready
  const child = spawn(bin, ["tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:0", "--url", `http://127.0.0.1:${t.port}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.child = child;
  t.url = null;
  t.ready = false;
  let registered = false;
  const settle = () => {
    const url = t.url;
    if (registered && url) setTimeout(() => markReady(t, url), SETTLE_MS);
  };
  const read = (chunk: Buffer) => {
    if (t.child !== child) return;
    const s = chunk.toString();
    const m = t.url ? null : s.match(URL_RE);
    if (m) {
      t.url = m[0];
      void probe(t, m[0]);
      settle();
    }
    if (!registered && REGISTERED_RE.test(s)) {
      registered = true;
      settle();
    }
  };
  child.stdout?.on("data", read);
  child.stderr?.on("data", read);
  child.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") t.missing = true;
  });
  let misses = 0;
  const health = setInterval(async () => {
    const url = t.url;
    if (t.child !== child || !t.ready || !url) return;
    if (await nameExists(url)) {
      misses = 0;
      return;
    }
    if (++misses >= 2 && t.child === child && t.url === url) {
      console.warn("[tunnel] " + url + " no longer resolves; restarting cloudflared");
      child.kill();
    }
  }, HEALTH_MS);
  health.unref?.();
  child.on("exit", () => {
    clearInterval(health);
    if (t.child !== child) return;
    t.child = null;
    t.url = null;
    t.ready = false;
    wake(t);
    if (t.missing) return;
    t.restarts++;
    const delay = Math.min(30_000, 2000 * t.restarts);
    t.retryAt = Date.now() + delay;
    setTimeout(() => {
      if (!t.child) start(t);
    }, delay);
  });
}

// Next exits on Ctrl-C and on kill; take the tunnel down with it.
let cleanup = false;
function killOnExit() {
  if (cleanup) return;
  cleanup = true;
  process.once("exit", () => tunnels.forEach((t) => t.child?.kill()));
}

/**
 * The public https address for this server's port, starting the tunnel if needed. Waits up to waitMs for it to
 * answer; null when it isn't ready yet (or cloudflared isn't installed, or TUNNEL=0).
 */
export async function boothTunnel(port: number, waitMs = 12_000): Promise<string | null> {
  if (process.env.TUNNEL === "0" || !Number.isFinite(port) || port <= 0) return null;
  let t = tunnels.get(port);
  if (!t) {
    t = { port, child: null, url: null, ready: false, missing: false, restarts: 0, retryAt: 0, waiters: new Set() };
    tunnels.set(port, t);
    killOnExit();
  }
  if (t.missing) return null;
  if (!t.child && Date.now() >= t.retryAt) start(t);
  if (t.ready && t.url) return t.url;
  const tun = t;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      tun.waiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, waitMs);
    tun.waiters.add(done);
  });
  return t.ready ? t.url : null;
}
