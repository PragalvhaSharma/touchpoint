# Booth recognition research

21 November 2026 · [Repository snapshot](https://github.com/PragalvhaSharma/at-Western/tree/38e903b8530cfdc08d2e6cb42a9d1f1f3cbfdd7c)

**Decision for the demo.** Test whether lighting variations improve real walk-up greetings before expanding the gallery. The booth runs a pretrained EdgeFace model. Adding a photo adds another reference for comparison. It does not retrain the model. Whether the change helps depends on the names the booth actually gives visitors.

## What the roster contains

The review covered all 379 unique Slack IDs. We joined the existing profile table by exact Slack ID. Of its 366 rows, 356 matched distinct roster IDs and 10 fell outside that join. This leaves 23 roster members without a matching profile row. [Roster](../hack-western-13-people/hack-western-13-slack-members.csv) · [Profiles](../hack-western-13-people/hack-western-13-people-profiles.csv)

| Existing record | Roster members |
| --- | ---: |
| Slack roster lists a photo file | 190 |
| Profile contains a talking point | 355 |
| Profile lists a project | 322 |
| Profile lists both a project and a talking point | 321 |
| Repo labels the LinkedIn match high-confidence and lists a talking point | 267 |
| Project text and at least one URL in the profile's Sources field | 322 |
| Project text and a GitHub repository or Devpost submission URL in Sources | 241 |

A photo path can point to an avatar. The high-confidence label describes a profile match. For the 241 records with a direct link, the source belongs to the whole row and might support a different claim. A useful first-visit question is one the visitor can confirm from their own project. The roster fields reviewed contain no indication that the person opted into facial recognition.

## What the published benchmark measured

At a similarity threshold of 0.45, the greeter README reports **75% correct names, 0% wrong names and 2% false naming in the simulated stranger test** across 48 held-out profile photos. The comment next to the same threshold in the model code reports **85%, 0% and 3%**, without a sample size. The figures could come from different runs. The README is the source for the 48-photo result. Booth accuracy remains unmeasured by either figure. [Greeter README](../greeter/README.md) · [Model code](../greeter/greeter/faces.py)

The evaluator skips a test photo if it cannot detect a face or if the person has no accepted reference. It flags suspected duplicate photos and retains them in the reported rates. To simulate an unknown visitor, it removes the correct identity from the search for the same test photo. A live walk-up includes missed detections and people who never appear in either gallery. [Evaluator](../greeter/greeter/evaluate.py)

## Proposed experiment

1. Use an existing photo approved for this experiment by each participating teammate. Compare a gallery of originals with one containing the same originals plus lighting edits. Treat each original and all its edits as one source. The current gallery uses agreement between references, so two edits of the same mislabelled photo can reinforce the error. [Reference matching code](../greeter/greeter/db.py)
2. Use the same fresh, opt-in booth visits to score both galleries at the same threshold. Include volunteers omitted from both galleries. Keep the test visits independent of every reference photo. A generated side view infers details hidden in the original, so it would be a separate experiment.
3. Count visits, including missed detections. For enrolled visitors, report correct name, wrong name and no name. For unenrolled visitors, report any name and no name. Record counts and denominators for each gallery. A demo with few volunteers supports a local comparison, with limited precision.
4. Prefer the original gallery if the edited gallery introduces wrong greetings or gives no clear gain. If the booth is uncertain, a visitor can identify themselves and confirm a project before the greeter brings it up.

NIST's video evaluation identified lighting, head angle and face size as factors affecting recognition. It also measured errors for people outside the gallery. Those findings motivate testing the actual booth camera. [NIST video evaluation](https://www.nist.gov/news-events/news/2017/04/identifying-faces-video-images-major-challenge-nist-report-shows)
