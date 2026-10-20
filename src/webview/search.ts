import { isDrawingOpen } from './drawing';
import { host } from './host';
import './search.css';

// Cmd+F search bar shared by the Markdown note and the PDF view. Matches are painted with the CSS
// Custom Highlight API, so the documents (ProseMirror, pdf.js text layers) stay untouched.
// Esc goes back to where the search started; Cmd+Enter or a click into the document stays at the
// match. VS Code's "Go Back"/"Go Forward" keys (`host.navigationKeys`, with the user's own bindings)
// then switch between the start and the match.

export type SearchProvider<M> = {
  // Clicking in here closes the search and stays where the document is now.
  content: HTMLElement;
  find(re: RegExp): M[] | Promise<M[]>;
  // DOM range of a match, if it is rendered.
  range(match: M): Range | undefined;
  // Scrolls the match into view (unfolding it, scrolling to a page that isn't rendered yet).
  reveal(match: M): void;
  // Closing at a match: select it.
  accept(match: M): void;
  // Extra state to restore when going back (e.g. the ProseMirror selection).
  origin?(): () => void;
};

// Height of the bar plus some room, kept free above a revealed match.
const TOP_MARGIN = 60;

let provider: SearchProvider<any>;
let matches: unknown[] = [];
let current = 0;
let searchId = 0;
let timer: number | undefined;
// The query changed and wasn't searched yet.
let stale = false;
// Goes back to where the search started (also after closing at the match, via the "Go Back" key).
let restore: (() => void) | undefined;
// After going back: returns to the match ("Go Forward" key).
let forward: (() => void) | undefined;

const bar = document.createElement('div');
bar.className = 'mdlive-search';
const input = document.createElement('input');
input.placeholder = 'Find';
input.spellcheck = false;
const count = document.createElement('span');
count.className = 'mdlive-search-count';
bar.append(input, count);

function button(text: string, title: string, action: () => void): void {
  const b = document.createElement('button');
  b.textContent = text;
  b.title = title;
  // Keeps the focus in the input.
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', action);
  bar.append(b);
}
button('↑', 'Previous match (Shift+Enter)', () => step(-1));
button('↓', 'Next match (Enter)', () => step(1));
button('↩', 'Back to where the search started (Esc)', () => close('back'));
button('✕', 'Close and stay at the match (Cmd+Enter)', () => close('select'));

export function isSearchOpen(): boolean {
  return bar.isConnected;
}

function pattern(query: string): RegExp | undefined {
  const text = query.trim();
  if (!text) {
    return undefined;
  }
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'gi');
}

export function scrollToRect(rect: DOMRect): void {
  if (rect.top < TOP_MARGIN || rect.bottom > window.innerHeight) {
    window.scrollBy(0, rect.top - window.innerHeight / 3);
  }
}

function paint(): void {
  const all = new Highlight();
  const active = new Highlight();
  active.priority = 1;
  matches.forEach((m, i) => {
    const range = provider.range(m);
    if (range) {
      (i === current ? active : all).add(range);
    }
  });
  CSS.highlights.set('mdlive-search', all);
  CSS.highlights.set('mdlive-search-current', active);
  count.textContent = !pattern(input.value) ? '' : matches.length ? `${current + 1} of ${matches.length}` : 'No results';
  bar.classList.toggle('none', !!pattern(input.value) && !matches.length);
}

// Finds the matches again; `reveal` scrolls to the current one.
async function run(reveal: boolean): Promise<void> {
  stale = false;
  const re = pattern(input.value);
  const id = ++searchId;
  const found = re ? await provider.find(re) : [];
  if (id !== searchId || !isSearchOpen()) {
    return;
  }
  matches = found;
  current = Math.min(current, Math.max(0, matches.length - 1));
  if (reveal && matches.length) {
    provider.reveal(matches[current]);
  }
  paint();
}

// Called when the document changed or more of it got rendered (PDF pages).
export function refreshSearch(): void {
  if (isSearchOpen()) {
    run(false);
  }
}

function step(delta: number): void {
  if (!matches.length) {
    return;
  }
  current = (current + delta + matches.length) % matches.length;
  provider.reveal(matches[current]);
  paint();
}

function captureOrigin(): () => void {
  const x = window.scrollX;
  const y = window.scrollY;
  const focused = document.activeElement as HTMLElement | null;
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
  const extra = provider.origin?.();
  return () => {
    extra?.();
    focused?.focus({ preventScroll: true });
    if (range?.startContainer.isConnected && range.endContainer.isConnected) {
      selection!.removeAllRanges();
      selection!.addRange(range);
    }
    window.scrollTo(x, y);
  };
}

