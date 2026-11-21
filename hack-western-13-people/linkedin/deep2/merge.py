import json,glob,os,sys
os.chdir(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
cur={}
for f in sorted(glob.glob('linkedin/enrich/results/*chunk*.json')):
    if 'deep2' in f: continue
    for p in json.load(open(f)): cur[p['id']]=p
def key(v):
    if isinstance(v,dict): return (v.get('url') or v.get('name') or json.dumps(v,sort_keys=True)).lower().rstrip('/')
    return str(v).strip().lower().rstrip('/')
def ulist(a,b):
    out=[];seen=set()
    for v in (a or [])+(b or []):
        if not v: continue
        k=key(v)
        if k in seen: continue
        seen.add(k); out.append(v)
    return out
def merge(old,new):
    m=dict(old)
    if new.get('added_this_pass') or not old:
        # Agent rewrote the full record (including corrections/removals): its fields win.
        for k,v in new.items():
            if v is None: continue
            m[k]=v
        m['status']='done'
        m['merged_from']=ulist(old.get('merged_from'),['deep2'])
        return norm(m)
    for k,v in new.items():
        if isinstance(v,list) or isinstance(old.get(k),list):
            if k=='added_this_pass': m[k]=v; continue
            m[k]=ulist(old.get(k) if isinstance(old.get(k),list) else [], v if isinstance(v,list) else [])
        elif isinstance(v,dict):
            m[k]=v if v.get('url') else old.get(k,v)
        elif v not in (None,''):
            m[k]=v
    m['status']='done'
    m['merged_from']=ulist(old.get('merged_from'),['deep2'])
    return norm(m)
SCALARS=('current_role','school_program','grad_year','name','location_city','headline','summary')
def norm(m):
    for k in SCALARS:
        v=m.get(k)
        if isinstance(v,list) and v and all(isinstance(x,str) and len(x)<=1 for x in v): m[k]=''.join(v)
        elif isinstance(v,list): m[k]=', '.join(str(x.get('name') or x.get('title') or json.dumps(x)) if isinstance(x,dict) else str(x) for x in v if x)
        elif isinstance(v,dict): m[k]=str(v.get('name') or v.get('title') or json.dumps(v))
    return m
stats=[]
for f in sorted(glob.glob('linkedin/deep2/results-*.json'))+sorted(glob.glob('linkedin/deep2/rematch-profiles-*.json')):
    try: d=json.load(open(f))
    except Exception as ex: print('BAD',f,ex); continue
    out=[];added=0
    for p in d:
        if not p.get('id'): continue
        old=cur.get(p['id'],{})
        if p.get('added_this_pass'): added+=1
        out.append(merge(old,p))
    tag=os.path.basename(f).replace('.json','').replace('results-','').replace('rematch-profiles-','rm-')
    if tag.startswith('fix'): tag='zfix'+tag[3:]  # corrections load after every other deep2 chunk
    json.dump(out,open('linkedin/enrich/results/zz-zz-zz-deep2-chunk-%s.json'%tag,'w'),indent=1,ensure_ascii=False)
    stats.append((os.path.basename(f),len(out),added))
print(stats)

