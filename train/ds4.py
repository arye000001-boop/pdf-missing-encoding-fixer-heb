import sys,pickle,unicodedata; sys.path.insert(0,'/tmp/proto'); sys.path.insert(0,'/tmp')
from ds2 import *
import fix3
def truth_all(ch,pr,short):
    """verified truth string for one code (mupdf char ch) in a source font"""
    if ch is None: return None
    if pr and pr[0]=='torah':
        return fix3.TORAH_LET.get(ch) or fix3.TORAH_MARK.get(ch)
    if pr and pr[0]=='garbled':
        if ch in fix3.CTRL: return 'נ'
        if ch.isascii() and ch.isalpha() and ch in fix3.HAD_SPECIAL: return fix3.HAD_SPECIAL[ch]
        if ord(ch)>127 and not ('\u05d0'<=ch<='\u05ea'): return fix3.dec1(ch,pr[1])
        return ch
    return ch
OK=lambda t: t and all(('\u05b0'<=c<='\u05c7') or ('\u05d0'<=c<='\u05ea') or c in '.,:;!?()[]-־׳״\'"/%0123456789׃–—' for c in t)
def collect_src(path,fixed=False):
    doc=fitz.open(path); prof={} if fixed else profile_fonts(doc); out=[]; fonts={}
    for p in doc:
        for f in p.get_fonts(full=True): fonts[f[0]]=f[3]
    for xref,name in fonts.items():
        short=name.split('+')[-1]
        try: pr=probe2(doc,xref)
        except Exception: continue
        for c,(b,m,u) in pr.items():
            t=truth_all(u,prof.get(short),short)
            if t and OK(t): out.append((short+'#'+str(xref),unicodedata.normalize('NFC',t),b,m))
    return out
if __name__=='__main__':
    which=sys.argv[1]
    P={'ber':('/mnt/user-data/uploads/ברכות.pdf',False),'dy':('/mnt/user-data/uploads/דוגמא_מתוך_הספר_החדש___דרך_ישרה___-_פורים.pdf',False),
       '247':('/tmp/cmp/new_247_-_גליון_רמז_-_תשרי_חשון_תשפ_ז.pdf',True),'248':('/tmp/cmp/new_248_-_גליון_רמח_-_כסלו_טבת_תשפ_ז.pdf',True)}
    d=collect_src(*P[which]); pickle.dump(d,open(f'/tmp/proto/full_{which}.pkl','wb')); print(which,len(d))
