import { fixPdfEncoding, inspectPdfEncoding, type ReviewItem, type UserGlyph } from './encoding-fix';

const drop = document.getElementById('drop') as HTMLDivElement;
const pickFile = document.getElementById('pick-file') as HTMLButtonElement;
const pickFolder = document.getElementById('pick-folder') as HTMLButtonElement;
const fileInput = document.getElementById('file') as HTMLInputElement;
const folderInput = document.getElementById('folder') as HTMLInputElement;
const log = document.getElementById('log') as HTMLDivElement;
const bar = document.getElementById('bar') as HTMLProgressElement;
const out = document.getElementById('out') as HTMLDivElement;

folderInput.setAttribute('webkitdirectory', '');
folderInput.setAttribute('directory', '');

const reviewBox = document.getElementById('review') as HTMLElement;
const reviewItems = document.getElementById('review-items') as HTMLDivElement;
const DICT_KEY = 'hebfix.userGlyphs';

function loadUserGlyphs(): UserGlyph[] {
  try { return JSON.parse(localStorage.getItem(DICT_KEY) ?? '[]') as UserGlyph[]; } catch { return []; }
}
function saveUserGlyphs(list: UserGlyph[]) {
  localStorage.setItem(DICT_KEY, JSON.stringify(list));
}

let currentReview: ReviewItem[] = [];
function renderReview(items: ReviewItem[], skipped: { name: string; glyphs: number }[]) {
  currentReview = items;
  reviewItems.innerHTML = '';
  reviewBox.hidden = items.length === 0 && skipped.length === 0;
  const groups: [string, string, ReviewItem[]][] = [
    ['לא פוענחו', 'גליפים בפונטים עבריים שעדיין ממופים לתו לא עברי. הקלידו את התו הנכון.', items.filter((i) => i.kind === 'unresolved')],
    ['ניחושים לוודא', 'הכלי זיהה אותם לפי הצורה אך אינו בטוח לגמרי. אם התו הנוכחי נכון — השאירו; אם לא — תקנו.', items.filter((i) => i.kind === 'guess')],
  ];
  for (const [title, hint, list] of groups) {
    if (!list.length) continue;
    const h = document.createElement('h3'); h.textContent = `${title} (${list.length})`;
    const p = document.createElement('p'); p.className = 'muted'; p.textContent = hint;
    const grid = document.createElement('div'); grid.className = 'rv-grid';
    list.forEach((it) => {
      const i = items.indexOf(it);
      const card = document.createElement('div'); card.className = 'rv';
      const cv = document.createElement('canvas'); cv.width = it.thumbSize; cv.height = it.thumbSize;
      const ctx = cv.getContext('2d')!;
      const img = ctx.createImageData(it.thumbSize, it.thumbSize);
      for (let k = 0; k < it.thumbSize * it.thumbSize; k++) { const v = it.thumb[k]; img.data[k * 4] = img.data[k * 4 + 1] = img.data[k * 4 + 2] = v; img.data[k * 4 + 3] = 255; }
      ctx.putImageData(img, 0, 0);
      const base = Math.round(it.thumbSize * (1.15 / 1.6));   // baseline guide
      ctx.strokeStyle = 'rgba(220,38,38,.6)'; ctx.beginPath(); ctx.moveTo(0, base); ctx.lineTo(it.thumbSize, base); ctx.stroke();
      const input = document.createElement('input'); input.id = `rv-${i}`; input.value = it.guess; input.dir = 'rtl';
      const label = document.createElement('div');
      label.textContent = `${displayFontName(it.font)} · 0x${it.code.toString(16)}\nכעת: ${JSON.stringify(it.current)} · ביטחון ${Math.round(it.kmax * 100)}%`;
      label.style.whiteSpace = 'pre-line';
      card.append(cv, document.createElement('br'), input, label); grid.append(card);
    });
    if (title.startsWith('ניחושים')) {
      const det = document.createElement('details'); const sum = document.createElement('summary'); sum.append(h);
      const all = document.createElement('button'); all.type = 'button'; all.textContent = 'אשרו את כל הניחושים (הם נכונים)';
      all.addEventListener('click', () => {
        const dict = loadUserGlyphs();
        for (const it of list) dict.push({ f: it.f, text: (document.getElementById(`rv-${items.indexOf(it)}`) as HTMLInputElement).value });
        saveUserGlyphs(dict); void handleJobs(lastJobs, lastPreferZip);
      });
      det.append(sum, p, all, grid); reviewItems.append(det);
    } else reviewItems.append(h, p, grid);
  }
  if (skipped.length) {
    const h = document.createElement('h3'); h.textContent = `פונטים שלא זוהו כעבריים (${skipped.length})`;
    const p = document.createElement('p'); p.className = 'muted';
    p.textContent = 'נבדקו ונדחו כי הצורות שבהם אינן דומות מספיק לאותיות עבריות מוכרות: ' + [...new Set(skipped.map((f) => `${displayFontName(f.name)} (${f.glyphs} גליפים)`))].join(', ') + '. אם אחד מהם עברי — שלחו את הקובץ לבדיקה.';
    reviewItems.append(h, p);
  }
}

