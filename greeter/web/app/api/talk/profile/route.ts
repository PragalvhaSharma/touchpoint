// GET /api/talk/profile?id=<Slack id> -> one person's profile as an AI SDK UI message stream (SSE).
// No model is involved: the data is already ours. The AI SDK's data parts carry each card as it is ready, typed
// end to end (ProfileMessage), and a transient "status" part says what is being pulled right now. The cards from
// disk arrive a beat apart so the panel visibly fills in; GitHub and the people to meet come when they're found.
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { ProfileMessage } from "@/app/live/types";
import { liveLogos, sections, slow } from "./build";

const BEAT = 170; // ms between cards read from disk
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  const s = sections(id);
  if (!s) return Response.json({ error: "nobody with that id" }, { status: 404 });
  const first = s.identity.first;
  // logos for organisations we don't have on disk are looked up while the cards stream (3 s at most on screen)
  const logos = liveLogos(s, 3000);

  const stream = createUIMessageStream<ProfileMessage>({
    execute: async ({ writer }) => {
      const status = (step: string, label: string) => writer.write({ type: "data-status", data: { step, label }, transient: true });
      const beat = () => (request.signal.aborted ? Promise.reject(new Error("closed")) : sleep(BEAT));
      writer.write({ type: "start" });
      status("identity", "Matched " + first + "'s face");
      writer.write({ type: "data-identity", id: "identity", data: s.identity });
      await beat();
      status("profile", "Reading " + first + "'s profile");
      if (s.school) {
        writer.write({ type: "data-school", id: "school", data: s.school });
        await beat();
      }
      if (s.roles.now.length || s.roles.past.length || s.roles.leading.length) {
        writer.write({ type: "data-roles", id: "roles", data: s.roles });
        await beat();
      }
      if (s.projects.length) {
        writer.write({ type: "data-projects", id: "projects", data: s.projects });
        await beat();
      }
      if (s.wins.wins.length || s.wins.awards.length) {
        writer.write({ type: "data-wins", id: "wins", data: s.wins });
        await beat();
      }
      if (s.points.length) writer.write({ type: "data-points", id: "points", data: s.points });
      status("live", "Checking GitHub and who " + first + " should meet");
      const [more, newLogos] = await Promise.all([slow(s.identity.id), logos]);
      // same ids, so the panel swaps the letter tiles for the logos found live
      if (newLogos) {
        writer.write({ type: "data-roles", id: "roles", data: s.roles });
        writer.write({ type: "data-identity", id: "identity", data: s.identity });
      }
      if (more.repos.length) writer.write({ type: "data-repos", id: "repos", data: more.repos });
      if (more.meet.length) writer.write({ type: "data-meet", id: "meet", data: more.meet });
      status("done", "Profile ready");
      writer.write({ type: "finish" });
    },
    onError: () => "Couldn't read that profile.",
  });
  return createUIMessageStreamResponse({ stream, headers: { "cache-control": "no-store" } });
}

