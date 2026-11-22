// GET /api/logo?f=<file> -> a logo found live for an organisation public/logos doesn't have (see live-logos.ts).
import { logoFile } from "../talk/profile/live-logos";

export async function GET(request: Request) {
  const hit = logoFile(new URL(request.url).searchParams.get("f") ?? "");
  if (!hit) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(hit.body), {
    headers: {
      "content-type": hit.type,
      "cache-control": "public, max-age=86400",
      // an SVG from someone else's site never runs script here, even opened directly
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}

