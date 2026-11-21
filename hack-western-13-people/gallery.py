import csv, os, html, json, glob, sys
from pathlib import Path
from urllib.parse import quote, unquote
D = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, str(Path(D).parent / "scripts"))
from build_booth_gallery import build as build_booth_directory

directory = {person["id"]: person for person in build_booth_directory(Path(D))}

def directory_pictures(person_id, candidates):
    person = directory[person_id]
    allowed = {unquote(image["src"]): image for image in person["photos"]}
    paths = [unquote(person["primarySrc"])] if person["primarySrc"] else []
    paths.extend(p for p in candidates if p and p in allowed and p not in paths)
    images = ''.join('<img loading="lazy" src="%s" title="%s">' %
                     (html.escape(allowed[p]["src"]), html.escape(allowed[p]["source"])) for p in paths)
    if not images:
        initials = ''.join(word[0] for word in person["name"].split()[:2]) or '?'
        images = '<div class="ini">%s</div>' % html.escape(initials.upper())
    return '<div class="pics">' + images + '</div>'

def directory_link(person_id):
    return ' <a href="booth-gallery.html#person=%s&amp;view=profile">Booth profile and photos</a>' % quote(person_id)

rows = list(csv.DictReader(open(os.path.join(D, 'hack-western-13-slack-members.csv'))))
li = {}
for f in sorted(glob.glob(os.path.join(D, 'linkedin', 'results', '*chunk-*.json'))):
    try:
        for x in json.load(open(f)): li[x['id']] = x
    except Exception: pass
op = os.path.join(D, 'linkedin', 'overrides.json')
for k, v in (json.load(open(op)) if os.path.exists(op) else {}).items():
    if k in li: li[k].update(v)
fp = os.path.join(D, 'linkedin', 'fetched.json')
fetched = json.load(open(fp)) if os.path.exists(fp) else {}
def norm(s): return ''.join(c for c in (s or '').lower() if c.isalpha() or c == ' ').split()
for k, f in fetched.items():
    x = li.get(k)
    if not x or f.get('status') != 'ok' or (x.get('linkedin_url') or '').strip().rstrip('/').split('/in/')[-1] != f['url'].rstrip('/').split('/in/')[-1]: continue
    # photo_checked: the crawler read the top card, so its answer (photo or none) is final
    x['linkedin_photo'] = (f.get('linkedin_photo') or '') if f.get('photo_checked') else (f.get('linkedin_photo') or x.get('linkedin_photo') or '')
    x['banner_photo'] = f.get('banner_photo') or x.get('banner_photo') or ''
    d = f.get('description') or ''
    exp = ''
    for part in d.split(' · '):
        if part.startswith('Education: '): x['education'] = part[11:]
        if part.startswith('Location: '): x['location'] = part[10:]
        if part.startswith('Experience: '): exp = part[12:]
    t = (f.get('title') or '').replace(' | LinkedIn', '')
    h = t.split(' - ', 1)[1].strip() if ' - ' in t else ''
    if not h or '|' in h or 'Professional Profile' in h or h == x.get('location') or (x.get('education') and h.startswith(x.get('education'))): h = exp
    if h: x['headline'] = h
    x['page_name'] = f.get('page_name') or ''
