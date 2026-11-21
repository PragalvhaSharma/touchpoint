#!/usr/bin/env python3
"""LinkedIn photos for team-finder-only people (not in our Slack list) whose card has a confirmed
or likely LinkedIn but no team finder photo. Public page fetched as a link-preview crawler, no login.
Saved as reviewed fallback photos (source LinkedIn) so tfcard() shows them."""
import json, os, re, html, time, requests
D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = {'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'}
tf = [c for c in json.load(open(os.path.join(D, 'hackwestern-site', 'team-finder.json'))) if not c.get('slack_id')]
ag = {}
for f in ('enrich-tf-results.json', 'search-results.json'):
    try:
        for x in json.load(open(os.path.join(D, 'hackwestern-site', 'agent', f))): ag[x['id']] = x
    except Exception: pass
FB = os.path.join(D, 'linkedin', 'fallback-photos.json'); fb = json.load(open(FB))
for c in tf:
    i = 'tf:' + re.sub(r'[^a-z0-9]+', '-', c['name'].lower()).strip('-')
    p = ag.get(i, {})
    url = c.get('linkedin') or (p.get('linkedin_url') if p.get('confidence') in ('high', 'medium') else '')
    if not url or (c.get('photo_file') and os.path.exists(os.path.join(D, 'hackwestern-site', c['photo_file']))) or i in fb: continue
    u = 'https://www.linkedin.com/in/' + url.strip().rstrip('/').split('/in/')[-1]
    r = requests.get(u, headers=UA, timeout=25); t = html.unescape(r.text)
    # only the top-card photo; other displayphoto URLs are the "People also viewed" sidebar (strangers)
    top = re.search(r'<img[^>]*top-card-layout__entity-image[^>]*>', t) or re.search(r'<img[^>]*top-card__profile-image[^>]*>', t)
    m = re.search(r'(?:data-delayed-url|src)="(https://media\.licdn\.com/dms/image/[^"]*profile-displayphoto[^"]*)"', top.group(0)) if top else None
    ph = [m.group(1)] if m else []
    print(c['name'], r.status_code, 'captcha' if 'Checking your browser' in t else '', len(ph))
    if r.status_code == 200 and ph:
        q = requests.get(ph[0], headers={'User-Agent': 'Mozilla/5.0'}, timeout=20)
        if q.ok and len(q.content) > 1500:
            fn = 'photos-fallback/%s-linkedin.jpg' % i.replace(':', '-')
            open(os.path.join(D, fn), 'wb').write(q.content)
            fb[i] = {'file': fn, 'source': 'LinkedIn', 'page_url': url, 'reviewed': True, 'note': 'public LinkedIn photo of the confirmed/likely match on the team finder card'}
    time.sleep(3)
json.dump(fb, open(FB, 'w'), indent=1, ensure_ascii=False)

