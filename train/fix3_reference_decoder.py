#!/usr/bin/env python3
"""
תיקון שכבת טקסט עברית שבורה ב-PDF (אופליין).  גרסה 3
שימוש:  python3 fix_hebrew_pdf.py קלט.pdf [פלט.pdf] [--dpi 200] [--debug]
דורש:  pip install pymupdf
פלט:   פלט.pdf  - עמודים שבורים: תמונת העמוד + שכבת טקסט בלתי נראית מתוקנת (כל מילה בדיוק על מקומה);
                  עמודים תקינים מועתקים כמו שהם.
       פלט.txt  - הטקסט המתוקן, לפי אזורים (טור ימני לפני שמאלי, וכו')
"""
import sys, re, os, collections, unicodedata
import pymupdf as fitz

HEB = lambda c: '\u05d0' <= c <= '\u05ea'
NIK = lambda c: '\u0591' <= c <= '\u05c7'
OKCH = set('\u202a\u202b\u202c\u200e\u200f–—“”„‟•…״׳\u00a0₪')
MIR = str.maketrans('()[]{}<>', ')(][}{><')
CTRL = ''.join(chr(i) for i in range(1, 32))          # תווי בקרה שמייצגים את האות נ (בית 0xF0) בפונטי Hadassah/Vilna

# --- פונט "פסוקי תורה": כל קוד = אות אחת (עם דגש), הניקוד תווים נפרדים הממוקמים על האות ---
TORAH_LET = {'A': 'בּ', 'a': 'ב', 'C': 'דּ', 'c': 'ד', 'd': 'ה', 'e': 'ו', 'E': 'וּ', 'F': 'וֹ', 'g': 'ח', 'h': 'ט',
             'I': 'יּ', 'i': 'י', 'K': 'ךְ', 'L': 'ךָ', 'k': 'כ', 'l': 'ל', 'M': 'כּ', 'm': 'ם', 'n': 'מ', 'o': 'ן',
             'P': 'נּ', 'p': 'נ', 'r': 'ע', 'T': 'קּ', 'W': 'שׁ', 'w': 'ק', 'X': 'שּׁ', 'Y': 'תּ', 'z': 'ת', 'x': 'ר',
             '`': 'א', '\u00f5': 'אַ', '÷': 'לֹ', ':': '׃', 'Z': 'זּ', 'q': 'צ', 's': 'ס', 'u': 'ף', 'f': 'פ', 'b': 'ב',
             'B': 'בּ', 'j': 'ג', 'D': 'דּ', 'G': 'ח', 'H': 'ה', 'J': 'ג', 'N': 'נ', 'O': 'ן', 'Q': 'ץ', 'R': 'ר',
             'S': 'ס', 'U': 'ף', 'V': 'צּ', 'v': 'צ', 't': 'ת'}
TORAH_MARK = {'§': '\u05b0', '¤': '\u05b6', '¥': '\u05b5', '¦': '\u05b4', '©': '\u05b7', '¨': '\u05b8',
              '¡': '\u05b1', '¢': '\u05b3', 'Ÿ': '\u05b9'}      # Ÿ = חולם: ממוקם בשמאל האות (אחרי האות הקודמת ויזואלית)
HOLAM_LEFT = {'Ÿ'}
# --- פונטי Hadassah / Vilna: תווי ASCII בודדים שהם אותיות/ניקוד מיוחדים ---
HAD_SPECIAL = {'B': 'וֹ', 'E': 'ךָ', 'L': 'שׁ', 'N': 'שׂ', 'Z': '—', 'a': 'בּ', 'e': 'וּ', 'f': 'זּ', 'k': 'כּ',
               'l': 'לּ', 'p': 'נּ', 'v': 'צּ', 'z': 'תּ'}


def dec1(c, enc):
    """מפענח תו בודד (בית cp1255 שנקרא בקידוד שגוי)."""
    try:
        return c.encode(enc).decode('cp1255')
    except Exception:
        return None


def score(h):
    if h is None: return -10**9
    return (sum(1 for c in h if HEB(c)) - 3 * sum(1 for c in h if NIK(c))
            - 5 * sum(1 for c in h if ord(c) > 127 and not HEB(c) and not NIK(c)))


def is_garb_char(c):
    return (ord(c) > 127 and not HEB(c) and not NIK(c) and c not in OKCH) or c in CTRL or c in '„‟'