# photos reviewed as not the person (wrong person, pet, cartoon, object): {"<path>": "reason"}
_rj = os.path.join(D, 'linkedin', 'photo-rejects.json')
REJ = {os.path.splitext(k)[0] for k in (json.load(open(_rj)) if os.path.exists(_rj) else {})}  # extension-free: the repo copy turns .png/.webp into .jpg
def rej(p): return os.path.splitext(p)[0] in REJ
def ok(p): return bool(p) and not rej(p) and os.path.exists(os.path.join(D, p)) and os.path.getsize(os.path.join(D, p)) > 500
e = html.escape
fbp_ = os.path.join(D, 'linkedin', 'fallback-photos.json')
fallback = {k: v for k, v in (json.load(open(fbp_)) if os.path.exists(fbp_) else {}).items() if (v.get('reviewed') or v.get('manual')) and ok(v.get('file'))}
hwp = os.path.join(D, 'hackwestern-site', 'by-slack-id.json')
hw = json.load(open(hwp)) if os.path.exists(hwp) else {}
tfp = os.path.join(D, 'hackwestern-site', 'team-finder.json')
tfonly = [c for c in (json.load(open(tfp)) if os.path.exists(tfp) else []) if not c.get('slack_id')]
def handles(t):
    b = []
    if t.get('discord'): b.append('Discord: ' + e(t['discord']))
    if t.get('github'): b.append('<a href="%s" target="_blank" rel="noopener">GitHub (card)</a>' % e(t['github']))
    return '<span class="hw">%s</span>' % ' · '.join(b) if b else ''
def hwbits(i):
    h = hw.get(i, {}); m = h.get('mentor') or {}; t = h.get('team_finder') or {}
    pics = [(p, ttl) for p, ttl in ((m.get('photo_file'), 'Hack Western mentors page photo'), (t.get('photo_file'), 'Hack Western team finder photo')) if p and ok('hackwestern-site/' + p)]
    lines = []
    if m: lines.append('<span class="hw">Mentor page: %s</span>' % e(m.get('tags', '').replace('\n\n', ' | ').replace('\n', ', ')))
    if t:
        lines.append('<span class="hw">Team finder: %s</span>' % e(' · '.join(v for v in [t.get('status', ''), t.get('school', ''), ', '.join(t.get('skills') or [])] if v)))
        if t.get('looking_for'): lines.append('<span class="tfq">%s</span>' % e(t['looking_for'] + ((' ' + t['idea']) if t.get('idea') else '')))
        lines.append(handles(t))
    words = ' '.join([m.get('tags', ''), t.get('school', ''), ' '.join(t.get('skills') or []), t.get('looking_for', ''), t.get('idea', '')])
    return pics, ''.join(lines), words, bool(m), bool(t)
en = {}
for f in sorted(glob.glob(os.path.join(D, 'linkedin', 'enrich', 'results', '*chunk*.json'))):
    try:
        for x in json.load(open(f)): en[x['id']] = x
    except Exception: pass
def _sx(s):
    if not isinstance(s, dict): return s
    t = ' '.join(str(s.get(k)) for k in ('name', 'title', 'event', 'award', 'prize', 'org', 'venue', 'year', 'date') if s.get(k))
    d = s.get('summary') or s.get('description') or s.get('detail') or ''
    return (t + (': ' + str(d) if d else '')).strip() or (s.get('url') or json.dumps(s, ensure_ascii=False))
def L(v): return [_sx(s) for s in (v or []) if s]
def lk(o): return (o or {}).get('url') if isinstance(o, dict) else (o if isinstance(o, str) else '')
LIP = {}
for f in glob.glob(os.path.join(D, 'linkedin', 'li-public', '*.json')):
    try: LIP[os.path.basename(f)[:-5]] = json.load(open(f))
    except Exception: pass
def _slug(u): return (u or '').strip().rstrip('/').split('/in/')[-1].lower()
def lipfmt(it):
    s = it.get('title') or ''
    if it.get('org') and it['org'] != it.get('dates'): s += (', ' if s else '') + it['org']
    if it.get('dates'): s += ' (%s)' % it['dates']
    if it.get('description'): s += ': ' + it['description'][:220]
    return e(s)
