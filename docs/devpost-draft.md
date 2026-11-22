# Devpost write-up (DRAFT, edit freely; due Sun 9:00 AM)

Updated Sun 3:10 AM for the final story: the booth follow-up is the headline, entered for the TinyFish track
("Hire Your First AI Employee"). Numbers are measured from the repo or by the team tonight. Replace anything the team
decides differently, and check the open question at the bottom before submitting.

## Name and tagline
Touchpoint: hire your first AI employee for the sponsor booth. It remembers every visitor and does the recruiter's
follow-up before they reach the next table.

## Inspiration
At a hackathon, a sponsor's recruiters talk to hundreds of students in two days. Each conversation starts cold, and
the follow-up the recruiter promised ("I'll send you some roles") usually never happens, because by Sunday nobody
remembers who asked about what. We wanted to hire an AI employee for the booth: one that already knows the room,
listens to every conversation, and does the follow-up while the student is still walking to the next table.

## What it does
- **Recognises you.** A camera picks out the main face in front of it and matches it against Hack Western's own
  people data. Below a 50% match, it asks "Who is this?" instead of guessing.
- **Talks with you, hands free.** A voice agent greets you by name and brings up one real thing you've done, then
  holds a natural conversation. It remembers you if you come back, and it switches people in under a second.
- **Shows you things while it talks.** As the conversation moves, the agent builds the screen beside it: your
  project with its live GitHub stars and commits, the people in this room you should meet (as faces with the reason
  on each line), your path as a timeline, a quote from your own writing. Each screen is one visual moment, written
  live by the model from our own component library.
- **Does the recruiter's follow-up.** When you walk away (out of view for 20 seconds after a real conversation), the
  AI employee goes to work, and the booth screen shows every step live:
  1. **Listen:** it reads what you said at the booth and writes a brief: who you are, what you care about, what you
     asked for.
  2. **Research:** a TinyFish web agent opens the sponsor's live careers site (Scotiabank in our demo), searches it
     for you and comes back with 2 to 4 real open postings, each with a link and one line on why it fits you.
  3. **Draft:** it writes a short email that recalls something specific you said and lists those roles.
  4. **Send:** it sends the email from the booth's Gmail right away. One email per visitor every 6 hours, and the
     recruiter can press "Follow up" to send one on demand.
- **Every fact has a source.** Nothing is invented: every talking point traces back to a public page, every job
  link comes from the live careers site or real search results, and a privacy filter keeps religion, health, family,
  politics and contact details out of anything it says.

## How we used TinyFish
The research step is a TinyFish web agent. We give it the sponsor's careers site, starting on the site's own search
results for the visitor's query, plus a goal written from the brief: find 2 to 4 postings that fit this person, read
titles and links from the results list, never sign in, apply or submit anything but the search box, and return
structured JSON (title, URL, location, team, why). We call `run-sse`, so the run streams back to us as it goes: the
agent's live browser appears in the booth UI as an embedded view, and each step it reports
shows up in a ticker as it happens. The recruiter and the student can watch the AI
employee do the job.

A live browser on a real site can be slow or get blocked, and a booth can't wait forever, so a backup engine runs
quietly in parallel. It uses TinyFish Search and Fetch to find and read postings on the sponsor's domain, an OpenAI
model picks the ones that fit, and OpenAI web search is the last resort. Every link it returns must have appeared in
real search or fetch results. If the agent fails or passes its 150 second cap, the backup's roles take over and the
UI says so. In testing, the TinyFish agent found 4 real Scotiabank postings in about 175 seconds from the homepage
(about $0.37 at $0.016 per step), so we now start it on the search results page for the visitor's query, where it
found 4 in 120 seconds and 17 steps (about $0.27). The backup finds real postings in 8 to 21 seconds. End-to-end runs
delivered real emails, including one where the agent hit its cap and the backup took over with no extra wait.

## How we built it
- **People data:** agents researched the attendees from public pages, with one shared research tool that caches every
  page and paces every site across all agents. A second research pipeline went deeper on public LinkedIn and project
  pages. The two teams' agents merged their work through git, row by row. Result: 391 people, 1,817 sourced pages and
  about 5,700 facts; 294 people recognisable by face.
- **Faces:** YuNet finds faces and EdgeFace turns each into a fingerprint, with OpenCV on the CPU. One SQLite file
  with sqlite-vec makes "who is this" a single nearest-neighbour query.
- **Brain:** a Flue agent decides whether to greet, check the name first, or stay quiet. It can only answer through a
  schema-checked tool, and code checks that every talking point is one of the person's real facts.
- **Voice:** OpenAI Realtime over WebRTC, briefed per person, with per-person memory. Cartesia (sonic-3.6) speaks
  the replies, streamed a clause at a time.
- **Gemini API:** `gemini-3-flash-preview` runs the brain, the conversation agent and the screen writer. A full
  screen streams in about 1.3 seconds; if Gemini errors, OpenAI takes over before the visitor notices.
- **Generative screen:** the voice agent calls a `show` tool. Gemini writes the screen in OpenUI Lang, and it streams
  into React components built for this (Portrait, ProjectMoment, Faces, Path, Spotlight, QuoteMoment, BigNumber,
  Constellation).
- **Auth0 passkeys:** the booth shows a QR code for the person it is talking with. They scan it, tap "Is this you?"
  and sign in with Face ID through an Auth0 passkey, so the booth gets their own email and an explicit yes. Each QR
  is signed for one person and expires in 20 minutes, and the tunnel the phone uses only reaches the confirm page.
- **Follow-up pipeline:** one Next.js route streams the whole run with the Vercel AI SDK. The server writes each step,
  the live browser, the agent's actions, the roles, the brief and the email as `createUIMessageStream` data parts
  with stable ids, and the client reads them with `useChat`, so each card updates in place. `generateObject` builds
  the brief and `streamText` writes the email word by word into the email card. The email goes out through the gws
  CLI (Google Workspace) from the booth's Gmail.
- **Stack:** Next.js 16 and React 19, Python, the Flue agent harness, and the Vercel AI SDK. The landing page runs on
  a free domain from the GoDaddy Registry MLH challenge.

## Challenges
- LinkedIn hides some photos from logged-out visitors, and the first photo on such a page belongs to a stranger in
  the sidebar. An audit caught 71 wrong faces. We fixed it at the source and added a guard that drops any face filed
  under two different people.
- Making the screen feel like part of the conversation, not a profile page: one moment per screen, visuals first,
  text as a glance.
- A live web agent is slow next to a person walking away. Starting it on the careers site's search results instead
  of the homepage, capping it at 150 seconds, and running the backup in parallel kept the follow-up fast without
  giving up the real browser.
- Language models like to invent job links. Every link in the email has to come from the agent's run or from real
  search and fetch results; anything else is dropped before the email is written.

## What we learned
(team: add your own)

## What's next
(team: add your own)

## Built with
nextjs, react, typescript, python, opencv, sqlite, sqlite-vec, tinyfish, vercel-ai-sdk, openai, openai-realtime,
cartesia, gmail, google-workspace, gemini, auth0, godaddy-registry, openui, three.js, flue, zod

## Open question for the team before submitting
Emily's Touchpoint brief (docs/sponsor-track-strategy.html) says identification should be attendee-controlled (QR,
badge or check-in), with no facial identification required. The greeter as built recognises faces, and the follow-up
now emails visitors at the address in the Hack Western Slack export. Decide which story we tell, and make the
write-up and the demo match: for example, face recognition and follow-up emails only for people who opted in at
check-in, or QR check-in with the face used only to keep track of who is talking.
