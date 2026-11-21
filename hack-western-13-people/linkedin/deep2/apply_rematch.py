"""Apply LinkedIn re-match results (and deep-pass LinkedIn upgrades) to linkedin/overrides.json.
Only changes where the agent's (url, confidence) differs from the current effective state.
high/medium require a URL; never applied without evidence."""
import json, glob, os, shutil, sys
os.chdir(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
li = {x['id']: x for f in sorted(glob.glob('linkedin/results/*chunk-*.json')) for x in json.load(open(f))}
ov = json.load(open('linkedin/overrides.json'))
for k, v in ov.items():
    if k in li: li[k] = {**li[k], **v}
norm = lambda u: (u or '').strip().rstrip('/').split('/in/')[-1].lower()
changes = []
for f in sorted(glob.glob('linkedin/deep2/rematch-results-*.json')) + ['linkedin/deep2/linkedin-upgrades.json']:
    if not os.path.exists(f): continue
    for r in json.load(open(f)):
        cur = li.get(r['id'], {})
        c = r.get('confidence')
        if c not in ('high', 'medium', 'low', 'none'): continue
        if c in ('high', 'medium') and not r.get('linkedin_url'): print('SKIP no url', r['name']); continue
        if not (r.get('evidence') or '').strip(): print('SKIP no evidence', r['name']); continue
        if c == cur.get('confidence') and norm(r.get('linkedin_url')) == norm(cur.get('linkedin_url')): continue
        o = {k: r[k] for k in ('confidence', 'linkedin_url', 'evidence', 'headline', 'education', 'location', 'candidates') if k in r and r[k] is not None}
        if c == 'none': o['linkedin_url'] = ''
        changes.append((r['id'], r.get('name'), cur.get('confidence'), c, norm(cur.get('linkedin_url')), norm(r.get('linkedin_url'))))
        ov[r['id']] = {**ov.get(r['id'], {}), **o}
for ch in changes: print(*ch, sep=' | ')
print(len(changes), 'changes')
if '--write' in sys.argv and changes:
    shutil.copy('linkedin/overrides.json', 'linkedin/overrides.before-%s.json' % __import__('time').strftime('%H%M%S'))
    json.dump(ov, open('linkedin/overrides.json', 'w'), indent=1, ensure_ascii=False)
    print('written')