def lipdet(i, url):
    d = LIP.get(i)
    if not d or not url or _slug(d.get('url')) != _slug(url): return '', ''
    sec = []
    def ul(title, items):
        if items: sec.append('<b>%s</b><ul>%s</ul>' % (title, ''.join('<li>%s</li>' % it for it in items)))
    if d.get('about'): sec.append('<b>About</b><p>%s</p>' % e(d['about'][:600]))
    cur = [x.get('org') or x.get('title') for x in d.get('experience') or [] if x.get('org') or x.get('title')]
    if cur: sec.append('<b>Current</b><p>%s</p>' % e(', '.join(dict.fromkeys(cur))))
    ul('Education', [lipfmt(x) for x in d.get('education') or []])
    ul('Honors and awards (self-reported)', [lipfmt(x) for x in (d.get('awards') or [])[:10]])
    ul('Certifications', [lipfmt(x) for x in (d.get('certifications') or [])[:8]])
    ul('Projects', [lipfmt(x) for x in (d.get('li_projects') or [])[:6]])
    ul('Publications', [lipfmt(x) for x in d.get('publications') or []])
    ul('Volunteering', [lipfmt(x) for x in (d.get('volunteering') or [])[:6]])
    ul('Organizations', [lipfmt(x) for x in d.get('organizations') or []])
    ul('Recent posts', [e((p.get('date') or '') + ': ' + (p.get('text') or '')[:200]) + (' <a href="%s" target="_blank" rel="noopener">post</a>' % e(p['url']) if p.get('url') else '') for p in (d.get('posts') or [])[:4]])
    if d.get('languages'): sec.append('<p class="sk">Languages: %s</p>' % e(', '.join(d['languages'])))
    if not sec: return '', ''
    words = ' '.join([d.get('about') or ''] + [' '.join([x.get('title') or '', x.get('org') or '']) for k in ('experience', 'education', 'awards', 'certifications', 'volunteering', 'organizations') for x in d.get(k) or []])
    return '<details><summary>LinkedIn page</summary>%s<p class="sk">From the public LinkedIn page, fetched %s.</p></details>' % (''.join(sec), e(d.get('fetched') or '')), words
def prof(p):
    if not p: return '', '', ''
    p = dict(p)
    for _k in ('school_program', 'current_role', 'grad_year'):
        if isinstance(p.get(_k), (list, dict)): p[_k] = ', '.join(_sx(x) for x in (p[_k] if isinstance(p[_k], list) else [p[_k]]) if x)
    links = []
    for lab, key in (('Site', 'personal_site'), ('GitHub', 'github'), ('Devpost', 'devpost')):
        u = lk(p.get(key))
        if u: links.append('<a href="%s" target="_blank" rel="noopener">%s</a>' % (e(u), lab))
    for o in [o for o in (p.get('other_professional_links') or []) if o][:4]:
        u = lk(o)
        lab = ((o.get('label') if isinstance(o, dict) else '') or 'Link').split(' (')[0]
        if len(lab) > 26: lab = lab[:24].rstrip() + '…'
        if u: links.append('<a href="%s" target="_blank" rel="noopener" title="%s">%s</a>' % (e(u), e((o.get('label') if isinstance(o, dict) else '') or ''), e(lab)))
    sec = []
    def ul(title, items):
        if items: sec.append('<b>%s</b><ul>%s</ul>' % (title, ''.join('<li>%s</li>' % it for it in items)))
    meta = ' · '.join(v for v in [p.get('school_program') or '', ('Class of ' + str(p['grad_year'])) if p.get('grad_year') else '', p.get('current_role') or ''] if v)
    if meta: sec.append('<p>%s</p>' % e(meta))
    ul('Talking points', [e(t) for t in L(p.get('talking_points'))])
    ul('Hackathon wins', [e(t) for t in L(p.get('hackathon_wins'))])
    pj = []
    for o in [o for o in (p.get('projects') or []) if o][:6]:
        if isinstance(o, dict):
            nm = e(o.get('name') or '')
            if lk(o): nm = '<a href="%s" target="_blank" rel="noopener">%s</a>' % (e(lk(o)), nm)
            pj.append(nm + (': ' + e(o['summary']) if o.get('summary') else ''))
        else: pj.append(e(str(o)))
    ul('Projects', pj)
    ul('Roles', [e(t) for t in L(p.get('past_roles'))[:6]])
    ul('Clubs and leadership', [e(t) for t in L(p.get('clubs_leadership'))])
    ul('Awards', [e(t) for t in L(p.get('awards'))])
    ul('Publications and research', [e(t) for t in L(p.get('publications'))[:6]])
    ul('In the news', [e(t) for t in L(p.get('news'))[:5]])
    if L(p.get('skills_interests')): sec.append('<p class="sk">%s</p>' % e(', '.join(L(p.get('skills_interests'))[:12])))
    body = ''.join(sec)
    det = '<details><summary>Profile</summary>%s</details>' % body if body else ''
    words = ' '.join([p.get('school_program') or '', p.get('current_role') or ''] + [str(s) for s in L(p.get('skills_interests'))] + [str(s) for s in L(p.get('past_roles'))] + [str(s) for s in L(p.get('clubs_leadership'))])
    return ' '.join(links), det, words
