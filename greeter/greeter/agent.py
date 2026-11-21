"""A mock agent: looks a person up and talks to them about themselves.

No model behind it. It shows the steps a real agent would take (match the
face, read the profile) and turns the profile's talking points into one line
said to the person ("He won X: ask how" becomes "You won X. How?"). Swap
say_to() for a real model call later; the UI streams whatever it yields.
"""
import itertools
import re

OPENERS = ["Hey {name}, good to see you!", "{name}! Welcome.", "Oh hi {name}.", "Look who it is, {name}."]
IRREGULAR = {"is": "are", "was": "were", "has": "have", "does": "do"}


def _verb(v: str) -> str:
    v_low = v.lower()
    if v_low in IRREGULAR:
        return IRREGULAR[v_low]
    if v_low.endswith("ies"):
        return v[:-3] + "y"
    if v_low.endswith(("sses", "shes", "ches", "xes")):
        return v[:-2]
    if v_low.endswith("s") and not v_low.endswith("ss"):
        return v[:-1]
    return v


def to_you(text: str) -> str:
    """Third person to second: "She won ... her app" -> "You won ... your app"."""
    text = re.sub(r"\b(he|she|they)\s+(\w+)", lambda m: "you " + _verb(m.group(2)), text, flags=re.I)
    text = re.sub(r"\b(his|her|their)\b", "your", text, flags=re.I)
    text = re.sub(r"\b(him|them)\b", "you", text, flags=re.I)
    text = re.sub(r"\b(himself|herself|themselves)\b", "yourself", text, flags=re.I)
    return text


def spoken(point: str) -> str:
    """One talking point as something said to the person."""
    point = point.strip().rstrip(".")
    fact, _, ask = point.partition(": ask ")
    if point.lower().startswith("ask "):
        fact, ask = "", point[4:]
    out = ""
    if fact:
        out += to_you(fact)[0].upper() + to_you(fact)[1:] + ". "
    if ask:
        ask = to_you(ask)
        out += ("Tell me about " + ask[6:] if ask.lower().startswith("about ") else "I'm curious " + ask) + "."
    return out.strip()


class MockAgent:
    def __init__(self):
        self.visits = itertools.count()

    def say_to(self, person, score: float):
        """Yields (kind, text): "step" is what the agent does, "say" is what it says."""
        n = next(self.visits)
        yield "step", f"Face matched: {person.name}"
        if person.role:
            yield "step", f"Slack: {person.role}"
        yield "step", f"Profile: {len(person.facts)} talking points" if person.facts else "Profile: no confirmed profile"
        first = person.name.split()[0] if person.name else person.id
        line = OPENERS[n % len(OPENERS)].format(name=first)
        if person.facts:
            line += " " + spoken(person.facts[n % len(person.facts)])
        else:
            line += " I don't know much about you yet. What are you building this weekend?"
        yield "say", line
