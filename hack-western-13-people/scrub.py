"""Output-time scrub for the people exports. Removes emails, ethnicity/religion/orientation signals
from named cultural, faith or identity groups, political-party activity, postal codes and TheOrg
(broker-like) links. Spoken languages and built projects are kept."""
import re
ETH = (r"Chinese|Korean|Taiwanese|Vietnamese|Ukrainian|Indian|Pakistani|Bangladeshi|Sri Lankan|Tamil|Punjabi|Sikh|Hindu|"
       r"Muslim|Islamic|Jewish|Christian|Catholic|Black|African|Caribbean|Hellenic|Greek|Persian|Iranian|Arab|Filipino|"
       r"Japanese|Afghan|Somali|Nigerian|Ghanaian|Ethiopian|Eritrean|Jamaican|Haitian|Latin American|Latinx|Hispanic|"
       r"South Asian|East Asian|Asian|Hong Kong|Cantonese|Malaysian|Singaporean|Indonesian|Thai|Turkish|Lebanese|Egyptian|"
       r"Armenian|Polish|Russian|Italian|Portuguese|Brazilian|Mexican|Nepali|Gujarati|Telugu|Malayalee|Bengali|Kurdish")
SCH = r"(?:Queen's|Queen’s|Western|UW|UofT|U of T|University of Waterloo|University of Toronto|McMaster|Waterloo|Ivey|York|TMU|Laurier)"
GROUP = re.compile(
    r"(?:\b" + SCH + r"\s+)?\b(?:" + ETH + r")(?:[- ](?:Canadian|Cultural|Heritage))?\s+"
    r"(?:Students?[’'\u200b]*\s+|Student[’'\u200b]*s\s+)?(?:Association|Club|Society|Union|Council|Alliance|Network|Federation|Fellowship)"
    r"(?:\s+(?:of|at)\s+(?:[A-Z][\w.]*)(?:\s+[A-Z][\w.]*){0,2})?(?:\s*\([A-Z]{2,7}\))?", re.I)
SUBS = [
    (re.compile(r"\bBlack Youth Mentor", re.I), "Youth Mentor"),
    (re.compile(r"\b(?:The\s+)?Association of [A-Z][a-z]+-Canadian Scientists (?:&|and) Engineers\b(?:\s*\([A-Z]+\))?"), "a professional association of scientists and engineers"),
    (re.compile(r"\b(?:" + ETH + r")-Canadian\b"), "Canadian"),
    (re.compile(r"\b(?:Western\s+)?MSA\s+Hack(?:athon|s)?(?:[- ]\d+)?\b", re.I), "a student-club hackathon"),
    (re.compile(r"\bMSA\s+Mentorship\s+Program\b", re.I), "a student-club mentorship program"),
    (re.compile(r"\bCAISA\s+Fashion\s+Show\b", re.I), "a student-club fashion show"),
    (re.compile(r"\bCAISA\b"), "a cultural student association"),
    (re.compile(r"\b(?:CSA\s+Western|Western\s+CSA)\b"), "a cultural student association"),
    (re.compile(r"\bcsa-whos-who: CSA executive team flashcards"), "a club's executive team flashcards"),
    (re.compile(r"Western AI, CSA and Interlink"), "Western AI, a cultural student association and Interlink"),
    (re.compile(r"\b(?:UW\s+)?KSA\b"), "a cultural student association"),
    (re.compile(r"\b(?:Canada\s+)?Traditional\s+Chinese\s+Culture\s+Institute\b", re.I), "a cultural institute"),
    (re.compile(r"\bSingapore\s+Indian\s+Development\s+Association\s*(?:\(SINDA\))?", re.I), "a community development association"),
    (re.compile(r"\bSINDA\b"), "a community association"),
    (re.compile(r"(?:highest honours presented by a community association upon|presented by a community association to)\s+\w+\s+students", re.I), "a community academic award"),
    (re.compile(r"\b(?:" + ETH + r")\s+(?:culture|heritage|traditions?)\b"), "cultural heritage"),
    (re.compile(r"\b(?:" + ETH + r")\s+community\b"), "the community"),
    (re.compile(r"\b(?:Ivey|Western|UW|Queen's)\s+Pride(?:\s+Club)?\b|\bPride\s+(?:Club|Society|Network)\b"), "a student club"),
    (re.compile(r"\bLGBT\+?\s*VC\b"), "a VC fellowship"),
]
SUBS.append((re.compile(r"(?:^|(?<=[.;] ))(?:(?![.;] )[^|\n])*?\b(?:RocketReach|ZoomInfo|SignalHire|ContactOut|Lusha|Apollo\.io)\b[^|\n]*?(?:(?<!e\.g)(?<!i\.e)[.;](?=\s+[A-Z(]|\s*$)|$)", re.I), "A data-broker result was ignored."))
POL = re.compile(r"\b(?:Liberal|Conservative|New Democratic|Green)\s+Party\b|\bParti\s+Lib[ée]ral\b|\bNDP\b|\bcampaign volunteer\b", re.I)
DROP = re.compile(r"theorg\.com", re.I)
EMAIL = re.compile(r"(?<![\w/])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b")
POSTAL = re.compile(r"\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d\b")
FSA = {'V5C': 'Burnaby, BC', 'L5M': 'Mississauga, ON', 'N6B': 'London, ON', 'N6G': 'London, ON', 'L4C': 'Richmond Hill, ON',
       'L4B': 'Richmond Hill, ON', 'N9E': 'Windsor, ON', 'L1X': 'Pickering, ON', 'M3B': 'Toronto, ON', 'M2J': 'Toronto, ON',
       'L9N': 'East Gwillimbury, ON', 'N2T': 'Waterloo, ON'}
KEEP = {'Email'}  # the Slack workspace export's own email column

SENSITIVE = re.compile(r'\b(church|mosque|masjid|temple|gurdwara|synagogue|parish|ministry|bible|quran|islamic|muslim|christian|catholic|jewish|hindu|sikh|faith|religio\w*|prayer|cancer|hospice|therapy patient|diagnos\w*|my (mom|dad|mother|father|sister|brother|son|daughter|wife|husband)|pregnan\w*|funeral)\b', re.I)

def _bad(s): return bool(POL.search(s) or DROP.search(s))


def unsafe(s):
    """Never say it: party politics, data brokers, or religion/health/family."""
    return bool(_bad(s) or SENSITIVE.search(s))
def scrub(s):
    if not isinstance(s, str) or not s: return s
    if ' | ' in s:
        s = ' | '.join(x for x in s.split(' | ') if not _bad(x))
    s = GROUP.sub("a cultural student association", s)
    for p, r in SUBS: s = p.sub(r, s)
    s = EMAIL.sub("[email omitted]", s)
    s = re.sub(r"(?:\s*A data-broker result was ignored\.)+", " A data-broker result was ignored.", s)
    s = re.sub(r"^\s+", "", s)
    s = re.sub(r"^\s*\[email omitted\]\s*[·|,;:-]?\s*", "", s)
    s = POSTAL.sub(lambda m: FSA.get(m.group(0)[:3], ''), s).strip()
    return s
def scrub_row(row): return {k: (v if k in KEEP else scrub(v)) for k, v in row.items()}
def clean(v):
    """Walk JSON: drop list items about party politics or TheOrg, scrub every string."""
    if isinstance(v, str): return scrub(v)
    if isinstance(v, list):
        return [clean(x) for x in v if not _bad(x if isinstance(x, str) else __import__('json').dumps(x, ensure_ascii=False))]
    if isinstance(v, dict): return {k: clean(x) for k, x in v.items()}
    return v
