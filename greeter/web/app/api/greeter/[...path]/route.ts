import type { NextRequest } from "next/server";

// The Python greeter (camera, faces, agent) runs on its own port. Everything the page needs goes
// through here so the page has one origin: /api/greeter/frame, /events, /face, /held, /speak (spoken
// audio), /history and /talk, and POST /see (a dropped photo), /grab, /add, /hear (recorded audio) and /say.
const UPSTREAM = process.env.GREETER_API ?? "http://127.0.0.1:8080";

async function proxy(req: NextRequest, ctx: RouteContext<"/api/greeter/[...path]">) {
  const { path } = await ctx.params;
  const target = `${UPSTREAM}/${path.map(encodeURIComponent).join("/")}${new URL(req.url).search}`;
  const post = req.method === "POST";
  // Recorded audio arrives as webm or mp4; the greeter needs the type to decode it.
  const sent = req.headers.get("content-type");
  try {
    const res = await fetch(target, {
      method: req.method,
      body: post ? await req.arrayBuffer() : undefined,
      headers: post && sent ? { "content-type": sent } : undefined,
      cache: "no-store",
      signal: req.signal,
    });
    const headers = new Headers({ "cache-control": "no-store" });
    const type = res.headers.get("content-type");
    if (type) headers.set("content-type", type);
    // Where the faces are in this frame, so the page can make the unknown ones clickable.
    const faces = res.headers.get("x-faces");
    if (faces) headers.set("x-faces", faces);
    if (path[0] === "events") {
      headers.set("cache-control", "no-cache, no-transform");
      headers.set("x-accel-buffering", "no");
    }
    if (path[0] === "photo" || path[0] === "face") headers.set("cache-control", "private, max-age=300");
    // The same line always sounds the same, so the browser can keep its audio for a while.
    if (path[0] === "speak" && res.ok) headers.set("cache-control", "private, max-age=3600");
    return new Response(res.body, { status: res.status, headers });
  } catch {
    return Response.json({ message: `The greeter isn't running at ${UPSTREAM}.` }, { status: 502 });
  }
}

export { proxy as GET, proxy as POST };
