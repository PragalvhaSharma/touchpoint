import path from "node:path";
import { csv, load } from "@/app/api/talk/data/store";
import { isEmail } from "./consent";

export type Visitor = { id: string; name: string; first: string; role: string; headline: string | null; photo: string };

const REPO = path.resolve(process.cwd(), "../.."); // next runs from greeter/web
const MEMBERS = path.join(process.env.HW_DATA ?? path.join(REPO, "hack-western-13-people"), "hack-western-13-slack-members.csv");

/** Their name and email in the Hack Western Slack directory (email may be ""), or null when they aren't in it. */
export function directoryContact(personId: string): { name: string; email: string } | null {
  try {
    const row = csv(MEMBERS).find((r) => r["Slack user ID"] === personId);
    if (!row) return null;
    const email = (row["Email"] || row["Other email"] || "").trim();
    return { name: (row["Name"] ?? "").replace(/\s*\(you\)\s*$/, ""), email: isEmail(email) ? email : "" };
  } catch {
    return null;
  }
}

/** Who the booth thinks this badge id is, from the greeter's own data (null if unknown or the data is missing). */
export function visitor(id: string): Visitor | null {
  try {
    const p = load().byId.get(id)?.person;
    if (!p) return null;
    return {
      id: p.id,
      name: p.name,
      first: p.name.split(/\s+/)[0] ?? p.name,
      role: p.role,
      headline: p.headline ?? null,
      photo: p.photo ?? `/api/greeter/face?id=${encodeURIComponent(p.id)}`,
    };
  } catch {
    return null;
  }
}

