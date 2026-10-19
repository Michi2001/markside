import { type EditorState, Plugin, Selection, type TextSelection } from '@milkdown/kit/prose/state';
import { $prose } from '@milkdown/kit/utils';
import type { EditorView } from '@milkdown/kit/prose/view';
import katex from 'katex';
import * as pdfjs from 'pdfjs-dist';
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { type Anchor, type Divider, type Proposal, type Rect, type Section, formatAnchor, pageExplanation, pageKey } from '../../sidecar';
import { isDrawingOpen } from '../drawing';
import { type Fold, foldPlugin, getFolds, setFolds, toggleFold } from '../fold';
import { HIGHLIGHT_COLORS, colorFromStyle } from '../highlight';
import { applyInit, handleHostMessage, post, saveFile } from '../host';
import {
  HIGHLIGHT_KEYS,
  type NoteEditor,
  REMOVE_HIGHLIGHT_KEY,
  createNoteEditor,
  getActiveEditor,
  installShortcuts,
  listItemRange,
  runFormatCommand,
  selectedDrawings,
  setActiveEditor,
} from '../noteEditor';
import './pdf.css';

// PDF pages on the left, the notes of `paper.pdf.md` as cards next to the text or area they belong to:
// on the page itself where it has free space close to the mark (`placeOnPage`), else in the margin on
// the right (pushed down when they would overlap; long notes push the next page down). Every card is a Crepe editor of its note's body, created once the card comes near the view.
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
const MAX_NOTES_SHARE = 0.6;
// Zoom limits as page scale (not relative to the fit), so narrow windows zoom in as far as wide ones.
const MIN_ZOOM_SCALE = 0.1;
const MAX_ZOOM_SCALE = 8;
const SNAPSHOT_SCALE = 2.5;
const RENDER_DELAY_MS = 200;
const COLORS = ['yellow', 'red', 'green', 'blue'];
// Free space on a page: grid cells of CELL points, occupied where the rendered page differs from its
// background, grown by INK_PAD cells so cards keep a distance from the content.
const CELL = 4;
const INK_PAD = 2;
// Widths a card placed on the page may take (column units, like the margin), widest first; narrower
// ones cost NARROW_COST points of distance per unit, so they are only used to stay closer to the mark.
const PAGE_CARD_WIDTHS = [240, 200, 160];
const NARROW_COST = 0.1;
// Spots right of the mark count their horizontal distance only this much (reading goes on to the right).
const RIGHT_WEIGHT = 0.6;
// A card goes onto the page only within this distance of its mark (fraction of the page's longer
// side); farther away, the margin is easier to follow.
const MAX_PAGE_DISTANCE = 0.12;
// A card on the page may stick out past its right edge by this share of its width (into the margin).
const MAX_OVERHANG = 0.5;
// Hues of red and green; random colors (Alt+A, stored as `h<hue>`) keep away from them.
const AVOID_HUES = [345, 135];

type Claude = {
  page: number;
  el: HTMLElement;
  summary: HTMLElement;
  body: HTMLElement;
  // The explanation after its first paragraph (the key message, always shown).
  source: string;
  editor?: NoteEditor;
  creating?: Promise<NoteEditor>;
};

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
  // Page notes: Claude's explanation of the page, shown read-only above the own note.
  claude?: Claude;
  // Position on the page (PDF points) from the last layout, null = in the margin, undefined = not laid out yet.
  place?: { x: number; y: number; w: number } | null;
  // Kept in the margin until the focus leaves the card (new notes, Alt+P); then it may move onto the page.
  inMargin?: boolean;
};

// Occupied cells of a page (1 = content or a card), row by row; `raw`: the content itself, without
// the distance around it (connectors must not cross it).
type Grid = { cols: number; rows: number; cells: Uint8Array; raw: Uint8Array };
type Box = { x0: number; y0: number; x1: number; y1: number };

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
  // Band below the row: divider after this page (lecture end / own section), else a "+" on hover.
  divider: HTMLElement;
  renderedScale: number;
  task?: RenderTask;
  ink?: Grid;
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
// Lecture ends and own sections (`## Sections` in the notes file).
let dividers: Divider[] = [];
// Card to focus once the extension has added its note.
let pendingFocus: string | undefined;
// Collapsed list items/headings per card (`foo.pdf.assets/.folds.json`).
let folds: Record<string, Fold[]> = {};
// Mark under the pointer (Delete/Backspace removes it).
let hoveredMark: string | undefined;
// Own note card under the pointer (Alt+K asks Claude about it).
let hoveredCard: Card | undefined;
// Page whose explanation by Claude is under the pointer (Alt+K asks about it).
let hoveredClaude: number | undefined;
// Notes just created with their card open: left empty, the mark goes too.
const freshNotes = new Set<string>();
// Claude's explanations (`paper.pdf.claude.md`) as received.
let explanations: Section[] = [];
// Per page: the explanation as the webview sent it, while the file holds it (in its own formatting).
let ownExplanations: Record<number, string> = {};
let showExplanations = true;
// All explanations expanded (lightbulb); pages in `toggled` show the other state.
let expandExplanations = false;
const toggled = new Set<number>();
// Annotations Claude proposed on questions about a bullet, until accepted or rejected.
let proposals: Proposal[] = [];
// Pages near the viewport (rendered); others drop their canvas.
const nearPages = new Set<PageView>();
// Rows far from the viewport whose cards are laid out once they come near (zooming stays cheap).
const staleRows = new Set<PageView>();

// ---------- Pages ----------