document.getElementById('review-save')!.addEventListener('click', () => {
  const dict = loadUserGlyphs();
  currentReview.forEach((it, i) => {
    const v = (document.getElementById(`rv-${i}`) as HTMLInputElement).value;
    if (v === '') return;
    dict.push({ f: it.f, text: v });
  });
  saveUserGlyphs(dict);
  void handleJobs(lastJobs, lastPreferZip);
});
document.getElementById('dict-export')!.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(loadUserGlyphs())], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'hebrew-glyph-dictionary.json'; a.click();
});
document.getElementById('dict-import')!.addEventListener('click', () => document.getElementById('dict-file')!.click());
document.getElementById('dict-file')!.addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
  try { saveUserGlyphs([...loadUserGlyphs(), ...(JSON.parse(await f.text()) as UserGlyph[])]); say('המילון יובא.'); } catch { say('קובץ מילון לא תקין.'); }
});
document.getElementById('dict-share')!.addEventListener('click', async () => {
  const json = JSON.stringify(loadUserGlyphs());
  const base = 'https://github.com/arye000001-boop/pdf-missing-encoding-fixer-heb/issues/new?template=glyph-corrections.yml';
  if (json.length < 5500) { window.open(`${base}&json=${encodeURIComponent(json)}`, '_blank'); return; }
  try { await navigator.clipboard.writeText(json); say('המילון הועתק ללוח. הדביקו אותו בטופס שייפתח.'); } catch { say('הורידו את המילון בכפתור "ייצוא מילון" והדביקו את תוכנו בטופס.'); }
  window.open(base, '_blank');
});
document.getElementById('dict-reset')!.addEventListener('click', () => { saveUserGlyphs([]); say('המילון אופס.'); });

function say(msg: string) {
  log.textContent = msg;
}

function displayFontName(font: string): string {
  return font.split('+').pop() ?? font;
}

function compactFontList(fonts: string[], empty: string, limit = 24): string {
  const unique = [...new Set(fonts.map(displayFontName))].sort((a, b) =>
    a.localeCompare(b),
  );
  if (unique.length === 0) return empty;
  const shown = unique.slice(0, limit).join(', ');
  const more = unique.length > limit ? `, ועוד ${unique.length - limit}` : '';
  return `${shown}${more}`;
}

type PdfJob = {
  file: File;
  path: string;
};

type FixedPdf = {
  review: ReviewItem[];
  skippedFonts: { name: string; glyphs: number }[];
  outputPath: string;
  bytes: Uint8Array;
  pageCount: number;
  fixedFonts: string[];
  complexFonts: string[];
  lastModified: number;
};

type ZipEntry = {
  path: string;
  bytes: Uint8Array;
  date: Date;
};

type BrowserFileSystemEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
};

type BrowserFileSystemFileEntry = BrowserFileSystemEntry & {
  file(success: (file: File) => void, error?: (err: DOMException) => void): void;
};

type BrowserFileSystemDirectoryEntry = BrowserFileSystemEntry & {
  createReader(): {
    readEntries(
      success: (entries: BrowserFileSystemEntry[]) => void,
      error?: (err: DOMException) => void,
    ): void;
  };
};

function filePath(file: File): string {
  const withRelativePath = file as File & { webkitRelativePath?: string };
  return withRelativePath.webkitRelativePath || file.name;
}

function outputPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized.replace(/\.pdf$/i, '.fixed.pdf');
}

function pdfJobs(files: File[]): PdfJob[] {
  return files
    .filter((file) => /\.pdf$/i.test(file.name))
    .map((file) => ({ file, path: filePath(file) }));
}

