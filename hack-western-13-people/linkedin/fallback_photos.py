#!/usr/bin/env python3
"""Fallback photos for Hack Western 13 members who have no LinkedIn photo.

Re-runnable. For every member with (no Slack photo and no LinkedIn photo) or
(a high/medium LinkedIn match but no LinkedIn photo), try, in order:
  1. GitHub avatar (gh api users/<login>; default identicons skipped)
  2. Devpost profile photo (default avatar skipped)
  3. Personal site headshot (obvious headshot <img>, then og:image)
Links come only from sources tied to the person:
  - enrichment profiles when the LinkedIn match is high/medium, or when the
    profile sets links_confidence high/medium (research on low/none people)
  - research result files in hackwestern-site/agent/*results*.json with
    links_confidence high/medium
  - a GitHub link the person listed on their own Hack Western team finder card
New finds are saved with "reviewed": false and do not show in the gallery
until approved after a visual check:
  python3 linkedin/fallback_photos.py                 # find new photos
  python3 linkedin/fallback_photos.py --approve ID..  # keep (shows a person)
  python3 linkedin/fallback_photos.py --reject ID.. --why "logo"  # drop; rerun tries the next source
Entries with "manual": true are never overwritten.
"""
import csv, glob, html, io, json, os, re, subprocess, sys, urllib.parse
from concurrent.futures import ThreadPoolExecutor
import requests
from PIL import Image

D = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(D, 'linkedin', 'fallback-photos.json')
REJ = os.path.join(D, 'linkedin', 'fallback-rejected.json')
REJ_TMP = '/tmp/hw13t2/fallback-rejected.json'
PDIR = os.path.join(D, 'photos-fallback')
UA = {'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'}
HM = ('high', 'medium')


def load(p, default):
    try:
        return json.load(open(p))
    except Exception:
        return default


def save_json(p, obj):
    tmp = p + '.tmp'
    json.dump(obj, open(tmp, 'w'), indent=1, ensure_ascii=False)
    os.replace(tmp, p)


def ok(p):
    return bool(p) and os.path.exists(os.path.join(D, p)) and os.path.getsize(os.path.join(D, p)) > 500


def slug(u):
    return (u or '').strip().rstrip('/').split('/in/')[-1]


def lk(o):
    return (o or {}).get('url') if isinstance(o, dict) else (o if isinstance(o, str) else '')


def lev(o):
    return (o or {}).get('evidence', '') if isinstance(o, dict) else ''


def state():
    """Mirror gallery.py: merged LinkedIn matches plus fetched photo status."""
    rows = list(csv.DictReader(open(os.path.join(D, 'hack-western-13-slack-members.csv'))))
    li = {}
    for f in sorted(glob.glob(os.path.join(D, 'linkedin', 'results', '*chunk-*.json'))):
        for x in load(f, []):
            li[x['id']] = x
    for k, v in load(os.path.join(D, 'linkedin', 'overrides.json'), {}).items():
        if k in li:
            li[k].update(v)
    for k, f in load(os.path.join(D, 'linkedin', 'fetched.json'), {}).items():
        x = li.get(k)
        if not x or f.get('status') != 'ok' or slug(x.get('linkedin_url')) != slug(f.get('url')):
            continue
        x['linkedin_photo'] = f.get('linkedin_photo') or x.get('linkedin_photo') or ''
    en = {}
    for f in sorted(glob.glob(os.path.join(D, 'linkedin', 'enrich', 'results', '*chunk*.json'))):
        for x in load(f, []):
            en[x['id']] = x
    res = {}
    for f in sorted(glob.glob(os.path.join(D, 'hackwestern-site', 'agent', '*results*.json'))):
        d = load(f, [])
        d = d if isinstance(d, list) else d.get('results', [])
        for x in d:
            if isinstance(x, dict) and x.get('id') and (x.get('links_confidence') or '').lower() in HM:
                res[x['id']] = x
    hw = load(os.path.join(D, 'hackwestern-site', 'by-slack-id.json'), {})
    return rows, li, en, res, hw