def profile_fonts(doc):
    """מזהה פרופיל לכל פונט: 'torah' / ('garbled', קידוד) / None (תקין)."""
    ftxt = collections.defaultdict(list)
    for p in doc:
        for b in p.get_text('rawdict')['blocks']:
            for l in b.get('lines', []):
                for s in l['spans']:
                    ftxt[s['font']].extend(c['c'] for c in s['chars'] if c['c'] != ' ')
    prof = {}
    for f, cs in ftxt.items():
        if not cs: continue
        heb = sum(1 for c in cs if HEB(c))
        marks = {c for c in cs if c in TORAH_MARK}
        asc = sum(1 for c in cs if c.isascii() and c.isalpha())
        if len(marks) >= 3 and asc >= 0.35 * len(cs) and heb == 0:
            prof[f] = ('torah', None); continue
        g = [c for c in cs if is_garb_char(c)]
        if len(g) >= max(3, heb) and heb < 0.5 * len(cs):
            txt = ''.join(c for c in g if c not in CTRL)
            e = max((score(''.join(dec1(c, enc) or '' for c in txt)), enc) for enc in ('mac_roman', 'cp1252'))[1]
            prof[f] = ('garbled', e)
    return prof


def visual_to_logical(s):
    r = s[::-1].translate(MIR)
    return re.sub(r'[0-9A-Za-z]+', lambda m: m.group(0)[::-1], r)


# ----------------------------------------------------------------------------------------------------------
class Cl:        # אשכול = אות + ניקוד
    __slots__ = ('t', 'x0', 'y0', 'x1', 'y1', 'size', 'by', 'font', 'garb', 'eff')
    def __init__(s, t, bbox, size, by, font, garb):
        s.t = t; s.x0, _y0, s.x1, _y1 = bbox; s.size = size; s.by = by; s.font = font; s.garb = garb; s.eff = size
        # גובה לפי קו הבסיס וגודל האות (ולא לפי תיבת הפונט, שלעיתים גבוהה פי 2) - כדי שהסימון ייצמד לשורה
        s.y0 = by - 0.88 * size; s.y1 = by + 0.27 * size


def decode_page(page, prof):
    """מחזיר רשימת אשכולות (אות+ניקוד) עם גיאומטריה מדויקת, וסימון אם הדף שבור."""
    cls = []; garbled = False; unresolved = 0
    tlets, tmarks = [], []
    for b in page.get_text('rawdict')['blocks']:
        for l in b.get('lines', []):
            for s in l['spans']:
                f = s['font']; pr = prof.get(f); size = s['size']
                chars = s['chars']
                if pr and pr[0] == 'torah':
                    garbled = True
                    for c in chars:
                        ch = c['c']
                        if ch == ' ': continue
                        (tmarks if ch in TORAH_MARK else tlets).append((c, size, f))
                    continue
                # פונט רגיל / שבור-בקידוד: אשכול לכל אות; ניקוד נצמד לאות לפי מיקום
                recs = []
                span_enc = None
                if not pr:
                    st = ''.join(c['c'] for c in chars)
                    if st.strip() and not any(HEB(c) for c in st) and any(0x80 <= ord(c) < 0x3000 and c not in OKCH for c in st):
                        cand = max((score(''.join(dec1(c, e) or '' for c in st)), e) for e in ('mac_roman', 'cp1252'))
                        if cand[0] > 0: span_enc = cand[1]
                for c in chars:
                    ch = c['c']
                    if ch == ' ': continue
                    garb = False
                    if span_enc and ord(ch) > 127 and not HEB(ch):
                        t = dec1(ch, span_enc) or ch; garb = True
                    elif pr and pr[0] == 'garbled':
                        if ch in '³': continue      # קישוט מפריד
                        if ch in CTRL: t = 'נ'; garb = True
                        elif ch.isascii() and ch.isalpha() and ch in HAD_SPECIAL: t = HAD_SPECIAL[ch]; garb = True
                        elif ord(ch) > 127 and not HEB(ch) and not NIK(ch):
                            t = dec1(ch, pr[1]); garb = True
                            if t is None: t = ch; unresolved += 1
                        else: t = ch
                    else:
                        t = ch
                    recs.append((t, c, garb))
                    garbled |= garb
                bases = [(t, c, g) for t, c, g in recs if not (len(t) == 1 and NIK(t))]
                marks = [(t, c, g) for t, c, g in recs if len(t) == 1 and NIK(t)]
                items = [[t, c, g] for t, c, g in bases]
                for t, c, g in marks:
                    mx = (c['bbox'][0] + c['bbox'][2]) / 2
                    best = None; bd = 1e9
                    for it in items:
                        bb = it[1]['bbox']
                        d = 0 if bb[0] - 0.3 <= mx <= bb[2] + 0.3 else min(abs(mx - bb[0]), abs(mx - bb[2]))
                        if d < bd: bd = d; best = it
                    if best is not None and bd < size * 0.9: best[0] += t
                    else: items.append([t, c, g])
                for t, c, g in items:
                    cls.append(Cl(t, c['bbox'], size, c['origin'][1], f, g))
    if tlets:
        tlets.sort(key=lambda t: (round(t[0]['origin'][1], 0), t[0]['origin'][0]))
        items = [[TORAH_LET.get(c['c'], c['c']), c, sz, f] for c, sz, f in tlets]
        unresolved += sum(1 for c, sz, f in tlets if c['c'] not in TORAH_LET)
        for m, msz, mf in tmarks:
            my = m['origin'][1]; mx = m['origin'][0]
            cand = [k for k, it in enumerate(items) if abs(it[1]['origin'][1] - my) < 0.6 and it[1]['origin'][0] <= mx + 0.05]
            if not cand: continue
            k = max(cand, key=lambda k: items[k][1]['origin'][0])
            if m['c'] in HOLAM_LEFT:
                nxt = [q for q, it in enumerate(items) if abs(it[1]['origin'][1] - my) < 0.6 and it[1]['origin'][0] > items[k][1]['origin'][0]]
                if nxt: k = min(nxt, key=lambda q: items[q][1]['origin'][0])
            items[k][0] += TORAH_MARK[m['c']]
        for t, c, sz, f in items:
            cls.append(Cl(t, c['bbox'], sz, c['origin'][1], f, True))
    return cls, garbled, unresolved


