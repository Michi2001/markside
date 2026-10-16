import {
  type Background,
  type Drawing,
  type DrawingFile,
  type Stroke,
  blobToDataUrl,
  drawingFile,
  isDrawing,
  openDrawingEditor,
  parseDrawing,
} from '../webview/drawing';
import './style.css';

// Waits for drawing requests from the Mac (server-sent events) and sends the result back.
// The page is served under /<token>/, so relative URLs carry the token.
const status = document.getElementById('status') as HTMLElement;
let currentId = 0;
let abort: AbortController | undefined;

// Nothing drawn here may get lost when Safari reloads the page or the connection drops:
// DRAFT holds the open canvas (from the first change on), OUTBOX finished results until the Mac has
// received them, ORPHAN a draft whose request the Mac dropped (offered on the next request).
// `target` tells the Mac where a drawing belongs, so it can save it even when nobody waits for it.
type Target = { note: string; src: string | null };
type Draft = { id: number; target: Target; image?: Background; strokes: Stroke[] };
type Result = { id: number; target: Target; file: DrawingFile | null };
const DRAFT = 'mdlive-draft';
const OUTBOX = 'mdlive-outbox';
const ORPHAN = 'mdlive-orphan';

function load<T>(key: string): T | null {
  return JSON.parse(localStorage.getItem(key) ?? 'null');
}

function store(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

function noteName(target: Target): string {
  return decodeURIComponent(target.note.split('/').pop()!);
}

async function draw(id: number, drawing: Drawing, target: Target): Promise<void> {
  const draft = load<Draft>(DRAFT);
  if (draft?.id === id) {
    // Page reloaded or reconnected: continue where the pen stopped.
    edit(id, { ...drawing, strokes: draft.strokes }, target, true);
    return;
  }
  if (draft && draft.strokes.length > 0) {
    store(ORPHAN, draft); // canvas of a request the Mac has dropped meanwhile
  }
  localStorage.removeItem(DRAFT);
  const orphan = load<Draft>(ORPHAN);
  localStorage.removeItem(ORPHAN);
  if (!orphan) {
    edit(id, drawing, target, false);
    return;
  }
  // Same drawing (or both new): offer to continue with the changes.
  if (orphan.target.src === target.src && (target.src === null || orphan.target.note === target.note)) {
    const question = target.src
      ? 'This drawing has changes from earlier that never reached the Mac. Continue with them?'
      : 'There is an unsaved new drawing from earlier. Continue with it?';
    const restore = confirm(question);
    edit(id, restore ? { ...drawing, strokes: orphan.strokes } : drawing, target, restore);
    return;
  }
  const where = orphan.target.src ? '' : ' It will be added at the end of that note.';
  if (!confirm(`There is an unsaved drawing from "${noteName(orphan.target)}". Edit it instead of the drawing just opened?${where}`)) {
    edit(id, drawing, target, false);
    return;
  }
  queue({ id, target, file: null }); // the drawing just opened stays as it is
  edit(orphan.id, await orphanDrawing(orphan), orphan.target, true);
}

// The draft keeps no image data; the original image comes from the Mac again.
async function orphanDrawing({ target, image, strokes }: Draft): Promise<Drawing> {
  if (!image) {
    return { strokes };
  }
  const res = await fetch(`asset?note=${encodeURIComponent(target.note)}&src=${encodeURIComponent(target.src!)}`);
  if (!res.ok) {
    status.textContent = 'The background image of that drawing is gone.';
    return { strokes };
  }
  const href = isDrawing(target.src!) ? parseDrawing(await res.text()).image!.href : await blobToDataUrl(await res.blob());
  return { strokes, image: { ...image, href } };
}

// `restored`: the strokes differ from the request already, so keep a draft right away.
async function edit(id: number, drawing: Drawing, target: Target, restored: boolean): Promise<void> {
  currentId = id;
  abort = new AbortController();
  const image = drawing.image && { ...drawing.image, href: '' };
  const save = (strokes: Stroke[]): void => store(DRAFT, { id, target, image, strokes });
  if (restored) {
    save(drawing.strokes);
  }
  const result = await openDrawingEditor(drawing, abort.signal, save);
  if (currentId !== id) {
    return; // cancelled from the Mac or replaced by a newer request
  }
  currentId = 0;
  localStorage.removeItem(DRAFT);
  queue({ id, target, file: result && drawingFile(result) });
}

function queue(result: Result): void {
  store(OUTBOX, [...(load<Result[]>(OUTBOX) ?? []), result]);
  send();
}

// Delivers finished drawings in order; retried on every reconnect until the Mac has them.
let sending = false;

async function send(): Promise<void> {
  if (sending) {
    return;
  }
  sending = true;
  for (let out = load<Result[]>(OUTBOX)?.[0]; out; out = load<Result[]>(OUTBOX)?.[0]) {
    const res = await fetch('result', { method: 'POST', body: JSON.stringify(out) }).catch(() => undefined);
    if (!res?.ok) {
      status.textContent = 'Drawing not sent yet – it is kept here and sent as soon as the Mac is reachable …';
      break;
    }
    const sent = out;
    store(OUTBOX, load<Result[]>(OUTBOX)!.filter((r) => r.id !== sent.id));
  }
  sending = false;
}

// Safari ignores user-scalable=no; without this a resting palm can pinch-zoom the page.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('selectstart', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => e.preventDefault());

// The Mac only runs the server on demand (Alt+D, double-click), so the page keeps reconnecting.
// EventSource retries by itself, but Safari gives up (CLOSED) when the server is unreachable.
const RECONNECT_MS = 3000;

function connect(): void {
  const events = new EventSource('events');
  events.onopen = () => {
    status.textContent = 'Connected. Waiting for a drawing request from the Mac (Alt+D) …';
    send();
  };
  events.onerror = () => {
    status.textContent = 'Waiting for the Mac – Alt+D or a double-click on a drawing/image there starts the connection …';
    if (events.readyState === EventSource.CLOSED) {
      setTimeout(connect, RECONNECT_MS);
    }
  };
  events.addEventListener('draw', (e) => {
    const { id, drawing, target } = JSON.parse((e as MessageEvent).data);
    // Reconnects resend the pending request: keep the open canvas, and don't reopen a request whose
    // result is still on its way.
    if (id === currentId || load<Result[]>(OUTBOX)?.some((r) => r.id === id)) {
      return;
    }
    // Reset first: the replaced canvas must not deliver an (empty) result for its id.
    currentId = 0;
    abort?.abort();
    draw(id, drawing, target);
  });
  events.addEventListener('cancel', (e) => {
    if (JSON.parse((e as MessageEvent).data).id === currentId) {
      currentId = 0;
      // Cancelled from the Mac (notification closed, new request): keep what was drawn.
      const draft = load<Draft>(DRAFT);
      if (draft && draft.strokes.length > 0) {
        store(ORPHAN, draft);
      }
      localStorage.removeItem(DRAFT);
      abort?.abort();
    }
  });
}

// Drafts and results stored by the previous version have no target.
for (const key of [DRAFT, OUTBOX, ORPHAN]) {
  const value = load<{ target?: unknown }>(key);
  if (value && !Array.isArray(value) && !value.target) {
    localStorage.removeItem(key);
  }
}

connect();
