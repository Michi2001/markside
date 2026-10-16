import { Selection } from '@milkdown/kit/prose/state';
import * as pdfjs from 'pdfjs-dist';
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { type Anchor, type Rect, type Section, formatAnchor, pageKey } from '../../sidecar';
import { isDrawingOpen } from '../drawing';
import { type Fold, foldPlugin, getFolds, setFolds, toggleFold } from '../fold';
import { applyInit, handleHostMessage, post, saveFile } from '../host';
import { HIGHLIGHT_KEYS, type NoteEditor, createNoteEditor, getActiveEditor, installShortcuts, setActiveEditor } from '../noteEditor';
import './pdf.css';

// PDF pages on the left, the notes of `paper.pdf.md` as cards in the margin on the right, each next to
// the text or area it belongs to (pushed down when they would overlap; long notes push the next page
// down). Every card is a Crepe editor of its note's body, created once the card comes near the view.
// Every page has a page note card (empty until written); marks without a note are plain highlights
// and only get a card while it is being edited.

// The notes column fills the space right of the page up to the window edge, at least MIN_NOTES_WIDTH
// (in the column's own units); fitting the pages leaves notesWidth (setting mdLive.pdfNotesWidth) for
// it at 100 %. Zooming magnifies the notes like the pages (CSS zoom on the column, `notesZoom`), so the
// note's font size stays its size at 100 %.
const MIN_NOTES_WIDTH = 200;
const GAP = 24;
// Left and right padding of #viewer.
const VIEWER_PADDING = 48 + 24;
const CARD_GAP = 8;
const MAX_SCALE = 2;
const SNAPSHOT_SCALE = 2.5;
const RENDER_DELAY_MS = 200;
const COLORS = ['yellow', 'red', 'green', 'blue'];
// Hues of red and green; random colors (Alt+A, stored as `h<hue>`) keep away from them.
const AVOID_HUES = [345, 135];

type Card = {
  key: string;
  section: Section;
  el: HTMLElement;
  body: HTMLElement;
  editor?: NoteEditor;
  creating?: Promise<NoteEditor>;
  // Body (without the area snapshot) last exchanged with the extension.
  source: string;
  // Bodies this card sent recently: a `notes` message carrying one of them is a late echo and must
  // not reset the editor while typing (macOS dictation would insert its phrase a second time).
  sent: string[];
};

// The snapshot image at the start of an area note stays in the file (for Claude) but is not shown in
// its card; `text` is what the card edits.
const SNAPSHOT_ALT = 'PDF area';
const SNAPSHOT = /^!\[(?:PDF area)?\]\([^)\s]+\)[ \t]*(?:\r?\n|$)/;

function splitBody(section: Section): { snapshot: string; text: string } {
  const match = section.anchor?.area ? SNAPSHOT.exec(section.body) : null;
  return match
    ? { snapshot: match[0].trim(), text: section.body.slice(match[0].length).replace(/^\s*\n/, '') }
    : { snapshot: '', text: section.body };
}

type PageView = {
  num: number;
  page: PDFPageProxy;
  // Page size at scale 1 (PDF points).
  width: number;
  height: number;
  row: HTMLElement;
  pageEl: HTMLElement;
  marks: HTMLElement;
  margin: HTMLElement;
  lines: SVGSVGElement;
  renderedScale: number;
  task?: RenderTask;
};

const viewer = document.getElementById('viewer') as HTMLElement;
const pages: PageView[] = [];
const cards = new Map<string, Card>();
let scale = 1;
let zoom = 1;
let notesWidth = 360;
let distUri = '';
// Sections received before the pages exist.
let latestSections: Section[] = [];
// Card to focus once the extension has added its note.
let pendingFocus: string | undefined;
// Collapsed list items/headings per card (`foo.pdf.assets/.folds.json`).
let folds: Record<string, Fold[]> = {};
// Mark under the pointer (Delete/Backspace removes it).
let hoveredMark: string | undefined;
// Notes just created with their card open: left empty, the mark goes too.
const freshNotes = new Set<string>();
// Pages near the viewport (rendered); others drop their canvas.
const nearPages = new Set<PageView>();
// Rows far from the viewport whose cards are laid out once they come near (zooming stays cheap).
const staleRows = new Set<PageView>();

// ---------- Pages ----------

function fitScale(): number {
  const maxWidth = Math.max(...pages.map((p) => p.width));
  const available = viewer.clientWidth - VIEWER_PADDING - GAP;
  const fit = Math.max(0.3, Math.min(MAX_SCALE, (available - notesWidth) / maxWidth));
  return fit * zoom;
}