def make_lines(cls):
    """אשכולות -> שורות ויזואליות (קטעים רציפים באותו קו בסיס)."""
    cls = sorted(cls, key=lambda c: (round(c.by, 0), c.x0))
    rows = []
    for c in sorted(cls, key=lambda c: c.by):
        for r in rows:
            if abs(r[0].by - c.by) <= 0.35 * min(c.size, r[0].size):
                r.append(c); break
        else: rows.append([c])
    lines = []
    for r in rows:
        r.sort(key=lambda c: c.x0)
        # הערות קטנות בתוך שורה (בגודל אות שונה, קצרות, ומוקפות באותו גודל) אינן עמודה נפרדת
        runs = [[r[0]]]
        for c in r[1:]:
            if abs(c.size - runs[-1][0].size) <= 0.10 * runs[-1][0].size: runs[-1].append(c)
            else: runs.append([c])
        for k in range(1, len(runs) - 1):
            a, m, b = runs[k - 1], runs[k], runs[k + 1]
            if len(m) <= 14 and abs(a[0].size - b[0].size) <= 0.10 * a[0].size:
                for c in m: c.eff = a[0].size
        seg = [r[0]]
        for c in r[1:]:
            p = seg[-1]
            gap = c.x0 - p.x1
            big_size_change = abs(c.eff - p.eff) > 0.10 * min(c.eff, p.eff)
            if gap > 3.2 * max(c.size, p.size) or (big_size_change and gap > 0.3 * min(c.size, p.size)):
                lines.append(seg); seg = [c]
            else: seg.append(c)
        lines.append(seg)
    return lines


def split_gutters(lines):
    """מפצל שורות באותו קו בסיס בין טורים: פער שחוזר באותו מקום אופקי בשורות שכנות = מרווח בין טורים."""
    info = []
    for seg in lines:
        gaps = [(a.x1, b.x0) for a, b in zip(seg, seg[1:]) if b.x0 - a.x1 >= 3.0]
        info.append((min(c.x0 for c in seg), max(c.x1 for c in seg), seg[0].by, max(c.size for c in seg), gaps))
    out = []
    for i, seg in enumerate(lines):
        x0, x1, by, sz, gaps = info[i]
        cuts = []
        for (ga, gb) in gaps:
            near = [info[j] for j in range(len(lines)) if j != i and abs(info[j][2] - by) <= 7 * sz and info[j][0] < gb and info[j][1] > ga]
            if len(near) < 4: continue
            hit = sum(1 for n in near if any(min(gb, hb) - max(ga, ha) >= 1.5 for ha, hb in n[4]))
            if hit >= 4 and hit >= 0.8 * len(near): cuts.append((ga + gb) / 2)
        if not cuts: out.append(seg); continue
        cuts.sort(); cur = []; k = 0
        for c in seg:
            while k < len(cuts) and (c.x0 + c.x1) / 2 > cuts[k]:
                if cur: out.append(cur); cur = []
                k += 1
            cur.append(c)
        if cur: out.append(cur)
    return out


