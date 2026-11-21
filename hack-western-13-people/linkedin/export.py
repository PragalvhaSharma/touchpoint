import json, glob, os, csv
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
li = {x['id']: x for f in sorted(glob.glob(os.path.join(D, 'linkedin', 'results', '*chunk-*.json'))) for x in json.load(open(f))}
for k, v in json.load(open(os.path.join(D, 'linkedin', 'overrides.json'))).items():
    if k in li: li[k].update(v)
fe = json.load(open(os.path.join(D, 'linkedin', 'fetched.json')))
rows = list(csv.DictReader(open(os.path.join(D, 'hack-western-13-slack-members.csv'))))
hw = json.load(open(os.path.join(D, 'hackwestern-site', 'by-slack-id.json')))
order = {'high': 0, 'medium': 1, 'low': 2, 'none': 3}
out = []
for r in rows:
    x = li.get(r['Slack user ID'], {}); f = fe.get(r['Slack user ID'], {}) if x.get('confidence') in ('high', 'medium') else {}
    slug = lambda u: (u or '').strip().rstrip('/').split('/in/')[-1].lower()
    if f and slug(f.get('url')) != slug(x.get('linkedin_url')): f = {}
    d = f.get('description', '') if f.get('status') == 'ok' else ''
    parts = dict((p.split(': ', 1) + [''])[:2] for p in d.split(' · ') if ': ' in p)
    t = (f.get('title') or '').replace(' | LinkedIn', ''); h = t.split(' - ', 1)[1] if ' - ' in t else ''
    if not h or '|' in h: h = parts.get('Experience', '') or x.get('headline', '')
    good = x.get('confidence') in ('high', 'medium')
    h_ = hw.get(r['Slack user ID'], {}); m_ = h_.get('mentor') or {}; t_ = h_.get('team_finder') or {}
    out.append({'Name': r['Name'], 'Role': r['Role'], 'Email': r['Email'], 'LinkedIn match': {'high': 'Confirmed', 'medium': 'Likely', 'low': 'Unsure', 'none': 'Not found'}.get(x.get('confidence'), ''),
        'LinkedIn URL': x.get('linkedin_url', '') if good else '', 'Possible LinkedIn URLs (unsure)': ' '.join(([x.get('linkedin_url')] if x.get('confidence') == 'low' and x.get('linkedin_url') else []) + [c for c in (x.get('candidates') or []) if isinstance(c, str)]),
        'Headline / current work': (h or x.get('current_work', '')) if good else '', 'Education': (parts.get('Education') or x.get('education', '')) if good else '', 'Location': (parts.get('Location') or x.get('location', '')) if good else '',
        'Evidence': x.get('evidence', ''), 'Slack photo': ('photos/' + os.path.basename(r['Photo file'])) if r['Photo file'] else '',
        'LinkedIn photo': f.get('linkedin_photo', '') if good else '', 'LinkedIn banner': f.get('banner_photo', '') if good else '', 'Slack user ID': r['Slack user ID']})
    out[-1].update({'On HW mentors page': 'yes' if m_ else '', 'Mentor tags': (m_.get('tags') or '').replace('\n\n', ' | ').replace('\n', ', '),
        'Team finder card': t_.get('name', ''), 'Team finder school': t_.get('school', ''), 'Team finder skills': ', '.join(t_.get('skills') or []), 'Team finder looking for': ((t_.get('looking_for') or '') + (' ' + t_['idea'] if t_.get('idea') else '')).strip(),
        'Team finder GitHub': t_.get('github', ''), 'Team finder Discord': t_.get('discord', ''), 'HW site photo': ' '.join('hackwestern-site/' + p for p in (m_.get('photo_file'), t_.get('photo_file')) if p)})
out.sort(key=lambda o: (order.get(li.get(o['Slack user ID'], {}).get('confidence'), 4), o['Name'].lower()))
with open(os.path.join(D, 'hack-western-13-linkedin.csv'), 'w', newline='') as fh:
    import sys; sys.path.insert(0, D); from scrub import scrub_row
    w = csv.DictWriter(fh, list(out[0].keys())); w.writeheader(); w.writerows(scrub_row(o) for o in out)
print(len(out), sum(1 for o in out if o['LinkedIn URL']), sum(1 for o in out if o['LinkedIn photo']))