// Zoom of the notes column: the user zoom, but when zooming in (in a narrow window, e.g. split view,
// where the pages start out small) the notes only grow once the pages are larger than their PDF size.
function notesZoom(): number {
  return zoom <= 1 ? zoom : Math.min(zoom, Math.max(1, scale));
}

function sizePage(pv: PageView): void {
  pv.pageEl.style.width = `${pv.width * scale}px`;
  pv.pageEl.style.height = `${pv.height * scale}px`;
  pv.pageEl.style.setProperty('--total-scale-factor', String(scale));
  const free = viewer.clientWidth - VIEWER_PADDING - GAP - pv.width * scale;
  pv.margin.style.width = `${Math.max(MIN_NOTES_WIDTH, free / notesZoom())}px`;
  pv.margin.style.zoom = String(notesZoom());
}

async function renderPage(pv: PageView): Promise<void> {
  if (pv.renderedScale === scale) {
    return;
  }
  pv.renderedScale = scale;
  pv.task?.cancel();
  const viewport = pv.page.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  const task = pv.page.render({
    canvas,
    canvasContext: canvas.getContext('2d')!,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
  });
  pv.task = task;
  const done = await task.promise.then(
    () => true,
    (e) => {
      if (e instanceof pdfjs.RenderingCancelledException) {
        return false;
      }
      throw e;
    },
  );
  if (!done) {
    return;
  }
  const textLayer = document.createElement('div');
  textLayer.className = 'textLayer';
  // Swapped in after rendering, so zooming never shows an empty page.
  pv.pageEl.querySelectorAll('canvas, .textLayer').forEach((el) => el.remove());
  pv.pageEl.prepend(canvas);
  pv.pageEl.append(textLayer);
  await new pdfjs.TextLayer({ textContentSource: pv.page.streamTextContent(), container: textLayer, viewport }).render();
}

function releasePage(pv: PageView): void {
  pv.task?.cancel();
  pv.renderedScale = 0;
  pv.pageEl.querySelectorAll('canvas, .textLayer').forEach((el) => el.remove());
}

const pageObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const pv = pages.find((p) => p.row === entry.target)!;
      pv.margin.classList.toggle('far', !entry.isIntersecting);
      if (entry.isIntersecting) {
        nearPages.add(pv);
        if (staleRows.delete(pv)) {
          layoutRow(pv);
        }
        renderPage(pv);
      } else {
        nearPages.delete(pv);
        releasePage(pv);
      }
    }
  },
  { rootMargin: '1500px 0px' },
);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent?.append(node);
  return node;
}

function createPageView(page: PDFPageProxy): PageView {
  const { width, height } = page.getViewport({ scale: 1 });
  const row = el('div', 'row', viewer);
  const pageEl = el('div', 'page', row);
  const marks = el('div', 'marks', pageEl);
  const margin = el('div', 'margin', row);
  const lines = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  lines.classList.add('lines');
  row.append(lines);
  return { num: page.pageNumber, page, width, height, row, pageEl, marks, margin, lines, renderedScale: 0 };
}

function applyScale(): void {
  const next = fitScale();
  // Keeps the position in the document while the pages change size.
  const anchor = pages.find((p) => p.row.getBoundingClientRect().bottom > 0);
  const offset = anchor ? anchor.row.getBoundingClientRect().top / anchor.row.offsetHeight : 0;
  scale = next;
  pages.forEach(sizePage);
  layoutAll();
  if (anchor) {
    window.scrollTo(0, anchor.row.offsetTop - offset * anchor.row.offsetHeight);
  }
}

async function loadPdf(url: string): Promise<void> {
  const worker = await (await fetch(distUri + 'pdf.worker.min.mjs')).text();
  pdfjs.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(new Blob([worker], { type: 'text/javascript' })), {
    type: 'module',
  });
  const data = await (await fetch(url)).arrayBuffer();
  const pdf = await pdfjs.getDocument({
    data,
    cMapUrl: distUri + 'pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: distUri + 'pdfjs/standard_fonts/',
    wasmUrl: distUri + 'pdfjs/wasm/',
    useWorkerFetch: false,
  }).promise;
  for (let i = 1; i <= pdf.numPages; i++) {
    pages.push(createPageView(await pdf.getPage(i)));
  }
  scale = fitScale();
  pages.forEach(sizePage);
  applySections(latestSections);
  pages.forEach((pv) => pageObserver.observe(pv.row));
}