def line_words(seg):
    """מפצל שורה למילים לפי רווחים; כל מילה: (טקסט לוגי, bbox, גודל)."""
    words = []; cur = [seg[0]]
    for c in seg[1:]:
        p = cur[-1]
        if c.x0 - p.x1 > 0.17 * max(c.size, p.size): words.append(cur); cur = [c]
        else: cur.append(c)
    words.append(cur)
    out = []
    for w in words:
        vis = ''.join(c.t for c in w)
        out.append((vis, (min(c.x0 for c in w), min(c.y0 for c in w), max(c.x1 for c in w), max(c.y1 for c in w)),
                    max(c.size for c in w), w))
    return out


def logical_word(w):
    """מילה בסדר ויזואלי (רשימת אשכולות אות+ניקוד) -> טקסט לוגי; ההיפוך לפי אשכולות כדי שהניקוד יישאר אחרי האות."""
    toks = [c.t for c in w]
    full = ''.join(toks)
    if not any(HEB(ch) for ch in full) and full.isascii(): return full
    r = [t.translate(MIR) if len(t) == 1 else t for t in reversed(toks)]
    out = []; i = 0
    isl = lambda t: len(t) == 1 and t.isascii() and t.isalnum()
    while i < len(r):
        if isl(r[i]):
            k = i
            while k < len(r) and isl(r[k]): k += 1
            out += r[i:k][::-1]; i = k
        else: out.append(r[i]); i += 1
    return ''.join(out)


def line_text(words):
    """סדר ימין->שמאל אם יש עברית; אחרת שמאל->ימין."""
    full = ' '.join(t for t, bb, sz, w in words)
    if any(HEB(c) for c in full):
        return ' '.join(logical_word(w) for t, bb, sz, w in reversed(words))
    return full


# ------------------------- סדר קריאה לפי אזורים (בלוקים) --------------------------------------------
def build_blocks(lines):
    """משייך שורות לזרמים (טורים) לפי גודל אות ומיקום אופקי, וקורא כל זרם עד סופו: מימין לשמאל."""
    L = []
    for seg in lines:
        L.append(dict(seg=seg, x0=min(c.x0 for c in seg), x1=max(c.x1 for c in seg),
                      y0=min(c.y0 for c in seg), y1=max(c.y1 for c in seg),
                      size=sum(c.size for c in seg) / len(seg), by=seg[0].by))
    if not L: return []
    X0 = min(l['x0'] for l in L); X1 = max(l['x1'] for l in L); W = max(X1 - X0, 1)
    cen = lambda l: (l['x0'] + l['x1']) / 2
    # 1. שורות רחבות = מחיצות
    wide = sorted([l for l in L if (l['x1'] - l['x0']) >= 0.72 * W], key=lambda l: l['y0'])
    wid = {id(l) for l in wide}
    narrow = [l for l in L if id(l) not in wid]
    # 2. מחלקות גודל
    narrow.sort(key=lambda l: l['size'])
    classes = []
    for l in narrow:
        if classes and l['size'] - classes[-1][0]['size'] <= 0.06 * classes[-1][0]['size']: classes[-1].append(l)
        else: classes.append([l])
    # 3. בתוך כל מחלקה: זרמים לפי מרכז אופקי (פער גדול = טור אחר)
    gapmax = max(30.0, 0.07 * W)
    streams = []
    for cl in classes:
        cs = sorted(cl, key=lambda l: -cen(l)); cur = [cs[0]]
        for l in cs[1:]:
            if cen(cur[-1]) - cen(l) > gapmax: streams.append(cur); cur = [l]
            else: cur.append(l)
        streams.append(cur)
    for st in streams: st.sort(key=lambda l: l['y0'])
    # 4. זרמים גדולים מול צפים (כותרות, מספרי הערות, קישוטים)
    big = [st for st in streams if len(st) >= 4]
    small = [l for st in streams if len(st) < 4 for l in st]
    if not big:
        big = [sorted(L, key=lambda l: (l['y0'], -l['x1']))]; small = []; wide = []
    top = min(l['y0'] for st in big for l in st)
    header = sorted([l for l in small if l['y1'] <= top + 4], key=lambda l: (round(l['y0'] / 10), -l['x1']))
    small = [l for l in small if l['y1'] > top + 4]
    bstat = []
    for st in big:
        bstat.append(dict(lines=list(st), c=sum(cen(l) for l in st) / len(st), x0=min(l['x0'] for l in st), x1=max(l['x1'] for l in st)))
    for l in small:      # צף: מצטרף לזרם הקרוב ביותר אופקית
        best = min(bstat, key=lambda b: 0 if b['x0'] - 3 <= cen(l) <= b['x1'] + 3 and abs(cen(l) - b['c']) < 0.5 * (b['x1'] - b['x0']) + 20 else abs(cen(l) - b['c']) + 1000)
        best['lines'].append(l)
    for b in bstat: b['lines'].sort(key=lambda l: l['y0'])
    # 5. הרכבה: כותרת, ואז לכל קטע בין מחיצות רחבות - הזרמים מימין לשמאל
    ybounds = [w['y0'] for w in wide]
    out = []
    if header: out.append(dict(lines=header))
    nseg = len(ybounds) + 1
    for k in range(nseg):
        segs = []
        for b in sorted(bstat, key=lambda b: -b['c']):
            ls = [l for l in b['lines'] if sum(1 for y in ybounds if l['y0'] >= y - 2) == k]
            if ls: segs.append(dict(lines=ls))
        out += segs
        if k < len(wide): out.append(dict(lines=[w for w in wide if sum(1 for y in ybounds if w['y0'] >= y - 2) == k + 1]))
    return [b for b in out if b['lines']]


