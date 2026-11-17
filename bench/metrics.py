import re,sys,subprocess,collections
H=lambda c:'\u05d0'<=c<='\u05ea'
def ext(pdf,f,l):
    return subprocess.run(['pdftotext','-f',str(f),'-l',str(l),pdf,'-'],capture_output=True,text=True).stdout
def metrics(t):
    t=t.replace('\u202b','').replace('\u202c','').replace('\u202a','').replace('\u200e','').replace('\u200f','')
    n=len(t.replace(' ','').replace('\n',''))
    heb=sum(map(H,t)); nik=len(re.findall('[\u05b0-\u05c7]',t))
    lat=len(re.findall('[A-Za-z]',t))
    odd=len(re.findall('[\u0000-\u0008\u000b\u000c\u000e-\u001f\u0080-\u02ff\ue000-\uf8ff\ufffd]',t))
    words=re.findall(r'[\u05d0-\u05ea\u05b0-\u05c7]+',t)
    long_=sum(1 for w in words if len(re.sub('[\u05b0-\u05c7]','',w))>14)
    badmark=len(re.findall(r'(?:^|[^\u05d0-\u05ea\u05b0-\u05c7])[\u05b0-\u05c7]',t))
    brk=len(re.findall(r'\)[^()\n]{0,40}\(',t))    # ") ... (" = reversed pair
    ok=len(re.findall(r'\([^()\n]{0,40}\)',t))
    return dict(chars=n,heb=heb,nikud=nik,latin=lat,odd=odd,long_words=long_,mark_misplaced=badmark,paren_reversed=brk,paren_ok=ok)
if __name__=='__main__':
    pdf,f,l=sys.argv[1],int(sys.argv[2]),int(sys.argv[3])
    print(metrics(ext(pdf,f,l)))
