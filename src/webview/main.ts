import { Selection, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { isDrawingOpen } from './drawing';
import { type Fold, foldPlugin, getFolds, setFolds, toggleFold } from './fold';
import { applyInit, handleHostMessage, post } from './host';
import { type NoteEditor, createNoteEditor, editDrawing, installShortcuts, sendSelection, setActiveEditor } from './noteEditor';
import { installSearch, refreshSearch, scrollToRect } from './search';
import { setSuggestions, suggestionPlugin } from './suggestions';

const root = document.getElementById('editor') as HTMLElement;
// Obsidian-style inline title above the note; editing it renames the file.
const title = document.getElementById('title') as HTMLElement;
let titleText = '';
// Compact copy of the title pinned to the top once the title is scrolled out of view.
const titlebar = document.getElementById('titlebar') as HTMLElement;

let editor: NoteEditor | undefined;

async function createEditor(text: string, folds: Fold[]): Promise<void> {
  editor = await createNoteEditor(
    root,
    text,
    (markdown) => post({ type: 'edit', text: markdown }),
    (crepe) => crepe.editor.use(foldPlugin((folds) => post({ type: 'folds', folds }))).use(suggestionPlugin),
  );
  setActiveEditor(editor);
  setFolds(editor.view(), folds);
}

function setTitle(text: string): void {
  titleText = text;
  title.textContent = text;
  titlebar.textContent = text;
}

new IntersectionObserver(([entry]) => titlebar.classList.toggle('visible', !entry.isIntersecting)).observe(title);

titlebar.addEventListener('mousedown', (e) => {
  e.preventDefault();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  title.focus();
});

title.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    title.textContent = titleText;
  }
  if (e.key !== 'Enter' && e.key !== 'Escape') {
    return;
  }
  e.preventDefault();
  if (!editor) {
    title.blur();
    return;
  }
  // Like Obsidian: Enter continues at the start of the note (the blur renames).
  const view = editor.view();
  view.dispatch(view.state.tr.setSelection(Selection.atStart(view.state.doc)));
  view.focus();
});

title.addEventListener('blur', () => {
  const text = (title.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text === titleText) {
    title.textContent = titleText;
    return;
  }
  // The extension reopens the editor for the renamed file, or sends the old title back.
  post({ type: 'rename', title: text });
});

// ---------- Search (Cmd+F) ----------

type Match = { from: number; to: number };

// Range of characters [from, to) of a CodeMirror code block, whose lines are separate elements.
function codeRange(content: Element, from: number, to: number): Range | undefined {
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (const line of content.querySelectorAll('.cm-line')) {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const end = offset + node.length;
      if (!started && from < end) {
        range.setStart(node, from - offset);
        started = true;
      }
      if (started && to <= end) {
        range.setEnd(node, to - offset);
        return range;
      }
      offset = end;
    }
    offset++;
  }
  return undefined;
}

function matchRange(view: EditorView, match: Match): Range | undefined {
  const $from = view.state.doc.resolve(match.from);
  if ($from.parent.type.spec.code) {
    const content = (view.nodeDOM($from.before()) as HTMLElement | null)?.querySelector?.('.cm-content');
    if (content) {
      return codeRange(content, match.from - $from.start(), match.to - $from.start());
    }
  }
  const start = view.domAtPos(match.from, 1);
  const end = view.domAtPos(match.to, -1);
  if (start.node.nodeType !== Node.TEXT_NODE || end.node.nodeType !== Node.TEXT_NODE) {
    return undefined;
  }
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

installSearch<Match>({
  content: root,
  find(re) {
    const matches: Match[] = [];
    editor?.view().state.doc.descendants((node, pos) => {
      if (!node.isTextblock) {
        return true;
      }
      // Text of the block with the document position of every character (inline atoms count as one).
      let text = '';
      const at: number[] = [];
      node.forEach((child, offset) => {
        const start = pos + 1 + offset;
        const str = child.isText ? child.text! : '\ufffc';
        for (let i = 0; i < str.length; i++) {
          at.push(start + i);
        }
        text += str;
      });
      for (const m of text.matchAll(re)) {
        if (m[0]) {
          matches.push({ from: at[m.index], to: at[m.index + m[0].length - 1] + 1 });
        }
      }
      return false;
    });
    return matches;
  },
  range: (match) => (editor ? matchRange(editor.view(), match) : undefined),
  reveal(match) {
    const view = editor!.view();
    // Inside a collapsed section: moving the cursor there unfolds it (foldPlugin).
    if (!matchRange(view, match)?.getClientRects().length) {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, match.from, match.to)));
    }
    const range = matchRange(view, match);
    if (range) {
      scrollToRect(range.getBoundingClientRect());
    } else {
      (view.nodeDOM(view.state.doc.resolve(match.from).before()) as HTMLElement | null)?.scrollIntoView?.({ block: 'center' });
    }
  },
  accept(match) {
    const view = editor!.view();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, match.from, match.to)));
    view.focus();
  },
  origin() {
    const view = editor?.view();
    const state = view?.state;
    return () => {
      if (view && view.state.doc === state?.doc) {
        view.dispatch(view.state.tr.setSelection(state.selection));
      }
    };
  },
});

installShortcuts((e) => e.target === title);

// Alt+Y: collapse the section at the cursor. Matched by key (Option+Y types ¥ on Mac), so it is the
// Y key on QWERTZ and QWERTY alike.
window.addEventListener(
  'keydown',
  (e) => {
    if (!editor || isDrawingOpen() || e.target === title || !e.altKey || e.metaKey || e.ctrlKey) {
      return;
    }
    if (e.key === '¥' || e.key.toLowerCase() === 'y') {
      e.preventDefault();
      e.stopPropagation();
      toggleFold(editor.view());
      editor.view().focus();
    }
  },
  true,
);

window.addEventListener('message', async (event) => {
  const msg = event.data;
  if (handleHostMessage(msg)) {
    return;
  }
  switch (msg.type) {
    case 'init':
      applyInit(msg);
      setTitle(msg.title);
      await createEditor(msg.text, msg.folds);
      setSuggestions(editor!.view(), msg.suggestions);
      break;
    case 'suggestions':
      if (editor) {
        setSuggestions(editor.view(), msg.suggestions);
      }
      break;
    case 'update': {
      if (!editor) {
        return;
      }
      // replaceAll drops the collapsed headings, so they are restored by heading text.
      const folds = getFolds(editor.view().state);
      editor.setMarkdown(msg.text);
      setFolds(editor.view(), folds);
      refreshSearch();
      break;
    }
    case 'title':
      setTitle(msg.title);
      break;
    case 'requestSelection':
      sendSelection();
      break;
    case 'requestReview':
      // The whole note: Claude reviews it and suggests changes.
      post({ type: 'selection', text: '', propose: true });
      break;
    case 'insertDrawing':
      if (editor && !isDrawingOpen()) {
        editDrawing(editor);
      }
      break;
  }
});

post({ type: 'ready' });
