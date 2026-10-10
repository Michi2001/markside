import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import { editorViewCtx, remarkPluginsCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { type EditorState, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { callCommand, insert, replaceAll } from '@milkdown/kit/utils';
import { createImageBlockView, extendImageBlockSchema, remarkHtmlImages } from './imageView';
import { highlight } from './highlight';
import { setHeading, shiftHeading } from './headings';
import { indentListItems, moveBlocksKeymap } from './moveBlocks';
import './style.css';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

const vscode = acquireVsCodeApi();
const root = document.getElementById('editor') as HTMLElement;

let crepe: Crepe | undefined;
let baseUri = '';
// Markdown last exchanged with the extension; listener updates equal to it are not echoed back.
let lastSynced = '';
let uploadCounter = 0;
const pendingUploads = new Map<number, (path: string) => void>();

// Relative image paths in the note are resolved against the note's folder (as a webview URI).
function resolveUrl(url: string): string {
  if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) {
    return url;
  }
  return new URL(url, baseUri).toString();
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.readAsDataURL(file);
  });
}

async function uploadImage(file: File): Promise<string> {
  const id = ++uploadCounter;
  const data = await fileToBase64(file);
  const saved = new Promise<string>((resolve) => pendingUploads.set(id, resolve));
  vscode.postMessage({ type: 'saveImage', id, name: file.name, mime: file.type, data });
  return saved;
}

function getView(): EditorView {
  return crepe!.editor.action((ctx) => ctx.get(editorViewCtx));
}

function imageFiles(data: DataTransfer | null): File[] {
  return Array.from(data?.files ?? []).filter((f) => f.type.startsWith('image/'));
}

async function insertImages(files: File[]): Promise<void> {
  for (const file of files) {
    const path = await uploadImage(file);
    crepe!.editor.action(insert(`![](${path})`));
  }
}

// Inside a bullet list the shortcuts act on the whole text of the touched items, even if only part
// of it (or nothing) is selected. Returns null outside lists.
function listItemRange(state: EditorState): { from: number; to: number } | null {
  const { $from, $to } = state.selection;
  const inItem = ($pos: typeof $from) => $pos.parent.isTextblock && $pos.depth > 1 && $pos.node(-1).type.name === 'list_item';
  if (!inItem($from) || !inItem($to)) {
    return null;
  }
  return { from: $from.start(), to: $to.end() };
}

function sendSelection(): void {
  const { state } = getView();
  const { from, to } = listItemRange(state) ?? state.selection;
  vscode.postMessage({ type: 'selection', text: state.doc.textBetween(from, to, '\n', ' ') });
}

async function createEditor(text: string): Promise<void> {
  crepe = new Crepe({
    root,
    defaultValue: text,
    featureConfigs: {
      [Crepe.Feature.ImageBlock]: { onUpload: uploadImage, proxyDomURL: resolveUrl },
    },
  });
  crepe.editor.config((ctx) => {
    ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, bullet: '-' as const }));
    ctx.update(remarkPluginsCtx, (prev) => [...prev, remarkHtmlImages]);
    ctx.update(imageBlockSchema.key, extendImageBlockSchema);
  });
  crepe.on((listener) => {
    listener.markdownUpdated((_ctx, markdown) => {
      if (markdown === lastSynced) {
        return;
      }
      lastSynced = markdown;
      vscode.postMessage({ type: 'edit', text: markdown });
    });
  });
  crepe.editor.use(moveBlocksKeymap).use(highlight);
  await crepe.create();
  const view = getView();
  const crepeImageView = view.props.nodeViews!['image-block'];
  view.setProps({
    nodeViews: { ...view.props.nodeViews, 'image-block': createImageBlockView(crepeImageView, resolveUrl) },
  });
  lastSynced = crepe.getMarkdown();
}

root.addEventListener(
  'paste',
  (e) => {
    const files = imageFiles(e.clipboardData);
    if (files.length === 0) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    insertImages(files);
  },
  true,
);

