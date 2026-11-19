import pymupdf as fitz, numpy as np, cv2, glob, os
from PIL import Image, ImageDraw, ImageFont
HEBL="אבגדהוזחטיכלמנסעפצקרשת"+"ךםןףץ"
CELL=70; FS=48; BASE=50; DPI=144; S=DPI/72
def _areamat(src,dst):
    M=np.zeros((dst,src),np.float64); r=src/dst
    for i in range(dst):
        a,b=i*r,(i+1)*r
        for k in range(int(np.floor(a)),min(src,int(np.ceil(b)))):
            M[i,k]=max(0.0,min(b,k+1)-max(a,k))
    return M/M.sum(1,keepdims=True)
_K=np.array([np.exp(-1/(2*0.8**2)),1.0,np.exp(-1/(2*0.8**2))]); _K=_K/_K.sum()
def _blur(a):
    p=np.pad(a,1,mode='reflect')
    t=_K[0]*p[:,:-2]+_K[1]*p[:,1:-1]+_K[2]*p[:,2:]
    return _K[0]*t[:-2,:]+_K[1]*t[1:-1,:]+_K[2]*t[2:,:]
def feat(img, em):
    ys,xs=np.where(img>100)
    if len(xs)<8: return None
    x0,x1,y0,y1=xs.min(),xs.max()+1,ys.min(),ys.max()+1
    crop=img[y0:y1,x0:x1].astype(np.float64)/255
    h,w=crop.shape; side=max(h,w)
    can=np.zeros((side,side)); oy=(side-h)//2; ox=(side-w)//2; can[oy:oy+h,ox:ox+w]=crop
    R=_areamat(side,20); b=_blur(R@can@R.T)
    base=BASE*S
    meta=np.array([w/h,(base-y0)/em,(base-y1)/em,h/em,w/em],np.float32)
    return b.flatten().astype(np.float32),meta
def probe(doc, xref, codes=range(256)):
    """render every single-byte code of a simple font in isolation; returns {code:(bitmap,meta)}"""
    pg=doc.new_page(width=CELL*16,height=CELL*16)
    doc.xref_set_key(pg.xref,"Resources",f"<</Font<</P {xref} 0 R>>>>")
    ops=[]
    for c in codes:
        r,k=divmod(c,16)
        ops.append(f"BT /P {FS} Tf 1 0 0 1 {k*CELL+8} {CELL*16-(r*CELL+BASE)} Tm <{c:02X}> Tj ET")
    cx=doc.get_new_xref(); doc.update_object(cx,"<<>>"); doc.update_stream(cx,"\n".join(ops).encode())
    doc.xref_set_key(pg.xref,"Contents",f"{cx} 0 R")
    pix=pg.get_pixmap(dpi=DPI,colorspace=fitz.csGRAY)
    a=255-np.frombuffer(pix.samples,np.uint8).reshape(pix.height,pix.width)
    out={}
    cs=int(CELL*S)
    for c in codes:
        r,k=divmod(c,16)
        cell=a[r*cs:(r+1)*cs,k*cs:(k+1)*cs]
        f=feat(cell,FS*S)
        if f: out[c]=f
    doc.delete_page(pg.number)
    return out
_REF=None
def refs():
    global _REF
    if _REF: return _REF
    ims=[]; 
    for fp in sorted(glob.glob('/tmp/ref/*.ttf')):
        try: font=ImageFont.truetype(fp,int(FS*S))
        except Exception: continue
        for var in ([b'Regular',b'Bold'] if 'wght' in fp or 'Frank' in fp or 'Heebo' in fp or 'Noto' in fp else [None]):
            try:
                if var: font.set_variation_by_name(var)
            except Exception: pass
            for ch in HEBL:
                im=Image.new('L',(int(CELL*S),int(CELL*S)),0); d=ImageDraw.Draw(im)
                d.text((8*S,BASE*S),ch,font=font,fill=255,anchor='ls')
                f=feat(np.array(im),FS*S)
                if f: ims.append((ch,)+f)
    _REF=ims; return ims
def classify(f, k=1):
    b,m=f; best=[]
    for ch,rb,rm in refs():
        d=np.sum((b-rb)**2)+ 6*np.sum(np.abs(m[:4]-rm[:4])*np.array([1,2,3,1]))
        best.append((d,ch))
    best.sort(); return best[:k]
