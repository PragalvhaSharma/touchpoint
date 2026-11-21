# Greeter

Knows who is in front of it, and an AI brain ([../flue](../flue)) decides whether and how to talk to them about themselves, with a mock agent as the fallback. The Arduino link is mocked.

- `greeter/faces.py`: YuNet finds faces (0.2 MB); EdgeFace-S tells whose (14 MB, IJB-C 95.6, LFW 99.78). OpenCV only, CPU, runs on QNX. `Focus` locks onto the main person (largest, centred, facing the camera) and only switches when someone else clearly takes over for half a second.
- `greeter/roster.py`: who it knows, read in place from `../hack-western-13-people` (Slack photo, Confirmed LinkedIn photo, hackwestern.com photo; talking points only from "high" profile matches) and from `people/<name>/` (added at the table).
- `greeter/db.py`: one SQLite file (`greeter.db`) caches people, talking points and face fingerprints for nearest-neighbour lookup. The first launch after the mirror update recomputes fingerprints from the saved portraits. Later launches reuse them.
- `greeter/brain.py`: asks the brain (`--brain http://127.0.0.1:8090`) what to do about someone and checks the typed answer: greet, confirm their name, or skip, the line, the talking point and the Arduino line.
- `greeter/agent.py`: the mock agent, used without a brain or when it can't be reached; turns a talking point into a line said to the person.
- `greeter/conversation.py`: who the greeter is talking with and switching between people (a known face that holds the middle for 1.5 s, a new guest after 3 s of a face it doesn't know, nobody after 8 s of an empty view), the voice session brief, and the talking endpoints.
- `greeter/talk.py`: every line said, per person id, in `greeter.db`'s `talk` table, and the client for the conversation agent (`cd ../flue && npm run talk`, port 8095), which keeps its own memory per id.
- `greeter/voice.py`: short-lived keys for OpenAI Realtime voice sessions (`gpt-realtime-2.1`, semantic turn detection so people can interrupt), plus speech to text and text to speech for typed messages. With `CARTESIA_API_KEY` set, Cartesia does the speaking: the Realtime session listens and answers in text, and the page streams each line to Cartesia (`sonic-3.6`, voice Parker) with a short-lived token from `GET /session` (renewed with `GET /tts`). `GREETER_CARTESIA_VOICE` and `GREETER_CARTESIA_MODEL` change the voice and model. Without the Cartesia key, or if Cartesia fails, OpenAI's own voice (cedar) speaks. Both keys go in the environment or in `greeter/.env` (gitignored).
- `greeter/link.py`: the Arduino line, mocked; `--serial /dev/serusb1` for the real board.
- `greeter/main.py`: the camera loop and a small API on port 8080 (`/frame`, `/events`, `/samples`, `/photo`, `/face`, `/see`, `/add`, and for talking `/session`, `/log`, `/say`, `/hear`, `/speak`, `/history`, `/talk`). Opening 8080 in a browser sends you to the web app.
- `web/`: the Next.js app on port 3000, one page with the live greeter (camera, who is in view, the person card, the conversation, and a voice dock at the bottom that connects by itself to whoever is in front of the camera).
- `web/app/api/talk/ui/route.ts`: the screen writer. Gemini (`gemini-3-flash-preview`, through the Gemini API's OpenAI-compatible endpoint, streamed) turns a request plus the person's real records into the OpenUI program the screen renders: their portrait, awards, repos and people to meet. It reads `GEMINI_API_KEY` from the environment or from `greeter/.env`, and the `X-Talk-UI-Model` response header names the model that wrote each screen. Without the key it uses OpenAI (`gpt-5.6-luna`, `OPENAI_API_KEY`), then Claude (`ANTHROPIC_API_KEY`), then OpenCodex; `TALK_UI_PROVIDER=gemini|openai|anthropic|ocx` forces one and `TALK_UI_MODEL` picks the model.
- `greeter/evaluate.py`: learns everyone from Slack photos only, tests on their LinkedIn photos.

Requirements:

- Python 3.11 to 3.13 with `uv`, and Node 23.6 or newer for `web/` and `../flue`.
- Gemini API: `GEMINI_API_KEY` in `greeter/.env` (for the screen writer) and `flue/.env` (for the brain and the conversation agent, which both run on `gemini-3-flash-preview`).
- OpenAI API: `OPENAI_API_KEY` in `greeter/.env` for the Realtime voice. Optional: `CARTESIA_API_KEY` for the Cartesia voice.

```
uv run greeter                 # photos only, API on http://localhost:8080
uv run greeter --camera 0      # with a webcam
uv run greeter --camera 0 --brain http://127.0.0.1:8090   # the AI decides (cd ../flue && npm run brain)
cd ../flue && npm run talk     # the conversation agent on 8095, so people can talk back
uv run greeter-eval            # accuracy on held-out photos
cd web && npm install && npm run build && npm start   # http://localhost:3000
```

Use `npm run dev` in `web/` while editing. `GREETER_API` points the web app at a greeter on another address, and `GREETER_UI` tells 8080 where to redirect.

The greeter averages fingerprints from each aligned face and its horizontal mirror. On a still photo, a face at least 40 pixels on its shorter side needs a similarity of 0.45 and a lead of 0.05 over the next person. Faces from 24 to under 40 pixels need a similarity of 0.50 and a lead of 0.10 over an actual runner-up. When two faces match the same person, the standard-size face gets priority.

The camera applies the stricter live naming threshold of greater than 0.50. For a single standard-size face left unnamed with a poor landmark fit, the booth straightens the crop and tries a fresh alignment twice. Both views must agree and lead the next person by at least 0.10.

On the 15 verified second photos, the alignment retry recovered Eric with the November 21 pre-sync gallery (13 correct, 0 wrong, 2 blank). With the refreshed references, both views still picked Eric first. One lead fell to 0.094 and the booth abstained. The refreshed gallery scored 12 correct, 0 wrong and 3 blank both with and without the retry. Two additional labeled video stills were correct. Removing each subject's own references in turn left all 17 images unnamed.

In the paired still-photo test, both versions used the same lighting references, with identified copies of test photos excluded from the gallery. On the 124 unambiguous photos, `b87ddfe` gave 23 correct names, 8 wrong names and 93 abstentions. The mirror and small-face update gave 26 correct names, 6 wrong names and 92 abstentions. All three additional correct names came from the 63 people with an accepted reference.

On a 10-core Apple M5, the updated app processed staged 720p frames at 39 FPS with one face and 24 FPS with one standard-size and one small face together. Timing covered detection through JPEG encoding with the full gallery. The first index build took 48.3 seconds with models already on disk, and cached startup took 0.46 seconds. Camera capture and browser delivery were outside the timing.

An earlier 48-person LinkedIn benchmark reported 75% correct names, 0% wrong names and 2% simulated strangers named at a 0.45 threshold.

## Verified booth portraits

The booth now loads the 35 reviewed primary portraits and four lighting edits per portrait. All 175 references passed enrollment under their intended roster IDs. The update also retires 55 rejected sources and 14 older copies of the reviewed photos. [Portrait manifest](../hack-western-13-people/faces/verified-portraits.csv)

Both comparisons below replay the same 132 still photos through the production matcher. Each cell gives **correct / wrong / unnamed** counts. The baseline is `f741a30`.

| Training references allowed | Before | Older references retired | Retired + 35 portraits and edits |
| --- | ---: | ---: | ---: |
| Original test, LinkedIn references withheld | 27 / 9 / 96 | 27 / 9 / 96 | 27 / 9 / 96 |
| All sources, copies of test photos withheld | 29 / 16 / 87 | 29 / 15 / 88 | 29 / 15 / 88 |

The full-gallery change prevented one wrong greeting. Adding the new references after retiring the old ones changed no predictions on these photos. The original test excludes 34 of the 35 new sources by design. An additional check that also excluded a previously missed circular crop gave the same original-test scores.

The subsequent profile-photo audit retained 90 test photos, replaced 15, and removed 27. All four historical photos labeled with IDs from the reviewed cohort were removed. On the 90 retained photos, the full-gallery comparison went from 28 correct, 9 wrong and 53 unnamed to 28 correct, 8 wrong and 54 unnamed. The fixed set supports checking errors elsewhere in the roster, but has no verified test photo of these 35 people. [Source audit](https://github.com/PragalvhaSharma/at-Western/commit/ec09d88aa763e1e27ed39472bc8cb6dba9634015) · [Results and paired transitions](benchmarks/portrait_review_results.json)

Two additional photos from the portrait review gave a direct check on two members of the cohort. Neither image, nor a detected crop, mirror or re-encoding of it, was in either training gallery. Both photos went unnamed before the update. The updated booth correctly named the older professional headshot and detected no face in the side-view event photo. Neither version gave a wrong name on these two photos. [Professional headshot](https://people.bayt.com/amira-antoun-5057475/) · [Side-view event photo](https://nishantshah.xyz/about.html)

To repeat the comparison from `greeter/`, use the existing model files and a separate checkout of the baseline. The runner verifies the model and test-image checksums before scoring.

```sh
git worktree add --detach /tmp/booth-before-portraits f741a30
git worktree add --detach /tmp/booth-after-portraits 7222256
uv run python benchmarks/portrait_review.py --baseline /tmp/booth-before-portraits \
  --candidate /tmp/booth-after-portraits --models models --output /tmp/booth-portrait-results.json
```