// ---------- Notes ----------

function pageView(num: number): PageView | undefined {
  return pages[num - 1];
}

function top(anchor: Anchor): number {
  return Math.min(...anchor.rects.map((r) => r.y));
}

function cardsOf(pv: PageView): Card[] {
  return [...cards.values()]
    .filter((c) => c.section.page === pv.num)
    .sort((a, b) => (a.section.anchor ? top(a.section.anchor) : -1) - (b.section.anchor ? top(b.section.anchor) : -1));
}

function isEmpty(card: Card): boolean {
  return (card.editor ? card.editor.crepe.getMarkdown() : card.source).trim() === '';
}

function createCard(section: Section): Card {
  const pv = pageView(section.page)!;
  const cardEl = el('div', 'card');
  const head = el('div', 'card-head', cardEl);
  el('span', 'card-label', head);
  const del = el('button', 'card-delete', head);
  del.title = 'Delete note';
  del.textContent = '×';
  const body = el('div', 'card-body', cardEl);
  const card: Card = { key: section.key, section, el: cardEl, body, source: splitBody(section).text, sent: [] };
  updateCard(card, section);
  body.textContent = card.source;
  pv.margin.append(cardEl);

  del.addEventListener('mousedown', (e) => {
    e.preventDefault();
    removeNote(card.key);
  });
  head.addEventListener('mousedown', (e) => {
    e.preventDefault();
    focusCard(card, true);
  });
  body.addEventListener('mousedown', () => {
    if (!card.editor) {
      focusCard(card, true);
    }
  });
  // A mark whose note stays empty is kept as a plain highlight (removed if it was only just created
  // for this note); its card goes once the focus leaves it (not while drawing into it).
  cardEl.addEventListener('focusout', () => {
    setTimeout(() => {
      const left = !cardEl.contains(document.activeElement) && !isDrawingOpen();
      if (cards.get(card.key) !== card || !left) {
        return;
      }
      const fresh = freshNotes.delete(card.key);
      if (card.section.anchor && isEmpty(card)) {
        if (fresh) {
          removeNote(card.key, true);
        } else {
          dropCard(card);
          layoutRow(pv);
        }
      }
    }, 200);
  });
  cardEl.addEventListener('mouseenter', () => setHover(card.key));
  cardEl.addEventListener('mouseleave', () => setHover(undefined));
  new ResizeObserver(() => scheduleLayout(pv)).observe(cardEl);
  cardObserver.observe(cardEl);
  cards.set(card.key, card);
  return card;
}

function updateCard(card: Card, section: Section): void {
  card.section = section;
  const { anchor } = section;
  card.el.dataset.key = section.key;
  card.el.dataset.color = anchor?.color ?? '';
  setCustomColor(card.el, anchor?.color);
  card.el.classList.toggle('page-note', !anchor);
  card.el.classList.toggle('area', !!anchor?.area);
  card.el.classList.toggle('empty', !card.source.trim());
  const label = card.el.querySelector('.card-label') as HTMLElement;
  label.textContent = anchor ? (anchor.area ? section.label || 'Area' : `„${section.label}“`) : `Page ${section.page}`;
  label.title = label.textContent;
}

// Folds of cards whose note is gone are dropped.
function saveCardFolds(key: string, list: Fold[]): void {
  const exists = (k: string) => k.startsWith('page:') || latestSections.some((s) => s.key === k);
  const next = Object.fromEntries(Object.entries({ ...folds, [key]: list }).filter(([k, l]) => l.length > 0 && exists(k)));
  if (JSON.stringify(next) !== JSON.stringify(folds)) {
    folds = next;
    post({ type: 'folds', folds });
  }
}

function ensureEditor(card: Card): Promise<NoteEditor> {
  card.creating ??= (async () => {
    card.body.textContent = '';
    const editor = await createNoteEditor(
      card.body,
      card.source,
      (markdown) => {
        card.source = markdown;
        card.sent = [...card.sent.slice(-49), markdown];
        card.el.classList.toggle('empty', !markdown.trim());
        const { snapshot } = splitBody(card.section);
        const text = snapshot && markdown.trim() ? `${snapshot}\n\n${markdown}` : snapshot || markdown;
        post({ type: 'editNote', key: card.key, text });
      },
      (crepe) => crepe.editor.use(foldPlugin((f) => saveCardFolds(card.key, f))),
      card.section.anchor ? undefined : 'Note on this page…',
    );
    card.editor = editor;
    setFolds(editor.view(), folds[card.key] ?? []);
    return editor;
  })();
  return card.creating;
}

