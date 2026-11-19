import sys,pickle; sys.path.insert(0,'/tmp/proto'); sys.path.insert(0,'/tmp')
from glyphs import *
import glyphs, fix3
from fix3 import *
def probe2(doc,xref):
    """probe all codes; return {code:(bitmap,meta,unicode_char_from_mupdf)}"""
    pg=doc.new_page(width=CELL*16,height=CELL*16)
    doc.xref_set_key(pg.xref,"Resources",f"<</Font<</P {xref} 0 R>>>>")
    ops=[]
    for c in range(256):
        r,k=divmod(c,16)
        ops.append(f"BT /P {FS} Tf 1 0 0 1 {k*CELL+8} {CELL*16-(r*CELL+BASE)} Tm <{c:02X}> Tj ET")
    cx=doc.get_new_xref(); doc.update_object(cx,"<<>>"); doc.update_stream(cx,"\n".join(ops).encode())
    doc.xref_set_key(pg.xref,"Contents",f"{cx} 0 R")
    pix=pg.get_pixmap(dpi=DPI,colorspace=fitz.csGRAY)
    a=255-np.frombuffer(pix.samples,np.uint8).reshape(pix.height,pix.width)
    uni={}
    for b in pg.get_text('rawdict')['blocks']:
        for l in b.get('lines',[]):
            for s in l['spans']:
                for ch in s['chars']:
                    ox,oy=ch['origin']; k=int(round((ox-8)/CELL)); r=int(round((oy-BASE)/CELL))
                    if 0<=k<16 and 0<=r<16: uni[r*16+k]=ch['c']
    out={}; cs=int(CELL*S)
    for c in range(256):
        r,k=divmod(c,16); f=feat(a[r*cs:(r+1)*cs,k*cs:(k+1)*cs],FS*S)
        if f: out[c]=(f[0],f[1],uni.get(c))
    doc.delete_page(pg.number); return out
def truth(ch,pr):
    if ch is None: return None
    if pr and pr[0]=='garbled':
        if ch in CTRL: return 'נ'
        if ch.isascii() and ch.isalpha() and ch in HAD_SPECIAL: return HAD_SPECIAL[ch]
        if ord(ch)>127: return dec1(ch,pr[1])
        return ch
    return ch
def collect(path):
    doc=fitz.open(path); prof=profile_fonts(doc); out=[]; fonts={}
    for p in doc:
        for f in p.get_fonts(full=True): fonts[f[0]]=f[3]
    for xref,name in fonts.items():
        short=name.split('+')[-1]
        try: pr=probe2(doc,xref)
        except Exception: continue
        for c,(b,m,u) in pr.items():
            t=truth(u,prof.get(short))
            if t and len(t)==1 and '\u05d0'<=t<='\u05ea': out.append((short,t,b,m))
    return out
if __name__=='__main__':
    data=collect('/mnt/user-data/uploads/ברכות.pdf')+collect('/mnt/user-data/uploads/דוגמא_מתוך_הספר_החדש___דרך_ישרה___-_פורים.pdf')
    pickle.dump(data,open('/tmp/proto/ds.pkl','wb')); print(len(data),'glyphs from',len({d[0] for d in data}),'fonts')
