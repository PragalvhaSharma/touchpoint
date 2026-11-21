import csv, json, re, os
from collections import Counter, OrderedDict
D = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(D, 'hack-western-13-slack-members-raw.csv')
if not os.path.exists(RAW):
    os.rename(os.path.join(D, 'hack-western-13-slack-members.csv'), RAW)
rows = list(csv.DictReader(open(RAW)))

REMOVE_IDS = set()
removed = []
for r in rows:
    why = None
    if r['Account type'] == 'Bot': why = 'Bot or app'
    elif r['Email'] == 'hello@hackwestern.com': why = 'Hack Western organization account'
    elif r['Email'] == 'sponsor@pcbway.com': why = 'Shared PCBWay sponsor account'
    elif r['Deactivated'] == 'Yes': why = 'Deactivated account'
    if why: REMOVE_IDS.add(r['Slack user ID']); removed.append((r['Full name'], r['Email'], why))

ZW = re.compile('[\u200b-\u200d\ufeff]')
UNSURE = {'laygo.fiona', 'tallapaneni.surya', 'ethn.yang', 'jehan.khxn', 'michael.dakt'}
def strip_tag(s):
    s = ZW.sub('', s or '')
    s = re.sub(r'^\s*\[[^\]]*\]\s*-?\s*', '', s)
    s = s.replace(',', ' ')
    return re.sub(r'\s+', ' ', s).strip()
def fix_case(s):
    return ' '.join(w[:1].upper() + w[1:].lower() if (w.islower() or w.isupper()) and w.isalpha() and len(w) > 1 else w for w in s.split())
def is_handle(s, email):
    return ' ' not in s and (bool(re.search(r'[\d._]', s)) or s.lower() == email.split('@')[0].lower())

def best_name(r):
    full, disp = strip_tag(r['Full name']), strip_tag(r['Display name'])
    email = r['Email']
    name = full
    if disp and ' ' in disp and (' ' not in full or (disp.lower().startswith(full.split(' ')[0].lower()) and len(disp) > len(full))):
        name = disp
    quality = 'Full name'
    if is_handle(name, email):
        parts = name.split('.')
        if name in ('jerry', 'Kristina'):
            return name.capitalize(), 'First name only'
        if len(parts) >= 2 and all(re.fullmatch(r'[A-Za-z]+', p) for p in parts) and name.lower() not in UNSURE:
            name = ' '.join(p.capitalize() + ('.' if len(p) == 1 else '') for p in parts)
            quality = 'Read from username'
        else:
            quality = 'Username only'
    else:
        name = fix_case(name)
        if ' ' not in name: quality = 'First name only'
    return name, quality

SPONSOR_TAGS = {'CANADA LIFE': 'Canada Life', 'STARTECH': 'StarTech.com', 'STARTECH.COM': 'StarTech.com', 'SUNLIFE': 'Sun Life', 'CSE-CST': 'CSE (Communications Security Establishment)'}
SPONSOR_DOMAINS = {'canadalife.com': 'Canada Life', 'startech.com': 'StarTech.com', 'scotiabank.com': 'Scotiabank', 'commure.com': 'Commure', 'cse-cst.gc.ca': 'CSE (Communications Security Establishment)'}
SCHOOLS = {'uwo.ca': 'Western University', 'ivey.ca': 'Ivey Business School (Western)', 'uwaterloo.ca': 'University of Waterloo', 'mcmaster.ca': 'McMaster University', 'utoronto.ca': 'University of Toronto', 'yorku.ca': 'York University', 'mylaurier.ca': 'Wilfrid Laurier University', 'ontariotechu.net': 'Ontario Tech University', 'nus.edu': 'National University of Singapore', 'ucla.edu': 'UCLA', 'hackthenorth.com': 'Hack the North', 'tesser.sh': 'Tesser', 'unrepped.co': 'Unrepped'}
def org_for(email, tag):
    t = ZW.sub('', tag).upper()
    if t in SPONSOR_TAGS: return SPONSOR_TAGS[t]
    dom = email.lower().split('@')[-1]
    for k, v in {**SPONSOR_DOMAINS, **SCHOOLS}.items():
        if dom == k or dom.endswith('.' + k): return v
    return ''
def role_for(tag, email):
    t = ZW.sub('', tag).upper()
    if t == 'ORGANIZER': return 'Organizer'
    if t == 'SPONSORSHIPS ORGANIZER': return 'Organizer (Sponsorships)'
    if t == 'MENTOR': return 'Mentor'
    if t == 'JUDGE': return 'Judge'
    if t == 'VOLUNTEER': return 'Volunteer'
    if t in SPONSOR_TAGS or email.lower().split('@')[-1] in SPONSOR_DOMAINS: return 'Sponsor rep'
    return 'Participant'
JOKE_TITLES = {"Horses don't stop they keep going", '🐎', 'Esteemed', 'mastah hacka'}