function baseScale(): number {
  const maxWidth = Math.max(...pages.map((p) => p.width));
  const available = viewer.clientWidth - VIEWER_PADDING - GAP;
  // In narrow windows (split view) a wide notes setting would squeeze the pages to a minimum, so the
  // notes take at most MAX_NOTES_SHARE of the width at zoom 1.
  const notes = Math.min(notesWidth, available * MAX_NOTES_SHARE);
  return Math.max(0.3, Math.min(MAX_SCALE, (available - notes) / maxWidth));
}

function fitScale(): number {
  const base = baseScale();
  return base * clampZoom(zoom, base);
}

function clampZoom(z: number, base: number): number {
  return Math.min(MAX_ZOOM_SCALE / base, Math.max(MIN_ZOOM_SCALE / base, z));
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
  if (!pv.ink) {
    pv.ink = inkGrid(pv, canvas);
    scheduleLayout(pv);
  }
  await new pdfjs.TextLayer({ textContentSource: pv.page.streamTextContent(), container: textLayer, viewport }).render();
}

// Cells where the rendered page differs from its most frequent color (text, images, figures). A page
// with a busy background ends up fully occupied, so its cards stay in the margin.
function inkGrid(pv: PageView, canvas: HTMLCanvasElement): Grid {
  const { width, height } = canvas;
  const data = canvas.getContext('2d')!.getImageData(0, 0, width, height).data;
  const counts = new Map<number, number>();
  for (let i = 0; i < data.length; i += 4 * 7) {
    const c = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const bg = [...counts].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const [br, bgG, bb] = [((bg >> 8) & 15) * 16 + 8, ((bg >> 4) & 15) * 16 + 8, (bg & 15) * 16 + 8];
  const cols = Math.ceil(pv.width / CELL);
  const rows = Math.ceil(pv.height / CELL);
  const ink = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const row = Math.min(rows - 1, Math.floor((y / height) * rows)) * cols;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (Math.abs(data[i] - br) + Math.abs(data[i + 1] - bgG) + Math.abs(data[i + 2] - bb) > 60) {
        ink[row + Math.min(cols - 1, Math.floor((x / width) * cols))] = 1;
      }
    }
  }
  const grid = { cols, rows, cells: new Uint8Array(cols * rows), raw: ink };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (ink[r * cols + c]) {
        fillCells(grid, c - INK_PAD, r - INK_PAD, c + INK_PAD + 1, r + INK_PAD + 1);
      }
    }
  }
  return grid;
}

// Marks cells [c0, c1) x [r0, r1) as occupied (clamped to the grid).
function fillCells(grid: Grid, c0: number, r0: number, c1: number, r1: number): void {
  for (let r = Math.max(0, r0); r < Math.min(grid.rows, r1); r++) {
    grid.cells.fill(1, r * grid.cols + Math.max(0, c0), r * grid.cols + Math.min(grid.cols, c1));
  }
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
  const divider = el('div', 'divider', row);
  divider.addEventListener('mousedown', (e) => e.preventDefault());
  divider.addEventListener('click', (e) => {
    const del = (e.target as Element).closest('.divider-del');
    post(del ? { type: 'deleteDivider', after: page.pageNumber } : { type: 'editDivider', after: page.pageNumber });
  });
  return { num: page.pageNumber, page, width, height, row, pageEl, marks, margin, lines, divider, renderedScale: 0 };
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
  applyExplanations(explanations);
  applyDividers(dividers);
  pages.forEach((pv) => pageObserver.observe(pv.row));
  reportView();
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
  const claude = section.anchor ? undefined : createClaude(cardEl, section.page);
  const body = el('div', 'card-body', cardEl);
  const card: Card = { key: section.key, section, el: cardEl, body, source: splitBody(section).text, sent: [], claude };
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
      // No longer kept in its spot: it may move (onto the page, or off it when it grew over its text).
      card.inMargin = false;
      scheduleLayout(pv);
      if (card.editor) {
        removeEmptyItems(card.editor.view());
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

// Bullets left without text (Enter after the last one) go once the card is left; a list without
// any item left goes as a whole.
function removeEmptyItems(view: EditorView): void {
  const empty: number[] = [];
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === 'list_item' && node.childCount === 1 && node.firstChild!.isTextblock && node.firstChild!.content.size === 0) {
      empty.push(pos);
    }
  });
  if (empty.length === 0) {
    return;
  }
  const tr = view.state.tr;
  for (const pos of empty.reverse()) {
    const $pos = tr.doc.resolve(pos);
    if ($pos.parent.childCount === 1) {
      tr.delete($pos.before(), $pos.after());
    } else {
      tr.delete(pos, pos + tr.doc.nodeAt(pos)!.nodeSize);
    }
  }
  view.dispatch(tr);
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
        if (card.claude?.el.classList.contains('open')) {
          ensureClaudeEditor(card.claude);
        }
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
// `fresh`: a note just created; it is written in the margin and placed once the focus leaves it.
function openNote(section: Section, atEnd: boolean, fresh = false): void {
  const card = cards.get(section.key) ?? createCard(section);
  if (fresh || card.place === undefined) {
    card.inMargin = true;
  }
  layoutRow(pageView(section.page)!);
  focusCard(card, atEnd);
}

function emptyPageSection(page: number): Section {
  return { key: pageKey(page), page, label: '', body: '', start: 0, bodyStart: 0, end: 0 };
}