def links_for(i, li, en, res, hw):
    """Ordered candidate links: (source, url, evidence)."""
    conf = (li.get(i, {}).get('confidence') or '').lower()
    profs = []
    p = en.get(i)
    if p and (conf in HM or (p.get('links_confidence') or '').lower() in HM):
        why = 'LinkedIn match %s' % conf if conf in HM else 'links_confidence %s' % p.get('links_confidence')
        profs.append((p, 'enrichment profile (%s)' % why))
    if i in res:
        profs.append((res[i], 'research result (links_confidence %s)' % res[i].get('links_confidence')))
    gh, dp, site = [], [], []
    for p, why in profs:
        if lk(p.get('github')):
            gh.append((lk(p['github']), '%s; %s' % (why, lev(p.get('github')))))
        if lk(p.get('devpost')):
            dp.append((lk(p['devpost']), '%s; %s' % (why, lev(p.get('devpost')))))
        if lk(p.get('personal_site')):
            site.append((lk(p['personal_site']), '%s; %s' % (why, lev(p.get('personal_site')))))
    tf = (hw.get(i) or {}).get('team_finder') or {}
    if tf.get('github'):
        gh.append((tf['github'], 'self-listed on their Hack Western 13 team finder card'))
    out, seen = [], set()
    for src, lst in (('GitHub avatar', gh), ('Devpost photo', dp), ('Personal site', site)):
        for u, ev in lst:
            u = u.strip()
            if not u or u.lower().rstrip('/') in seen:
                continue
            seen.add(u.lower().rstrip('/'))
            out.append((src, u, ev.strip('; ')))
    return out


def ext_of(b):
    if b[:3] == b'\xff\xd8\xff':
        return 'jpg'
    if b[:8] == b'\x89PNG\r\n\x1a\n':
        return 'png'
    if b[:4] == b'RIFF' and b[8:12] == b'WEBP':
        return 'webp'
    if b[:6] in (b'GIF87a', b'GIF89a'):
        return 'gif'
    return ''


def colours(b):
    try:
        im = Image.open(io.BytesIO(b)).convert('RGB')
        c = im.getcolors(maxcolors=4096)  # full size: identicons are exactly 2 colours
        return len(c) if c else 4096, im.size
    except Exception:
        return 0, (0, 0)


def get(url, **kw):
    return requests.get(url, headers=UA, timeout=20, allow_redirects=True, **kw)


def github(u):
    m = re.search(r'github\.com/([A-Za-z0-9-]+)', u)
    if not m:
        return None, 'not a GitHub profile URL'
    login = m.group(1)
    r = subprocess.run(['gh', 'api', 'users/' + login, '--jq', '.avatar_url'], capture_output=True, text=True)
    av = r.stdout.strip()
    if r.returncode or not av:
        return None, 'gh api failed for %s' % login
    sep = '&' if '?' in av else '?'
    b = get(av + sep + 's=460').content
    n, _ = colours(b)
    if 0 < n <= 3:
        return None, 'default GitHub identicon for %s' % login
    return (b, av, 'https://github.com/' + login), ''


def devpost(u):
    page = u if u.startswith('http') else 'https://devpost.com/' + u
    t = get(page).text
    m = re.search(r'<img alt="[^"]*?&#39;s avatar"[^>]*?src="([^"]+)"', t) or re.search(r'<img[^>]*class="user-photo[^"]*"[^>]*src="([^"]+)"', t)
    if not m:
        return None, 'no avatar img on Devpost page'
    src = html.unescape(m.group(1))
    if 'no-avatar' in src or '/defaults/' in src:
        return None, 'Devpost default avatar'
    src = src.replace('=s96-c', '=s400-c')
    if src.startswith('//'):
        src = 'https:' + src
    b = get(src).content
    n, _ = colours(b)
    if 0 < n <= 3:
        return None, 'Devpost avatar is a default or identicon'
    return (b, src, page), ''