RANK = {'high': 0, 'medium': 1, 'low': 2, 'none': 3, '': 4}
import re as _re
byurl = {}
for k, x in li.items():
    if (x.get('confidence') or '') in ('high', 'medium') and x.get('linkedin_url'):
        byurl.setdefault(x['linkedin_url'].rstrip('/').split('/in/')[-1].lower(), []).append(k)
dup = {k for v in byurl.values() if len(v) > 1 for k in v}
def dname(r, x, p):
    for cand in ((p or {}).get('name'), x.get('name')):
        c = _re.sub(r'\s*\((second account|Slack:[^)]*)\)', '', cand or '').strip()
        if c and c != r['Name'] and (len(c.split()) > len(r['Name'].split()) or (c.startswith(r['Name']) and len(c) > len(r['Name']))): return c
    return ''
def card(r):
    x = li.get(r['Slack user ID'], {})
    conf = (x.get('confidence') or '').lower()
    url = x.get('linkedin_url') or ''
    show = conf in ('high', 'medium')
    pp = en.get(r['Slack user ID'])
    plinkonly = not show and bool(pp) and (pp.get('links_confidence') or '').lower() in ('high', 'medium')
    plinks, pdet, pwords = prof(pp) if show or plinkonly else ('', '', '')
    ldet, lwords = lipdet(r['Slack user ID'], url) if show else ('', '')
    pdet += ldet; pwords += ' ' + lwords
    hpics, hlines, hwords, isment, istf = hwbits(r['Slack user ID'])
    isment = isment or r['Role'] == 'Mentor'
    real = dname(r, x, en.get(r['Slack user ID'])) if show else ''
    pic = x.get('linkedin_photo') if show and ok(x.get('linkedin_photo')) else ''
    fbk = fallback.get(r['Slack user ID']) if not pic else None
    ban = x.get('banner_photo') if show and ok(x.get('banner_photo')) else ''
    head = x.get('headline') or ''
    sub = ' · '.join(v for v in [x.get('education') or '', x.get('location') or ''] if v)
    q = ' '.join([r['Name'], real, r['Role'], r['Organization / school'], head, sub, conf, pwords, hwords, 'mentor' if isment else '']).lower()
    sl = 'photos/' + os.path.basename(r['Photo file']) if r['Photo file'] and not rej('photos/' + os.path.basename(r['Photo file'])) else ''
    imgs = directory_pictures(r['Slack user ID'], [sl, *['hackwestern-site/' + hp for hp, _ in hpics],
                                                   pic, fbk['file'] if fbk else ''])
    link = ''
    if url and conf in ('high', 'medium'):
        link = '<a href="%s" target="_blank" rel="noopener">LinkedIn</a>' % e(url)
        if plinks: link += ' ' + plinks
    elif url and conf == 'low':
        link = '<a class="maybe" href="%s" target="_blank" rel="noopener">Possible LinkedIn</a>' % e(url)
    cands = [c for c in (x.get('candidates') or []) if isinstance(c, str) and c != url][:3]
    if conf == 'low' and cands:
        link += ' ' + ' '.join('<a class="maybe" href="%s" target="_blank" rel="noopener">alt %d</a>' % (e(c), i + 1) for i, c in enumerate(cands))
    if plinkonly and plinks:
        link += (' ' if link else '') + plinks + (' <span>(LinkedIn unconfirmed; these links verified separately)</span>' if url and conf == 'low' else ' <span>(no LinkedIn match)</span>')
    link += directory_link(r['Slack user ID'])
    fbl = '<span class="fbl"><a href="%s" target="_blank" rel="noopener">Photo: %s</a></span>' % (e(fbk.get('page_url') or fbk.get('source_url') or ''), e(fbk['source'])) if fbk else ''
    badge = '<i class="c %s">%s</i>' % (conf or 'none', {'high': 'Confirmed', 'medium': 'Likely', 'low': 'Unsure', 'none': 'Not found'}.get(conf, 'Not searched'))
    return RANK.get(conf, 4), '<figure data-q="%s" data-c="%s"%s>%s<figcaption><b>%s</b>%s<span>%s%s</span>%s%s%s<span class="links">%s</span>%s%s<small>%s</small></figcaption></figure>' % (
        e(q), conf or 'none', (' data-p="1"' if pdet else '') + ('' if sl else ' data-np="1"') + (' data-m="1"' if isment else '') + (' data-tf="1"' if istf else '') + (' data-fb="1"' if fbk else ''), imgs,
        e(real) + ' <span>(Slack: %s)</span>' % e(r['Name']) if real else e(r['Name']),
        badge + (' <i class="c low">Same person as another Slack account</i>' if r['Slack user ID'] in dup else ''), e('Mentor' if isment and r['Role'] != 'Mentor' else r['Role']) + (' <span>(Slack role: %s)</span>' % e(r['Role']) if isment and r['Role'] != 'Mentor' else ''), (' · ' + e(r['Organization / school'])) if r['Organization / school'] else '',
        '<span class="hl">%s</span>' % e(head) if head and show else '', '<span>%s</span>' % e(sub) if sub and show else '', hlines, link, pdet, fbl, e(x.get('evidence') or ''))