function goBack(): void {
  forward = captureOrigin();
  restore?.();
  restore = undefined;
}

function goForward(): void {
  restore = captureOrigin();
  forward?.();
  forward = undefined;
}

// Whether a key event matches a VS Code key binding like "cmd+-", "ctrl+shift+-" or "cmd+[BracketRight]".
const KEY_NAMES: Record<string, string> = { left: 'arrowleft', right: 'arrowright', up: 'arrowup', down: 'arrowdown' };
// Fallback for keys whose character changes with Shift/Alt (US positions, as VS Code names them).
const CODE_KEYS: Record<string, string> = { Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Slash: '/', Backslash: '\\', Comma: ',', Period: '.' };
function matchesKey(e: KeyboardEvent, binding: string): boolean {
  // Chords ("cmd+k cmd+-") are not supported.
  if (binding.includes(' ')) {
    return false;
  }
  const parts = binding.toLowerCase().split(/\+(?=.)/);
  const key = binding.split(/\+(?=.)/).pop()!;
  const has = (...names: string[]) => names.some((n) => parts.includes(n));
  if (e.metaKey !== has('cmd', 'meta', 'win') || e.ctrlKey !== has('ctrl') || e.altKey !== has('alt', 'option') || e.shiftKey !== has('shift')) {
    return false;
  }
  if (key.startsWith('[')) {
    return e.code === key.slice(1, -1);
  }
  const name = KEY_NAMES[key.toLowerCase()] ?? key.toLowerCase();
  return e.key.toLowerCase() === name || CODE_KEYS[e.code] === name || e.code.toLowerCase() === `key${name}`;
}

function open(): void {
  if (isSearchOpen()) {
    input.select();
    return;
  }
  const selected = window.getSelection()?.toString().replace(/\s+/g, ' ').trim() ?? '';
  restore = captureOrigin();
  forward = undefined;
  if (selected && selected.length <= 200) {
    input.value = selected;
  }
  current = 0;
  document.body.append(bar);
  input.focus();
  input.select();
  run(true);
}

// 'back': return to where the search started; 'select': stay and select the match; 'stay': only close
// (a click into the document places the cursor itself).
function close(mode: 'back' | 'select' | 'stay'): void {
  if (!isSearchOpen()) {
    return;
  }
  clearTimeout(timer);
  const match = matches[current];
  bar.remove();
  CSS.highlights.delete('mdlive-search');
  CSS.highlights.delete('mdlive-search-current');
  matches = [];
  if (mode === 'back') {
    goBack();
  } else if (mode === 'select' && match !== undefined) {
    provider.accept(match);
  } else if (document.activeElement === input) {
    input.blur();
  }
}

input.addEventListener('input', () => {
  current = 0;
  stale = true;
  clearTimeout(timer);
  timer = window.setTimeout(() => run(true), 120);
});

export function installSearch<M>(searchProvider: SearchProvider<M>): void {
  provider = searchProvider;
  // Capture phase and installed before the other key handlers: keys typed in the bar must not reach
  // the editors' shortcuts.
  window.addEventListener(
    'keydown',
    (e) => {
      if (isDrawingOpen()) {
        return;
      }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopImmediatePropagation();
        open();
        return;
      }
      // Otherwise the keys reach VS Code and navigate between editors as usual.
      const back = restore && host.navigationKeys.back.some((k) => matchesKey(e, k));
      const ahead = forward && host.navigationKeys.forward.some((k) => matchesKey(e, k));
      if ((back || ahead) && !isSearchOpen()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (back) {
          goBack();
        } else {
          goForward();
        }
        return;
      }
      if (!bar.contains(e.target as Node)) {
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        close('back');
      } else if (e.key === 'Enter' && mod) {
        e.preventDefault();
        close('select');
      } else if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(timer);
        if (!stale) {
          step(e.shiftKey ? -1 : 1);
        } else {
          run(true);
        }
      } else if (mod) {
        // Cmd+W, Cmd+C/V etc. keep working.
        return;
      }
      e.stopImmediatePropagation();
    },
    true,
  );
  window.addEventListener(
    'mousedown',
    (e) => {
      if (isSearchOpen() && provider.content.contains(e.target as Node)) {
        close('stay');
      }
    },
    true,
  );
}