// Syncs the cards with the notes in the file. Cards whose body equals what they last exchanged with
// the extension are left alone, so typing is never interrupted by its own echo.
function applySections(sections: Section[], reset: string[] = []): void {
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
    if (text !== card.source && (!card.sent.includes(text) || reset.includes(section.key))) {
      card.source = text;
      if (reset.includes(section.key)) {
        card.sent = [];
      }
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
    updateClaude(card);
  }
  applyProposals();
  renderMarks();
  layoutAll();
  const focus = pendingFocus && byKey.get(pendingFocus);
  if (focus) {
    pendingFocus = undefined;
    openNote(focus, true, true);
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

// ---------- Explanations by Claude ----------

// Claude's explanation sits at the top of the page note card: its key message (first paragraph)
// when collapsed, the whole explanation in an editor when expanded (created once near the viewport).
// The user may edit it; what they type is always italic (`ownItalic`), Claude never writes italics,
// so authorship stays visible.
function createClaude(cardEl: HTMLElement, page: number): Claude {
  const claudeEl = el('div', 'claude', cardEl);
  const head = el('div', 'claude-head', claudeEl);
  const summary = el('span', 'claude-summary', head);
  el('span', 'claude-chevron', head).title = 'Show/hide the explanation';
  const del = el('button', 'card-delete', head);
  del.title = 'Dismiss explanation';
  del.textContent = '×';
  const body = el('div', 'claude-body', claudeEl);
  del.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Cmd+Z afterwards undoes this, not the last edit of a focused card.
    (document.activeElement as HTMLElement | null)?.blur();
    post({ type: 'deleteExplanation', page });
  });
  // A plain click toggles; dragging selects the text (Alt+K asks Claude about it).
  head.addEventListener('click', () => {
    if (window.getSelection()?.isCollapsed && claudeEl.classList.contains('more')) {
      if (!toggled.delete(page)) {
        toggled.add(page);
      }
      updateClaude(cards.get(pageKey(page))!);
    }
  });
  // Double-click selects a whole bullet (or the key message), ready to highlight.
  claudeEl.addEventListener('dblclick', (e) => {
    const target = e.target as Element;
    const block = summary.contains(target) ? summary : target.closest('.claude-body p');
    if (block) {
      const range = document.createRange();
      range.selectNodeContents(block);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      showPopover();
    }
  });
  // Changes that arrived while typing are shown once the editor is left.
  claudeEl.addEventListener('focusout', () =>
    setTimeout(() => {
      if (!claudeEl.contains(document.activeElement)) {
        updateClaude(cards.get(pageKey(page))!);
      }
    }),
  );
  return { page, el: claudeEl, summary, body, source: '' };
}

// Text typed into an explanation is italic: the cursor always carries the emphasis mark (also after
// moving it next to Claude's text). Moved or pasted text keeps its formatting.
const ownItalic = $prose(
  () =>
    new Plugin({
      appendTransaction: (_trs, _old, state) => {
        const em = state.schema.marks.emphasis;
        const $cursor = (state.selection as TextSelection).$cursor;
        if (!em || !$cursor || !$cursor.parent.type.allowsMarkType(em)) {
          return null;
        }
        const marks = state.storedMarks ?? $cursor.marks();
        return em.isInSet(marks) ? null : state.tr.setStoredMarks(em.create().addToSet(marks));
      },
    }),
);

// A page's explanation as shown: the text the webview sent last if the file still holds it.
function explanationText(page: number): string {
  return showExplanations ? (ownExplanations[page] ?? pageExplanation(explanations, page)) : '';
}

// A page's explanation: key message (first paragraph) and the rest.
function splitExplanation(markdown: string): { first: string; rest: string } {
  const split = /\n\s*\n/.exec(markdown);
  return split ? { first: markdown.slice(0, split.index), rest: markdown.slice(split.index + split[0].length).trim() } : { first: markdown, rest: '' };
}

function ensureClaudeEditor(claude: Claude): void {
  claude.creating ??= (async () => {
    claude.body.textContent = '';
    const editor = await createNoteEditor(
      claude.body,
      claude.source,
      (markdown) => {
        claude.source = markdown;
        post({ type: 'editExplanation', page: claude.page, text: markdown, undoable: false });
      },
      (crepe) => crepe.editor.use(ownItalic),
    );
    claude.editor = editor;
    return editor;
  })();
}