cards = [card(r) for r in rows]
tfe = {}
for f in ('enrich-tf-results.json', 'search-results.json'):
    fp2 = os.path.join(D, 'hackwestern-site', 'agent', f)
    try:
        for x in json.load(open(fp2)): tfe[x['id']] = x
    except Exception: pass
import re as _re2
def tfcard(c):
    i = 'tf:' + _re2.sub(r'[^a-z0-9]+', '-', c['name'].lower()).strip('-')
    p = tfe.get(i) or {}
    url = c.get('linkedin') or ((p.get('linkedin_url') or '') if p.get('confidence') in ('high', 'medium') else '')
    conf = 'high' if c.get('linkedin') else (p.get('confidence') or 'none')
    plinks, pdet, pwords = prof(p) if p.get('status') == 'done' or p.get('confidence') in ('high', 'medium') else ('', '', '')
    if not plinks and c.get('github'): plinks = '<a href="%s" target="_blank" rel="noopener">GitHub</a>' % e(c['github'])
    nm = p.get('name') or c['name']
    tfb = fallback.get(i)
    pics = directory_pictures(i, ['hackwestern-site/' + c['photo_file'] if c.get('photo_file') else '',
                                  tfb['file'] if tfb else ''])
    meta = '<span class="hw">Team finder: %s</span>' % e(' · '.join(v for v in [c.get('status', ''), c.get('school', ''), ', '.join(c.get('skills') or [])] if v))
    if c.get('looking_for'): meta += '<span class="tfq">%s</span>' % e(c['looking_for'] + ((' ' + c['idea']) if c.get('idea') else ''))
    meta += handles(c)
    link = ('<a href="%s" target="_blank" rel="noopener">LinkedIn</a> ' % e(url) if url else '') + plinks
    link += directory_link(i)
    head = p.get('current_role') or ''
    badge = '<i class="c %s">%s</i>' % (conf, {'high': 'Confirmed', 'medium': 'Likely', 'low': 'Unsure', 'none': 'Not found'}.get(conf, 'Not found'))
    q = ' '.join([nm, c['name'], c.get('school', ''), ' '.join(c.get('skills') or []), c.get('looking_for', ''), c.get('idea', ''), head, pwords, 'team finder']).lower()
    return RANK.get(conf, 4), '<figure data-q="%s" data-c="%s" data-tf="1" data-np="1"%s>%s<figcaption><b>%s</b>%s<span>Participant (not matched to a Slack account)</span>%s%s<span class="links">%s</span>%s<small>%s</small></figcaption></figure>' % (
        e(q), conf, ' data-p="1"' if pdet else '', pics, e(nm) + (' <span>(card: %s)</span>' % e(c['name']) if nm != c['name'] else ''), badge,
        '<span class="hl">%s</span>' % e(head) if head else '', meta, link, pdet, 'LinkedIn and GitHub self-listed on the Hack Western team finder.' if c.get('linkedin') else e(p.get('evidence') or ''))
