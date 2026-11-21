# Verifier log: deep2 results-1, 3, 4, 5, 8, 10, 12

Verifier pass on 2026-11-21. Originals backed up at /tmp/hw13v/bak/. Every changed record also has a "Verifier:" line in confidence_notes when a claim was removed or flagged.

## Scope

- Structural and privacy scan: all 203 records (30+30+30+30+29+28+28). All files are valid JSON; IDs match the input files; every record has id, name and status "done".
- No phone numbers or street addresses were found. Every email address already appeared in the input files. Mentions of brokers are notes saying their data was excluded, plus TheOrg used as a secondary source for Noah Medland and Kassem Kanjo (allowed).
- Spot checks: over 60 people and about 130 claims (wins, awards, publications, news, patents, new GitHub/Devpost/site links) were fetched with curl from Devpost, the GitHub API and READMEs, personal sites, news pages and paper PDFs. Each was checked for the claim and for a second identity tie. No logins were used.

## Changes by person

**Akhil Sunil**
- talking_points: removed "Ask what VEGA is at Hack Western 13." (duplicate)
- talking_points: removed "Ask what VEGA, his Hack Western 13 build, does" (duplicate)

**Anastasiya Volgina**
- hackathon_wins: "Site says 5x hackathon winner; her README adds that tailhub was a GitHub Universe finalist" -> "Self-described '5x hackathon winner' (UNVERIFIED: site renders only with JavaScript); her GitHub README says tailhub was a GitHub Universe finalist (confirmed) (site unreadable without JS)
- awards: "Accepted to Y Combinator Startup School" -> "UNVERIFIED: Accepted to Y Combinator Startup School (no public source confirmed)" (no source confirmed)

**Angelina Elwazzan**
- talking_points: removed "She is looking for teammates who want to combine hardware and software: ask what sensor or actuator idea she wants to build this weekend" (duplicate)

**Anton Kuzmichev**
- talking_points: removed "He helps organize SummerHacks: compare notes on running hackathons with Hack Western." (duplicate)

**Ashley Moon**
- talking_points: removed "Ask what she is building in hw13." (duplicate)

**Atika Hussain**
- talking_points: removed "Ask how SkinSense AI went at Hack Western 12 and what she is building this year" (duplicate)

**Baraka Waweru**
- talking_points: removed "Ask how he combines CS and Applied Math at Western" (duplicate)

**Brittney Chong**
- talking_points: removed "Ask what it took to run Hack Western 13 as co-director." (duplicate)

**Chandler Xie**
- awards: removed "TD Enablement Platform Innovation Challenge winner (Phoenix)" (duplicate of hackathon_wins entry)
- hackathon_wins: "TD Enablement Platform Innovation Challenge winner (Phoenix)" -> "UNVERIFIED: TD Enablement Platform Innovation Challenge winner (Phoenix); his site describes Phoenix as TD intern work but does not mention a win" (win wording not on site)
- projects/Phoenix (TD): summary -> "Internal agentic marketplace built during his TD internship (React, FastAPI, PostgreSQL); reported challenge win UNVERIFIED." (win not confirmed)

**Claresta Cheung**
- talking_points: removed "She is a McMaster EE student looking for an embedded-systems co-op; ask what hardware she likes working on." (duplicate)

**Daniel Antal**
- hackathon_wins: removed "DataQuest '26: 2nd place overall (per LinkedIn)" (duplicate)
- hackathon_wins: "DataQuest: 2nd overall, $500 prize (GitHub README)" -> "DataQuest '26: 2nd overall, $500 prize (LinkedIn and GitHub README)" (merged duplicate)

**Daniel Ely Legada**
- talking_points: removed "Ask how he is finding The Odin Project curriculum." (duplicate)

**Dhruvil Patel**
- hackathon_wins: "2nd place, SerenityHacks (MyBuddy)" -> "UNVERIFIED: 2nd place, SerenityHacks (MyBuddy); Devpost entry shows no winner badge and his Devpost lists no wins" (not confirmed on Devpost or repo)
- projects/MyBuddy: summary -> "AI mental health support agent built for SerenityHacks (placement UNVERIFIED: no winner badge on Devpost)." (placement not confirmed)

