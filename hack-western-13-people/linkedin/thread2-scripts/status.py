import csv,json,glob,os,sys
D='/Users/prag/Documents/PragPersonal/Projects/at-Western/outputs/hack-western-13-slack'
os.chdir(D)
rows=list(csv.DictReader(open('hack-western-13-slack-members.csv')))
li={}
for f in sorted(glob.glob('linkedin/results/*chunk-*.json')):
    for x in json.load(open(f)): li[x['id']]=x
ov=json.load(open('linkedin/overrides.json'))
for k,v in ov.items(): li.setdefault(k,{'id':k}).update(v)
fe=json.load(open('linkedin/fetched.json'))
fb=json.load(open('linkedin/fallback-photos.json')) if os.path.exists('linkedin/fallback-photos.json') else {}
en={}
for f in sorted(glob.glob('linkedin/enrich/results/*chunk*.json')):
    for x in json.load(open(f)): en[x['id']]=x
def ok(p): return bool(p) and os.path.exists(p) and os.path.getsize(p)>500
def slug(u): return (u or '').strip().rstrip('/').split('/in/')[-1].lower()
KEYS=['personal_site','github','devpost','other_professional_links','school_program','grad_year','current_role','past_roles','projects','hackathon_wins','awards','clubs_leadership','skills_interests','talking_points']
def filled(p): return sum(1 for k in KEYS if p.get(k) and (not isinstance(p.get(k),dict) or p[k].get('url')))
out={'conf':{},'fetch_todo':[],'fetch_blocked':[],'nophoto_page':[],'no_enrich':[],'low':[],'none':[],'none_firstonly':[],'thin':[],'li_photo':0,'fallback':0,'slack_photo':0,'no_photo_any':0,'enriched':0}
for r in rows:
    i=r['Slack user ID']; x=li.get(i,{}); c=(x.get('confidence') or 'none').lower(); u=x.get('linkedin_url') or ''
    out['conf'][c]=out['conf'].get(c,0)+1
    hm=c in ('high','medium') and u
    f=fe.get(i); fok=f and f.get('status')=='ok' and slug(f.get('url'))==slug(u)
    lp=hm and fok and ok(f.get('linkedin_photo'))
    rec={'id':i,'name':r['Name'],'role':r['Role'],'email':r['Email'],'org':r['Organization / school'],'conf':c,'linkedin_url':u}
    if hm:
        if not f or slug(f.get('url'))!=slug(u): out['fetch_todo'].append(rec)
        elif f.get('status')!='ok': out['fetch_blocked'].append(rec)
        elif not ok(f.get('linkedin_photo')): out['nophoto_page'].append(rec)
        if i not in en: out['no_enrich'].append(rec)
        elif filled(en[i])<5: out['thin'].append(dict(rec,filled=filled(en[i])))
    if c=='low': out['low'].append(rec)
    if c=='none':
        out['none'].append(rec)
        if len(r['Name'].split())<2: out['none_firstonly'].append(rec)
    if i in en: out['enriched']+=1
    if lp: out['li_photo']+=1
    fbp=fb.get(i,{}).get('file')
    if fbp and ok(fbp): out['fallback']+=1
    if r['Photo file']: out['slack_photo']+=1
    if not lp and not (fbp and ok(fbp)) and not r['Photo file']: out['no_photo_any']+=1
json.dump(out,open('/tmp/hw13t2/status.json','w'),indent=1)
print({k:(len(v) if isinstance(v,list) else v) for k,v in out.items()})

