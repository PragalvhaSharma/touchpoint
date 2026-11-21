# Pass 3: keep collecting, and resolve conflicts (Hack Western 13 people)

Work dir: /Users/prag/Documents/PragPersonal/Projects/at-Western/outputs/hack-western-13-slack
These are people in the Hack Western 13 Slack (Nov 20-22, 2026, Western University, London ON). Prag (a Western CS + Ivey student) wants the fullest accurate public professional picture of each person, and wants conflicting information resolved. Pass 2 (results-N.json) is done and verified; this pass adds more and fixes conflicts.

## What you own
You own a set of linkedin/deep2/results-N.json files (named in your task). Edit those records IN PLACE. Each record is the person's full current profile; the merge step lets any record with "added_this_pass" replace the old one wholesale, so never drop correct existing fields. Before your first write, copy your files to /tmp/hw13p3/bak/. Write with a temp file + rename, and re-validate JSON after every write. Update after every few people.
Scratch space: linkedin/deep2/work-p3-<your letter>/. Log: append to linkedin/deep2/pass3-log-<your letter>.md (your own file). Touch nothing else.

## New input you now have: the public LinkedIn page
linkedin/li-public/<slack id>.json holds a parse of each matched person's public (logged-out) LinkedIn page: about, experience (current employers only; past titles are hidden logged out), education (school, dates, description), honors/awards, certifications, li_projects, publications, volunteering, organizations, languages, recent posts by them. Raw HTML is in /tmp/hw13-li-html/<id>.html (contains more structure, e.g. pastPositionsDetails locations, ld+json alumniOf/worksFor). Only use it when its "url" slug equals the person's matched LinkedIn slug. Do NOT re-fetch LinkedIn profile pages (rate limits); use the cache.

## Tasks, per person in your files
1. Conflicts. Compare the record (school_program, grad_year, current_role, past_roles, awards, hackathon_wins, links) with the LinkedIn page and with their own site/GitHub/Devpost. Resolve each conflict with this precedence: their own site or GitHub README > their LinkedIn page > Devpost > news/club pages > anything else. Fix the record, and add "pass3 conflict: <field>: kept X over Y because <source>" to confidence_notes. Dates that just moved on (e.g. graduated, new internship) count as updates, not errors.
2. Fill gaps from the LinkedIn page: empty school_program / grad_year / current_role; awards and certifications worth knowing (label "(self-reported on LinkedIn)"); volunteering/leadership into clubs_leadership; li_projects into projects. Don't copy trivia (first aid, generic online courses). Don't create duplicates of what is already in the record.
3. Collect more. Prioritise the thinnest records in your files first (fewest filled fields). Look for: GitHub (gh api users/<u>, repos sorted by stars/updated, profile README, orgs), Devpost portfolio (prizes), personal site, Google Scholar / arXiv / ORCID, hackathon winner pages, club/team pages (Western, Waterloo, UofT, McMaster etc.), scholarship and award announcements, news (student papers like Western Gazette, university news, CBC, local), talks/podcasts/YouTube about their work, npm/PyPI packages, Kaggle, Hugging Face, Product Hunt, App Store apps, startups they founded (company site, incubator pages like Western Morrissette Institute, Velocity, Propel, DMZ, YC, Next 36, Shad, TKS). Every new fact needs a source URL in sources.
4. Update talking_points (2-4, grounded, phrased as conversation openers Prag could use at the event) when you add something better.
5. Set "added_this_pass" to a list of short strings saying what you added or fixed in pass 3 (replace pass-2 contents). If you change nothing for a person, leave the record exactly as is.

Known corrections to apply if the person is in your files: Edmund Chen has two LinkedIn slugs, keep edmund-chen3; Nathan Schultz RBC vs IBM conflict (resolve from sources); Matthew Zhu's Shopify claim (check against his own site/resume); Ethan Rong's Wealthsimple dates (check).

## Identity bar
Only add facts clearly about THIS person: same name plus a second tie (matching school, employer, handle, linked from their own profiles). When unsure, leave it out and note it in confidence_notes.

## Hard rules
- Public professional information only. No home addresses, personal phone numbers, personal emails, birthdays, family, relationships, health, religion, politics, finances, or anything login-gated or leaked.
- Leave out any fact whose only source is a data broker (RocketReach, ZoomInfo, SignalHire, ContactOut, Apollo, Lusha, etc.). TheOrg only as a second source.
- Never log in anywhere, never use a signed-in browser, never create accounts, never contact or message anyone, never post.
- Search tools: web_search, TinyFish search/fetch (mcp__tinyfish tools) if they work, gh api, and curl for direct page fetches (Bing https://www.bing.com/search?q=..., DuckDuckGo html, Yandex) when quotas hit. Budget about 2 minutes per person; keep going until everyone in your files has been looked at.
- Do not spawn subagents.

## Return
Short summary: people with meaningful additions (count), conflicts resolved (person: what), most notable new finds, anything you could not verify, and what blocked you.

