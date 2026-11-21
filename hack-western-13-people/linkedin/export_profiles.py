import csv, json, glob, os
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
inp = {}
for f in sorted(glob.glob(os.path.join(D, 'linkedin', 'enrich', 'chunk-*.json'))):
    for x in json.load(open(f)): inp[x['id']] = x
mem = {r['Slack user ID']: r for r in csv.DictReader(open(os.path.join(D, 'hack-western-13-slack-members.csv')))}
li = {x['id']: x for f in sorted(glob.glob(os.path.join(D, 'linkedin', 'results', '*chunk-*.json'))) for x in json.load(open(f))}
for k, v in json.load(open(os.path.join(D, 'linkedin', 'overrides.json'))).items():
    if k in li: li[k].update(v)
for k, x in li.items():
    inp[k] = {'name': x.get('name', ''), 'role': mem.get(k, {}).get('Role', ''), 'linkedin_url': x.get('linkedin_url', ''), 'confidence': x.get('confidence', '')}
import re
def real(p, i):
    s = mem.get(p['id'], {}).get('Name', '')
    for c in (p.get('name'), i.get('name')):
        c = re.sub(r'\s*\((second account|Slack:[^)]*)\)', '', c or '').strip()
        if c and (len(c.split()) > len(s.split()) or (c.startswith(s) and len(c) > len(s))): return c
    return s or p.get('name', '')
def lk(o): return (o or {}).get('url', '') if isinstance(o, dict) else (o or '')
def _sx(s):
    if not isinstance(s, dict): return str(s)
    t = ' '.join(str(s.get(k)) for k in ('name', 'title', 'event', 'award', 'prize', 'org', 'venue', 'year', 'date') if s.get(k))
    d = s.get('summary') or s.get('description') or s.get('detail') or ''
    u = s.get('url') or ''
    return ((t + (': ' + str(d) if d else '')).strip() + (' (%s)' % u if u else '')).strip() or json.dumps(s, ensure_ascii=False)
def j(v, f=_sx): return ' | '.join(f(s) for s in (v or []) if s)
out = []
for f in sorted(glob.glob(os.path.join(D, 'linkedin', 'enrich', 'results', '*chunk*.json'))):
    for p in json.load(open(f)):
        i = inp.get(p['id'], {})
        if i.get('confidence') not in ('high', 'medium') and not (p.get('independent') and p.get('links_confidence') in ('high', 'medium')): continue
        out.append({
            'Name': real(p, i), 'Slack name': mem.get(p['id'], {}).get('Name', ''), 'Role': i.get('role', ''), 'LinkedIn': i.get('linkedin_url', '') if i.get('confidence') in ('high', 'medium') else '', 'LinkedIn match': i.get('confidence', '') if i.get('confidence') in ('high', 'medium') else (i.get('confidence', '') + ' (profile from GitHub/Devpost/site only)'),
            'School / program': p.get('school_program', ''), 'Grad year': p.get('grad_year', ''), 'Current role': p.get('current_role', ''),
            'Personal site': lk(p.get('personal_site')), 'GitHub': lk(p.get('github')), 'Devpost': lk(p.get('devpost')),
            'Other links': j(p.get('other_professional_links'), lk), 'Past roles': j(p.get('past_roles')),
            'Projects': j(p.get('projects'), lambda o: (o.get('name', '') + (': ' + o['summary'] if o.get('summary') else '')) if isinstance(o, dict) else str(o)),
            'Hackathon wins': j(p.get('hackathon_wins')), 'Awards': j(p.get('awards')), 'Publications': j(p.get('publications')), 'News': j(p.get('news')), 'Clubs / leadership': j(p.get('clubs_leadership')),
            'Skills / interests': j(p.get('skills_interests')), 'Talking points': j(p.get('talking_points')),
            'Status': p.get('status', ''), 'Confidence notes': p.get('confidence_notes', ''), 'Sources': j(p.get('sources')),
            'Has Slack photo': 'yes' if mem.get(p['id'], {}).get('Photo file') else 'no', 'Slack user ID': p['id']})
rk = {'high': 0, 'medium': 1}
_seen = {}
for o in out: _seen[o['Slack user ID'] or o['Name']] = o
out = list(_seen.values())
LIP = {}
for f_ in glob.glob(os.path.join(D, 'linkedin', 'li-public', '*.json')):
    try: LIP[os.path.basename(f_)[:-5]] = json.load(open(f_))
    except Exception: pass
_sl = lambda u: (u or '').strip().rstrip('/').split('/in/')[-1].lower()
def _it(x):
    s = x.get('title') or ''
    if x.get('org') and x['org'] != x.get('dates'): s += (', ' if s else '') + x['org']
    if x.get('dates'): s += ' (%s)' % x['dates']
    if x.get('description'): s += ': ' + x['description'][:300]
    return s
LIPCOLS = ['LinkedIn about', 'LinkedIn current', 'LinkedIn education', 'LinkedIn honors/awards (self-reported)', 'LinkedIn certifications', 'LinkedIn projects', 'LinkedIn publications', 'LinkedIn volunteering', 'LinkedIn organizations', 'LinkedIn languages', 'Recent LinkedIn posts', 'LinkedIn page fetched']
def lipcols(i, url):
    d = LIP.get(i)
    if not d or not url or _sl(d.get('url')) != _sl(url): return {c: '' for c in LIPCOLS}
    g = lambda k: ' | '.join(_it(x) for x in d.get(k) or [])
    return {'LinkedIn about': d.get('about') or '', 'LinkedIn current': ' | '.join(dict.fromkeys(x.get('org') or x.get('title') for x in d.get('experience') or [] if x.get('org') or x.get('title'))),
            'LinkedIn education': g('education'), 'LinkedIn honors/awards (self-reported)': g('awards'), 'LinkedIn certifications': g('certifications'), 'LinkedIn projects': g('li_projects'),
            'LinkedIn publications': g('publications'), 'LinkedIn volunteering': g('volunteering'), 'LinkedIn organizations': g('organizations'), 'LinkedIn languages': ', '.join(d.get('languages') or []),
            'Recent LinkedIn posts': ' | '.join('%s: %s %s' % (p.get('date') or '', (p.get('text') or '')[:300], p.get('url') or '') for p in d.get('posts') or []), 'LinkedIn page fetched': d.get('fetched') or ''}
