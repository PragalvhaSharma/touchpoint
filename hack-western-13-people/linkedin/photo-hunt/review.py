
"""Photo-hunt review: python3 linkedin/photo-hunt/review.py sheet  -> /tmp/hunt-sheet-N.png
   python3 linkedin/photo-hunt/review.py approve ID [ID ...]   (ids as in results; adds to fallback-photos.json as reviewed+manual)"""
import json,glob,os,sys
from PIL import Image,ImageDraw,ImageFont
D=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.chdir(D)
def found():
    out=[]
    for f in sorted(glob.glob('linkedin/photo-hunt/results-*.json')):
        try: d=json.load(open(f))
        except Exception as ex: print('bad json',f,ex); continue
        for x in d:
            if x.get('status')=='found' and x.get('file') and os.path.exists(x['file']): out.append(x)
    return out
if sys.argv[1]=='sheet':
    fb=json.load(open('linkedin/fallback-photos.json'))
    xs=[x for x in found() if x['id'] not in fb]
    try: font=ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc',14)
    except Exception: font=ImageFont.load_default()
    per=20; cols=5; W=220; H=270
    for p in range(0,len(xs),per):
        chunk=xs[p:p+per]; rows=(len(chunk)+cols-1)//cols
        im=Image.new('RGB',(cols*W,rows*H),'white'); dr=ImageDraw.Draw(im)
        for k,x in enumerate(chunk):
            c,r=k%cols,k//cols
            t=Image.open(x['file']).convert('RGB'); t.thumbnail((200,200))
            im.paste(t,(c*W+10,r*H+5))
            dr.text((c*W+10,r*H+210),'%d. %s'%(p+k+1,x['name'][:26]),fill='black',font=font)
            dr.text((c*W+10,r*H+230),(x.get('source') or '')[:28],fill='gray',font=font)
        fn='/tmp/hunt-sheet-%d.png'%(p//per+1); im.save(fn); print(fn,[(p+k+1,x['id'],x['name']) for k,x in enumerate(chunk)])
elif sys.argv[1]=='approve':
    fb=json.load(open('linkedin/fallback-photos.json')); m={x['id']:x for x in found()}
    for i in sys.argv[2:]:
        x=m[i]; fb[i]={'file':x['file'],'source':x.get('source'),'source_url':x.get('source_url',''),'page_url':x.get('page_url',''),'evidence':x.get('evidence',''),'reviewed':True,'manual':True}
        print('approved',i,x['name'])
    json.dump(fb,open('linkedin/fallback-photos.json','w'),indent=1,ensure_ascii=False)

