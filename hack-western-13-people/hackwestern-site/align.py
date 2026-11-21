import json, glob, csv, os, re
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rows = list(csv.DictReader(open(os.path.join(D, 'hack-western-13-slack-members.csv'))))
byid = {r['Slack user ID']: r for r in rows}
li = {x['id']: x for f in sorted(glob.glob(os.path.join(D, 'linkedin', 'results', '*chunk-*.json'))) for x in json.load(open(f))}
for k, v in json.load(open(os.path.join(D, 'linkedin', 'overrides.json'))).items():
    if k in li: li[k].update(v)
en = {x['id']: x for f in sorted(glob.glob(os.path.join(D, 'linkedin', 'enrich', 'results', '*chunk-*.json'))) for x in json.load(open(f))}
slug = lambda u: (u or '').strip().rstrip('/').split('/in/')[-1].split('?')[0].lower()
gh = lambda u: (u or '').strip().rstrip('/').split('github.com/')[-1].split('/')[0].lower() if 'github.com/' in (u or '') else ''
def lk(o): return (o or {}).get('url') if isinstance(o, dict) else (o or '')
print('== MENTORS ==')
ms = json.load(open(os.path.join(D, 'hackwestern-site', 'mentors.json')))
for m in ms:
    r = byid.get(m['slack_id']); x = li.get(m['slack_id'], {})
    ours = slug(x.get('linkedin_url')); off = slug(m['linkedin'])
    st = 'NO SLACK ROW' if not r else ('no official LI' if not off else ('MATCH' if ours == off else 'MISMATCH'))
    print(f"{st:14} {m['name']:22} slack={r['Name'] if r else '-'} role={r['Role'] if r else '-'} conf={x.get('confidence')} ours={ours} official={off}")
ment_ids = {m['slack_id'] for m in ms}
print('Slack mentors not on site:', [r['Name'] for r in rows if r['Role']=='Mentor' and r['Slack user ID'] not in ment_ids])
print('== TEAM FINDER ==')
tf = json.load(open(os.path.join(D, 'hackwestern-site', 'team-finder.json')))
ourslug = {slug(x.get('linkedin_url')): k for k, x in li.items() if x.get('linkedin_url')}
ourcand = {}
for k, x in li.items():
    for c in (x.get('candidates') or []):
        if isinstance(c, str): ourcand.setdefault(slug(c), k)
ourgh = {gh(lk(p.get('github'))): k for k, p in en.items() if gh(lk(p.get('github')))}
res = []
for c in tf:
    fn, li_ = c['name'].split()[0].lower(), c['name'].split()[-1].rstrip('.').lower()
    hit, how = None, ''
    if c['linkedin'] and slug(c['linkedin']) in ourslug: hit, how = ourslug[slug(c['linkedin'])], 'our LI slug'
    elif c['github'] and gh(c['github']) in ourgh: hit, how = ourgh[gh(c['github'])], 'our GitHub'
    elif c['linkedin'] and slug(c['linkedin']) in ourcand: hit, how = ourcand[slug(c['linkedin'])], 'our candidate'
    else:
        cands = [r for r in rows if r['Name'].lower().split()[0] == fn and (len(r['Name'].split()) == 1 or r['Name'].split()[-1][0].lower() == li_[0])]
        if len(cands) == 1: hit, how = cands[0]['Slack user ID'], 'name only'
        elif cands: how = 'ambiguous: ' + ', '.join(r['Name'] for r in cands)
    r = byid.get(hit); x = li.get(hit, {})
    res.append(dict(tf=c['name'], slack=r['Name'] if r else '', id=hit or '', how=how, conf=x.get('confidence',''), ours=slug(x.get('linkedin_url')), official=slug(c['linkedin']), gh=gh(c['github']), school=c['school'], photo=bool(c.get('photo_file')), slack_photo=bool(r and r['Photo file'])))
for o in res: print(o)
json.dump(res, open(os.path.join(D, 'hackwestern-site', 'team-finder-align.json'), 'w'), indent=1)
