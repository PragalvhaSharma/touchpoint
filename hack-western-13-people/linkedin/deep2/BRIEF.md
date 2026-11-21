# Deep research pass 2 (Hack Western 13 people)

Work dir: /Users/prag/Documents/PragPersonal/Projects/at-Western/outputs/hack-western-13-slack
These are people in the Hack Western 13 Slack (Nov 20-22, 2026, Western University, London ON). The user (Prag, a Western CS + Ivey student) wants richer, accurate, fully public professional data on each person so he knows who he's talking to.

## Profile deepening (input-N.json -> results-N.json)
Each input entry has Slack info, the matched LinkedIn (high = confirmed, medium = likely) and current_record, the profile built so far. Your job: make each record fuller and more current. Start from current_record, keep everything that is correct, and ADD:
- missing school/program and grad year; current role and recent past roles/internships (with company and year if public)
- personal site, GitHub, Devpost, and other professional links (Google Scholar, Kaggle, Hugging Face, Medium/Substack, YouTube channel about their work, X/Bluesky if professional, ORCID, Behance/Dribbble, App Store/Product Hunt, company sites they founded)
- projects (name, one-line summary, url), especially recent ones and Devpost submissions with prizes
- hackathon wins (event, year, prize, project), scholarships and awards, publications/research (title, venue, year), press/news mentions, talks
- clubs, teams, leadership; startups founded
- skills/interests; 2-4 specific talking points Prag could raise (grounded in a source, phrased as conversation openers)
- every new fact needs a source URL in sources
Fix anything in current_record you find is wrong, and say what you fixed in confidence_notes.

Good sources that work without login: Devpost profiles (devpost.com/<handle>; the portfolio lists every project and prize), GitHub (gh api users/<u>, gh api "users/<u>/repos?sort=updated", the profile README), personal sites, Google Scholar, university/club team pages, scholarship pages, news, hackathon winner pages, public LinkedIn posts (linkedin.com/posts/<slug>_... load by curl and show author + text; only count them if the author slug is the matched slug). LinkedIn profile pages return 999 when logged out; don't hammer them. web_search and TinyFish may hit quotas; fall back to curl (DuckDuckGo html: https://html.duckduckgo.com/html/?q=..., Bing: https://www.bing.com/search?q=...) and Yandex.

Identity bar: only add facts that are clearly about THIS person (same name plus a second signal: matching school, employer, handle, linked site, or linked from their own profiles). Same-name strangers are the main risk; when unsure, leave it out and mention it in confidence_notes.

## LinkedIn re-match (rematch-low.json / rematch-none.json -> rematch-results-low.json / rematch-results-none.json)
These members have only an unsure (low) LinkedIn candidate or none. Try to find their LinkedIn and confirm or reject. Signals: Slack display name, email handle (often first+last name, or a uwo.ca/uwaterloo.ca handle), Organization/school, role, any independent links in current_record, GitHub commit-email lookups (gh api "search/commits?q=author-email:<email>" -H "Accept: application/vnd.github.cloak-preview"), Devpost handle = email handle, team finder. Output one entry per input: {"id","name" (best real name),"linkedin_url","confidence":"high"|"medium"|"low"|"none","evidence" (the concrete ties),"headline","education","location","candidates":[other urls]}. high = two independent ties (e.g. email handle + school, or their own site links the profile); medium = strong single tie plus consistent details; never upgrade on name alone. If you can't improve on the existing state, repeat it unchanged. Also, for anyone you confirm (high/medium), add a full profile record in the same format as results-N.json into rematch-profiles-<low|none>.json.

## Rules (hard)
- Public professional information only. Do NOT collect home addresses, personal phone numbers, birthdays, family members, relationships, health, religion, politics, finances, or anything from login-gated or leaked sources. No private social media.
- Never log in anywhere, never use a signed-in browser (no user Chrome), never create accounts, never contact or message anyone.
- gh api for public GitHub reads is fine.
- Only write your own output file(s) named in your task, plus scratch files in linkedin/deep2/work-<your N>/. Don't edit any other file in the work dir; other agents and threads are working there.
- Write your output file early (start it as a copy of the current records / existing state) and update it after every few people, so nothing is lost if you stop. It must always be valid JSON.
- Keep going until every person in your input has been worked; budget roughly 1 to 2 minutes per person.

## Output format for results-N.json
JSON array, one entry per input person, same keys as current_record (id, status "done", name, personal_site/github/devpost as {"url","evidence"}, school_program, grad_year, current_role, confidence_notes, other_professional_links [{"url","evidence"}], past_roles [str], projects [{"name","summary","url"}], hackathon_wins [str], awards [str], clubs_leadership [str], skills_interests [str], talking_points [str], sources [url]) plus "publications" [str], "news" [str: "headline - outlet, year (url)"], and "added_this_pass" [short strings saying what you added or fixed]. Keep independent and links_confidence if current_record had them.

When done, return a short summary: how many people got meaningful additions, the most notable finds, anything you corrected, and what blocked you. Do not spawn subagents.

