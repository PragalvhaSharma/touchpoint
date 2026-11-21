import { load, resolve, search, meet, repo } from "./store";
export type { Fact, Page, Person, Found, Meet, Repo } from "./store";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const op = params.get("op");
  const q = params.get("q") ?? "";
  const headers = { "cache-control": "no-store" };
  if (op === "repo") {
    const url = params.get("url") ?? q;
    if (!url) return Response.json({ error: "url is required" }, { status: 400, headers });
    const r = await repo(url);
    return r ? Response.json(r, { headers }) : Response.json({ error: "no such repository on GitHub" }, { status: 404, headers });
  }
  const s = load();
  if (op === "person") return Response.json(resolve(s, q)?.person ?? null, { headers });
  if (op === "search") return Response.json(search(s, q), { headers });
  if (op === "meet") return Response.json(meet(s, params.get("id") ?? q), { headers });
  return Response.json({ error: "op must be person, search, meet or repo" }, { status: 400, headers });
}