out = OrderedDict()
for r in rows:
    if r['Slack user ID'] in REMOVE_IDS: continue
    name, quality = best_name(r)
    if r['Username'] == 'pragalvhasharma': name, quality = 'Pragalvha Sharma (you)', 'Full name'
    notes = []
    pron = r.get('Name Pronunciation') or ''
    if re.fullmatch(r'[\d\s()+-]{10,}', pron): notes.append('Phone number typed into pronunciation field: ' + pron)
    elif pron: notes.append('Pronounced ' + pron)
    title = '' if r['Title'] in JOKE_TITLES else r['Title']
    rec = OrderedDict([
        ('Name', name), ('Role', role_for(r['Tag in name'], r['Email'])), ('Organization / school', org_for(r['Email'], r['Tag in name'])),
        ('Email', r['Email']), ('Other email', ''), ('Title', title), ('Slack display name', ZW.sub('', r['Display name'] or r['Full name'])),
        ('Slack username', ZW.sub('', r['Username'])), ('Name source', quality), ('Time zone', r['Time zone label']),
        ('Slack admin', {'Primary owner': 'Primary owner', 'Owner': 'Owner', 'Admin': 'Admin'}.get(r['Account type'], '')),
        ('Notes', '; '.join(notes)), ('Slack user ID', r['Slack user ID']), ('Profile link', r['Profile link']), ('Photo URL', r['Photo URL']),
    ])
    key = name.lower() if ' ' in name else name.lower() + '|' + r['Slack user ID']
    if key in out and ' ' in name:
        out[key]['Other email'] = rec['Email']
        out[key]['Notes'] = '; '.join(x for x in [out[key]['Notes'], 'Has a second Slack account (' + rec['Slack user ID'] + ')'] if x)
        removed.append((name, rec['Email'], 'Second account, merged into one row'))
        continue
    out[key] = rec
for r in removed:
    if r[2] == 'Deactivated account':
        for rec in out.values():
            if rec['Name'].split()[0] == r[0].split()[0] and rec['Name'].split()[-1] == r[0].split()[-1]:
                rec['Other email'] = r[1]; rec['Notes'] = '; '.join(x for x in [rec['Notes'], 'Also had a deactivated Slack account'] if x)
POSSIBLE = [('llavric@uwo.ca', 'Lucian Lavric'), ('a2baid@uwaterloo.ca', 'Anay Baid'), ('c783wang@uwaterloo.ca', 'Colin Wang')]
for em, other in POSSIBLE:
    for rec in out.values():
        if rec['Email'] == em: rec['Notes'] = '; '.join(x for x in [rec['Notes'], 'Possibly a second account of ' + other] if x)

# Fill only schools checked against these members' own event team-finder cards.
with open(os.path.join(D, 'hackwestern-site', 'reviewed-roster-schools.json')) as source:
    reviewed_schools = json.load(source)
recs = list(out.values())
for member in recs:
    if not member['Organization / school']:
        member['Organization / school'] = reviewed_schools.get(member['Slack user ID'], '')
ROLE_ORDER = {'Organizer': 0, 'Organizer (Sponsorships)': 1, 'Judge': 2, 'Mentor': 3, 'Sponsor rep': 4, 'Volunteer': 5, 'Participant': 6}
recs.sort(key=lambda x: (ROLE_ORDER[x['Role']], x['Name source'] != 'Full name', x['Name'].lower()))
cols = list(recs[0].keys())
with open(os.path.join(D, 'hack-western-13-slack-members.csv'), 'w', newline='') as f:
    w = csv.DictWriter(f, cols, lineterminator="\n"); w.writeheader(); w.writerows(recs)

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter
wb = Workbook(); ws = wb.active; ws.title = 'People'
ws.append(cols)
for x in recs: ws.append([x[c] for c in cols])
for c in ws[1]: c.font = Font(bold=True, color='FFFFFF'); c.fill = PatternFill('solid', fgColor='4A154B')
ws.freeze_panes = 'B2'; ws.auto_filter.ref = ws.dimensions
for i, c in enumerate(cols, 1):
    ws.column_dimensions[get_column_letter(i)].width = min(max(len(c), *(len(str(x[c])) for x in recs)) + 2, 42)
s = wb.create_sheet('Summary')
s.append(['Hack Western 13 Slack: people']); s['A1'].font = Font(bold=True, size=13)
s.append(['People', len(recs)]); s.append(['With email', sum(bool(x['Email']) for x in recs)])
s.append([]); s.append(['Role', 'Count']); s['A5'].font = Font(bold=True)
for k, v in sorted(Counter(x['Role'] for x in recs).items(), key=lambda kv: ROLE_ORDER[kv[0]]): s.append([k, v])
s.append([]); s.append(['Organization / school (from email, tag or event card)', 'Count']); s.cell(s.max_row, 1).font = Font(bold=True)
for k, v in Counter(x['Organization / school'] or 'Personal email, unknown' for x in recs).most_common(): s.append([k, v])
s.append([]); s.append(['Name source', 'Count']); s.cell(s.max_row, 1).font = Font(bold=True)
for k, v in Counter(x['Name source'] for x in recs).most_common(): s.append([k, v])
s.column_dimensions['A'].width = 46; s.column_dimensions['B'].width = 10
r2 = wb.create_sheet('Removed')
r2.append(['Name in Slack', 'Email', 'Why removed'])
for c in r2[1]: c.font = Font(bold=True)
for x in removed: r2.append(list(x))
r2.column_dimensions['A'].width = 28; r2.column_dimensions['B'].width = 32; r2.column_dimensions['C'].width = 40
wb.save(os.path.join(D, 'hack-western-13-slack-members.xlsx'))
print('people', len(recs), 'removed', len(removed))
print(Counter(x['Role'] for x in recs)); print(Counter(x['Name source'] for x in recs))
print([x['Name'] for x in recs if x['Name source'] == 'Read from username'])
print([x['Name'] for x in recs if x['Name source'] == 'Username only'][:80])
print([(x['Name'], x['Notes']) for x in recs if x['Notes']])
