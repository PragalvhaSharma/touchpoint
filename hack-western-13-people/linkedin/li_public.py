#!/usr/bin/env python3
"""Parse the public (logged-out) LinkedIn profile of every high/medium match into
linkedin/li-public/<slack id>.json: about, experience (company/title/dates/location),
education, honors and awards, volunteering, websites, and the person's own recent posts.
Fetched as a link-preview crawler (User-Agent facebookexternalhit/1.1), no login.
Entries mentioning religion, health or family are dropped (research brief exclusions).
  python3 linkedin/li_public.py [--refresh] [ID ...]"""
import glob, html, json, os, re, sys, time
from concurrent.futures import ThreadPoolExecutor
import requests
from bs4 import BeautifulSoup
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(D, 'linkedin', 'li-public'); CACHE = '/tmp/hw13-li-html'
os.makedirs(OUT, exist_ok=True); os.makedirs(CACHE, exist_ok=True)
UA = {'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'}
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scrub import SENSITIVE  # one privacy filter for every path (scrub.py)
clean = lambda s: re.sub(r'\s+', ' ', html.unescape(s or '')).strip()
slug = lambda u: (u or '').strip().rstrip('/').split('/in/')[-1].lower()

def items(sec):
    out = []
    if not sec: return out
    for li in sec.select('li'):
        if li.find('li'): continue
        h3 = li.find('h3'); h4 = li.find('h4')
        dr = li.select_one('.date-range') or li.find('span', class_=re.compile('date-range'))
        meta = [clean(p.get_text(' ')) for p in li.select('.experience-item__meta-item, .education__item--details')]
        desc = li.select_one('.show-more-less-text__text--less, .show-more-less-text__text--more')
        it = {'title': clean(h3.get_text(' ')) if h3 else '', 'org': clean(h4.get_text(' ')) if h4 else '',
              'dates': clean(dr.get_text(' ')) if dr else '', 'meta': [m for m in meta if m and m != it_dates(dr)] if False else [m for m in meta if m],
              'description': clean(desc.get_text(' '))[:400] if desc else ''}
        for k in ('title', 'org'):
            if it[k].strip(' -') == '': it[k] = ''
        if not it['title'] and not it['org']: continue
        txt = ' '.join(str(v) for v in it.values())
        if SENSITIVE.search(txt): continue
        out.append(it)
    return out
def it_dates(x): return ''

def parse(t, url):
    s = BeautifulSoup(t, 'html.parser')
    sec = lambda n: s.find('section', attrs={'data-section': n}) or s.find(attrs={'data-section': n})
    about = sec('summary'); about = clean(about.get_text(' ')).removeprefix('About').strip() if about else ''
    rec = {'url': url, 'about': '' if SENSITIVE.search(about) else about[:1200],
           'experience': items(sec('experience')), 'education': items(sec('educationsDetails') or sec('educations')),
           'awards': items(sec('honors-and-awards')), 'volunteering': items(sec('volunteering')),
           'certifications': items(sec('certifications')), 'li_projects': items(sec('projects')),
           'publications': items(sec('publications')), 'organizations': items(sec('organizations')),
           'websites': [], 'posts': [], 'fetched': time.strftime('%Y-%m-%d')}
    w = sec('websites')
    if w: rec['websites'] = sorted({clean(a.get_text(' ')) for a in w.find_all('a') if clean(a.get_text(' '))})
    for m in re.finditer(r'<script type="application/ld\+json">(.*?)</script>', t, re.S):
        try: d = json.loads(m.group(1))
        except Exception: continue
        for g in d.get('@graph', []) if isinstance(d, dict) else []:
            if g.get('@type') != 'DiscussionForumPosting': continue
            if slug((g.get('author') or {}).get('url')) != slug(url): continue
            txt = clean(g.get('text'))
            if not txt or SENSITIVE.search(txt): continue
            rec['posts'].append({'date': (g.get('datePublished') or '')[:10], 'text': txt[:500], 'url': g.get('url') or g.get('mainEntityOfPage'),
                                 'likes': ((g.get('interactionStatistic') or {}).get('userInteractionCount'))})
        me = d.get('mainEntity') if isinstance(d, dict) else None
        if isinstance(me, dict):
            rec['headline'] = clean(me.get('jobTitle') if isinstance(me.get('jobTitle'), str) else ', '.join(me.get('jobTitle') or []))
            rec['location'] = clean((me.get('address') or {}).get('addressLocality'))
            aw = [clean(a) for a in (me.get('awards') or []) if a and not SENSITIVE.search(a)]
            have = {a['title'] for a in rec['awards']}
            rec['awards'] += [{'title': a, 'org': '', 'dates': '', 'meta': [], 'description': ''} for a in aw if a not in have]
            rec['languages'] = [clean(l.get('name')) for l in (me.get('knowsLanguage') or []) if isinstance(l, dict) and l.get('name')]
    tt = s.find('title'); rec['page_title'] = clean(tt.get_text()) if tt else ''
    return rec

def main():
    li = {x['id']: x for f in sorted(glob.glob(os.path.join(D, 'linkedin/results/*chunk-*.json'))) for x in json.load(open(f))}
    for k, v in json.load(open(os.path.join(D, 'linkedin/overrides.json'))).items():
        if k in li: li[k] = {**li[k], **v}
    ids = [a for a in sys.argv[1:] if not a.startswith('--')]
    todo = [(i, x) for i, x in li.items() if x.get('confidence') in ('high', 'medium') and x.get('linkedin_url') and (not ids or i in ids)
            and ('--refresh' in sys.argv or ids or not os.path.exists(os.path.join(OUT, i + '.json')))]
    print('targets', len(todo), flush=True)
    def one(a):
        i, x = a
        u = 'https://www.linkedin.com/in/' + x['linkedin_url'].strip().rstrip('/').split('/in/')[-1]
        cp = os.path.join(CACHE, i + '.html')
        t = open(cp).read() if os.path.exists(cp) and '--refetch' not in sys.argv else ''
        if '<title>Checking your browser' in t: t = ''
        if t: pass
        else:
            for k in range(3):
                try:
                    r = requests.get(u, headers=UA, timeout=25)
                    if r.status_code == 200 and '<title>Checking your browser' not in r.text: break
                except Exception: r = None
                time.sleep(3 + 5 * k)
            if not r or r.status_code != 200 or '<title>Checking your browser' in r.text: return i, 'FAIL %s' % ('captcha' if r is not None and r.status_code == 200 else (r.status_code if r is not None else 'err'))
            t = r.text; open(cp, 'w').write(t)
        rec = parse(t, x['linkedin_url']); rec['name'] = x.get('name')
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__)))); from scrub import clean
        json.dump(clean(rec), open(os.path.join(OUT, i + '.json'), 'w'), indent=1, ensure_ascii=False)
        return i, 'ok exp %d edu %d aw %d vol %d posts %d' % tuple(len(rec[k]) for k in ('experience', 'education', 'awards', 'volunteering', 'posts'))
    with ThreadPoolExecutor(3) as ex:
        for i, st in ex.map(one, todo): print(i, li[i].get('name'), st, flush=True)
if __name__ == '__main__': main()