have = {o['Slack user ID'] for o in out}
for k, x in li.items():
    if k in have or k not in LIP or x.get('confidence') not in ('high', 'medium'): continue
    m = mem.get(k, {})
    out.append({'Name': real({'id': k, 'name': x.get('name')}, {}), 'Slack name': m.get('Name', ''), 'Role': m.get('Role', ''), 'LinkedIn': x.get('linkedin_url', ''), 'LinkedIn match': x.get('confidence', ''),
                'Status': 'linkedin_page_only', 'Sources': x.get('linkedin_url', ''), 'Has Slack photo': 'yes' if m.get('Photo file') else 'no', 'Slack user ID': k})
cols = list(out[0].keys()) + LIPCOLS
for o in out:
    for c_ in cols: o.setdefault(c_, '')
    if o['Slack user ID']: o.update(lipcols(o['Slack user ID'], o['LinkedIn']))
tfl = {('tf:' + re.sub(r'[^a-z0-9]+', '-', c['name'].lower()).strip('-')): c for c in json.load(open(os.path.join(D, 'hackwestern-site', 'team-finder.json'))) if not c.get('slack_id')}
for fn_ in ('enrich-tf-results.json', 'search-results.json'):
    try: tfr = json.load(open(os.path.join(D, 'hackwestern-site', 'agent', fn_)))
    except Exception: continue
    for p in tfr:
        if p['id'] not in tfl: continue
        c = tfl[p['id']]; url = c.get('linkedin') or p.get('linkedin_url', '')
        conf = 'high' if c.get('linkedin') else p.get('confidence', '')
        if conf not in ('high', 'medium'): continue
        out.append({
            'Name': p.get('name') or c['name'], 'Slack name': '(team finder only: %s)' % c['name'], 'Role': 'Participant', 'LinkedIn': url, 'LinkedIn match': conf,
            'School / program': p.get('school_program', '') or c.get('school', ''), 'Grad year': p.get('grad_year', ''), 'Current role': p.get('current_role', ''),
            'Personal site': lk(p.get('personal_site')), 'GitHub': lk(p.get('github')) or c.get('github', ''), 'Devpost': lk(p.get('devpost')),
            'Other links': j(p.get('other_professional_links'), lk), 'Past roles': j(p.get('past_roles')),
            'Projects': j(p.get('projects'), lambda o: (o.get('name', '') + (': ' + o['summary'] if o.get('summary') else '')) if isinstance(o, dict) else str(o)),
            'Hackathon wins': j(p.get('hackathon_wins')), 'Awards': j(p.get('awards')), 'Publications': j(p.get('publications')), 'News': j(p.get('news')), 'Clubs / leadership': j(p.get('clubs_leadership')),
            'Skills / interests': j(p.get('skills_interests')), 'Talking points': j(p.get('talking_points')),
            'Status': p.get('status', ''), 'Confidence notes': p.get('confidence_notes', ''), 'Sources': j(p.get('sources')),
            'Has Slack photo': 'no', 'Slack user ID': ''})
# Keep public event registrations distinguishable from checked-in participants.
with open(os.path.join(D, 'devpost-registrants.json')) as registrations:
    known_devposts = {row['Devpost'].rstrip('/').casefold() for row in out}
    for registration in json.load(registrations):
        profile_url = registration['Devpost'].rstrip('/').casefold()
        if profile_url not in known_devposts:
            out.append({key: registration.get(key, '') for key in out[0]})
            known_devposts.add(profile_url)
out.sort(key=lambda r: (rk.get(r['LinkedIn match'], 2), r['Name'].lower()))
# Two Slack accounts that matched the same LinkedIn profile are one person: point each at the other.
_by = {}
for r in out:
    s = (r.get('LinkedIn') or '').strip().rstrip('/').split('/in/')[-1].lower()
    if s: _by.setdefault(s, []).append(r)
for rs in _by.values():
    for r in rs:
        r['Same person as'] = '; '.join('%s (%s)' % (o['Slack name'] or o['Name'], o['Slack user ID']) for o in rs if o is not r) if len(rs) > 1 else ''
if 'Same person as' not in cols: cols.insert(cols.index('LinkedIn match') + 1, 'Same person as')
fn = os.path.join(D, 'hack-western-13-people-profiles.csv')
with open(fn, 'w', newline='') as fh:
    import sys; sys.path.insert(0, D); from scrub import scrub_row
    w = csv.DictWriter(fh, fieldnames=cols if out else ['Name']); w.writeheader(); w.writerows(scrub_row(o) for o in out)
c = lambda k: sum(1 for r in out if r.get(k))
print(len(out), 'rows; site', c('Personal site'), 'github', c('GitHub'), 'devpost', c('Devpost'), 'wins', c('Hackathon wins'), 'li page', c('LinkedIn page fetched'), 'li awards', c('LinkedIn honors/awards (self-reported)'), 'nothing', sum(1 for r in out if r['Status'] == 'nothing_found'))
