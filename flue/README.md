# Greeter brain on Flue

The deciding half of the Greeter, built on [Flue](https://flueframework.com), the TypeScript agent harness from the Astro team. The Python greeter finds and names faces; when someone has been in view for a moment it asks this brain what to do, and an AI decides: greet them, check their name first, or stay quiet, and what to say. It replaces the mock in [greeter/greeter/agent.py](../greeter/greeter/agent.py), which stays as the fallback.

The decision is type safe from end to end. The model can only answer by calling a `decide` tool whose input is a Valibot schema, so it picks one of three actions, a line, and a talking point by its index in the person's real facts. Code checks what a schema can't: the talking point exists, the line uses the person's first name, and a match within 0.05 of the bar is confirmed ("Hi, are you Alex?") before any facts come up. A failed check goes back to the model, which fixes its call. Code, never the model, turns the action into the Arduino line.

**Gemini API:** with `GEMINI_API_KEY` set, Google's Gemini (`gemini-3-flash-preview`, through pi-ai's built-in `google` provider) is the model behind both agents. It makes every greet, confirm or skip decision through the `decide` tool, writes the spoken line, and holds every remembered conversation in `npm run talk`. Both servers log `using google/gemini-3-flash-preview` at startup and report it at `GET /health`.

| File | What it is |
| --- | --- |
| [src/decision.ts](src/decision.ts) | The contract: `Sighting` (what the camera saw), `Decision` (what the AI may answer), the cross-field rules and the safe fallback |
| [src/agents/greeter.ts](src/agents/greeter.ts) | The `Greeter` agent: one conversation per person, their profile from `../greeter/greeter.db`, the `decide` tool and the model choice |
| [src/brain.ts](src/brain.ts) | The HTTP server the Python greeter calls: `POST /decide`, `GET /health` |
| [src/agents/companion.ts](src/agents/companion.ts) | The `Companion` agent people talk with after the first hello: one remembered conversation per person |
| [src/talk.ts](src/talk.ts) | The conversation server the Python greeter calls: `POST /talk/:id`, `GET /health` |
| [src/tools/people.ts](src/tools/people.ts) | Reads people and talking points from `../greeter/greeter.db` (read only) |
| [src/decision.test.ts](src/decision.test.ts) | The rules the model can't get past |

## Run it

Requirements:

- Node 23.6 or newer, which runs the TypeScript directly.
- Gemini API: `GEMINI_API_KEY` in `flue/.env` or the shell (the default model, `google/gemini-3-flash-preview`). Without it, the fallbacks under [Which model](#which-model) apply.

```
cd flue
npm install
npm run brain                     # http://127.0.0.1:8090
cd ../greeter && uv run greeter --camera 0 --brain http://127.0.0.1:8090
```

Try one decision without the camera: `npm run brain -- --once '{"id":"U0CGDSG30DS","name":"Alex Li","score":0.62,"visit":1}'`. Example answer:

```json
{ "action": "greet", "say": "Hey Alex! Congrats on winning the SpurHacks startup track with Cluely. Have you kept building that project?",
  "fact": 0, "why": "Solid match, first visit", "source": "agent", "link": "P Alex Li", "ms": 2450 }
```

A bad request gets a 400 listing the fields that failed the schema. If the model is down or takes longer than 5 s (`GREETER_BRAIN_TIMEOUT_MS`), the brain answers with a safe greeting that uses no facts (`"source": "fallback"`), and for the next 30 s it answers that way at once instead of making everyone wait. If the brain itself is down, the Python greeter uses its mock agent.

`npm run check` type-checks everything and `npm test` runs the rule tests.

Conversations persist per person in `.data/brain.db`, and when the greeter last spoke to each person in `.data/last-spoke.json`. On a return visit the AI knows what it already said and picks a new talking point. It may stay quiet only when it spoke to them under two minutes ago, and the code enforces that rule. Requests for the same person run one at a time. People whose name is a username (such as `aelrafi3`) are greeted without a name. Delete `.data` to start the demo fresh.

## Talking with it

After the first hello, people talk with the greeter out loud, hands free, the way ChatGPT voice works: they just speak, it answers in a natural voice, and they can cut in at any time. The voice is an OpenAI Realtime session (`gpt-realtime-2.1`) that the web page opens over WebRTC with a short-lived key from the Python greeter (`GET /session`). When `greeter/.env` has `CARTESIA_API_KEY`, the session answers in text and Cartesia speaks it (`sonic-3.6`, voice Parker), streamed a clause at a time; otherwise OpenAI's cedar voice does. The key is minted already briefed: the `Companion` agent's prompt for that person (`GET /prompt/:id` here), how to sound like a person at the table, and their whole conversation so far. The page posts every line either side says back to the greeter (`POST /log`), which keeps the record and passes it to the `Companion` agent, so typed messages and later sessions carry on from the same memory. The keys live in `greeter/.env` as `OPENAI_API_KEY=...` and `CARTESIA_API_KEY=...` (gitignored); the agent itself uses the same model as the brain.

```
npm run talk                      # http://127.0.0.1:8095
curl -s localhost:8095/talk/U0CKWHRFWF6 -d '{"said":"I finally got the servo working"}'
```

Every person has their own conversation, keyed by their id in `greeter.db`: their Slack id, the folder name of someone added at the table, or `guest-<time>` for a face the camera doesn't know. Flue keeps each one in `.data/talk.db`, so memory survives restarts. When someone else holds the middle of the picture for 1.5 s, the greeter ends the voice session and opens one briefed for them. When the first person comes back it switches back, and if they've been gone more than two minutes it opens with a welcome back about something from last time. A face it doesn't know becomes a new guest after 3 s, and with nobody in view for 8 s it stops talking.

`POST /talk/:id` takes `said` (their words), `event` (a camera note such as "Sam just walked back up to the table") and `context` (lines said outside this agent, from the greeting brain or the voice session), and answers `{ text, ms }`. `GET /prompt/:id` returns the agent's prompt for that person. `GREETER_TALK_PORT` moves it.

## Which model

`npm run brain` and `npm run talk` load `flue/.env` if it exists (never commit it), and variables already set in the shell win. The first match below wins.

- `GREETER_MODEL` picks any model Flue knows, for example `google/gemini-3.5-flash`, `openai/gpt-5.4-mini`, `anthropic/claude-sonnet-4-6` or `ocx/anthropic/claude-opus-5-5`. Small, fast models suit this job, because a greeting that arrives after the person walks away is useless.
- With `GEMINI_API_KEY` set, it calls Gemini 3 Flash (`google/gemini-3-flash-preview`) directly through the Gemini API. This is the default for the booth. In testing on the free tier it decided a greeting in 1.3 s and answered a conversation turn in about 4 s.
- With `ANTHROPIC_API_KEY` set, it calls Claude Haiku 4.5 directly.
- With no key and no `GREETER_MODEL`, it goes through a local OpenAI-compatible server at `http://localhost:10100/v1` (OpenCodex on Prag's Mac). Set `OCX_BASE_URL` to use another one.
- With `OPENAI_API_KEY` set, run `GREETER_MODEL=openai/gpt-4.1-mini npm run brain` to call OpenAI directly. This works on the Pi or any laptop without OpenCodex. It answered in 1.2 to 2.6 s in testing and costs well under a tenth of a cent per decision.
- `GREETER_DB` points at a different `greeter.db`; `GREETER_BRAIN_PORT` and `GREETER_BRAIN_HOST` move the server.
