import { Selection } from '@milkdown/kit/prose/state';
import { isDrawingOpen } from './drawing';
import { type Fold, foldPlugin, getFolds, setFolds, toggleFold } from './fold';
import { applyInit, handleHostMessage, post } from './host';
import { type NoteEditor, createNoteEditor, editDrawing, installShortcuts, sendSelection, setActiveEditor } from './noteEditor';

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
    (crepe) => crepe.editor.use(foldPlugin((folds) => post({ type: 'folds', folds }))),
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
      break;
    case 'update': {
      if (!editor) {
        return;
      }
      // replaceAll drops the collapsed headings, so they are restored by heading text.
      const folds = getFolds(editor.view().state);
      editor.setMarkdown(msg.text);
      setFolds(editor.view(), folds);
      break;
    }
    case 'title':
      setTitle(msg.title);
      break;
    case 'requestSelection':
      sendSelection();
      break;
    case 'insertDrawing':
      if (editor && !isDrawingOpen()) {
        editDrawing(editor);
      }
      break;
  }
});

post({ type: 'ready' });