// Plain text of a Markdown paragraph.
function plain(markdown: string): string {
  return markdown
    .replace(/<\/?mark[^>]*>/gi, '')
    .replace(/==([^=]+)==/g, '$1').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`$>#]/g, '').replace(/\s+/g, ' ').trim();
}

// Highlight color of the key message (it is highlighted as a whole).
function summaryColor(markdown: string): string | undefined {
  const tag = /<mark(\s[^>]*)?>/i.exec(markdown)?.[0];
  return tag ? colorFromStyle(tag) : /==[^=]+==/.test(markdown) ? 'yellow' : undefined;
}

// Highlights the whole key message in `color`, or removes its highlight if it has that color
// (null: removes any highlight).
function toggleSummaryMark(markdown: string, color: string | null): string {
  const current = summaryColor(markdown);
  const bare = markdown.replace(/<\/?mark[^>]*>/gi, '').replace(/==/g, '');
  if (!color || current === color) {
    return bare;
  }
  const wrap = (text: string) => (color === 'yellow' ? `==${text}==` : `<mark style="background: ${HIGHLIGHT_COLORS[color]};">${text}</mark>`);
  const bold = /^\*\*([\s\S]*)\*\*$/.exec(bare);
  return bold ? `**${wrap(bold[1])}**` : wrap(bare);
}

// The explanation (card) holding the current text selection or cursor.
function explanationAtSelection(): Card | undefined {
  const node = window.getSelection()?.anchorNode;
  const claudeEl = (node instanceof Element ? node : node?.parentElement)?.closest('.claude');
  return claudeEl ? [...cards.values()].find((c) => c.claude?.el === claudeEl) : undefined;
}

function inSummary(card: Card): boolean {
  return !!card.claude?.summary.contains(window.getSelection()?.anchorNode ?? null);
}

// Highlights the collapsed key message as a whole (color null removes it); undoable with Cmd+Z.
function markSummary(card: Card, color: string | null): void {
  const { first, rest } = splitExplanation(explanationText(card.section.page));
  const text = [toggleSummaryMark(first, color), rest].filter(Boolean).join('\n\n');
  post({ type: 'editExplanation', page: card.section.page, text, undoable: true });
  window.getSelection()?.removeAllRanges();
  setActiveEditor(undefined);
  hidePopover();
}

// The popover's dots on a selection in an explanation: the key message, else the editor.
function highlightExplanation(card: Card, color: string): void {
  if (inSummary(card)) {
    markSummary(card, color);
  } else if (card.claude?.editor) {
    runFormatCommand(card.claude.editor, 'ToggleHighlight', color);
    hidePopover();
  }
}

function updateClaude(card: Card): void {
  const { claude } = card;
  if (!claude) {
    return;
  }
  const page = card.section.page;
  const markdown = explanationText(page);
  const { first } = splitExplanation(markdown);
  const open = !!markdown && expandExplanations !== toggled.has(page);
  card.el.classList.toggle('has-claude', !!markdown);
  claude.el.classList.toggle('more', !!markdown);
  claude.el.classList.toggle('open', open);
  const color = summaryColor(first);
  claude.summary.textContent = color ? '' : plain(first);
  if (color) {
    const mark = el('mark', '', claude.summary);
    mark.textContent = plain(first);
    if (HIGHLIGHT_COLORS[color]) {
      mark.dataset.color = color;
    } else {
      mark.style.background = color;
    }
  }
  // Not while typing in it (a late echo would reset the editor).
  if (markdown !== claude.source && !claude.el.contains(document.activeElement)) {
    claude.source = markdown;
    if (claude.editor) {
      claude.editor.setMarkdown(markdown);
    } else if (!claude.creating) {
      claude.body.textContent = markdown;
    }
  }
  if (open && card.creating) {
    ensureClaudeEditor(claude);
  }
}

function applyExplanations(sections: Section[], own: Record<number, string> = ownExplanations): void {
  explanations = sections;
  ownExplanations = own;
  cards.forEach(updateClaude);
  applyProposals();
  layoutAll();
}

// ---------- Annotations proposed by Claude ----------

// A proposal sits below what the question was about (the explanation or the note) with buttons to
// add it there (as a sub-bullet of the bullet asked about, a new note on a selected passage; marked
// as Claude's) or to drop it.
function applyProposals(): void {
  document.querySelectorAll('.proposal').forEach((node) => node.remove());
  for (const p of proposals) {
    // A passage or mark without a note card yet: shown in the page note.
    const card = cards.get(p.key) ?? cards.get(pageKey(p.page));
    const parent = p.explanation ? card?.claude?.el : card?.el;
    if (!parent) {
      continue;
    }
    const box = el('div', 'proposal', parent);
    const head = el('div', 'proposal-head', box);
    el('span', 'proposal-label', head).textContent = p.replace ? 'Change suggested by Claude' : 'Suggested by Claude';
    if (p.quote) {
      const quote = el('span', 'proposal-quote', head);
      quote.textContent = `${p.replace ? 'replaces' : 'on'} „${p.quote}“`;
      quote.title = p.quote;
    }
    // Bullets as • (indented like their Markdown).
    const text = el('div', 'proposal-text', box);
    for (const line of p.body.split('\n').filter((l) => l.trim())) {
      const bullet = /^(\s*)(?:[-*+]|\d+[.)])\s+/.exec(line);
      const row = el('div', bullet ? 'proposal-bullet' : '', text);
      row.innerHTML = inlineHtml(bullet ? line.slice(bullet[0].length) : line);
      row.style.marginLeft = bullet ? `${bullet[1].length / 2 + 1}em` : '';
    }
    const actions = el('div', 'proposal-actions', box);
    const accept = el('button', 'proposal-accept', actions);
    accept.textContent = p.replace ? 'Replace' : 'Add';
    accept.title = p.replace ? 'Replace the bullet with this version' : p.quote ? 'Add below the bullet' : 'Add to the end';
    const reject = el('button', 'proposal-reject', actions);
    reject.textContent = 'Dismiss';
    const answer = (type: 'acceptProposal' | 'rejectProposal') => (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      proposals = proposals.filter((q) => q !== p);
      box.remove();
      post({ type, id: p.id });
    };
    accept.addEventListener('mousedown', answer('acceptProposal'));
    reject.addEventListener('mousedown', answer('rejectProposal'));
  }
}

// A line of a proposal as HTML: math via KaTeX, bold, italics and code; everything else as text.
function inlineHtml(markdown: string): string {
  const escape = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return markdown
    .split(/(\$\$[^$]+\$\$|\$[^$\n]+\$|`[^`]+`)/)
    .map((part, i) => {
      if (i % 2 === 0) {
        return escape(part)
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
      }
      if (part.startsWith('`')) {
        return `<code>${escape(part.slice(1, -1))}</code>`;
      }
      const display = part.startsWith('$$');
      return katex.renderToString(part.slice(display ? 2 : 1, display ? -2 : -1), { throwOnError: false });
    })
    .join('');
}