async function fixOnePdf(
  job: PdfJob,
  index: number,
  total: number,
): Promise<FixedPdf> {
  const info = inspectPdfEncoding(new Uint8Array(await job.file.arrayBuffer()));
  const fontList = compactFontList(
    info.lostFonts,
    '(אין - נראה שכבר יש מיפוי טקסט תקין)',
  );
  say(
    `קובץ ${index + 1} מתוך ${total}: ${job.path}\n` +
      `עמודים: ${info.pageCount}\n` +
      `פונטים לתיקון: ${fontList}\n\n` +
      'מעבד...',
  );

  // Re-read: mupdf detaches the input buffer it opens, so inspect and fix each
  // take their own copy.
  const { bytes, fixedFonts, review, skippedFonts } = fixPdfEncoding(
    new Uint8Array(await job.file.arrayBuffer()),
    {
      userGlyphs: loadUserGlyphs(),
      bracketMode: (document.getElementById('viewer') as HTMLSelectElement | null)?.value === 'raw' ? 'raw' : 'chrome',
      onProgress: ({ font, fontCount, name }) => {
        const fileProgress = fontCount === 0 ? 1 : font / fontCount;
        bar.value = Math.round(((index + fileProgress) / total) * 100);
        say(
          `קובץ ${index + 1} מתוך ${total}: ${job.path}\n` +
            `מתקן פונט ${font} מתוך ${fontCount}: ${name}...`,
        );
      },
    },
  );

  bar.value = Math.round(((index + 1) / total) * 100);
  return {
    review,
    skippedFonts,
    outputPath: outputPath(job.path),
    bytes,
    pageCount: info.pageCount,
    fixedFonts,
    complexFonts: info.complexFonts,
    lastModified: job.file.lastModified,
  };
}

function makeDownload(blob: Blob, filename: string, label: string) {
  const url = URL.createObjectURL(blob);
  out.innerHTML = `<a class="dl" href="${url}" download="${filename}">${label}</a>`;
}

async function handleFiles(files: File[], preferZip = false) {
  await handleJobs(pdfJobs(files), preferZip);
}

let lastJobs: PdfJob[] = [];
let lastPreferZip = false;

