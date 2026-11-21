#!/usr/bin/env python3
"""Fetch public LinkedIn profile pages (no login) as a link-preview crawler, for every
high/medium match that has no LinkedIn photo yet. Tip from Akshay's commit 4fc6662:
User-Agent facebookexternalhit/1.1 gets the public page; the real photo is the
media.licdn.com profile-displayphoto URL in the HTML (og:image is a placeholder).
Updates linkedin/fetched.json and saves photos to photos-linkedin/.
  python3 linkedin/fetch_li_crawler.py [--all] [--limit N] [ID ...]"""
import glob, html, json, os, re, shutil, sys, time
import requests
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = {'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'}
li = {x['id']: x for f in sorted(glob.glob(os.path.join(D, 'linkedin/results/*chunk-*.json'))) for x in json.load(open(f))}
for k, v in json.load(open(os.path.join(D, 'linkedin/overrides.json'))).items():
    if k in li: li[k] = {**li[k], **v}
FE = os.path.join(D, 'linkedin/fetched.json'); fe = json.load(open(FE))
slug = lambda u: (u or '').strip().rstrip('/').split('/in/')[-1].lower()
args = [a for a in sys.argv[1:] if not a.startswith('--')]
lim = int(sys.argv[sys.argv.index('--limit') + 1]) if '--limit' in sys.argv else 10**9
if '--limit' in sys.argv: args = [a for a in args if a != str(lim)]
todo = []
for i, x in li.items():
    if args and i not in args: continue
    if x.get('confidence') not in ('high', 'medium') or not x.get('linkedin_url'): continue
    f = fe.get(i, {})
    if '--all' not in sys.argv and f.get('linkedin_photo') and slug(f.get('url')) == slug(x['linkedin_url']) and os.path.exists(os.path.join(D, f['linkedin_photo'])): continue
    todo.append((i, x))
todo = todo[:lim]
print('targets', len(todo))
shutil.copy(FE, '/tmp/fetched.before-crawler.json')
def meta(t, prop):
    m = re.search(r'<meta[^>]{0,40}(?:property|name)="%s"[^>]{0,20}content="([^"]*)"' % re.escape(prop), t) or re.search(r'<meta[^>]{0,10}content="([^"]*)"[^>]{0,40}(?:property|name)="%s"' % re.escape(prop), t)
    return html.unescape(m.group(1)) if m else ''
def save(url, path):
    r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
    if r.ok and r.headers.get('content-type', '').startswith('image') and len(r.content) > 1500:
        open(os.path.join(D, path), 'wb').write(r.content); return path
    return ''
got = 0
for i, x in todo:
    u = 'https://www.linkedin.com/in/' + x['linkedin_url'].strip().rstrip('/').split('/in/')[-1]
    try:
        r = requests.get(u, headers=UA, timeout=25)
    except Exception as ex:
        print('ERR', x['name'], ex); continue
    t = r.text
    if r.status_code != 200 or 'profile' not in t[:200000].lower() or '<title>Checking your browser' in t:
        print('FAIL', r.status_code, x['name'], u); time.sleep(1); continue
    title = meta(t, 'og:title') or (re.search(r'<title>([^<]{0,300})', t) or [None, ''])[1]
    desc = meta(t, 'description') or meta(t, 'og:description')
    # Only the person's own photo: the <img> in the top card. Other profile-displayphoto URLs on the
    # page belong to the "People also viewed" sidebar (strangers). Ghost avatar = no public photo.
    u_ = html.unescape(t)
    top = re.search(r'<img[^>]*top-card-layout__entity-image[^>]*>', u_) or re.search(r'<img[^>]*top-card__profile-image[^>]*>', u_)
    ph = []
    if top:
        m = re.search(r'(?:data-delayed-url|src)="(https://media\.licdn\.com/dms/image/[^"]*profile-displayphoto[^"]*)"', top.group(0))
        if m: ph = [m.group(1)]
    if not ph and not top:
        og = meta(t, 'og:image')
        if 'profile-displayphoto' in og: ph = [og]
    bn = re.findall(r'https://media\.licdn\.com/dms/image/[^"\s]*?profile-displaybackgroundimage[^"\s]*', u_)
    e = dict(fe.get(i, {}))
    e.update({'url': x['linkedin_url'], 'status': 'ok', 'page_name': html.unescape(title.split(' - ')[0].split(' | ')[0]).strip(), 'title': html.unescape(title), 'description': desc, 'photo_url': ph[0] if ph else '', 'banner_url': bn[0] if bn else '', 'fetched_via': 'facebookexternalhit (public, no login)'})
    e['photo_checked'] = 'topcard'
    e.pop('linkedin_photo', None)
    if ph:
        p = save(ph[0], 'photos-linkedin/%s-linkedin.jpg' % i)
        if p: e['linkedin_photo'] = p; got += 1
    if bn:
        b = save(bn[0], 'photos-linkedin/%s-banner.jpg' % i)
        if b: e['banner_photo'] = b
    fe[i] = e
    print('OK' if ph else 'NOPHOTO', x['name'], '|', e['page_name'], '|', title[:80])
    json.dump(fe, open(FE, 'w'), indent=1, ensure_ascii=False)
    time.sleep(1.5)
print('photos', got, 'of', len(todo))
