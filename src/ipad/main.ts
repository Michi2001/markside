import { openDrawingEditor, parseStrokes } from '../webview/drawing';
import './style.css';

// Waits for drawing requests from the Mac (server-sent events) and sends the result back.
// The page is served under /<token>/, so relative URLs carry the token.
const status = document.getElementById('status') as HTMLElement;
let currentId = 0;
let abort: AbortController | undefined;

async function draw(id: number, svg: string | null): Promise<void> {
  currentId = id;
  abort = new AbortController();
  const result = await openDrawingEditor(svg ? parseStrokes(svg) : [], abort.signal);
  if (currentId !== id) {
    return; // cancelled from the Mac or replaced by a newer request
  }
  currentId = 0;
  await fetch('result', { method: 'POST', body: JSON.stringify({ id, svg: result }) });
}

// Safari ignores user-scalable=no; without this a resting palm can pinch-zoom the page.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('selectstart', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => e.preventDefault());

const events = new EventSource('events');
events.onopen = () => (status.textContent = 'Connected. Waiting for a drawing request from the Mac (Alt+D) …');
events.onerror = () => (status.textContent = 'Not connected to the Mac – retrying …');
events.addEventListener('draw', (e) => {
  const { id, svg } = JSON.parse((e as MessageEvent).data);
  // Reconnects resend the pending request; keep the open canvas in that case.
  if (id === currentId) {
    return;
  }
  abort?.abort();
  draw(id, svg);
});
events.addEventListener('cancel', (e) => {
  if (JSON.parse((e as MessageEvent).data).id === currentId) {
    currentId = 0;
    abort?.abort();
  }
});
