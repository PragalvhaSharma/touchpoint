# Hack Western 13 people research

Open the [shared booth gallery](booth-gallery.html) in a browser after pulling this checkout. Search for a person and switch between **Profile** and **Photos** to see their source-linked details, original images and lighting edits. Bookmarks keep the selected roster ID and view.

Rebuild the shared gallery from the repository root with `python3 scripts/build_booth_gallery.py`. Its image links are relative to this directory. The builder reads the current roster, verified portraits, review decisions, lighting variants and research database. The [Slack export gallery](photo-gallery.html) is also available.

For search and matching, read [directory.jsonl](directory.jsonl): one line per person with everything above merged (roster, LinkedIn, profiles, team finder, Devpost registrants, verified portraits and confirmed research facts), their talking points, their source-linked profile sections, the photos used for face matching and a `search_text` field. Accounts the profiles sheet marks as "Same person as" are folded into one record (the folded IDs are listed in `also`); the greeter folds them the same way, so one face never ties with itself. Rebuild with `python3 scripts/export_directory.py` after changing any data here.

Pull the shared branch and restart the Python greeter to refresh your local booth database. Startup reads the tracked `people.db`, roster exports, portraits and lighting edits, then rebuilds the local index used by the camera and the web app. The checked-in galleries open directly from a clone.

- `hack-western-13-slack-members.csv`: all 379 Slack members (name, role, school, Slack ID, photo file)
- `hack-western-13-linkedin.csv`: LinkedIn match per member with confidence (high, medium, low, none), evidence, and Hack Western mentor and team-finder fields
- `hack-western-13-people-profiles.csv`: public professional profiles (site, GitHub, Devpost, roles, projects, wins, talking points) for matched members plus team-finder-only people
- `hackwestern-site/`: mentors and team-finder data pulled from hackwestern.com, with alignment files
- `linkedin/`: raw match and enrichment results, plus `overrides.json` corrections

Photos are kept small (512 px JPEG): `photos.py` saves them that way, and `python3 compress_photos.py` shrinks anything added another way and fixes every reference to a renamed file. Run it before committing photos.

Rebuild: `python3 linkedin/export.py && python3 gallery.py && python3 linkedin/export_profiles.py`.

Everything here comes from public pages and Hack Western's own site. Medium and low matches are best guesses, and entries marked UNVERIFIED were not confirmed.
