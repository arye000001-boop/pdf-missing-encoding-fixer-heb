"""Create CID-font test PDFs (Identity-H TrueType) with a broken or missing ToUnicode, ground truth = original text."""
import pymupdf as fitz, re
TXT=["בְּרֵאשִׁית בָּרָא אֱלֹהִים אֵת הַשָּׁמַיִם וְאֵת הָאָרֶץ","ואת השמים ואת הארץ (דף ג.) 12 ס\"ק א' ב'","קורין את שמע בערבין משעה שהכהנים נכנסים"]
def font_xref(d):
    for x in range(1,d.xref_length()):
        if d.xref_get_key(x,'Subtype')[1]=='/Type0': return x
for name,ff in (('dejavusans','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'),('heebo','Heebo.ttf')):
    d=fitz.open(); p=d.new_page(width=500,height=200)
    for i,t in enumerate(TXT): p.insert_text((20,40+i*30),t,fontname='hf',fontfile=ff,fontsize=14)
    d.save(f'/tmp/cid/{name}_orig.pdf')
    a=fitz.open(f'/tmp/cid/{name}_orig.pdf'); x=font_xref(a); tx=int(re.match(r'(\d+) 0 R',a.xref_get_key(x,'ToUnicode')[1]).group(1))
    s=a.xref_stream(tx).decode('latin1'); a.update_stream(tx,re.sub(r'<([0-9A-Fa-f]{4})>\s*<[0-9A-Fa-f]{4,}>',lambda m:f'<{m.group(1)}> <0041>',s).encode('latin1')); a.save(f'/tmp/cid/{name}_garbage.pdf')
    b=fitz.open(f'/tmp/cid/{name}_orig.pdf'); b.xref_set_key(font_xref(b),'ToUnicode','null'); b.save(f'/tmp/cid/{name}_notounicode.pdf')