tcards = [tfcard(c) for c in tfonly]
ph = [c for c, r in zip(cards, rows) if r['Photo file']]
nph = [c for c, r in zip(cards, rows) if not r['Photo file']]
n = {k: sum(1 for c in cards if c[0] == v) for k, v in RANK.items()}
nl = sum(1 for r in rows if li.get(r['Slack user ID'], {}).get('confidence') in ('high', 'medium') and ok(li[r['Slack user ID']].get('linkedin_photo')))
nfb = sum(1 for c in cards if 'data-fb="1"' in c[1])
npf = sum(1 for c in cards if 'data-p="1"' in c[1])
nm_ = sum(1 for c in cards if 'data-m="1"' in c[1]); ntf = sum(1 for c in cards if 'data-tf="1"' in c[1]); nhw = sum(1 for c in cards if 'hackwestern-site/photos' in c[1])
srt = lambda cs: ''.join(c[1] for c in sorted(cs, key=lambda c: (c[0], 'data-p="1"' not in c[1])))
page = '''<!doctype html><meta charset="utf-8"><title>Hack Western 13 people</title><style>
body{font:14px -apple-system,system-ui,sans-serif;margin:24px;background:#faf9f7;color:#222}h1{font-size:20px;margin:0 0 4px}p.sum{color:#666;margin:0 0 14px}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:18px}
input{font:inherit;padding:8px 12px;width:320px;border:1px solid #ccc;border-radius:8px}
button{font:inherit;padding:6px 12px;border:1px solid #ccc;border-radius:16px;background:#fff;cursor:pointer}button.on{background:#222;color:#fff;border-color:#222}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px}
figure{margin:0;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px #0002;display:flex;flex-direction:column}figure[hidden]{display:none}
.ini{flex:1;aspect-ratio:2/1;display:flex;align-items:center;justify-content:center;background:#ece9e4;color:#9a948b;font-size:34px;font-weight:600}h2{font-size:16px;margin:28px 0 10px}h2[hidden]{display:none}
.ban{height:56px;background:#e9e6e1 center/cover}
.pics{display:flex;gap:2px}.pics img{flex:1;min-width:0;aspect-ratio:1;object-fit:cover;display:block}.pics img:only-child{aspect-ratio:2/1;object-position:50%% 30%%}
figcaption{padding:8px 10px;display:flex;flex-direction:column;gap:3px}
span{color:#666;font-size:12px;overflow-wrap:anywhere}span.hl{color:#333}small{color:#999;font-size:11px}
i.c{font-style:normal;font-size:11px;font-weight:600;align-self:flex-start;padding:1px 7px;border-radius:9px}
.high{background:#dcf3e2;color:#17633a}.medium{background:#e3edfb;color:#1f4f8f}.low{background:#fdf0d5;color:#8a5a00}.none{background:#eee;color:#777}
a{color:#0a66c2;font-size:12px;font-weight:600;text-decoration:none}a.maybe{color:#8a5a00;font-weight:500}
details{font-size:12px;color:#333;border-top:1px solid #eee;padding-top:4px}summary{cursor:pointer;color:#0a66c2;font-weight:600}
details b{display:block;margin-top:6px;font-size:11px;color:#777;text-transform:uppercase;letter-spacing:.03em}details ul{margin:2px 0;padding-left:16px}details li{margin:1px 0}details p{margin:4px 0}details p.sk{color:#666}
.links a{margin-right:6px}
span.hw{color:#5b3fa8}span.tfq{color:#444;font-style:italic}
span.fbl a{font-size:11px;font-weight:500;color:#7a6f60}
</style>
<h1>Hack Western 13 Slack: %d people</h1>
<p><a href="booth-gallery.html">Full booth directory with profiles, originals and lighting variants</a></p>
<p class="sum">LinkedIn: %d confirmed, %d likely, %d unsure, %d not found. %d cards show a LinkedIn photo, %d show a photo from the Hack Western site, %d without a LinkedIn photo show a fallback photo from their own GitHub, Devpost or personal site (labelled on the card), and %d have a public professional profile (open "Profile" for projects, wins and talking points). %d mentors; %d Slack members have a team finder card, plus %d team finder hackers not matched to Slack. Matches are based on name plus school, role or Hack Western evidence; "Unsure" links are candidates only.</p>
<div class="bar"><input placeholder="Filter by name, role, school, headline" oninput="go()">
<button class="on" data-f="all">All</button><button data-f="high medium">Has LinkedIn</button><button data-f="high">Confirmed</button><button data-f="prof">Has profile</button><button data-f="m">Mentors</button><button data-f="tf">Team finder</button><button data-f="low">Unsure</button><button data-f="none">Not found</button><button data-f="np">No Slack photo</button></div>
<h2 id="h1">With a Slack photo (%d)</h2><main>''' % (len(rows), n['high'], n['medium'], n['low'], n['none'] + n[''], nl, nhw, nfb, npf, nm_, ntf, len(tcards), len(ph)) + srt(ph) + '''</main><h2 id="h2">No Slack photo (%d)</h2><main>''' % len(nph) + srt(nph) + '''</main><h2 id="h3">Team finder only, not in our Slack list (%d)</h2><main>''' % len(tcards) + srt(tcards) + '''</main>
<script>let F='all';const I=document.querySelector('input');
document.querySelectorAll('button').forEach(b=>b.onclick=()=>{document.querySelectorAll('button').forEach(x=>x.classList.remove('on'));b.classList.add('on');F=b.dataset.f;go()});
function go(){const v=I.value.toLowerCase();for(const f of document.querySelectorAll('figure'))f.hidden=!(f.dataset.q.includes(v)&&(F=='all'||(F=='prof'?f.dataset.p=='1':F=='np'?f.dataset.np=='1':F=='m'?f.dataset.m=='1':F=='tf'?f.dataset.tf=='1':F.split(' ').includes(f.dataset.c))));document.querySelectorAll('main').forEach((m,i)=>{document.getElementById('h'+(i+1)).hidden=!m.querySelector('figure:not([hidden])')})}</script>'''
import sys; sys.path.insert(0, D); from scrub import scrub
open(os.path.join(D, 'photo-gallery.html'), 'w').write(scrub(page))
print(len(rows), n, 'linkedin photos', nl, 'fallback photos', nfb, 'profiles', npf, 'mentors', nm_, 'tf linked', ntf, 'tf only', len(tcards), 'hw photos', nhw)

