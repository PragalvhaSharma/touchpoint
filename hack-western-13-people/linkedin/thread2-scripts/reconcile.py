import json,glob,os,sys
D='/Users/prag/Documents/PragPersonal/Projects/at-Western/outputs/hack-western-13-slack'; os.chdir(D)
rank={'none':0,'low':1,'medium':2,'high':3}
files=sorted(glob.glob('hackwestern-site/agent/thread2-*-results.json'))
files=[f for f in files if 'combined' not in f and 'fixes' not in f]
# verifier fixes are the final word: applied last, may downgrade
FIXF='hackwestern-site/agent/thread2-fixes-results.json'
FIX={p['id']:p for p in (json.load(open(FIXF)) if os.path.exists(FIXF) else [])}
base={}
for f in sorted(glob.glob('linkedin/results/*chunk-*.json')):
    for x in json.load(open(f)): base[x['id']]=x
OV=json.load(open('linkedin/overrides.json'))
def curstate(i):
    o=OV.get(i,{}); b=base.get(i,{})
    return (o.get('confidence') or b.get('confidence') or 'none'), ((o['linkedin_url'] if 'linkedin_url' in o else b.get('linkedin_url')) or '')
kept=[]
by={}
GIN={x['id']:x for x in json.load(open('/tmp/hw13t2/github-pass.json'))}
def stale(f,p):
    if 'github' not in f: return False
    g=GIN.get(p.get('id'),{})
    return 'unchanged' in str(p.get('confidence_notes','')).lower() or ((p.get('confidence') or 'none').lower()==g.get('current_confidence') and slug(p.get('linkedin_url'))==slug(g.get('current_linkedin_url')))
for f in files:
    try: d=json.load(open(f))
    except Exception as e: print('BAD',f,e); continue
    for p in (d if isinstance(d,list) else d.get('results',[])):
        if p.get('id'): by.setdefault(p['id'],[]).append((f,p))
LISTS=['other_professional_links','past_roles','projects','hackathon_wins','awards','clubs_leadership','skills_interests','talking_points','sources','candidates']
def lk(o): return (o or {}).get('url','') if isinstance(o,dict) else (o or '')
def slug(u): return (u or '').strip().rstrip('/').split('/in/')[-1].lower()
out=[];links=[];flags=[]
for i,ps in by.items():
    vote=[p for f,p in ps if not stale(f,p)]
    allstale=not vote
    if allstale: vote=[dict(ps[0][1])]
    vote.sort(key=lambda p:-rank.get((p.get('confidence') or 'none').lower(),0))
    best=dict(vote[0]); c=(best.get('confidence') or 'none').lower()
    oc,ou=curstate(i)
    if allstale or (rank.get(oc,0)>=rank.get(c,0) and not (c==oc and best.get('linkedin_url'))):
        if rank.get(oc,0)>rank.get(c,0): kept.append(i)
        best['confidence']=oc; best['linkedin_url']=ou; best['evidence']=OV.get(i,{}).get('evidence') or base.get(i,{}).get('evidence','')
    hm={slug(p.get('linkedin_url')) for p in vote if (p.get('confidence') or '').lower() in ('high','medium') and p.get('linkedin_url')}
    if c==oc and oc in ('high','medium') and ou and slug(best.get('linkedin_url'))!=slug(ou):
        # same confidence, different URL: keep the current URL and record the other as a candidate
        flags.append(i+' url-kept'); best['candidates']=(best.get('candidates') or [])+[best.get('linkedin_url')]
        best['linkedin_url']=ou; best['evidence']=OV.get(i,{}).get('evidence') or best.get('evidence','')
    if len(hm)>1 and not (oc in ('high','medium') and slug(ou) in hm):
        best['confidence']='low'; best['evidence']='UNVERIFIED: agents disagreed on the LinkedIn: '+' vs '.join(p.get('linkedin_url','') for p in vote if p.get('linkedin_url'))
        flags.append(i)
    if i in FIX:
        fx=FIX[i]; best['confidence']=fx['confidence']; best['linkedin_url']=fx.get('linkedin_url',''); best['evidence']=fx.get('evidence','')
    fc=(best.get('confidence') or 'none').lower()
    # people without a high/medium LinkedIn only take details from rows that did not rely on a LinkedIn match
    src=[(f,p) for f,p in ps if fc in ('high','medium') or (p.get('confidence') or 'none').lower() not in ('high','medium')]
    if fc not in ('high','medium'):
        for k in ('school_program','grad_year','current_role','headline','education','location'): best[k]=''
        for k in LISTS: best[k]=[]
        for k in ('personal_site','github','devpost'): best[k]=None
        best['confidence_notes']=''
        if src: best['name']=src[-1][1].get('name') or best.get('name')
        for f,p in src:
            if p.get('confidence_notes'): best['confidence_notes']=p['confidence_notes']
    for p in [p for f,p in src]:
        for k in ('personal_site','github','devpost'):
            if not lk(best.get(k)) and lk(p.get(k)): best[k]=p[k]
        for k in ('school_program','grad_year','current_role','headline','education','location','name'):
            if not best.get(k) and p.get(k): best[k]=p[k]
        for k in LISTS:
            cur=best.get(k) or []; seen={json.dumps(x,sort_keys=True) for x in cur}
            for x in p.get(k) or []:
                if json.dumps(x,sort_keys=True) not in seen: cur.append(x); seen.add(json.dumps(x,sort_keys=True))
            best[k]=cur
    lc=max((p.get('links_confidence') or 'none' for f,p in src), key=lambda v:rank.get(v,0)) if src else 'none'
    if i in FIX and FIX[i].get('links_confidence'): lc=FIX[i]['links_confidence']
    if i in FIX and FIX[i].get('notes'): best['confidence_notes']=(best.get('confidence_notes') or '')+' '+FIX[i]['notes']
    best['links_confidence']=lc
    best['evidence']=best.get('evidence') or best.get('confidence_notes','')
    if len(ps)>1: best['confidence_notes']=(best.get('confidence_notes') or '')+' [combined from '+', '.join(os.path.basename(f) for f,p in ps)+']'
    out.append(best)
    if (best.get('confidence') or 'none').lower() not in ('high','medium') and lc in ('high','medium') and any(lk(best.get(k)) for k in ('github','devpost','personal_site')):
        e={k:best.get(k) for k in ['id','name','personal_site','github','devpost','other_professional_links','school_program','grad_year','current_role','past_roles','projects','hackathon_wins','awards','clubs_leadership','skills_interests','talking_points','sources','confidence_notes','links_confidence']}
        e['status']='done'; e['independent']=True; links.append(e)
json.dump(out,open('hackwestern-site/agent/thread2-combined-results.json','w'),indent=1,ensure_ascii=False)
print('kept current (no downgrade)',len(kept));print('files',len(files),'people',len(out),'link-only profiles',len(links),'conflicts',flags)

