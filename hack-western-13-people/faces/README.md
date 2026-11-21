# More faces, one file per source

Each source writes `faces/<source>.csv` and its photos under `faces/<source>/`.
Photos go through `compress_photos.shrink` (512 px JPEG) before they are saved.

Columns, every source the same:

| Column | Meaning |
| --- | --- |
| Person ID | the Slack user ID when the person is on Slack; otherwise a slug of their full name (`jane-doe`), so the same person from two sources merges |
| Slack user ID | blank when not on Slack |
| Name | full name |
| Role | Participant, Judge, Mentor, Sponsor rep, Organizer, Speaker... |
| Organization | company or school |
| Source | devpost, github, gravatar, hackwestern-site... |
| Photo | path relative to `hack-western-13-people/`, e.g. `faces/github/U0CJ8RJ77LN.jpg` (blank if none) |
| Match | `Confirmed` only when the source itself ties the photo to this person (their own link, their own email, a named headshot); otherwise `Likely` |
| Evidence | one line: why this is them |
| Facts | for people not on Slack: talking points, ` \| ` separated, same style as the profiles CSV |

The greeter learns only `Confirmed` rows.

`verified-portraits.csv` lists the 35 portraits confirmed in the booth gallery
review, with the original image bytes, SHA-256, and source page for each roster
ID. The greeter gives each reviewed original first priority. When updating a
portrait, save the new original under a new path so its lighting edits have
their own directory. From `greeter/`, run
`uv run python -m greeter.lighting --verified-only` to generate the four edits.
The loader also checks `verified-portraits/superseded.csv` to exclude the
specific versions of older photos that were rejected or duplicate the reviewed
original. Their files remain available for reproducing past benchmarks.