// Crepe editors are created once their card comes near the viewport.
const cardObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const card = [...cards.values()].find((c) => c.el === entry.target);
      if (entry.isIntersecting && card) {
        ensureEditor(card);
      }
    }
  },
  { rootMargin: '800px 0px' },
);

async function focusCard(card: Card, atEnd: boolean): Promise<void> {
  const editor = await ensureEditor(card);
  setActiveEditor(editor);
  const view = editor.view();
  if (atEnd && !card.el.contains(document.activeElement)) {
    // After a block like the snapshot of an area, writing continues in a new paragraph below it.
    const { doc, schema } = view.state;
    const tr = view.state.tr;
    if (!doc.lastChild?.isTextblock) {
      tr.insert(doc.content.size, schema.nodes.paragraph.create());
    }
    view.dispatch(tr.setSelection(Selection.atEnd(tr.doc)));
  }
  view.focus();
  card.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function dropCard(card: Card): void {
  cards.delete(card.key);
  cardObserver.unobserve(card.el);
  card.editor?.crepe.destroy();
  if (getActiveEditor() === card.editor) {
    setActiveEditor(undefined);
  }
  card.el.remove();
}

// Removes a text or area note (mark and note) from the file; `discard`: a mark only just created
// for a note that stayed empty, which is not kept as an undo step.
function removeNote(key: string, discard = false): void {
  const section = latestSections.find((s) => s.key === key);
  const card = cards.get(key);
  if (card) {
    dropCard(card);
  }
  latestSections = latestSections.filter((s) => s.key !== key);
  post({ type: 'deleteNote', key, discard });
  renderMarks();
  if (section) {
    layoutRow(pageView(section.page)!);
  }
}

// Opens the card of a note (created on demand for a plain highlight).
function openNote(section: Section, atEnd: boolean): void {
  const card = cards.get(section.key) ?? createCard(section);
  layoutRow(pageView(section.page)!);
  focusCard(card, atEnd);
}

function emptyPageSection(page: number): Section {
  return { key: pageKey(page), page, label: '', body: '', start: 0, bodyStart: 0, end: 0 };
}

// Syncs the cards with the notes in the file. Cards whose body equals what they last exchanged with
// the extension are left alone, so typing is never interrupted by its own echo.
function applySections(sections: Section[]): void {
  latestSections = sections;
  if (pages.length === 0) {
    return;
  }
  const byKey = new Map(sections.map((s) => [s.key, s]));
  const shown = [
    ...pages.map((pv) => byKey.get(pageKey(pv.num)) ?? emptyPageSection(pv.num)),
    ...sections.filter((s) => s.anchor && pageView(s.page) && (splitBody(s).text || cards.get(s.key)?.el.contains(document.activeElement))),
  ];
  const keys = new Set(shown.map((s) => s.key));
  for (const card of [...cards.values()]) {
    if (!keys.has(card.key)) {
      dropCard(card);
    }
  }
  for (const section of shown) {
    const card = cards.get(section.key) ?? createCard(section);
    const { text } = splitBody(section);
    if (text !== card.source && !card.sent.includes(text)) {
      card.source = text;
      if (card.editor) {
        // replaceAll drops the collapsed items, they are restored by text.
        const view = card.editor.view();
        const kept = getFolds(view.state);
        card.editor.setMarkdown(text);
        setFolds(view, kept);
      } else if (!card.creating) {
        card.body.textContent = text;
      }
    }
    updateCard(card, section);
  }
  renderMarks();
  layoutAll();
  const focus = pendingFocus && byKey.get(pendingFocus);
  if (focus) {
    pendingFocus = undefined;
    openNote(focus, true);
  }
}

// ---------- Marks on the pages ----------

function renderMarks(): void {
  for (const pv of pages) {
    pv.marks.replaceChildren();
  }
  for (const section of latestSections) {
    const { anchor } = section;
    if (!anchor || !pageView(anchor.page)) {
      continue;
    }
    for (const r of anchor.rects) {
      const mark = el('div', anchor.area ? 'mark area' : 'mark', pageView(anchor.page)!.marks);
      mark.dataset.key = section.key;
      mark.dataset.color = anchor.color;
      setCustomColor(mark, anchor.color);
      Object.assign(mark.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
    }
  }
}

// Random colors `h<hue>` get their CSS colors inline.
function setCustomColor(node: HTMLElement | SVGElement, color: string | undefined): void {
  const hue = /^h(\d+)$/.exec(color ?? '')?.[1];
  if (hue) {
    node.style.setProperty('--mark-custom', `hsla(${hue}, 85%, 55%, 0.32)`);
    node.style.setProperty('--line-custom', `hsl(${hue}, 70%, 48%)`);
  } else {
    node.style.removeProperty('--mark-custom');
    node.style.removeProperty('--line-custom');
  }
}

// A random hue far from red and green and from the random colors already on the page.
function randomColor(page: number): string {
  const used = latestSections.filter((s) => s.anchor?.page === page).map((s) => Number(/^h(\d+)$/.exec(s.anchor!.color)?.[1]));
  const avoid = [...AVOID_HUES, ...used.filter(Number.isFinite)];
  const distance = (h: number) => Math.min(...avoid.map((a) => Math.min(Math.abs(h - a), 360 - Math.abs(h - a))));
  let best = 0;
  for (let i = 0; i < 20; i++) {
    const hue = Math.floor(Math.random() * 360);
    if (distance(hue) > distance(best)) {
      best = hue;
    }
  }
  return `h${best}`;
}

function setHover(key: string | undefined): void {
  document.querySelectorAll('.hover').forEach((n) => n.classList.remove('hover'));
  if (key) {
    document.querySelectorAll(`[data-key="${CSS.escape(key)}"]`).forEach((n) => n.classList.add('hover'));
  }
}

// Fraction of the page under the pointer.
function pagePoint(pv: PageView, e: MouseEvent): { x: number; y: number } {
  const r = pv.pageEl.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

// The note whose mark is under the pointer (the lowest one on the page if marks overlap).
function noteAt(pv: PageView, e: MouseEvent): Section | undefined {
  const { x, y } = pagePoint(pv, e);
  const pad = 0.004;
  return latestSections
    .filter((s) => s.anchor && s.page === pv.num)
    .sort((a, b) => top(b.anchor!) - top(a.anchor!))
    .find((s) => s.anchor!.rects.some((r) => x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad));
}

// ---------- Layout of the margin ----------

const dirtyRows = new Set<PageView>();

function scheduleLayout(pv: PageView): void {
  if (!nearPages.has(pv)) {
    staleRows.add(pv);
    return;
  }
  if (dirtyRows.size === 0) {
    requestAnimationFrame(() => {
      dirtyRows.forEach(layoutRow);
      dirtyRows.clear();
    });
  }
  dirtyRows.add(pv);
}

function layoutAll(): void {
  for (const pv of pages) {
    if (nearPages.has(pv)) {
      layoutRow(pv);
    } else {
      staleRows.add(pv);
    }
  }
}

// Places each card at the height of its mark, below the previous card if they would overlap, and
// lets the row grow when the notes are longer than the page.
// Card positions are in the column's own units (before its zoom).
function layoutRow(pv: PageView): void {
  const pageHeight = (pv.height * scale) / notesZoom();
  let y = 0;
  const placed: { card: Card; top: number }[] = [];
  // Heights first, then positions: alternating reads and writes would force a layout per card.
  const rowCards = cardsOf(pv);
  const heights = rowCards.map((card) => card.el.offsetHeight);
  rowCards.forEach((card, i) => {
    const desired = card.section.anchor ? top(card.section.anchor) * pageHeight - 10 : 0;
    const cardTop = Math.max(desired, y);
    card.el.style.top = `${cardTop}px`;
    placed.push({ card, top: cardTop });
    y = cardTop + heights[i] + CARD_GAP;
  });
  pv.margin.style.height = `${Math.max(pageHeight, y)}px`;
  drawLines(pv, placed);
}

// Connector from each mark to its card.
function drawLines(pv: PageView, placed: { card: Card; top: number }[]): void {
  const pageWidth = pv.width * scale;
  const pageHeight = pv.height * scale;
  // Computed, not measured: the page starts the row and the column follows after the flex gap (GAP).
  // Measuring the zoomed column differs between Chromium versions (CSS zoom semantics changed).
  const x1 = pageWidth + GAP;
  pv.lines.replaceChildren();
  for (const { card, top: cardTop } of placed) {
    const { anchor } = card.section;
    if (!anchor) {
      continue;
    }
    // Starts at the page edge, level with the mark, so it never runs across the page's text.
    const first = anchor.rects.reduce((a, b) => (b.y < a.y ? b : a));
    const sy = (first.y + first.h / 2) * pageHeight;
    const ey = (cardTop + 14) * notesZoom();
    const edge = pageWidth;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${edge},${sy} C${edge + GAP / 2},${sy} ${x1 - GAP / 2},${ey} ${x1},${ey}`);
    path.dataset.key = card.key;
    path.dataset.color = anchor.color;
    setCustomColor(path, anchor.color);
    path.classList.toggle('focus', card.el.contains(document.activeElement));
    pv.lines.append(path);
  }
}

// ---------- Creating notes ----------

function pageOf(node: Node | null): PageView | undefined {
  const pageEl = (node instanceof Element ? node : node?.parentElement)?.closest('.page');
  return pages.find((p) => p.pageEl === pageEl);
}

// Rectangles of the selected text on its first page, one per line, as fractions of the page.
function selectionRects(range: Range, pv: PageView): Rect[] {
  const box = pv.pageEl.getBoundingClientRect();
  const raw: DOMRect[] = [];
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  for (let node = walker.currentNode; node; node = walker.nextNode()!) {
    if (node.nodeType !== Node.TEXT_NODE || !range.intersectsNode(node) || pageOf(node) !== pv) {
      continue;
    }
    const sub = document.createRange();
    sub.selectNodeContents(node);
    if (node === range.startContainer) {
      sub.setStart(node, range.startOffset);
    }
    if (node === range.endContainer) {
      sub.setEnd(node, range.endOffset);
    }
    raw.push(...Array.from(sub.getClientRects()).filter((r) => r.width > 1 && r.height > 1));
  }
  // Merges the pieces of each line.
  const lines: { left: number; right: number; top: number; bottom: number }[] = [];
  for (const r of raw.sort((a, b) => a.top - b.top)) {
    const line = lines.find((l) => Math.abs((l.top + l.bottom) / 2 - (r.top + r.bottom) / 2) < r.height / 2);
    if (line) {
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
    } else {
      lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
  }
  return lines.map((l) => ({
    x: (l.left - box.left) / box.width,
    y: (l.top - box.top) / box.height,
    w: (l.right - l.left) / box.width,
    h: (l.bottom - l.top) / box.height,
  }));
}

// `edit`: open the new note's card; otherwise the mark is a plain highlight. `replace`: keys of
// notes removed in the same step.
function addNote(anchor: Anchor, label: string, body: string, edit: boolean, replace: string[] = []): void {
  if (edit) {
    pendingFocus = formatAnchor(anchor);
    // Replacing marks keeps the new one even without a note (the old highlight would be lost), so does
    // an area (its snapshot is the note).
    if (replace.length === 0 && !body) {
      freshNotes.add(pendingFocus);
    }
  }
  post({ type: 'addNote', anchor, label, body, replace });
}

// Rects on the same line that share some width.
function overlaps(a: Rect, b: Rect): boolean {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > Math.min(a.h, b.h) / 2;
}

function pdfSelection(): { range: Range; pv: PageView } | undefined {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return undefined;
  }
  const range = selection.getRangeAt(0);
  const pv = pageOf(range.startContainer);
  return pv && pv.pageEl.contains(range.startContainer) ? { range, pv } : undefined;
}

function markSelection(color: string, edit: boolean): void {
  const current = pdfSelection();
  hidePopover();
  if (!current) {
    return;
  }
  const rects = selectionRects(current.range, current.pv);
  const label = current.range.toString().replace(/\s+/g, ' ').trim();
  window.getSelection()!.removeAllRanges();
  if (rects.length > 0 && label) {
    // Text marks under the selection are replaced by the new one (e.g. to change the color); their
    // notes move over to it.
    const replaced = latestSections.filter(
      (s) => s.anchor && !s.anchor.area && s.page === current.pv.num && s.anchor.rects.some((r) => rects.some((n) => overlaps(r, n))),
    );
    const body = replaced.map((s) => s.body).filter(Boolean).join('\n\n');
    addNote({ page: current.pv.num, rects, area: false, color }, label, body, edit, replaced.map((s) => s.key));
  }
}

async function snapshot(pv: PageView, r: Rect): Promise<string> {
  const viewport = pv.page.getViewport({ scale: SNAPSHOT_SCALE });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(r.w * viewport.width);
  canvas.height = Math.round(r.h * viewport.height);
  const transform = [1, 0, 0, 1, -r.x * viewport.width, -r.y * viewport.height];
  await pv.page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport, transform }).promise;
  const data = canvas.toDataURL('image/png').split(',')[1];
  return saveFile({ name: 'area.png', mime: 'image/png', data });
}

async function addAreaNote(pv: PageView, r: Rect): Promise<void> {
  const path = await snapshot(pv, r);
  addNote({ page: pv.num, rects: [r], area: true, color: randomColor(pv.num) }, 'Area', `![${SNAPSHOT_ALT}](${path})`, true);
}

// Alt + drag on a page marks an area.
function startArea(pv: PageView, e: MouseEvent): void {
  e.preventDefault();
  window.getSelection()?.removeAllRanges();
  const start = pagePoint(pv, e);
  const box = el('div', 'marquee', pv.pageEl);
  let rect: Rect = { x: start.x, y: start.y, w: 0, h: 0 };
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const move = (ev: MouseEvent) => {
    const p = pagePoint(pv, ev);
    const x = clamp(Math.min(start.x, p.x));
    const y = clamp(Math.min(start.y, p.y));
    rect = { x, y, w: clamp(Math.max(start.x, p.x)) - x, h: clamp(Math.max(start.y, p.y)) - y };
    Object.assign(box.style, { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` });
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    box.remove();
    if (rect.w * pv.width * scale > 8 && rect.h * pv.height * scale > 8) {
      addAreaNote(pv, rect);
    }
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

// ---------- Claude ----------

// The page taking up most of the window.
function pageInView(): PageView | undefined {
  const visible = (pv: PageView) => {
    const r = pv.pageEl.getBoundingClientRect();
    return Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
  };
  return pages.reduce<PageView | undefined>((best, pv) => (!best || visible(pv) > visible(best) ? pv : best), undefined);
}

function askClaude(): void {
  const current = pdfSelection();
  if (current) {
    const quote = current.range.toString().replace(/\s+/g, ' ').trim();
    post({ type: 'askClaude', page: current.pv.num, quote, rects: selectionRects(current.range, current.pv) });
    return;
  }
  const mark = latestSections.find((s) => s.key === hoveredMark);
  const page = mark?.page ?? pageInView()?.num;
  if (page) {
    post({ type: 'askClaude', page, key: mark?.key });
  }
}

// Color dots shown next to a text selection on a page.
const popover = el('div', 'popover', document.body);
popover.hidden = true;
for (const color of COLORS) {
  const dot = el('button', 'dot', popover);
  dot.dataset.color = color;
  const key = Object.keys(HIGHLIGHT_KEYS).find((k) => HIGHLIGHT_KEYS[k] === color)!.slice(3);
  dot.title = `Highlight with a note (Alt+Shift+${key}; Alt+${key}: highlight only)`;
  dot.addEventListener('mousedown', (e) => {
    e.preventDefault();
    markSelection(color, true);
  });
}

function hidePopover(): void {
  popover.hidden = true;
}

function showPopover(): void {
  const current = pdfSelection();
  if (!current) {
    hidePopover();
    return;
  }
  const rects = current.range.getClientRects();
  const last = rects[rects.length - 1];
  popover.hidden = false;
  popover.style.left = `${Math.min(last.right + 6, window.innerWidth - popover.offsetWidth - 8)}px`;
  popover.style.top = `${last.bottom + 6}px`;
}

// ---------- Events ----------

viewer.addEventListener('mousedown', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('.card')) {
    return;
  }
  // Clicking the document leaves the notes: shortcuts no longer act on the last card.
  setActiveEditor(undefined);
  hidePopover();
  const pv = pageOf(target);
  if (pv && e.altKey && e.button === 0) {
    startArea(pv, e);
  }
});

viewer.addEventListener('mouseup', (e) => {
  if (!(e.target as HTMLElement).closest('.card')) {
    setTimeout(showPopover);
  }
});

viewer.addEventListener('click', (e) => {
  const pv = pageOf(e.target as Node);
  if (!pv || !window.getSelection()?.isCollapsed) {
    return;
  }
  const note = noteAt(pv, e);
  if (note) {
    openNote(note, false);
  }
});

viewer.addEventListener('mousemove', (e) => {
  const pv = pageOf(e.target as Node);
  hoveredMark = undefined;
  if (pv) {
    const note = noteAt(pv, e);
    setHover(note?.key);
    hoveredMark = note?.key;
    pv.pageEl.classList.toggle('over-mark', !!note);
  }
});
viewer.addEventListener('mouseleave', () => (hoveredMark = undefined));

// The connector of the focused card is emphasized.
for (const type of ['focusin', 'focusout']) {
  document.addEventListener(type, () =>
    setTimeout(() => {
      for (const path of document.querySelectorAll<SVGPathElement>('.lines path')) {
        path.classList.toggle('focus', !!cards.get(path.dataset.key!)?.el.contains(document.activeElement));
      }
    }),
  );
}

// Ctrl + wheel (pinch on the trackpad) zooms.
window.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey) {
      return;
    }
    e.preventDefault();
    zoom = Math.min(4, Math.max(0.25, zoom * Math.exp(-e.deltaY / 200)));
    scheduleScale();
  },
  { passive: false },
);

