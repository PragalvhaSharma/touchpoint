// Live check of the research step. Run from greeter/web:
//   zsh -lc 'node_modules/.bin/jiti scripts/try-research.mts [careersUrl] [company]'
//   FOLLOWUP_FORCE_BACKUP=1 ... to skip the TinyFish agent
import { findRoles } from "../lib/followup/research";
import type { Booth, Brief } from "../lib/followup/types";

const careersUrl = process.argv[2] ?? "https://jobs.scotiabank.com/";
const company = process.argv[3] ?? "Scotiabank";
const booth: Booth = { company, careersUrl, recruiter: "Booth recruiter", searchUrl: process.argv[4] };
const brief: Brief = {
  person: {
    id: "demo",
    name: "Priya Shah",
    role: "3rd-year Computer Science student at Western",
    photo: null,
  },
  company,
  summary: `Third-year Western CS student who built an ML fraud-detection hack and came to ask about ${company} data and ML internships for summer 2027.`,
  interests: ["machine learning", "data science", "internship summer 2027"],
  asks: [
    "Are there ML or data science internships for summer 2027?",
    "Send me the links to apply",
  ],
  query: "data intern co-op",
};

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`;
const ac = new AbortController();
process.on("SIGINT", () => ac.abort());
try {
  const roles = await findRoles(
    { booth, brief, signal: ac.signal },
    {
      browser: (b) => console.log(ts(), "browser", JSON.stringify(b)),
      action: (a) => console.log(ts(), "action ", `[${a.engine}]`, a.text),
    },
  );
  console.log(ts(), "RESULT", JSON.stringify(roles, null, 2));
} catch (e) {
  console.log(ts(), "ERROR", (e as Error).message);
  process.exitCode = 1;
}