async function handleJobs(jobs: PdfJob[], preferZip = false) {
  lastJobs = jobs;
  lastPreferZip = preferZip;
  out.innerHTML = '';
  reviewBox.hidden = true;
  if (jobs.length === 0) {
    say('לא נמצאו קבצי PDF לביצוע.');
    return;
  }

  bar.hidden = false;
  bar.value = 0;
  try {
    const fixed: FixedPdf[] = [];
    for (let i = 0; i < jobs.length; i++) {
      fixed.push(await fixOnePdf(jobs[i], i, jobs.length));
    }

    if (fixed.length === 1 && !preferZip) {
      makeDownload(
        new Blob([fixed[0].bytes as BlobPart], { type: 'application/pdf' }),
        fixed[0].outputPath.split('/').pop() ?? 'fixed.pdf',
        'הורדת ה-PDF המתוקן',
      );
    } else {
      const zip = createZip(
        fixed.map((item) => ({
          path: item.outputPath,
          bytes: item.bytes,
          date: new Date(item.lastModified || Date.now()),
        })),
      );
      makeDownload(
        new Blob([zip as BlobPart], { type: 'application/zip' }),
        'fixed-pdfs.zip',
        'הורדת ZIP עם כל הקבצים המתוקנים',
      );
    }

    renderReview(fixed.flatMap((item) => item.review), fixed.flatMap((item) => item.skippedFonts));
    const fixedFonts = fixed.flatMap((item) => item.fixedFonts);
    const fixedList = compactFontList(fixedFonts, '(אין)');
    const complexFonts = [...new Set(fixed.flatMap((item) =>
      item.complexFonts.filter((font) =>
        !item.fixedFonts.some((fixedName) =>
          displayFontName(fixedName) === displayFontName(font),
        ),
      ),
    ))];
    const complexList = compactFontList(complexFonts, '(אין)');
    const pages = fixed.reduce((sum, item) => sum + item.pageCount, 0);
    say(
      `הסתיים. ${fixed.length} קבצים, ${pages} עמודים.\\n` +
        `פונטים שתוקנו: ${fixedList}\\n` +
        `גופני CID שאינם נתמכים עדיין (מבוססי CFF או בקידוד מיוחד): ${complexList}\\n` +
        (complexFonts.length
          ? 'שים לב: נותרו גופני CID שאינם נתמכים עדיין; יש לבדוק אותם בנפרד.'
          : 'כל גופני ה-CID במסמך נתמכים.'),
    );
  } catch (e) {
    say(`שגיאה: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    bar.hidden = true;
  }
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < crcTable.length; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(date: Date): number {
  return (
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2)
  );
}

function dosDate(date: Date): number {
  const year = Math.max(1980, date.getFullYear());
  return ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
}

function write16(out: number[], value: number) {
  out.push(value & 0xff, (value >>> 8) & 0xff);
}

function write32(out: number[], value: number) {
  out.push(
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  );
}

function append(out: number[], bytes: Uint8Array) {
  for (const byte of bytes) out.push(byte);
}

function createZip(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: number[] = [];
  const centralDirectory: number[] = [];

  for (const entry of entries) {
    const pathBytes = encoder.encode(entry.path.replace(/\\/g, '/'));
    const crc = crc32(entry.bytes);
    const offset = chunks.length;
    const time = dosTime(entry.date);
    const date = dosDate(entry.date);

    write32(chunks, 0x04034b50);
    write16(chunks, 20);
    write16(chunks, 0x0800);
    write16(chunks, 0);
    write16(chunks, time);
    write16(chunks, date);
    write32(chunks, crc);
    write32(chunks, entry.bytes.length);
    write32(chunks, entry.bytes.length);
    write16(chunks, pathBytes.length);
    write16(chunks, 0);
    append(chunks, pathBytes);
    append(chunks, entry.bytes);

    write32(centralDirectory, 0x02014b50);
    write16(centralDirectory, 20);
    write16(centralDirectory, 20);
    write16(centralDirectory, 0x0800);
    write16(centralDirectory, 0);
    write16(centralDirectory, time);
    write16(centralDirectory, date);
    write32(centralDirectory, crc);
    write32(centralDirectory, entry.bytes.length);
    write32(centralDirectory, entry.bytes.length);
    write16(centralDirectory, pathBytes.length);
    write16(centralDirectory, 0);
    write16(centralDirectory, 0);
    write16(centralDirectory, 0);
    write16(centralDirectory, 0);
    write32(centralDirectory, 0);
    write32(centralDirectory, offset);
    append(centralDirectory, pathBytes);
  }

  const centralOffset = chunks.length;
  append(chunks, Uint8Array.from(centralDirectory));
  write32(chunks, 0x06054b50);
  write16(chunks, 0);
  write16(chunks, 0);
  write16(chunks, entries.length);
  write16(chunks, entries.length);
  write32(chunks, centralDirectory.length);
  write32(chunks, centralOffset);
  write16(chunks, 0);
  return Uint8Array.from(chunks);
}

async function filesFromEntry(
  entry: BrowserFileSystemEntry,
  path = '',
): Promise<PdfJob[]> {
  if (entry.isFile) {
    return new Promise((resolve, reject) => {
      (entry as BrowserFileSystemFileEntry).file((file) => {
        resolve([{ file, path: `${path}${file.name}` }]);
      }, reject);
    });
  }

  if (!entry.isDirectory) return [];
  const directory = entry as BrowserFileSystemDirectoryEntry;
  const reader = directory.createReader();
  const entries: BrowserFileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<BrowserFileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) break;
    entries.push(...batch);
  }
  const nested = await Promise.all(
    entries.map((child) => filesFromEntry(child, `${path}${entry.name}/`)),
  );
  return nested.flat();
}

async function jobsFromDrop(e: DragEvent): Promise<PdfJob[]> {
  const items = [...(e.dataTransfer?.items ?? [])];
  const entryReaders = items
    .map((item) => {
      const withEntry = item as unknown as {
        webkitGetAsEntry?: () => BrowserFileSystemEntry | null;
      };
      return withEntry.webkitGetAsEntry?.() ?? null;
    })
    .filter((entry): entry is BrowserFileSystemEntry => entry !== null);

  if (entryReaders.length > 0) {
    const nested = await Promise.all(entryReaders.map((entry) => filesFromEntry(entry)));
    return nested.flat().filter((job) => /\.pdf$/i.test(job.file.name));
  }
  return pdfJobs([...(e.dataTransfer?.files ?? [])]);
}

pickFile.addEventListener('click', () => fileInput.click());
pickFolder.addEventListener('click', () => folderInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) handleFiles([...fileInput.files]);
  fileInput.value = '';
});
folderInput.addEventListener('change', () => {
  if (folderInput.files?.length) handleFiles([...folderInput.files], true);
  folderInput.value = '';
});
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  void jobsFromDrop(e).then((jobs) => handleJobs(jobs, jobs.length > 1));
});