// While zooming, sizes and layout follow every frame (the old canvases are stretched); the pages
// are rendered sharp again once the gesture pauses, one after another, visible ones first.
let scaleFrame = 0;
let renderTimer: number | undefined;
function scheduleScale(): void {
  scaleFrame ||= requestAnimationFrame(() => {
    scaleFrame = 0;
    applyScale();
  });
  clearTimeout(renderTimer);
  renderTimer = window.setTimeout(renderNearPages, RENDER_DELAY_MS);
}

async function renderNearPages(): Promise<void> {
  const center = window.innerHeight / 2;
  const distance = (pv: PageView) => {
    const r = pv.row.getBoundingClientRect();
    return Math.max(0, r.top - center, center - r.bottom);
  };
  for (const pv of [...nearPages].sort((a, b) => distance(a) - distance(b))) {
    if (nearPages.has(pv)) {
      await renderPage(pv);
    }
  }
}
window.addEventListener('resize', scheduleScale);

window.addEventListener(
  'keydown',
  (e) => {
    document.body.classList.toggle('alt', e.altKey);
    if (isDrawingOpen()) {
      return;
    }
    // Delete/Backspace over a mark removes it with its note (unless typing somewhere).
    const typing = (document.activeElement as HTMLElement | null)?.closest('.card, [contenteditable="true"], input, textarea');
    // Cmd+Z / Cmd+Shift+Z outside the cards undo/redo adding and deleting marks and notes.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !typing && !e.altKey) {
      e.preventDefault();
      post({ type: 'undo', redo: e.shiftKey });
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && hoveredMark && !typing && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      removeNote(hoveredMark);
      hoveredMark = undefined;
      setHover(undefined);
      return;
    }
    if (!e.altKey || e.metaKey || e.ctrlKey) {
      return;
    }
    // Alt+Y in a card: collapse the list item or heading section at the cursor (like in notes).
    // The card is found from the focus (the last active editor may be another card).
    const focused = (document.activeElement as HTMLElement | null)?.closest('.card');
    if ((e.key === '¥' || e.key.toLowerCase() === 'y') && focused) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const editor = [...cards.values()].find((c) => c.el === focused)?.editor;
      if (editor) {
        toggleFold(editor.view());
        editor.view().focus();
      }
      return;
    }
    // Alt+K outside the cards asks Claude about the selected text, the mark under the pointer or the
    // page in view (inside a card it mentions the card's text, see installShortcuts).
    if (e.code === 'KeyK' && !focused) {
      e.preventDefault();
      e.stopImmediatePropagation();
      askClaude();
      return;
    }
    // Selected text: Alt+Q/W/E/R highlights it (like in notes), with Shift also opens a note on it;
    // Alt+A = random color with a note.
    const current = pdfSelection();
    const color = current && e.code === 'KeyA' ? randomColor(current.pv.num) : HIGHLIGHT_KEYS[e.code];
    if (color && current) {
      e.preventDefault();
      e.stopImmediatePropagation();
      markSelection(color, e.shiftKey || e.code === 'KeyA');
    }
  },
  true,
);
window.addEventListener('keyup', (e) => document.body.classList.toggle('alt', e.altKey));
window.addEventListener('blur', () => document.body.classList.remove('alt'));

// Formatting shortcuts only act on a focused card.
installShortcuts(() => !getActiveEditor());

window.addEventListener('message', async (event) => {
  const msg = event.data;
  if (handleHostMessage(msg)) {
    return;
  }
  switch (msg.type) {
    case 'init':
      applyInit(msg);
      distUri = msg.distUri;
      notesWidth = msg.notesWidth;
      latestSections = msg.sections;
      folds = msg.folds;
      await loadPdf(msg.pdfUrl);
      break;
    case 'notes':
      applySections(msg.sections);
      break;
    case 'notesWidth':
      notesWidth = msg.width;
      applyScale();
      break;
  }
});

post({ type: 'ready' });