// What Alt+K in an editor asks about: the selected text, else the bullet at the cursor.
function questionText(state: EditorState): string | undefined {
  const { from, to } = state.selection.empty ? (listItemRange(state) ?? state.selection) : state.selection;
  return state.doc.textBetween(from, to, ' ', ' ').replace(/\s+/g, ' ').trim() || undefined;
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

// Cards of marks go onto the page, into the free spot closest to their mark (`placeOnPage`); page
// notes and cards without room go into the margin, each at the height of its mark, below the previous
// card if they would overlap; the row grows when the notes are longer than the page.
// A card being edited (or an opened explanation) keeps its spot, so it never jumps while typing.
// Margin positions are in the column's own units (before its zoom), page positions in PDF points.
function layoutRow(pv: PageView): void {
  const z = notesZoom();
  const pageHeight = (pv.height * scale) / z;
  const rowCards = cardsOf(pv);
  const pinned = (card: Card) =>
    !!card.inMargin || (card.place !== undefined && card.el.contains(document.activeElement));
  const trying = rowCards.filter((card) => !pinned(card) && card.section.anchor && pv.ink);
  // Heights at each width a card is tried with; reads and writes in batches, not per card.
  rowCards.forEach((card) => {
    const onPage = pinned(card) ? !!card.place && !card.inMargin : trying.includes(card);
    card.el.classList.toggle('on-page', onPage);
    card.el.style.width = onPage && card.place ? `${card.place.w}px` : '';
  });
  const heights = new Map(rowCards.map((card) => [card, card.el.offsetHeight]));
  const heightsAt = PAGE_CARD_WIDTHS.map((w) => {
    trying.forEach((card) => (card.el.style.width = `${w}px`));
    return new Map(trying.map((card) => [card, card.el.offsetHeight]));
  });
  const grid = pv.ink && freeGrid(pv);
  const toPoints = (px: number) => (px * z) / scale;
  const boxes: Box[] = [];
  // A placed card and its connector take their cells, so later cards neither cover nor cross them.
  const reserve = (card: Card) => {
    const { x, y, w } = card.place!;
    const box = { x0: x, y0: y, x1: x + toPoints(w), y1: y + toPoints(heights.get(card)!) };
    boxes.push(box);
    fillCells(grid!, Math.floor(box.x0 / CELL) - 1, Math.floor(box.y0 / CELL) - 1, Math.ceil(box.x1 / CELL) + 1, Math.ceil(box.y1 / CELL) + 1);
    alongLine(connector(markBox(card.section.anchor!, pv.width, pv.height), box), (c, r) => fillCells(grid!, c, r, c + 1, r + 1));
  };
  for (const card of rowCards) {
    if (card.inMargin) {
      card.place = null;
    } else if (pinned(card) && card.place && grid) {
      reserve(card);
    }
  }
  for (const card of trying) {
    const sizes = PAGE_CARD_WIDTHS.map((w, i) => ({ w, wPt: toPoints(w), hPt: toPoints(heightsAt[i].get(card)!) }));
    card.place = placeOnPage(pv, grid!, card.section.anchor!, sizes, boxes);
    if (card.place) {
      heights.set(card, heightsAt[PAGE_CARD_WIDTHS.indexOf(card.place.w)].get(card)!);
      reserve(card);
    }
  }
  const margin = rowCards.filter((card) => !card.place);
  margin.forEach((card) => {
    card.el.classList.remove('on-page');
    card.el.style.width = '';
  });
  rowCards.forEach((card) => card.place && (card.el.style.width = `${card.place.w}px`));
  margin.forEach((card) => heights.set(card, card.el.offsetHeight));

  // Cards sticking out of the page into the column: margin cards go above or below them.
  const overhangs = rowCards
    .filter((card) => card.place && card.place.x * scale + card.place.w * z > pv.width * scale + GAP)
    .map((card) => {
      const t = (card.place!.y * scale) / z;
      return { top: t - CARD_GAP, bottom: t + heights.get(card)! + CARD_GAP };
    });
  let y = 0;
  const placed: { card: Card; top: number }[] = [];
  for (const card of rowCards) {
    if (card.place) {
      card.el.style.left = `${(card.place.x * scale - pv.width * scale - GAP) / z}px`;
      card.el.style.top = `${(card.place.y * scale) / z}px`;
    } else {
      const desired = card.section.anchor ? top(card.section.anchor) * pageHeight - 10 : 0;
      let cardTop = Math.max(desired, y);
      let blocking;
      while ((blocking = overhangs.find((o) => o.top < cardTop + heights.get(card)! && cardTop < o.bottom))) {
        cardTop = blocking.bottom;
      }
      card.el.style.left = '';
      card.el.style.top = `${cardTop}px`;
      y = cardTop + heights.get(card)! + CARD_GAP;
    }
    placed.push({ card, top: parseFloat(card.el.style.top) });
  }
  pv.margin.style.height = `${Math.max(pageHeight, y)}px`;
  drawLines(pv, placed, heights);
}

// The page's content plus all marks on it, as occupied cells.
function freeGrid(pv: PageView): Grid {
  const grid = { ...pv.ink!, cells: pv.ink!.cells.slice() };
  for (const section of latestSections) {
    if (section.anchor?.page !== pv.num) {
      continue;
    }
    for (const r of section.anchor.rects) {
      fillCells(grid, Math.floor((r.x * pv.width) / CELL), Math.floor((r.y * pv.height) / CELL), Math.ceil(((r.x + r.w) * pv.width) / CELL), Math.ceil(((r.y + r.h) * pv.height) / CELL));
    }
  }
  return grid;
}

// Bounding box of a mark, in units of a page of size w x h.
function markBox(anchor: Anchor, w: number, h: number): Box {
  return {
    x0: Math.min(...anchor.rects.map((r) => r.x)) * w,
    y0: Math.min(...anchor.rects.map((r) => r.y)) * h,
    x1: Math.max(...anchor.rects.map((r) => r.x + r.w)) * w,
    y1: Math.max(...anchor.rects.map((r) => r.y + r.h)) * h,
  };
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

// Connector between a mark and a card on the page: the shortest line between the two boxes.
function connector(m: Box, c: Box): [number, number, number, number] {
  const sx = clamp((c.x0 + c.x1) / 2, m.x0, m.x1);
  const sy = clamp((c.y0 + c.y1) / 2, m.y0, m.y1);
  const ex = clamp(sx, c.x0, c.x1);
  const ey = clamp(sy, c.y0, c.y1);
  return [clamp(ex, m.x0, m.x1), clamp(ey, m.y0, m.y1), ex, ey];
}

// Calls `visit` with the grid cell (column, row) of points along the line (PDF points); stops when it
// returns false.
function alongLine([x0, y0, x1, y1]: [number, number, number, number], visit: (c: number, r: number, x: number, y: number) => boolean | void): boolean {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (CELL / 2));
  for (let i = 1; i < steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    const y = y0 + ((y1 - y0) * i) / steps;
    if (visit(Math.floor(x / CELL), Math.floor(y / CELL), x, y) === false) {
      return false;
    }
  }
  return true;
}

// Free spot (PDF points) closest to the mark for a card in one of its `sizes` (`w` in column units,
// `wPt`/`hPt` in points) whose connector crosses neither content nor other cards (`boxes`), or null
// when there is none closer than the margin.
function placeOnPage(
  pv: PageView,
  grid: Grid,
  anchor: Anchor,
  sizes: { w: number; wPt: number; hPt: number }[],
  boxes: Box[],
): { x: number; y: number; w: number } | null {
  const { cols, rows, cells, raw } = grid;
  // Summed-area table: occupied cells in any rectangle in constant time.
  const sum = new Int32Array((cols + 1) * (rows + 1));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      sum[(r + 1) * (cols + 1) + c + 1] = cells[r * cols + c] + sum[r * (cols + 1) + c + 1] + sum[(r + 1) * (cols + 1) + c] - sum[r * (cols + 1) + c];
    }
  }
  const mark = markBox(anchor, pv.width, pv.height);
  const inside = (b: Box, x: number, y: number) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
  // The mark's own glyphs may reach a little past its rectangles (descenders, cell rounding).
  const own = { x0: mark.x0 - CELL, y0: mark.y0 - CELL, x1: mark.x1 + CELL, y1: mark.y1 + CELL };
  const clearLine = (card: Box) =>
    alongLine(connector(mark, card), (c, r, x, y) =>
      inside(own, x, y) || inside(card, x, y) || ((c >= cols || !raw[r * cols + c]) && !boxes.some((b) => inside(b, x, y))),
    );
  // Past the page's right edge there are no cells, only other cards.
  const clearOutside = (card: Box) =>
    card.x1 <= pv.width || !boxes.some((b) => b.x1 > pv.width && b.x0 < card.x1 && card.x0 < b.x1 && b.y0 < card.y1 && card.y0 < b.y1);
  // The margin starts at the page's right edge; a spot farther away than that is no gain.
  let best = Math.min(pv.width - mark.x1 + GAP / scale, MAX_PAGE_DISTANCE * Math.max(pv.width, pv.height));
  let place: { x: number; y: number; w: number } | null = null;
  for (const { w, wPt, hPt } of sizes) {
    const cost = (PAGE_CARD_WIDTHS[0] - w) * NARROW_COST;
    const cw = Math.ceil(wPt / CELL);
    const ch = Math.ceil(hPt / CELL);
    for (let r = 0; r + ch <= rows; r++) {
      const y = r * CELL;
      const dy = Math.max(0, y - mark.y1, mark.y0 - (y + hPt));
      if (dy + cost >= best) {
        continue;
      }
      for (let c = 0; c + cw <= cols + Math.floor(cw * MAX_OVERHANG); c++) {
        const x = c * CELL;
        const dx = x >= mark.x1 ? (x - mark.x1) * RIGHT_WEIGHT : Math.max(0, mark.x0 - (x + wPt));
        const d = Math.hypot(dx, dy) + cost;
        const c1 = Math.min(c + cw, cols);
        const used = () =>
          sum[(r + ch) * (cols + 1) + c1] - sum[r * (cols + 1) + c1] - sum[(r + ch) * (cols + 1) + c] + sum[r * (cols + 1) + c];
        const box = { x0: x, y0: y, x1: x + wPt, y1: y + hPt };
        if (d < best && used() === 0 && clearOutside(box) && clearLine(box)) {
          best = d;
          place = { x, y, w };
        }
      }
    }
  }
  return place;
}

