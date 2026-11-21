import csv
import glob
import json
import os

D = os.path.dirname(os.path.abspath(__file__))
BATCHES = 8

members = {
    row["Slack user ID"]: row
    for row in csv.DictReader(open(os.path.join(D, "hack-western-13-slack-members.csv")))
    if row["Photo file"]
}
linkedin = {
    item["id"]: item
    for path in sorted(glob.glob(os.path.join(D, "linkedin", "results", "chunk-*.json")))
    for item in json.load(open(path))
}
fetched_path = os.path.join(D, "linkedin", "fetched.json")
fetched = json.load(open(fetched_path)) if os.path.exists(fetched_path) else {}

records = []
for person_id, member in members.items():
    match = linkedin.get(person_id, {})
    fetch = fetched.get(person_id, {})
    records.append({
        "id": person_id,
        "name": member["Name"],
        "role": member["Role"],
        "organization_or_school": member["Organization / school"],
        "title": member["Title"],
        "slack_username": member["Slack username"],
        "email_for_identity_matching_only": member["Email"],
        "other_email_for_identity_matching_only": member["Other email"],
        "existing_linkedin": {
            "url": match.get("linkedin_url", ""),
            "confidence": match.get("confidence", ""),
            "evidence": match.get("evidence", ""),
            "headline": match.get("headline", ""),
            "current_work": match.get("current_work", ""),
            "education": match.get("education", ""),
            "location": match.get("location", ""),
            "candidates": match.get("candidates", []),
            "public_description": fetch.get("description", "") if fetch.get("status") == "ok" else "",
        },
    })

records.sort(key=lambda record: (record["role"], record["name"].lower(), record["id"]))
batches = [[] for _ in range(BATCHES)]
for index, record in enumerate(records):
    batches[index % BATCHES].append(record)

for index, batch in enumerate(batches, 1):
    path = os.path.join(D, "enrichment", "batches", f"batch-{index}.json")
    with open(path, "w") as handle:
        json.dump(batch, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

print(f"Prepared {len(records)} people in {BATCHES} batches: {[len(batch) for batch in batches]}")
