"""GitHub and Gravatar photos for people we already know, in the faces/ format.

GitHub: the person's own GitHub link (team finder, which they filled in, or a
"high" profile match) -> Confirmed; a "medium" profile match -> Likely.
Gravatar: their own Slack email -> Confirmed; no Gravatar means no row.

  python3 faces/fetch_avatars.py      (needs Pillow)
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import csv
import hashlib
import re
import sys
import urllib.error
import urllib.request

D = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(D))
from compress_photos import shrink  # noqa: E402

COLS = ["Person ID", "Slack user ID", "Name", "Role", "Organization", "Source", "Photo", "Match", "Evidence", "Facts"]


def rows(name):
    return list(csv.DictReader(open(D / name, newline="")))


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()
    except urllib.error.HTTPError:
        return None


def github_user(link):
    m = re.search(r"github\.com/([A-Za-z0-9-]+)/?$", (link or "").strip())
    return m.group(1) if m and m.group(1).lower() not in {"orgs", "features", "about"} else None


def main():
    slack = {r["Slack user ID"]: r for r in rows("hack-western-13-slack-members.csv")}
    jobs = {}  # (source, sid) -> (url, match, evidence)
    for r in rows("hack-western-13-linkedin.csv"):
        user = github_user(r["Team finder GitHub"])
        if user:
            jobs[("github", r["Slack user ID"])] = (f"https://github.com/{user}.png?size=512", "Confirmed",
                                                    f"their own team-finder GitHub: github.com/{user}")
    for r in rows("hack-western-13-people-profiles.csv"):
        user, sid = github_user(r["GitHub"]), r["Slack user ID"]
        if user and sid and ("github", sid) not in jobs:
            match = "Confirmed" if r["LinkedIn match"] == "high" else "Likely"
            jobs[("github", sid)] = (f"https://github.com/{user}.png?size=512", match,
                                     f"GitHub from the {r['LinkedIn match']} profile match: github.com/{user}")
    for sid, r in slack.items():
        for col in ("Email", "Other email"):
            email = r[col].strip().lower()
            if email and ("gravatar", sid) not in jobs:
                h = hashlib.sha256(email.encode()).hexdigest()
                jobs[("gravatar", sid)] = (f"https://gravatar.com/avatar/{h}?d=404&s=512", "Confirmed",
                                           "Gravatar of their own Slack email")

    def fetch(item):
        (source, sid), (url, match, evidence) = item
        data = get(url)
        if not data:
            return None
        out = D / "faces" / source / f"{sid}.jpg"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(shrink(data))
        s = slack.get(sid, {})
        return source, {"Person ID": sid, "Slack user ID": sid, "Name": s.get("Name", ""), "Role": s.get("Role", ""),
                        "Organization": s.get("Organization / school", ""), "Source": source,
                        "Photo": str(out.relative_to(D)), "Match": match, "Evidence": evidence, "Facts": ""}

    with ThreadPoolExecutor(8) as ex:
        results = [r for r in ex.map(fetch, jobs.items()) if r]
    for source in ("github", "gravatar"):
        with open(D / "faces" / f"{source}.csv", "w", newline="") as f:
            w = csv.DictWriter(f, COLS)
            w.writeheader()
            w.writerows(row for s, row in results if s == source)
        n = sum(1 for s, _ in results if s == source)
        print(f"{source}: {n} photos of {sum(1 for k in jobs if k[0] == source)} tried")


if __name__ == "__main__":
    main()