**Diya Saxena**
- projects: removed duplicate "MediMonitor" (https://devpost.com/diyasaxena17) (duplicate project)

**Eliza Anis**
- talking_points: removed "Her recent repos (neura, flowprint, nudge) are all privacy-first local assistants; ask why she builds local-first." (duplicate)

**Eric Fu**
- talking_points: removed "Ask what payload the McMaster CubeSat team is building" (duplicate)

**Eric Lee**
- projects: removed duplicate "Auto Dash" (https://devpost.com/software/auto-dash) (same Devpost page, now titled VendiGo)

**Eric Zeng**
- past_roles: removed "Founding Team Captain, Team 9659" (duplicate)
- past_roles: removed "Intern, Cyberworks Robotics" (duplicate)

**Ghala Basaad**
- awards: "PointClickCare Women in Computer Science Award (Nov 2025; 1 of 5, $10,000)" -> "PointClickCare Women in Computer Science Award (Nov 2025; 1 of 5, $10,000) (UNVERIFIED: LinkedIn snippet only; not on her portfolio)" (single LinkedIn snippet)

**Hanjing Lin**
- talking_points: removed "Ask what he works on for Western's Sunstang solar car team." (duplicate)

**Harry Yang**
- awards: removed "Queen's UX Designathon: First Place" (repeats hackathon_wins)

**Hossane Tang**
- clubs_leadership: removed "Western Cyber Society" (duplicate)

**James Hong**
- past_roles: removed "Software Engineer, Manulife (Jan-Apr 2026)" (duplicate)

**Jeffrey Wong**
- past_roles: "Co-Founder & Tech Lead, SiteWhiz (freelance web dev with his sister, from Jan 2025)" -> "Co-Founder & Tech Lead, SiteWhiz (freelance web dev, from Jan 2025)" (family detail removed)
- projects: removed duplicate "BeaverTrail" (https://github.com/JeffreyWongg/beavertrail) (merged into BeaverTrails entry)

**Jenny Jarvis**
- past_roles: removed "IT Business Systems Analyst, Canada Life (Jan to Nov 2023)" (duplicate)
- past_roles: removed "Business Analyst, Canada Life / London Life (2007 to Jan 2023)" (duplicate)
- talking_points: removed "She worked through the London Life / Great-West Life / Canada Life merger: ask what changed for IT" (duplicate)
- talking_points: removed "Canada Life ran a sponsor challenge at Hack Western 12: ask what the challenge looks for this year" (duplicate)

**Jerry Jiang**
- no data change; Babson comes from the AI Tinkerers entry (Cloudflare-blocked, could not re-fetch). Poach article confirmed for Akatos

**Kaitlyn Zhu**
- talking_points: removed "Ask about the meme stock watchlist." (duplicate)

**Kristina Batrak**
- clubs_leadership: removed "Project Director, Western CSUS" (duplicate of Director, Western CSUS (2026/27))

**Liangray Li**
- projects: removed duplicate "IBR: Accounting Away FX Risk" (https://iveybusinessreview.ca/magazine/articles/currency-risk) (duplicate project)

**Lucian Lavric**
- hackathon_wins: "1st place, S:Hacks 2025 (per legacywave.group bio) (single source)" -> "UNVERIFIED: 1st place, S:Hacks 2025 (legacywave.group bio, which no longer shows this text)" (single source no longer shows it)
- hackathon_wins: "Winner, 2025 Scotiabank hackathon (per legacywave.group bio) (single source)" -> "UNVERIFIED: Winner, 2025 Scotiabank hackathon (legacywave.group bio, which no longer shows this text)" (single source no longer shows it)

**Lukas Bozinov**
- awards: "Winner, AMD 2026 Intern Innovation Showcase (ClauDia)" -> "Winner, AMD 2026 Intern Innovation Showcase (ClauDia) (UNVERIFIED: LinkedIn snippet only; not on lukasboz.github.io)" (single LinkedIn snippet)
- projects/ClauDia: summary -> "Agentic AI diagnostic tool for AMD lab engineers that streamlines workstation troubleshooting; reportedly won AMD's 2026 Intern Innovation Showcase (UNVERIFIED, LinkedIn snippet only)." (single source)
- talking_points: "ClauDia won AMD's Intern Innovation Showcase and is deployed team-wide. How did you get lab engineers to trust an agent -> "He built ClauDia, an agentic troubleshooting tool for AMD lab engineers: ask how he got engineers to trust an agent for troubleshooting." (talking point leaned on an unverified award)

**Marco Chen**
- projects: removed duplicate "pr-review-app" (https://github.com/marcocharco/pr-review-app) (same repo as Contify)
- talking_points: removed "Ask about the PR review infinite canvas." (duplicate)
- talking_points: removed "Ask how he balances Ivey with CS." (duplicate)

**Michael Zhang**
- projects: removed duplicate "viennalytics" (https://github.com/elphoun/viennalytics) (duplicate project)

**Miller Downey**
- projects: removed duplicate "TrickyClip" (https://github.com/Milllr/TrickyClip) (merged into trickyclip.com entry)
- past_roles: removed "Software Engineer at Mave" (duplicate)
- past_roles: removed "Software Engineer at Sliq" (duplicate)

**Mohammad Zain Al Abbideen Syed**
- clubs_leadership: removed "YU Blueprint" (duplicate)

**Mohsen Sarrafan Chaharsoughi**
- past_roles: removed "Robotics and AI Research Assistant at UCLA Secure Systems Lab" (duplicate)

**Molick Hou**
- projects: removed duplicate "Cogwalk" (https://devpost.com/software/cogwalk) (duplicate project)
- talking_points: removed "Ask about his thesis on LLM uncertainty." (duplicate)
- talking_points: removed "Ask about his thesis on Bayesian decision-making under LLM uncertainty" (duplicate)

**Nathan Espejo**
- awards: "Western Engineering Competition finalist (top 5 of 87 teams, per older resume)" -> "UNVERIFIED: Western Engineering Competition finalist (top 5 of 87 teams); not on his current site, awards page or resume" (not found in any current source)
- projects: removed duplicate "A.W.A.R.E." (https://devpost.com/nate-e-espejo) (duplicate project)

**Noah Kassam**
- past_roles: removed "Business Development Representative at Ndax" (duplicate)
- clubs_leadership: removed "VP Industry, Western Founders Network" (duplicate)

**Noah Levy**
- hackathon_wins: "NexHacks 2026: Seda sponsor prize (GENzNEWS) (per earlier pass)" -> "UNVERIFIED: NexHacks 2026 Seda sponsor prize (GENzNEWS); no winner badge on Devpost" (not confirmed)
- hackathon_wins: "NASA Space Apps 2024 global nominee (myFarm)" -> "UNVERIFIED: NASA Space Apps 2024 global nominee (myFarm); noahlevy.ca renders only with JavaScript and no other source found" (not confirmed)

**Noah Medland**
- sources: removed "https://openapi.felo.ai/model-cases/jev/julian" (AI aggregator page, not a primary source about him)
- past_roles: removed "Director of Finance, Western Climbing Club (Oct 2024-May 2025)" (duplicate)
- past_roles: "Vice President of Finance and Director of Finance at Western Climbing Club" -> "Vice President of Finance and Director of Finance, Western Climbing Club (Director Oct 2024-May 2025)" (merged duplicate)
- talking_points: removed "His Hack the North 2026 team built Commotion, an AI crowd simulation with one agent per person; ask what the simulated crowds actually did. (duplicate)

**Oladele Magbadelo**
- projects: removed duplicate "Distributed URL Shortener" (mlh-meta-production-engineering-hack) (duplicate project)

**Owen Li**
- hackathon_wins: "2026 Red Team Hackathon winner (Waterloo team; from earlier pass)" -> "UNVERIFIED: 2026 Red Team Hackathon winner (not on owenli.ca; Provenance Chain Devpost entry has no winner badge)" (not on his site or Devpost)
- talking_points: "Ask about the Red Team Hackathon and defence-tech projects like Provenance Chain." -> "Ask about his defence-tech work, like Provenance Chain and CyberSea for the Thales challenge." (talking point leaned on an unverified win)

**Priyansh Sharma**
- awards: "Third place nationally, University of Waterloo Financial Literacy Contest, 2025" -> "Third place nationally, University of Waterloo Financial Literacy Contest, 2025 (UNVERIFIED: not on his site; LinkedIn snippet only)" (single LinkedIn snippet)
- awards: "First place in category, Canadian Nuclear Laboratories Case Competition at Western University" -> "First place in category, Canadian Nuclear Laboratories Case Competition at Western University (UNVERIFIED: not on his site; LinkedIn snippet only)" (single LinkedIn snippet)

**Ronit Longia**
- awards: "CUCAI Best Paper for 'B.A.I.L.I.F.F.' legal-AI bias framework (per others' LinkedIn posts quoted in search results; not -> "UNVERIFIED: CUCAI Best Paper for 'B.A.I.L.I.F.F.' (the paper page lists Luke Blommesteyn and does not name Longia)" (paper page does not name him)
- projects: removed duplicate "Fedwrite" ("summary": "Hack the North 2026 project") (duplicate project)

**Ryuk Jones**
- talking_points: removed "Ask whether he is learning Mandarin himself." (duplicate)

**Sarah Gao**
- projects: removed duplicate "lingobunns" (https://first-project-55c61.web.app/) (merged into LingoBunns entry)

**Stephanie Li**
- talking_points: removed duplicate RBC career-direction question (duplicate)

**Tejass Kaushik**
- awards: removed "National first-place team research study across 34 countries (per site)" (duplicate)
- past_roles: removed "CTO, Stellar Learning (free IB/AP exam-prep platform with 40,000+ learners)" (duplicate)

**Terry Wang**
- talking_points: removed "Ask about battery balancing on Midnight Sun." (duplicate)

**Vaishak Nair**
- clubs_leadership: removed "Speaker: Kinfos AI Canada" (duplicate)

**Veronica Zhao**
- no data change; confirmed the Mengchen Zhao sources tie to her through the LinkedIn display name, noted in confidence_notes

**Vishall Balaji Balakrishnan**
- past_roles: removed "Teaching Assistant, Able Enrichment Centre (2024, per a ZoomInfo directory listing; UNVERIFIED detail)" (only source is ZoomInfo, a data broker)

**William Jiang**
- awards: "National Scholar, Western University (per known headline)" -> "UNVERIFIED: National Scholar, Western University (headline only; not on his site)" (not on his site)

**Yipeng Zhang**
- awards: removed "PMP certification" (duplicate)
- skills_interests: removed "PMP (issued Mar 2026)" (repeats awards)
- skills_interests: removed "Microsoft Certified: Azure Fundamentals (2020)" (repeats awards)
- skills_interests: removed "CompTIA A+" (repeats awards)
- talking_points: removed "Recently earned his PMP: ask what projects he runs at StarTech.com" (duplicate)

## Could not verify (left in place, flagged UNVERIFIED or noted)

- Jerry Jiang: Babson College comes from an AI Tinkerers entry that is now behind a Cloudflare challenge; the Poach article (Akatos) confirmed but does not mention Babson.
- Noah Levy, Anastasiya Volgina: their personal sites render only with JavaScript, so the site-only claims (NASA nominee, 5x winner) could not be read.
- Lucian Lavric: legacywave.group no longer shows the S:Hacks or Scotiabank text.
- LinkedIn-snippet-only awards (Lukas Bozinov AMD showcase, Priyansh Sharma case comps, Ghala Basaad PointClickCare, William Jiang National Scholar) cannot be checked without a LinkedIn login.
- Not spot-checked: Alice Nguyen (TECHNATION), Andy Liu, Edmund Chen, Lily Nguyen, Emily Zhang, Katherine Argall, Eric Fu, Murali Shruthi (Devpost shows no win badges; wins are from LinkedIn), Juna Kim (HW11 Top 5, SheHacks), Lecia Cheng (Scotiabank x Tangerine), Andrew Dai (SIH calLMAOut), James Hong (ReadBuddy), Millicent Song (HW11 finalist), Yipeng Zhang (FCC pages).

## Confirmed with no change (highlights)

- Veronica Zhao: the papers, thesis and Ligori award name Mengchen Zhao; kept because LinkedIn displays "Veronica (Mengchen) Zhao" with matching MESc years.
- Besma Serrai: the CUCAI 2025 paper co-authors include Millicent Song and Juna Kim (a supporting identity tie).
- Hadi Youssef: the AAMAS 2025 SCMRAG PDF lists Hadi Youssef, Western, hyousse8@uwo.ca.
- Evan Lin (HN posts, tinytpu.com), Neil Adams (US9813100B1), Lina Hout and Ali Mohammed-Ali (CBC), Stephanie Sheng and Liangray Li (Western Gazette), Radmehr Vafadar (Queen's Journal), Miller Downey (fintech.ca), Gloriana Zheng (Western News): all confirmed.
- Devpost or site wins confirmed for about 55 people, including Andrew Dai (7), Baron Liu (7), Nathan Espejo (6), Noah Levy (5), Malek Hammoud, Owen Li, Fahmi Omer and Anastasiya Volgina (4 each).


## Verifier pass 2: results-2, 6, 7, 9, 11, rematch-profiles-low/none

Scope: 155 records (results-2 30, results-6 30, results-7 29, results-9 29, results-11 28, rematch-profiles-low 3, rematch-profiles-none 6). All files are valid JSON, every id matches its input file and every status is "done". Sources were fetched with curl and the GitHub API only; no logins, no signed-in browser, no contact with anyone.

Structural scan: no phone numbers, street addresses or new personal emails (the uwo.ca addresses present are the members' own Slack emails). Every data-broker mention is an exclusion note; TheOrg appears only as a secondary source for Kethy Hu. Sensitive-word hits are benign (project descriptions and existing exclusion notes). A few cited pages (Arianna Tan's portfolio, Matthew Zhu's resume) show phone/email; the records do not copy them.

Changes by person:
- Dedupe: 136 near-duplicate items removed across results-2/6/7/11 and the rematch files, plus 45 in results-9 (17 records: Andrew Tu, Crystal Ge, Henrique Alcantara Leite, Aleks Bursac, Alan Sanjit, Cole Branston, Michelle Okolie, Reuben Varghese, Michelle Dominic, Matthew Zhu, Menakan Thamilchelvan, Ryan Peters, Omar Soliman, Leo Zhang, Ben Zhou, Sarina Cheng, llavric). Merged project pairs kept the longer summary and the non-empty URL; a second URL is kept in the summary as "(also: ...)".
- results-7: 56 project entries had url and summary swapped (25 people, incl. Sawaab Anas, Amelia Lon, Brayden Leung, Gary Yi, Abby Wang, Brianna Xiao, Eric Chen, Ola Waked, William, Andrew Chu, Luke Blommesteyn, Xinge Xu); swapped back.
- Arielle Tetelbaum: removed "Most Accessible (Telus), WFN Product Design Sprint: Throwback" and the talking point citing it. The Throwback Devpost page has no Winner badge and the sprint's winners are Shufflr, Crittr and 365.
- William (Zeng): confirmed EcoRewards (HTN 2024 RBC Avion), Expresso (Hack the 6ix 2024 3rd), CapitalQuest (GeeseHacks Sunlife), Stu3dio (HTN 2025 Finalist), Dream House (Hack the Valley X 2nd), Maple Valley (CxC 2025 runQL) and InsightOps (CxC 2025 Finalist) on their real Devpost slugs, each crediting William Zeng. Added Stu3dio/Vibe Draw URLs and the Devpost-confirmed Equill WaffleHacks 2024 win, and merged the duplicate KWAK entries.
- Jennifer Wang (results-2 and rematch-low): cleared personal_site jennw4.github.io; the notes already said it was placeholder content.
- Daniel Wang (rematch-none, U0CKECV7E92): removed X @Bluezmango123, the "f. (fdotinc)" role and the Bay Area talking point (role-overlap tie only; twstalker mirror 403). Also removed the twstalker and yclist sources (yclist does not name him) and labelled the roles and email evidence as self-reported on LinkedIn. His LinkedIn daniel04wang is the same one matched to organizer Daniel Wang (results-11, U0CFW6P7GBG), so this is likely a second Slack account. Both records now note this.
- Participation moved out of hackathon_wins: Karen Hatherell (sponsor attendance and presenting the Canada Life challenge, moved to past_roles); Gloria T. Huang, Surya Tallapaneni and Jerry Zhang (no-prize entries, moved to clubs_leadership); Kimberley Wang (case-competition participation line, moved to clubs_leadership).
- Joanna Liu: rewrote the stale pre-rematch confidence_notes. The Ramp start date is now labelled LinkedIn-only, and the CPP Investments article is marked UNVERIFIED (empty response to curl).
- Edison Qu: "$10.5M seed led by Variant" (Crunchbase 403) replaced with the $10M+ figure on his MLH Top 50 page.
- LinkedIn-only claims labelled "self-reported on LinkedIn": Alyssa Huang (GlideAbility), Victoria Y. Fan (role/school), Dhyaanam Pandya (lab RA role, WEESDF board), Emily Yu (RBC headline), Matias Rivas (two wins), Gloria T. Huang (CIBC).

Confirmed on cited sources (name plus second tie), about 47 records: Edison Qu, Emily Yu, Thomson Lam, Joanna Liu, Dhyaanam Pandya, Daniel Tan (resume, 10 items), David Liu, Kimberley Wang, Andrew Chu, Pragalvha Sharma, Abdullokh Tulkinov, Eric Chen, Luke Blommesteyn (3 publications + CUCAI Best Paper), Arianna Tan, ethn.yang, Mohammed Owda, Riley Wong, Lucas Vanderwielen, Sawaab Anas, Ola Waked, Tygo Crawley, George Farag, Nathan Schultz, Tristan Pinzari, Karen Hatherell, Sahaib Rakhra and William. Also Xander Chin (both MDPI papers via Crossref, author Alexander W. H. Chin; Devpost wins) and Jack Ruttan (AmericasNLP 2025 paper via Crossref, listed as "John Ruttan"; tied by the pinned ComancheNLP repo). Further confirmations: Aleeza Jahan (Globe and Mail names her), Ronnie Gu (README: 3 wins, CMO qualifier, AIME, 5x CEMC) and Jaemin Han (VCDash on Devpost). In results-9, all new wins were confirmed as Winner entries on Devpost for Ved Agwekar, Crystal Ge, Henrique Alcantara Leite, Aleks Bursac, Michelle Okolie (FrostByte), Omar Soliman, Leo Zhang, Ben Zhou (8 wins; project pages checked for GurtOS and Pixie; "15 wins" total is on thebenzhou.com) and James Yang (11 wins; project pages checked for FurMe, Visa Verify and InkLink). Matthew Zhu's Descartes scholarship, chess National Master and Team Canada, IB 40/45 / 97% and Stanford/Google certificates are all on chessdudeo7.github.io.

Could not verify (left as labelled): Edison Qu's exact Sapien round; the CPP Investments article (Joanna Liu); Daniel Wang's Climate Change-Makers 2nd place (LinkedIn + Gazette, GreenSort link still UNVERIFIED as noted); Edwin Ngui's PacRoyale win (JS-only site, already marked self-reported); Twirl 2nd place (William, self-reported); Jaemin Han's VCDash 3rd-place runQL placing (project listed, prize not visible on the profile card). In results-9, these unchanged older claims were not re-checked: Michelle Okolie's AccelR8 Grand Champion, Shane Marcelo's UNhacks 3rd, llavric's legacywave-sourced wins (already marked single source), Anerie Patel's 21 Under 21 (per LinkedIn) and Crystal Ge's FBLC awards (per LinkedIn).

