"""The greeter's ears and mouth: OpenAI speech to text, and Cartesia text to speech (OpenAI's when there's no Cartesia key).

The thinking happens in the Flue agent (flue/src/talk.ts); this module only turns what a person says
into text, and the agent's reply back into speech the page plays.

Keys: OPENAI_API_KEY and CARTESIA_API_KEY in the environment, or lines KEY=... in greeter/.env (gitignored).
With a Cartesia key, the live voice session thinks in text and the page speaks each line with Cartesia.
"""
from pathlib import Path
import json
import os
import urllib.error
import urllib.request
import uuid

STT_URL = "https://api.openai.com/v1/audio/transcriptions"
TTS_URL = "https://api.openai.com/v1/audio/speech"
SESSION_URL = "https://api.openai.com/v1/realtime/client_secrets"
CARTESIA_TTS_URL = "https://api.cartesia.ai/tts/bytes"
CARTESIA_TOKEN_URL = "https://api.cartesia.ai/access-token"
CARTESIA_VERSION = "2025-04-16"
CARTESIA_MODEL = os.environ.get("GREETER_CARTESIA_MODEL", "sonic-3.6")
# Parker, "Supportive Pal": casual, warm, friendly; the guy hosting the table.
CARTESIA_VOICE = os.environ.get("GREETER_CARTESIA_VOICE", "30894953-bcce-41fe-892c-15ce19c843ff")
CARTESIA_RATE = 44100
STYLE = "Warm, relaxed and casual, like a friendly guy hosting a table at a student hackathon. Natural pace, smiling voice."
# Words the transcriber should expect at this table.
VOCAB = "Hack Western, Western University, Ivey, QNX, Raspberry Pi, Arduino, Devpost, Flue, hackathon"
EXT = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav"}
# When the greeter takes its turn. A short pause is enough for it to come back, the person can cut it off,
# and if nobody says anything for a while it keeps the conversation going. The high threshold means only a
# voice close to the mic counts as speech; people talking further away are background noise.
TURN = {"type": "server_vad", "threshold": float(os.environ.get("GREETER_VAD", "0.7")), "prefix_padding_ms": 250,
        "silence_duration_ms": 380,
        "idle_timeout_ms": 8000, "create_response": True, "interrupt_response": True}
# near_field: tuned for one voice right at the mic, so the room fades out. If the person at the table isn't
# heard well on a laptop or room mic, GREETER_NOISE=far_field (and a lower GREETER_VAD) hears more of the room.
NOISE = os.environ.get("GREETER_NOISE", "near_field")
SPEED = 1.06  # a touch quicker than default; slow talk sounds like an assistant

# The /talk page's brief (GET /voice?id=): one person, what the camera knows about them, no memory.
BRIEF = """You are the greeter at Prag's table at Hack Western 13, a student hackathon at Western University.
You speak out loud through a screen with a camera. Keep every turn short: one or two sentences, warm, casual, curious.

The camera thinks the person in front of you is {name}{role}.
Face matching can be wrong, so open by greeting them by first name and checking, for example "Hey, {first}, right?".
Only after they confirm, bring up one thing you know about them below and ask about it. Bring up at most one new fact per turn.
If they say they are someone else, apologise, ask their name, forget everything below, and just chat about what they are building this weekend.
If they ask how you know them: you matched their face against photos from the Hack Western Slack and their public profiles like LinkedIn, and Prag can delete their entry if they ask him.
Never guess facts that are not listed below.

What you know about them:
{facts}"""

NO_FACTS = "- Nothing confirmed yet. Ask what they are building this weekend."


def brief(person) -> str:
    first = person.name.split()[0] if person.name else "there"
    role = f" ({person.role})" if person.role else ""
    facts = "\n".join(f"- {f}" for f in person.facts) or NO_FACTS
    return BRIEF.format(name=person.name, first=first, role=role, facts=facts)


class VoiceError(Exception):
    pass


def api_key(root: Path, name: str = "OPENAI_API_KEY") -> str | None:
    if os.environ.get(name):
        return os.environ[name]
    env = root / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            k, _, v = line.partition("=")
            if k.strip() == name and v.strip():
                return v.strip().strip("\"'")
    return None


