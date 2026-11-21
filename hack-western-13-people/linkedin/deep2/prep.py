import json,glob,csv,os,re
os.chdir(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
mem={r['Slack user ID']:r for r in csv.DictReader(open('hack-western-13-slack-members.csv'))}
li={x['id']:x for f in sorted(glob.glob('linkedin/results/*chunk-*.json')) for x in json.load(open(f))}
for k,v in json.load(open('linkedin/overrides.json')).items():
    if k in li: li[k].update(v)
cur={}
for f in sorted(glob.glob('linkedin/enrich/results/*chunk*.json')):
    for p in json.load(open(f)): cur[p['id']]=p
FIELDS=['personal_site','github','devpost','school_program','grad_year','current_role','other_professional_links','past_roles','projects','hackathon_wins','awards','clubs_leadership','skills_interests','talking_points']
def score(p):
    return sum(1 for k in FIELDS if p.get(k))+min(len(p.get('projects') or []),4)+min(len(p.get('talking_points') or []),3)
deep=[];rem={'low':[],'none':[]}
for sid,m in mem.items():
    x=li.get(sid,{}); conf=(x.get('confidence') or '').lower()
    base={'id':sid,'slack_name':m['Name'],'role':m['Role'],'email':m.get('Email',''),'org_school':m.get('Organization / school',''),'title':m.get('Title',''),
          'linkedin_url':x.get('linkedin_url',''),'linkedin_confidence':conf or 'none','linkedin_evidence':x.get('evidence',''),
          'linkedin_headline':x.get('headline',''),'linkedin_education':x.get('education',''),'linkedin_location':x.get('location',''),'candidates':x.get('candidates',[])}
    p=cur.get(sid)
    base['current_record']=p or {}
    if conf in('high','medium') or (p and p.get('independent') and (p.get('links_confidence') or '') in('high','medium')):
        base['thin_score']=score(p or {}); deep.append(base)
    if conf not in('high','medium'): rem['low' if conf=='low' else 'none'].append(base)
deep.sort(key=lambda b:b['thin_score'])
print('deep',len(deep),'low',len(rem['low']),'none',len(rem['none']))
print('score dist',[b['thin_score'] for b in deep[::20]])
n=6;wave1=deep[:180];wave2=deep[180:]
for i in range(n): json.dump(wave1[i::n],open('linkedin/deep2/input-%d.json'%(i+1),'w'),indent=1,ensure_ascii=False)
for i in range(n): json.dump(wave2[i::n],open('linkedin/deep2/input-%d.json'%(i+7),'w'),indent=1,ensure_ascii=False)
json.dump(rem['low'],open('linkedin/deep2/rematch-low.json','w'),indent=1,ensure_ascii=False)
json.dump(rem['none'],open('linkedin/deep2/rematch-none.json','w'),indent=1,ensure_ascii=False)
