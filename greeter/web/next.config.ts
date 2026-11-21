import type { NextConfig } from "next";
import { existsSync } from "node:fs";
import path from "node:path";

// The greeter's keys live once, in greeter/.env (the Python side reads the same file): the screen writer in
// app/api/talk/ui uses OPENAI_API_KEY from there. Anything already set in the environment still wins.
const greeterEnv = path.join(process.cwd(), "..", ".env");
if (existsSync(greeterEnv)) process.loadEnvFile(greeterEnv);

const nextConfig: NextConfig = {
  // the booth QR opens /confirm through its own cloudflared quick tunnel; without this, next dev blocks the page's
  // scripts from that host and the phone's buttons do nothing
  allowedDevOrigins: ["*.trycloudflare.com"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
