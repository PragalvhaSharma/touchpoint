import csv, os, re, urllib.request
from compress_photos import shrink  # every photo is saved small: 512 px JPEG
from concurrent.futures import ThreadPoolExecutor
D = os.path.dirname(os.path.abspath(__file__))
P = os.path.join(D, 'photos'); os.makedirs(P, exist_ok=True)
raw = {r['Slack user ID']: r for r in csv.DictReader(open(os.path.join(D, 'hack-western-13-slack-members-raw.csv')))}
rows = list(csv.DictReader(open(os.path.join(D, 'hack-western-13-slack-members.csv'))))
def slug(s): return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')[:40]
def get(r):
    if raw[r['Slack user ID']]['Custom photo'] != 'Yes' or not r['Photo URL']: return r['Slack user ID'], ''
    url = r['Photo URL']
    fn = slug(r['Name']) + '-' + r['Slack user ID'] + '.jpg'
    path = os.path.join(P, fn)
    if not os.path.exists(path):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'}), timeout=30) as resp: data = resp.read()
            open(path, 'wb').write(shrink(data))
        except Exception as e:
            return r['Slack user ID'], 'ERROR ' + str(e)[:60]
    return r['Slack user ID'], os.path.relpath(path, D)
with ThreadPoolExecutor(16) as ex: res = dict(ex.map(get, rows))
for r in rows: r['Photo file'] = res[r['Slack user ID']] if not res[r['Slack user ID']].startswith('ERROR') else ''
cols = list(rows[0].keys())
with open(os.path.join(D, 'hack-western-13-slack-members.csv'), 'w', newline='') as f:
    w = csv.DictWriter(f, cols); w.writeheader(); w.writerows(rows)
from openpyxl import load_workbook
wb = load_workbook(os.path.join(D, 'hack-western-13-slack-members.xlsx')); ws = wb['People']
hdr = [c.value for c in ws[1]]
if 'Photo file' not in hdr:
    col = len(hdr) + 1; ws.cell(1, col, 'Photo file')._style = ws.cell(1, 1)._style
else: col = hdr.index('Photo file') + 1
ids = {ws.cell(i, hdr.index('Slack user ID') + 1).value: i for i in range(2, ws.max_row + 1)}
for r in rows:
    c = ws.cell(ids[r['Slack user ID']], col, os.path.basename(r['Photo file']) if r['Photo file'] else '')
    if r['Photo file']: c.hyperlink = 'photos/' + os.path.basename(r['Photo file']); c.style = 'Hyperlink'
ws.column_dimensions[ws.cell(1, col).column_letter].width = 42
ws.auto_filter.ref = ws.dimensions
wb.save(os.path.join(D, 'hack-western-13-slack-members.xlsx'))
errs = [v for v in res.values() if v.startswith('ERROR')]
print('photos', sum(1 for v in res.values() if v and not v.startswith('ERROR')), 'default avatar', sum(1 for v in res.values() if not v), 'errors', len(errs), errs[:3])