BAD = re.compile(r'logo|favicon|icon|sprite|banner|screenshot|preview|cover|project|thumb|placeholder|\.svg', re.I)
GOOD = re.compile(r'headshot|portrait|profile|avatar|pfp|selfie|\bme\b|/me\.|_me\.|-me\.|myself|about', re.I)
# Single-page sites keep images in their JS bundles; only take obvious headshot file names there.
BUNDLE = re.compile(r'["\'(]([^"\'()\s]*?(?:^|/)(?:pfp|headshot|portrait|profile[-_]?(?:pic|photo|image)?|avatar|selfie|me|mypic|my[-_]?photo)(?:[-_.][^"\'()\s/]*)?\.(?:jpe?g|png|webp))["\')]', re.I)


def site(u):
    if not u.startswith('http'):
        u = 'https://' + u
    tried = []
    for page in (u, urllib.parse.urljoin(u if u.endswith('/') else u + '/', 'about')):
        try:
            r = get(page)
        except Exception as ex:
            tried.append('%s: %s' % (page, type(ex).__name__))
            continue
        if r.status_code != 200 or 'html' not in r.headers.get('content-type', ''):
            tried.append('%s: %s' % (page, r.status_code))
            continue
        t = r.text
        cands = []
        for m in re.finditer(r'<img\b[^>]*>', t, re.I):
            tag = m.group(0)
            s = re.search(r'\ssrc="([^"]+)"', tag) or re.search(r"\ssrc='([^']+)'", tag)
            if not s or s.group(1).startswith('data:'):
                continue
            alt = re.search(r'alt="([^"]*)"', tag) or re.search(r"alt='([^']*)'", tag)
            cls = re.search(r'class="([^"]*)"', tag)
            hay = ' '.join([s.group(1), alt.group(1) if alt else '', cls.group(1) if cls else ''])
            if GOOD.search(hay) and not BAD.search(s.group(1) + ' ' + (alt.group(1) if alt else '')):
                cands.append(urllib.parse.urljoin(r.url, html.unescape(s.group(1))))
        for prop in ('og:image', 'twitter:image'):
            m = re.search(r'<meta[^>]+(?:property|name)=["\']%s["\'][^>]+content=["\']([^"\']+)' % prop, t, re.I) or \
                re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']%s["\']' % prop, t, re.I)
            if m and not BAD.search(m.group(1)):
                cands.append(urllib.parse.urljoin(r.url, html.unescape(m.group(1))))
        for j in re.findall(r'<script[^>]+src="([^"]+\.js)"', t)[:25]:
            try:
                jt = get(urllib.parse.urljoin(r.url, j)).text
            except Exception:
                continue
            for m in BUNDLE.finditer(jt):
                cands.append(urllib.parse.urljoin(r.url, m.group(1)))
        for c in dict.fromkeys(cands):
            try:
                b = get(c).content
            except Exception:
                continue
            n, size = colours(b)
            if ext_of(b) and n > 16 and min(size) >= 64:
                return (b, c, r.url), ''
        tried.append('%s: no headshot candidate' % page)
    return None, '; '.join(tried)


FN = {'GitHub avatar': github, 'Devpost photo': devpost, 'Personal site': site}
SLUG = {'GitHub avatar': 'github', 'Devpost photo': 'devpost', 'Personal site': 'site'}


def norm_url(u):
    """Same image under another size/query (GitHub avatar reused on Devpost, Google =s96-c)."""
    return re.sub(r'=s\d+(-c)?$', '', (u or '').split('?')[0])