# ---------------------------------------------------------------------------------------------------------
def fontfile_guess():
    for c in ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'C:/Windows/Fonts/arial.ttf',
              '/Library/Fonts/Arial.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf']:
        if os.path.exists(c): return c
    raise SystemExit('לא נמצא פונט עם עברית; ערוך את fontfile_guess')


def process_page(page, prof):
    cls, garbled, unres = decode_page(page, prof)
    lines = split_gutters(make_lines(cls))
    blocks = build_blocks(lines)
    return blocks, garbled, unres, cls


def main():
    argv = sys.argv[1:]
    dpi = 200
    if '--dpi' in argv:
        i = argv.index('--dpi'); dpi = int(argv[i + 1]); del argv[i:i + 2]
    debug = '--debug' in argv
    argv = [a for a in argv if not a.startswith('--')]
    src = argv[0]; dst = argv[1] if len(argv) > 1 else os.path.splitext(src)[0] + '_fixed.pdf'
    doc = fitz.open(src); prof = profile_fonts(doc)
    print('פונטים שזוהו:', {k: v for k, v in prof.items()})
    ff = fontfile_guess(); font = fitz.Font(fontfile=ff)
    asc, desc = font.ascender, font.descender
    out = fitz.open(); txt = []; fixed = 0; unres_total = 0
    for n, page in enumerate(doc):
        blocks, g, unres, cls = process_page(page, prof)
        unres_total += unres
        page_txt = []
        for bi, b in enumerate(blocks):
            for ln in b['lines']:
                words = line_words(ln['seg'])
                page_txt.append(line_text(words))
            page_txt.append('')
        txt.append(f'--- עמוד {n+1} ---\n' + '\n'.join(page_txt).strip())
        if not g:
            out.insert_pdf(doc, from_page=n, to_page=n); continue
        fixed += 1
        np_ = out.new_page(width=page.rect.width, height=page.rect.height)
        pix = page.get_pixmap(dpi=dpi)
        np_.insert_image(np_.rect, stream=pix.tobytes('jpg', jpg_quality=85))
        for b in blocks:
            for ln in b['lines']:
                for vis, (x0, y0, x1, y1), size, w in reversed(line_words(ln['seg'])) if any(HEB(c) for c in ''.join(c.t for c in ln['seg'])) else line_words(ln['seg']):
                    if not vis.strip(): continue
                    wtxt = visual_to_logical(vis) if any(HEB(c) for c in vis) else vis
                    # ההדפסה בסדר ויזואלי (שמאל->ימין) כדי שחילוץ/העתקה יחזירו סדר לוגי תקין
                    shown = vis
                    h = y1 - y0
                    fs = h / (asc - desc)
                    tl = font.text_length(shown, fontsize=fs)
                    if tl <= 0 or fs < 1: continue
                    sx = (x1 - x0) / tl
                    ybase = y0 + asc * fs
                    pt = fitz.Point(x0, ybase)
                    np_.insert_text(pt, shown, fontname='hb', fontfile=ff, fontsize=fs, render_mode=3,
                                    morph=(pt, fitz.Matrix(sx, 0, 0, 1, 0, 0)))
        if debug:
            pass
    out.save(dst, deflate=True, garbage=3)
    open(os.path.splitext(dst)[0] + '.txt', 'w', encoding='utf8').write('\n\n'.join(txt))
    print(f'נוצר {dst}; תוקנו {fixed} עמודים מתוך {len(doc)}; תווים לא פוענחו: {unres_total}')


if __name__ == '__main__':
    main()
