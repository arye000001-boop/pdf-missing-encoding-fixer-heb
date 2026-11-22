"""Train the glyph-shape model (Hebrew letters + composites + marks + punctuation + Latin letters/digits).
usage: python3 train_model.py [--holdout PATTERN] [--out model.json]"""
import sys,glob,pickle,json,base64,re,collections,numpy as np
sys.path.insert(0,'/tmp/proto')
import glyphs
from glyphs import feat,FS,S,CELL,BASE
from PIL import Image,ImageDraw,ImageFont
HEB="אבגדהוזחטיכלמנסעפצקרשתךםןףץ"
LAT="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
W=np.array([2,3,3,2]); fx=lambda b,m:np.concatenate([b,m[:4]*W])
def font_files():
    fs=sorted(glob.glob('/tmp/ref/*.ttf'))
    for pat in ('/usr/share/fonts/truetype/dejavu/DejaVuSans*.ttf','/usr/share/fonts/truetype/freefont/*.ttf','/usr/share/fonts/truetype/liberation/*.ttf'):
        fs+=sorted(glob.glob(pat))
    return fs
def has_hebrew(font):
    try:
        im=Image.new('L',(120,120),0); ImageDraw.Draw(im).text((10,90),'ש',font=font,fill=255,anchor='ls'); a=np.array(im)
        im2=Image.new('L',(120,120),0); ImageDraw.Draw(im2).text((10,90),'\u05ea\u05ea',font=font,fill=255,anchor='ls')
        return a.sum()>0 and not np.array_equal(a,np.array(Image.new('L',(120,120),0)))
    except Exception: return False
def render(fp,chars,variation=None):
    font=ImageFont.truetype(fp,int(FS*S))
    if variation:
        try: font.set_variation_by_name(variation)
        except Exception: pass
    # reject fonts lacking the glyph: .notdef box identical for different chars
    out=[]
    sigs=collections.Counter()
    ims=[]
    for ch in chars:
        im=Image.new('L',(int(CELL*S),int(CELL*S)),0); ImageDraw.Draw(im).text((8*S,BASE*S),ch,font=font,fill=255,anchor='ls')
        a=np.array(im); ims.append((ch,a)); sigs[a.tobytes()]+=1
    for ch,a in ims:
        if sigs[a.tobytes()]>2: continue          # .notdef repeated -> font has no such glyph
        f=feat(a,FS*S)
        if f: out.append((ch,fx(*f)))
    return out
MARKS=[chr(c) for c in list(range(0x05b0,0x05be))+[0x05bf,0x05c1,0x05c2,0x05c7]]
def render_marks(fp,variation=None):
    """isolated nikud marks = (base letter + mark) minus (base letter), drawn on three base letters, baseline-relative."""
    out=[]
    try:
        font=ImageFont.truetype(fp,int(FS*S))
        if variation:
            try: font.set_variation_by_name(variation)
            except Exception: pass
    except Exception: return out
    def draw(t):
        im=Image.new('L',(int(CELL*S),int(CELL*S)),0); ImageDraw.Draw(im).text((8*S,BASE*S),t,font=font,fill=255,anchor='ls'); return np.array(im).astype(np.int16)
    for base in ('ב','ל','ד'):
        b0=draw(base)
        if b0.sum()==0: continue
        for m in MARKS:
            d=np.clip(draw(base+m)-b0,0,255).astype(np.uint8)
            if (d>100).sum()<10: continue
            f=feat(d,FS*S)
            if f: out.append((m,fx(*f)))
    return out
def build_refs(exclude=None):
    X=[];y=[];fam=[]
    for fp in font_files():
        if exclude and re.search(exclude,fp): continue
        vars_=[None]
        if any(k in fp for k in ('Heebo','Frank','Noto','Roboto','Lora','OpenSans','Assistant','Rubik')): vars_=['Regular','Bold']
        for v in vars_:
            for chars in (HEB,LAT):
                for ch,vec in render(fp,chars,v): X.append(vec);y.append(ch);fam.append(fp)
            for ch,vec in render_marks(fp,v): X.append(vec);y.append(ch);fam.append(fp)
    return np.array(X),np.array(y),fam
def book_data():
    data=[]
    for w in ('ber','dy','247','248'): data+=pickle.load(open(f'/tmp/proto/full_{w}.pkl','rb'))
    X=[];y=[];seen=set()
    for n,t,b,m in data:
        v=fx(b,m); key=(t,tuple(np.round(v[:400]*8).astype(int)))
        if key in seen: continue
        seen.add(key);X.append(v);y.append(t)
    return np.array(X),np.array(y)
if __name__=='__main__':
    hold=None
    if '--holdout' in sys.argv: hold=sys.argv[sys.argv.index('--holdout')+1]
    Xb,yb=book_data(); Xr,yr,_=build_refs(hold)
    X=np.vstack([Xb,Xr]);y=np.concatenate([yb,yr]); print('train',len(X),'classes',len(set(y)))
    from sklearn.svm import SVC
    clf=SVC(C=10,gamma='scale',decision_function_shape='ovo').fit(X,y)
    if hold:
        Xh=[];yh=[]
        for fp in font_files():
            if re.search(hold,fp):
                for chars in (HEB,LAT):
                    for ch,vec in render(fp,chars,None): Xh.append(vec);yh.append(ch)
        Xh=np.array(Xh);yh=np.array(yh); p=clf.predict(Xh)
        isH=np.array([c in HEB for c in yh])
        print('heldout glyphs',len(yh),'| Hebrew exact-class acc',round((p==yh)[isH].mean(),3),'| Latin exact-class acc',round((p==yh)[~isH].mean(),3))
        Xm=[];ym=[]
        for fp in font_files():
            if re.search(hold,fp):
                for ch,vec in render_marks(fp,None): Xm.append(vec);ym.append(ch)
        if Xm:
            pm=clf.predict(np.array(Xm)); print('held-out nikud marks',len(ym),'acc',round(float(np.mean(pm==np.array(ym))),3),'| predicted as a letter:',round(float(np.mean([p in HEB for p in pm])),3))
        print('Latin predicted as Hebrew letter (harmful):',round(np.mean([pp in HEB for pp in p[~isH]]),3),'| Hebrew predicted as Latin:',round(np.mean([pp not in HEB for pp in p[isH]]),3))
    else:
        print('nSV',clf.support_vectors_.shape)
        q=lambda a:base64.b64encode(np.clip(np.round((a+2)/8*255),0,255).astype(np.uint8).tobytes()).decode()
        model=dict(classes=list(clf.classes_),gamma=float(clf._gamma),nSupport=[int(v) for v in clf.n_support_],sv=q(clf.support_vectors_.ravel()),
         dual=[[round(float(v),4) for v in row] for row in clf.dual_coef_],intercept=[round(float(v),4) for v in clf.intercept_],dim=404)
        json.dump(model,open('/tmp/proto/model_latin.json','w'),ensure_ascii=False)
        import os; print('model bytes',os.path.getsize('/tmp/proto/model_latin.json'))
