"""The client for the brain: the TypeScript decision server in ../flue (npm run brain).

When the camera has had someone in view for a moment, the greeter asks the brain what to do. The
brain's AI answers through a schema-checked tool, so what comes back is always one of three actions
(greet, confirm, skip) with the line to say, the talking point it used and the Arduino line. This side
checks the answer again before acting on it; anything off raises BrainError and the greeter falls back
to the mock agent.
"""
from dataclasses import dataclass
import json
import urllib.error
import urllib.request

ACTIONS = ("greet", "confirm", "skip")
MAX_POINTS = 8  # the brain works from the first 8 talking points, the ones the page shows (MAX_POINTS in decision.ts)


class BrainError(Exception):
    pass


@dataclass(frozen=True)
class Verdict:
    action: str  # greet | confirm | skip
    say: str  # read aloud; empty when skipping
    fact: int | None  # index of the talking point the line uses
    why: str  # one line for the people running the table
    source: str  # agent | fallback (the brain's own safe greeting when the model failed)
    link: str | None  # the Arduino line, or None to send nothing
    ms: int
    error: str | None = None

    @classmethod
    def parse(cls, d: object, talking_points: int | None = None) -> "Verdict":
        """Check the brain's answer. With talking_points, the fact index must point at one of them."""
        if not isinstance(d, dict):
            raise BrainError("answer is not an object")
        action, say, fact, link = d.get("action"), d.get("say"), d.get("fact"), d.get("link")
        if action not in ACTIONS:
            raise BrainError(f"unknown action {action!r}")
        if not isinstance(say, str) or (action != "skip" and not say.strip()):
            raise BrainError("missing line to say")
        if fact is not None and (type(fact) is not int or fact < 0):
            raise BrainError(f"bad talking point index {fact!r}")
        if fact is not None and talking_points is not None and fact >= talking_points:
            raise BrainError(f"talking point {fact} doesn't exist (they have {talking_points})")
        if link is not None and (not isinstance(link, str) or not link.isprintable()):
            raise BrainError("bad Arduino line")
        if (link is None) != (action == "skip"):
            raise BrainError("the Arduino line must be sent exactly when the greeter speaks")
        if d.get("source") not in ("agent", "fallback"):
            raise BrainError(f"unknown source {d.get('source')!r}")
        try:
            ms = int(d.get("ms", 0))
        except (TypeError, ValueError) as e:
            raise BrainError(f"bad timing {d.get('ms')!r}") from e
        return cls(action, say.strip(), fact, str(d.get("why", "")), d["source"], link, ms, d.get("error"))


class Brain:
    def __init__(self, url: str, timeout: float = 30):
        self.url, self.timeout = url.rstrip("/"), timeout

    def decide(self, person, score: float, bar: float, visit: int, others: list[str]) -> Verdict:
        body = {"id": person.id, "name": person.name or person.id, "score": round(float(score), 4),
                "bar": bar, "visit": visit, "others": others}
        req = urllib.request.Request(self.url + "/decide", json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return Verdict.parse(json.load(r), min(len(person.facts or []), MAX_POINTS))
        except urllib.error.HTTPError as e:
            raise BrainError(f"brain said {e.code}: {e.read().decode(errors='replace')[:200]}") from e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            raise BrainError(f"can't reach the brain at {self.url}") from e
        except json.JSONDecodeError as e:
            raise BrainError("brain answered with something that isn't JSON") from e
