// Keys for the follow-up live in the environment, or in the greeter's own .env files (gitignored), so the web app
// can be started from any shell without copying secrets around.
import { readFileSync } from "node:fs";
import path from "node:path";

const FILES = [
  path.resolve(process.cwd(), ".env.local"),
  path.resolve(process.cwd(), "..", ".env"), // greeter/.env
  path.resolve(process.cwd(), "..", "..", "flue", ".env"),
];

export function env(name: string): string | undefined {
  const v = process.env[name];
  if (v) return v;
  for (const f of FILES) {
    try {
      const m = readFileSync(/*turbopackIgnore: true*/ f, "utf8").match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`, "m"));
      if (m?.[1]) return m[1].trim().replace(/^["']|["']$/g, "");
    } catch {}
  }
  return undefined;
}