root.addEventListener(
  'drop',
  (e) => {
    const files = imageFiles(e.dataTransfer);
    if (files.length === 0) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const view = getView();
    const pos = view.posAtCoords({ left: e.clientX, top: e.clientY });
    if (pos) {
      view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos.pos))));
    }
    insertImages(files);
  },
  true,
);

// Alt+<key> formatting commands (Crepe/Milkdown command names).
const FORMAT_COMMANDS: Record<string, string> = {
  KeyB: 'ToggleStrong',
  KeyI: 'ToggleEmphasis',
  KeyS: 'ToggleStrikeThrough',
  KeyC: 'ToggleInlineCode',
  KeyM: 'ToggleLatex',
};

// Alt+<key> highlight colors (see HIGHLIGHT_COLORS in highlight.ts).
const HIGHLIGHT_KEYS: Record<string, string> = {
  KeyQ: 'red',
  KeyW: 'yellow',
  KeyH: 'yellow',
  KeyE: 'green',
  KeyR: 'blue',
};

// Alt+<key> heading levels; 0 = back to text. The key left of 1 (^ on German Macs) reports
// IntlBackslash or Backquote depending on the keyboard, so both are accepted.
const HEADING_KEYS: Record<string, number> = {
  Backquote: 0,
  IntlBackslash: 0,
  Digit1: 1,
  Digit2: 2,
  Digit3: 3,
  Digit4: 4,
  Digit5: 5,
  Digit6: 6,
};

// Runs a formatting command; in lists it applies to the whole item text, then restores the cursor.
// Highlights only expand to the whole item when nothing is selected.
function runFormatCommand(command: string, payload?: unknown): void {
  const view = getView();
  const keepSelection = command === 'ToggleLatex' || (command === 'ToggleHighlight' && !view.state.selection.empty);
  const range = keepSelection ? null : listItemRange(view.state);
  const { anchor, head } = view.state.selection;
  if (range) {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to)));
  }
  crepe!.editor.action(callCommand(command, payload));
  if (range) {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
  }
  view.focus();
}

// Alt+K mirrors the Claude Code shortcut for "Insert @-Mention Reference".
// Handled here (not as a ProseMirror keymap) so Alt+M also works while the formula tooltip has focus.
window.addEventListener(
  'keydown',
  (e) => {
    const inCodeBlock = (e.target as HTMLElement).closest?.('.cm-editor');
    if (e.key === 'Tab' && !e.altKey && !e.metaKey && !e.ctrlKey && crepe && !inCodeBlock) {
      const view = getView();
      if (indentListItems(view, e.shiftKey) || shiftHeading(view, e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    if (!e.altKey || e.metaKey || e.ctrlKey || !crepe) {
      return;
    }
    const command = FORMAT_COMMANDS[e.code];
    if (e.code === 'KeyK') {
      e.preventDefault();
      e.stopPropagation();
      sendSelection();
    } else if (command) {
      e.preventDefault();
      e.stopPropagation();
      runFormatCommand(command);
    } else if (HIGHLIGHT_KEYS[e.code]) {
      e.preventDefault();
      e.stopPropagation();
      runFormatCommand('ToggleHighlight', HIGHLIGHT_KEYS[e.code]);
    } else if (e.code in HEADING_KEYS) {
      e.preventDefault();
      e.stopPropagation();
      setHeading(getView(), HEADING_KEYS[e.code]);
      getView().focus();
    }
  },
  true,
);

window.addEventListener('message', async (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      baseUri = msg.baseUri;
      document.body.dataset.theme = msg.theme;
      await createEditor(msg.text);
      break;
    case 'update':
      if (!crepe) {
        return;
      }
      crepe.editor.action(replaceAll(msg.text));
      lastSynced = crepe.getMarkdown();
      break;
    case 'theme':
      document.body.dataset.theme = msg.theme;
      break;
    case 'imageSaved':
      pendingUploads.get(msg.id)?.(msg.path);
      pendingUploads.delete(msg.id);
      break;
    case 'requestSelection':
      sendSelection();
      break;
  }
});

vscode.postMessage({ type: 'ready' });