// Connector from each mark to its card: on the page the shortest line between them, to the margin a
// curve from the page edge level with the mark (so it never runs across the page's text).
function drawLines(pv: PageView, placed: { card: Card; top: number }[], heights: Map<Card, number>): void {
  const pageWidth = pv.width * scale;
  const pageHeight = pv.height * scale;
  // Computed, not measured: the page starts the row and the column follows after the flex gap (GAP).
  // Measuring the zoomed column differs between Chromium versions (CSS zoom semantics changed).
  const x1 = pageWidth + GAP;
  const z = notesZoom();
  pv.lines.replaceChildren();
  for (const { card, top: cardTop } of placed) {
    const { anchor } = card.section;
    if (!anchor) {
      continue;
    }
    let d: string;
    if (card.place) {
      const x0 = card.place.x * scale;
      const y0 = card.place.y * scale;
      const box = { x0, y0, x1: x0 + card.place.w * z, y1: y0 + heights.get(card)! * z };
      const [sx, sy, ex, ey] = connector(markBox(anchor, pageWidth, pageHeight), box);
      d = `M${sx},${sy} L${ex},${ey}`;
    } else {
      const first = anchor.rects.reduce((a, b) => (b.y < a.y ? b : a));
      const sy = (first.y + first.h / 2) * pageHeight;
      const ey = (cardTop + 14) * z;
      const edge = pageWidth;
      d = `M${edge},${sy} C${edge + GAP / 2},${sy} ${x1 - GAP / 2},${ey} ${x1},${ey}`;
    }
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
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
  const range = snapToWords(selection.getRangeAt(0));
  const pv = pageOf(range.startContainer);
  return pv && pv.pageEl.contains(range.startContainer) ? { range, pv } : undefined;
}

// Completes words cut at the selection's ends: the text layer's glyphs don't match the PDF's exactly
// (e.g. a "• " in front of a bullet's text), so a drag starting on the first letter often begins after it.
function snapToWords(selected: Range): Range {
  const range = selected.cloneRange();
  const word = /[\p{L}\p{N}]/u;
  const start = range.startContainer;
  if (start.nodeType === Node.TEXT_NODE) {
    const text = start.textContent!;
    let i = range.startOffset;
    while (i > 0 && i < text.length && word.test(text[i]) && word.test(text[i - 1])) {
      i--;
    }
    range.setStart(start, i);
  }
  const end = range.endContainer;
  if (end.nodeType === Node.TEXT_NODE) {
    const text = end.textContent!;
    let i = range.endOffset;
    while (i > 0 && i < text.length && word.test(text[i - 1]) && word.test(text[i])) {
      i++;
    }
    range.setEnd(end, i);
  }
  return range;
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

// ---------- Dividers ----------

// A dated divider ends a lecture (red line), one with a title only starts an own section.
function applyDividers(list: Divider[]): void {
  dividers = list;
  for (const pv of pages) {
    const d = list.find((d) => d.after === pv.num);
    pv.row.classList.toggle('divided', !!d);
    pv.divider.classList.toggle('lecture', !!d?.date);
    pv.divider.replaceChildren();
    if (!d) {
      el('span', 'divider-add', pv.divider).textContent = '+';
      pv.divider.title = 'Add a lecture end or section here';
      continue;
    }
    const label = el('span', 'divider-label', pv.divider);
    if (d.date) {
      const [y, m, day] = d.date.split('-').map(Number);
      el('span', 'divider-date', label).textContent = new Date(y, m - 1, day).toLocaleDateString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    }
    if (d.title) {
      el('span', 'divider-title', label).textContent = d.title;
    }
    el('span', 'divider-del', pv.divider).textContent = '×';
    pv.divider.title = d.date ? `Lecture end after page ${pv.num} (click to edit)` : `Section starting on page ${pv.num + 1} (click to edit)`;
  }
}

function revealDivider(after: number): void {
  const pv = pageView(after);
  if (pv) {
    window.scrollTo(0, pv.row.offsetTop + pv.row.offsetHeight);
  }
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

// Tells the extension which page is in view (the explain command starts there).
let viewTimer: number | undefined;
function reportView(): void {
  clearTimeout(viewTimer);
  viewTimer = window.setTimeout(() => post({ type: 'view', page: pageInView()?.num ?? 1, pages: pages.length }), 300);
}
window.addEventListener('scroll', reportView);

// Plain text of every page, for choosing slides by topic.
async function allPageTexts(): Promise<string[]> {
  return Promise.all(
    pages.map(async (pv) =>
      (await pv.page.getTextContent()).items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    ),
  );
}

// Text selected in Claude's explanation of a page.
function explanationSelection(): { page: number; quote: string } | undefined {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return undefined;
  }
  const claudeEl = (selection.getRangeAt(0).commonAncestorContainer as Element).parentElement?.closest('.claude');
  const card = [...cards.values()].find((c) => c.claude?.el === claudeEl);
  return card && { page: card.section.page, quote: selection.toString().replace(/\s+/g, ' ').trim() };
}

function askClaude(): void {
  const explained = explanationSelection();
  if (explained) {
    post({ type: 'askClaude', page: explained.page, quote: explained.quote, explanation: true });
    return;
  }
  if (hoveredClaude) {
    post({ type: 'askClaude', page: hoveredClaude, explanation: true });
    return;
  }
  const current = pdfSelection();
  if (current) {
    const quote = current.range.toString().replace(/\s+/g, ' ').trim();
    // Color of the note it may get from Claude's proposal (random, like Alt+A).
    post({ type: 'askClaude', page: current.pv.num, quote, rects: selectionRects(current.range, current.pv), color: randomColor(current.pv.num) });
    return;
  }
  if (hoveredCard) {
    post({ type: 'askClaude', page: hoveredCard.section.page, key: hoveredCard.key, note: true });
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
    const explained = explanationAtSelection();
    if (explained) {
      highlightExplanation(explained, color);
    } else {
      markSelection(color, true);
    }
  });
}

function hidePopover(): void {
  popover.hidden = true;
}

function showPopover(): void {
  const selection = window.getSelection();
  const explained = selection && !selection.isCollapsed && explanationAtSelection();
  const range = pdfSelection()?.range ?? (explained ? selection.getRangeAt(0) : undefined);
  if (!range) {
    hidePopover();
    return;
  }
  for (const dot of popover.querySelectorAll<HTMLElement>('.dot')) {
    const key = Object.keys(HIGHLIGHT_KEYS).find((k) => HIGHLIGHT_KEYS[k] === dot.dataset.color)!.slice(3);
    dot.title = explained ? `Highlight (Alt+${key})` : `Highlight with a note (Alt+Shift+${key}; Alt+${key}: highlight only)`;
  }
  const rects = range.getClientRects();
  const last = rects[rects.length - 1];
  popover.hidden = false;
  popover.style.left = `${Math.min(last.right + 6, window.innerWidth - popover.offsetWidth - 8)}px`;
  popover.style.top = `${last.bottom + 6}px`;
}

// ---------- Events ----------

viewer.addEventListener('mousedown', (e) => {
  const target = e.target as HTMLElement;
  if (target.closest('.card')) {
    hidePopover();
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
  const target = e.target as HTMLElement;
  if (!target.closest('.card') || target.closest('.claude')) {
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
  const cardEl = (e.target as Element).closest?.('.card');
  hoveredCard = [...cards.values()].find((c) => c.el === cardEl);
  hoveredClaude = (e.target as Element).closest?.('.claude') ? hoveredCard?.section.page : undefined;
  hoveredMark = undefined;
  if (pv) {
    const note = noteAt(pv, e);
    setHover(note?.key);
    hoveredMark = note?.key;
    pv.pageEl.classList.toggle('over-mark', !!note);
  }
});
viewer.addEventListener('mouseleave', () => {
  hoveredMark = undefined;
  hoveredCard = undefined;
  hoveredClaude = undefined;
});

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
    zoom = clampZoom(zoom * Math.exp(-e.deltaY / 200), baseScale());
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
    // Shift+Delete/Backspace in a card deletes its whole note (with the mark; a page note is emptied).
    const cardEl = (document.activeElement as HTMLElement | null)?.closest('.card');
    const typingCard = [...cards.values()].find((c) => c.el === cardEl);
    // Typing in Claude's explanation (part of the page note card).
    const inClaude = !!(document.activeElement as HTMLElement | null)?.closest('.claude');
    // Shift+Enter finishes editing a card (outside code blocks, where it stays a line break).
    if (e.key === 'Enter' && e.shiftKey && typingCard && !e.altKey && !e.metaKey && !e.ctrlKey && !(document.activeElement as HTMLElement).closest('.cm-editor')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      (document.activeElement as HTMLElement).blur();
      setActiveEditor(undefined);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && e.shiftKey && typingCard && !inClaude && !e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (typingCard.section.anchor) {
        removeNote(typingCard.key);
      } else {
        typingCard.editor?.setMarkdown('');
        typingCard.source = '';
        typingCard.el.classList.add('empty');
        post({ type: 'editNote', key: typingCard.key, text: '' });
      }
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
    // Alt+Q/W/E/R in the collapsed key message of an explanation highlight it, Alt+X removes that
    // (in the expanded explanation, its editor handles the shortcuts like any card).
    const marking = !e.shiftKey && (HIGHLIGHT_KEYS[e.code] || e.code === REMOVE_HIGHLIGHT_KEY);
    const summaryCard = marking ? explanationAtSelection() : undefined;
    if (summaryCard && inSummary(summaryCard)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      markSummary(summaryCard, HIGHLIGHT_KEYS[e.code] ?? null);
      return;
    }
    // Alt+Y in a card: collapse the list item or heading section at the cursor (like in notes).
    // The card is found from the focus (the last active editor may be another card).
    const focused = (document.activeElement as HTMLElement | null)?.closest('.card');
    if ((e.key === '¥' || e.key.toLowerCase() === 'y') && focused) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const card = [...cards.values()].find((c) => c.el === focused);
      const editor = inClaude ? card?.claude?.editor : card?.editor;
      if (editor) {
        toggleFold(editor.view());
        editor.view().focus();
      }
      return;
    }
    // Alt+P in a card: move it into the margin while editing it; placed again once the focus leaves.
    // (Not Alt+N: on the Mac, Option+N is the dead key for ~, which preventDefault doesn't stop.)
    if (e.code === 'KeyP' && focused) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const card = [...cards.values()].find((c) => c.el === focused);
      if (card && !card.inMargin) {
        card.inMargin = true;
        layoutRow(pageView(card.section.page)!);
        card.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      return;
    }
    // Alt+K in a card asks Claude about it; Claude then proposes an annotation (`applyProposals`).
    const focusedCard = [...cards.values()].find((c) => c.el === focused);
    // Alt+K in Claude's explanation asks about the selected passage or the bullet at the cursor, else
    // the whole explanation.
    if (e.code === 'KeyK' && focusedCard && inClaude) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const state = focusedCard.claude?.editor?.view().state;
      const quote = state ? questionText(state) : window.getSelection()?.toString().replace(/\s+/g, ' ').trim() || undefined;
      post({ type: 'askClaude', page: focusedCard.section.page, quote, explanation: true });
      return;
    }
    // Alt+K in a note asks about the selected text or the bullet at the cursor, else the whole note;
    // selected drawings go along as PNG.
    const cardState = focusedCard?.editor?.view().state;
    if (e.code === 'KeyK' && focusedCard && cardState) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const ask = { type: 'askClaude', page: focusedCard.section.page, key: focusedCard.key, note: true, quote: questionText(cardState) };
      selectedDrawings(cardState).then((drawings) => post({ ...ask, drawings }));
      return;
    }
    // Alt+K outside the cards asks Claude about the selected text, the note card or mark under the
    // pointer or the page in view.
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
      dividers = msg.dividers;
      explanations = msg.explanations;
      ownExplanations = msg.ownExplanations;
      showExplanations = msg.showExplanations;
      expandExplanations = msg.expandExplanations;
      folds = msg.folds;
      proposals = msg.proposals;
      await loadPdf(msg.pdfUrl);
      break;
    case 'notes':
      applySections(msg.sections, msg.reset);
      applyDividers(msg.dividers);
      break;
    case 'revealDivider':
      revealDivider(msg.after);
      break;
    case 'requestPageTexts':
      post({ type: 'pageTexts', texts: await allPageTexts() });
      break;
    case 'explanations':
      applyExplanations(msg.sections, msg.own);
      break;
    case 'proposals':
      proposals = msg.proposals;
      applyProposals();
      break;
    case 'showExplanations':
      showExplanations = msg.show;
      if (msg.expand !== expandExplanations) {
        expandExplanations = msg.expand;
        toggled.clear();
      }
      applyExplanations(explanations);
      break;
    case 'notesWidth':
      notesWidth = msg.width;
      applyScale();
      break;
  }
});

post({ type: 'ready' });
