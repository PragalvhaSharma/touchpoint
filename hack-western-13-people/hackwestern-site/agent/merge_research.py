
import json, glob, os, sys
D='/Users/prag/Documents/PragPersonal/Projects/at-Western/outputs/hack-western-13-slack'
os.chdir(D)
rank={'none':0,'low':1,'medium':2,'high':3}
base={}
for f in sorted(glob.glob('linkedin/results/*chunk-*.json')):
    d=json.load(open(f)); d=d if isinstance(d,list) else d.get('results',[])
    for p in d: base[p['id']]=p
ov=json.load(open('linkedin/overrides.json'))
def cur(i):
    o=ov.get(i,{}); b=base.get(i,{})  # overrides may hold only evidence/location: fall back field by field
    return (o.get('confidence') or b.get('confidence') or 'none'), (o['linkedin_url'] if 'linkedin_url' in o else b.get('linkedin_url'))
prof_keys=['personal_site','github','devpost','other_professional_links','school_program','grad_year','current_role','past_roles','projects','hackathon_wins','awards','clubs_leadership','skills_interests','talking_points','sources','confidence_notes']
files=sys.argv[1:]
enrich=[]; log=[]
for f in files:
    if not os.path.exists(f): print('missing',f); continue
    d=json.load(open(f)); d=d if isinstance(d,list) else d.get('results',[])
    for p in d:
        i=p.get('id','')
        if not i or i.startswith('tf:'): continue
        c=(p.get('confidence') or 'none').lower(); u=p.get('linkedin_url') or ''
        oc,ou=cur(i)
        site_locked = i in ov and 'Hack Western' in ov[i].get('evidence','') and ov[i].get('confidence') in ('high','medium')
        if site_locked and rank[c]<rank.get(oc,0):
            log.append(f'KEEP {p.get("name")} {oc} (site-backed; research said {c})'); continue
        if c!=oc or (u and u!=ou):
            ev=p.get('evidence') or p.get('confidence_notes') or ''
            if isinstance(ev,list): ev=' '.join(map(str,ev))
            ov[i]={'confidence':c,'linkedin_url':u if c!='none' else '','evidence':f'{ev} (was {oc})'.strip()}
            log.append(f'{p.get("name")}: {oc} -> {c} {u}')
        if c in ('high','medium') and any(p.get(k) for k in ('current_role','school_program','projects','github')):
            e={'id':i,'name':p.get('name'),'status':'done'}
            for k in prof_keys: e[k]=p.get(k, [] if k in ('other_professional_links','past_roles','projects','hackathon_wins','awards','clubs_leadership','skills_interests','talking_points','sources') else '')
            enrich.append(e)
json.dump(ov,open('linkedin/overrides.json','w'),indent=1,ensure_ascii=False)
out='linkedin/enrich/results/zz-research-chunk.json'
prev=json.load(open(out)) if os.path.exists(out) else []
m={e['id']:e for e in prev}; m.update({e['id']:e for e in enrich})
json.dump(list(m.values()),open(out,'w'),indent=1,ensure_ascii=False)
print('\n'.join(log)); print('enrich rows', len(m))

