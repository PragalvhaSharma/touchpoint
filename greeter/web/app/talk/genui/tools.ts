// The voice agent's hands: OpenAI Realtime function tools that read our data and build the screen.
// The definitions go into the voice session's session.update; handleScreenTool runs a call in the browser
// and returns what goes back to the model as the function_call_output.
import type { ScreenHandle } from "./screen";

const DATA = "/api/talk/data";

export const screenTools = [
  {
    type: "function",
    name: "show",
    description:
      "Put something on the screen beside you while you talk: a person, their project, a quote, who they should meet, " +
      "a number. Call it every time you bring something up, then keep talking; the screen builds itself while you speak. " +
      "Returns at once.",
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description: "What to show, in a few plain words, naming who it's about, e.g. \"Evan Lin's chip project\" or \"people Maya should meet\".",
        },
        person_id: { type: "string", description: "The id of the person it's about, if you have it from lookup_person or search_people." },
      },
      required: ["request"],
    },
  },
  {
    type: "function",
    name: "lookup_person",
    description: "Everything we know about one person at Hack Western (facts with sources, their pages), by name or id.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Their name or id." } },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "search_people",
    description: "Find people at Hack Western who built, won, studied or work on something, e.g. \"robotics\", \"Waterloo\", \"won a hackathon\".",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "A few words about what they did." } },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "who_to_meet",
    description: "The people this person should meet here, each with one reason and what they share.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "The person's id." } },
      required: ["id"],
    },
  },
] as const;

export type ScreenToolName = (typeof screenTools)[number]["name"];

async function get(op: string, key: "q" | "id", value: string): Promise<unknown> {
  const r = await fetch(`${DATA}?op=${op}&${key}=${encodeURIComponent(value)}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`our data said ${r.status}`);
  return r.json();
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// One function call from the model. `about` is the id of the person the voice is talking with, used when a
// show call doesn't name anyone. Never throws: an error goes back to the model as {error} so it can carry on.
export async function handleScreenTool(name: string, args: string | Record<string, unknown>, screen: ScreenHandle, about?: string): Promise<object> {
  let a: Record<string, unknown>;
  try {
    a = typeof args === "string" ? (JSON.parse(args || "{}") as Record<string, unknown>) : args;
  } catch {
    return { error: "arguments weren't valid JSON" };
  }
  try {
    switch (name as ScreenToolName) {
      case "show": {
        const request = str(a.request);
        if (!request) return { error: "say what to show in request" };
        void screen.show(request, str(a.person_id) || about);
        return { shown: true };
      }
      case "lookup_person": {
        const person = await get("person", "q", str(a.query));
        return person ? { person } : { found: false };
      }
      case "search_people":
        return { people: await get("search", "q", str(a.query)) };
      case "who_to_meet":
        return { people: await get("meet", "id", str(a.id) || about || "") };
      default:
        return { error: `no tool called ${name}` };
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