class Voice:
    def __init__(self, root: Path, stt: str = "gpt-4o-mini-transcribe", tts: str = "gpt-4o-mini-tts", voice: str = "cedar"):
        self.root, self.stt, self.tts, self.voice = root, stt, tts, voice

    @property
    def ready(self) -> bool:
        return api_key(self.root) is not None

    @property
    def cartesia(self) -> bool:
        return api_key(self.root, "CARTESIA_API_KEY") is not None

    def _post(self, url: str, body: bytes, ctype: str, timeout: float = 30) -> bytes:
        key = api_key(self.root)
        if not key:
            raise VoiceError("no OPENAI_API_KEY (set it in the environment or greeter/.env)")
        req = urllib.request.Request(url, body, method="POST", headers={"Authorization": f"Bearer {key}", "Content-Type": ctype})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            raise VoiceError(f"OpenAI said {e.code}: {e.read().decode(errors='replace')[:300]}") from None
        except (urllib.error.URLError, TimeoutError) as e:
            raise VoiceError(f"can't reach OpenAI: {e}") from None

    def _cartesia(self, url: str, body: dict, timeout: float = 30) -> bytes:
        key = api_key(self.root, "CARTESIA_API_KEY")
        if not key:
            raise VoiceError("no CARTESIA_API_KEY (set it in the environment or greeter/.env)")
        req = urllib.request.Request(url, json.dumps(body).encode(), method="POST", headers={
            "Authorization": f"Bearer {key}", "Cartesia-Version": CARTESIA_VERSION, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            raise VoiceError(f"Cartesia said {e.code}: {e.read().decode(errors='replace')[:300]}") from None
        except (urllib.error.URLError, TimeoutError) as e:
            raise VoiceError(f"can't reach Cartesia: {e}") from None

    def tts_grant(self) -> dict:
        """What the page needs to speak with Cartesia: a short-lived token (never the API key) and the voice."""
        out = json.loads(self._cartesia(CARTESIA_TOKEN_URL, {"grants": {"tts": True}, "expires_in": 600}, timeout=15))
        if not out.get("token"):
            raise VoiceError("Cartesia didn't return a token")
        return {"token": out["token"], "version": CARTESIA_VERSION, "model": CARTESIA_MODEL,
                "voice": CARTESIA_VOICE, "speed": SPEED, "rate": CARTESIA_RATE}

    def hear(self, audio: bytes, mime: str, name: str = "") -> str:
        """What was said in one recorded utterance ('' when nothing was)."""
        mime = (mime or "audio/webm").split(";")[0].strip().lower()
        boundary = uuid.uuid4().hex
        fields = {"model": self.stt, "prompt": f"A conversation at {VOCAB}." + (f" Speaking with {name}." if name else "")}
        body = b""
        for k, v in fields.items():
            body += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
        body += (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.{EXT.get(mime, "webm")}"\r\n'
                 f"Content-Type: {mime}\r\n\r\n").encode() + audio + f"\r\n--{boundary}--\r\n".encode()
        out = json.loads(self._post(STT_URL, body, f"multipart/form-data; boundary={boundary}"))
        return out.get("text", "").strip()

    def speak(self, text: str) -> bytes:
        """The line as MP3 audio."""
        if self.cartesia:
            try:
                return self._cartesia(CARTESIA_TTS_URL, {
                    "model_id": CARTESIA_MODEL, "transcript": text, "voice": {"mode": "id", "id": CARTESIA_VOICE},
                    "language": "en", "generation_config": {"speed": SPEED},
                    "output_format": {"container": "mp3", "sample_rate": CARTESIA_RATE, "bit_rate": 128000}})
            except VoiceError as e:
                print(f"[voice] Cartesia couldn't say it, using OpenAI's voice: {e}", flush=True)
        body = {"model": self.tts, "voice": self.voice, "input": text, "instructions": STYLE, "response_format": "mp3"}
        return self._post(TTS_URL, json.dumps(body).encode(), "application/json")

    def session(self, instructions: str, model: str, voice: str, text_only: bool = False) -> dict:
        """A short-lived key the page uses to open a Realtime voice session (speech to speech over WebRTC),
        already briefed with instructions. Returns OpenAI's answer: {value: "ek_...", expires_at, session}.
        text_only: it still listens, but answers in text, which the page speaks with Cartesia."""
        audio_in = {
            "transcription": {"model": self.stt, "language": "en", "prompt": f"A conversation at {VOCAB}."},
            "turn_detection": TURN,
            "noise_reduction": {"type": NOISE},
        }
        session = {"type": "realtime", "model": model, "instructions": instructions, "audio": {"input": audio_in}}
        if text_only:
            session["output_modalities"] = ["text"]
        else:
            session["audio"]["output"] = {"voice": voice, "speed": SPEED}
        body = {"expires_after": {"anchor": "created_at", "seconds": 600}, "session": session}
        out = json.loads(self._post(SESSION_URL, json.dumps(body).encode(), "application/json", timeout=15))
        if not str(out.get("value", "")).startswith("ek_"):
            raise VoiceError("OpenAI didn't return a session key")
        return out

    def mint(self, person, model: str) -> dict:
        """A short-lived key for one conversation with `person` (the /talk page): {"key": "ek_..."} or {"error": "..."}."""
        body = {"session": {"type": "realtime", "model": model, "instructions": brief(person),
                            "audio": {"output": {"voice": self.voice}}}}
        try:
            out = json.loads(self._post(SESSION_URL, json.dumps(body).encode(), "application/json", timeout=15))
        except VoiceError as e:
            return {"error": str(e)}
        return {"key": out["value"]}
