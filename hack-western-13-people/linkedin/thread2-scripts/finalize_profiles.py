import json,glob,os,re
D='/Users/prag/Documents/PragPersonal/Projects/at-Western/outputs/hack-western-13-slack'; os.chdir(D)
OUT='linkedin/enrich/results/zz-zz-thread2-final-chunk.json'
base={}
for f in sorted(glob.glob('linkedin/results/*chunk-*.json')):
    for x in json.load(open(f)): base[x['id']]=x
ov=json.load(open('linkedin/overrides.json'))
def conf(i): return ((ov.get(i) or base.get(i) or {}).get('confidence') or 'none').lower()
def load(f):
    try: d=json.load(open(f)); return d if isinstance(d,list) else d.get('results',[])
    except Exception: return []
# lowest priority first; later sources win on scalars
efiles=[f for f in sorted(glob.glob('linkedin/enrich/results/*chunk*.json')) if f!=OUT]
research=['hackwestern-site/agent/research-none-results.json','hackwestern-site/agent/research-low-results.json','hackwestern-site/agent/thread2-combined-results.json']
deep=sorted(glob.glob('hackwestern-site/agent/thread2-deepen-*.json'))
order=[f for f in efiles if 'zz-research' in f]+research+[f for f in efiles if 'zz-research' not in f]+deep
SC=['name','personal_site','github','devpost','school_program','grad_year','current_role','confidence_notes']
LS=['other_professional_links','past_roles','projects','hackathon_wins','awards','clubs_leadership','skills_interests','talking_points','sources']
CAP={'talking_points':8}
rows={}
for f in order:
    for p in load(f):
        i=p.get('id','')
        if not i or i.startswith('tf:'): continue
        if f in research and (p.get('confidence') or 'none').lower()!=conf(i) and 'combined' not in f: continue
        rows.setdefault(i,[]).append((f,p))
def has(v): return bool(v.get('url')) if isinstance(v,dict) else bool(v)
def key(x,k=''):
    # projects/awards dedupe by name (several can share one site URL); links dedupe by URL
    if isinstance(x,dict):
        x=(x.get('name') or x.get('title') or x.get('url')) if k!='other_professional_links' else (x.get('url') or x.get('name'))
        x=x or ''
    return re.sub(r'[^a-z0-9]','',str(x).lower().replace('https','').replace('http','').replace('www',''))[:80]
out=[]
for i,rs in rows.items():
    c=conf(i)
    if c in ('high','medium'):
        use=[(f,p) for f,p in rs if f not in research or (p.get('confidence') or 'none').lower() in ('high','medium')]
        indep=False
    else:
        use=[(f,p) for f,p in rs if ('thread2-combined' in f or f in deep) and (f not in deep or (p.get('confidence') or 'none').lower() not in ('high','medium')) and p.get('links_confidence') in ('high','medium') and any(has(p.get(k)) for k in ('github','devpost','personal_site'))]
        indep=True
    if not use or (len(use)<2 and not indep): continue
    e={'id':i,'status':'done'}
    for f,p in use:
        for k in SC:
            if has(p.get(k)): e[k]=p[k]
    for k in LS:
        seen=set(); acc=[]
        for f,p in reversed(use):
            for x in p.get(k) or []:
                kk=key(x,k)
                if kk and kk not in seen: seen.add(kk); acc.append(x)
        e[k]=acc[:CAP[k]] if k in CAP else acc
    for k in SC: e.setdefault(k,'')
    e['merged_from']=[os.path.basename(f) for f,p in use]
    if indep: e['independent']=True; e['links_confidence']=[p.get('links_confidence') for f,p in use][-1]
    out.append(e)

# verifier fixes: drop personal X account, data-broker mentions, flag inferred surname
DROP_LINKS={'x.com/chardxbt'}
for e in out:
    e['other_professional_links']=[x for x in e.get('other_professional_links') or [] if not any(d in json.dumps(x).lower() for d in DROP_LINKS)]
    n=e.get('confidence_notes') or ''
    if isinstance(n,str) and re.search(r'signalhire|rocketreach|zoominfo|contactout',n,re.I):
        e['confidence_notes']=' '.join(x for x in re.split(r'(?<=[.!?])\s+',n) if not re.search(r'signalhire|rocketreach|zoominfo|contactout',x,re.I))
    if e['id']=='U0CHX8NSAVC' and 'Surname UNVERIFIED' not in n:
        e['confidence_notes']=(e.get('confidence_notes') or '')+' Surname UNVERIFIED: Slack name is only annajjj100; "Liu" is inferred from her site and Devpost initials.'
json.dump(out,open(OUT,'w'),indent=1,ensure_ascii=False)
print('final rows',len(out),'independent',sum(1 for e in out if e.get('independent')))