def find(i, cands, rejected_urls):
    notes = []
    for src, u, ev in cands:
        try:
            got, why = FN[src](u)
        except Exception as ex:
            got, why = None, '%s: %s' % (type(ex).__name__, ex)
        if not got:
            notes.append('%s %s: %s' % (src, u, why))
            continue
        b, img_url, page = got
        if norm_url(img_url) in rejected_urls:
            notes.append('%s %s: previously rejected' % (src, img_url))
            continue
        ext = ext_of(b) or 'jpg'
        rel = 'photos-fallback/%s-%s.%s' % (i, SLUG[src], ext)
        open(os.path.join(D, rel), 'wb').write(b)
        return {'file': rel, 'source': src, 'source_url': img_url, 'page_url': page,
                'evidence': 'Link from %s' % ev, 'reviewed': False}, notes
    return None, notes


def review(args, out, rej):
    why = ''
    if '--why' in args:
        why = args[args.index('--why') + 1]
        args = args[:args.index('--why')]
    for i in args[1:]:
        if i not in out:
            print('no entry', i)
            continue
        if args[0] == '--approve':
            out[i]['reviewed'] = True
        else:
            e = out.pop(i)
            e['reason'] = why
            rej.setdefault(i, []).append(e)
            fp = os.path.join(D, e['file'])
            if os.path.exists(fp):
                os.replace(fp, '/tmp/hw13t2/rejected-' + os.path.basename(fp))
    save_json(OUT, out)
    save_json(REJ, rej)
    save_json(REJ_TMP, rej)
    print(args[0], len(args) - 1)


def main():
    os.makedirs(PDIR, exist_ok=True)
    os.makedirs(os.path.dirname(REJ_TMP), exist_ok=True)
    out = load(OUT, {})
    rej = load(REJ, {})
    args = sys.argv[1:]
    if args and args[0] in ('--approve', '--reject'):
        return review(args, out, rej)
    rows, li, en, res, hw = state()
    targets = []
    for r in rows:
        i = r['Slack user ID']
        conf = (li.get(i, {}).get('confidence') or '').lower()
        has_li = conf in HM and ok(li.get(i, {}).get('linkedin_photo'))
        # low/none people with an independent profile (links_confidence high/medium) count too
        trusted = (en.get(i, {}).get('links_confidence') or '').lower() in HM or i in res
        if has_li or (r['Photo file'] and conf not in HM and not trusted):
            continue
        targets.append(i)
    todo = []
    for i in targets:
        e = out.get(i)
        if e and (e.get('manual') or ok(e.get('file'))):
            continue
        todo.append((i, links_for(i, li, en, res, hw)))
    rurls = {i: {norm_url(e.get('source_url')) for e in v} for i, v in rej.items()}
    log = {}

    def work(t):
        i, cands = t
        if not cands:
            return i, None, ['no trusted GitHub/Devpost/site links']
        return (i,) + find(i, cands, rurls.get(i, set()))
    with ThreadPoolExecutor(8) as ex:
        for i, e, notes in ex.map(work, todo):
            log[i] = notes
            if e:
                out[i] = e
    for k, v in load(OUT, {}).items():
        if v.get('manual'):
            out[k] = v
    save_json(OUT, out)
    if not os.path.exists(REJ):
        save_json(REJ, rej)
    names = {r['Slack user ID']: r['Name'] for r in rows}
    new = [i for i, _ in todo if i in out]
    print('targets', len(targets), 'already had fallback', len(targets) - len(todo), 'searched', len(todo), 'new', len(new))
    for i in new:
        print('  NEW', i, names[i], out[i]['source'], out[i]['file'])
    for i, notes in log.items():
        if i not in out:
            print('  none', i, names[i], '|', ' / '.join(notes)[:300])
    pend = [k for k, v in out.items() if not v.get('reviewed') and not v.get('manual')]
    if pend:
        print('PENDING VISUAL REVIEW (hidden in gallery until --approve):', ' '.join(pend))
    save_json('/tmp/hw13t2/fallback-log.json', {'targets': targets, 'log': log})


if __name__ == '__main__':
    main()

