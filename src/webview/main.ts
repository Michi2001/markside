import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import { commandsCtx, editorViewCtx, remarkPluginsCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { clearTextInCurrentBlockCommand } from '@milkdown/kit/preset/commonmark';
import { type EditorState, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { callCommand, insert, replaceAll } from '@milkdown/kit/utils';
import { type Drawing, type DrawingFile, drawingFile, imageDrawing, isDrawing, isDrawingOpen, loadDrawing, openDrawingEditor } from './drawing';
import { createImageBlockView, extendImageBlockSchema, remarkHtmlImages } from './imageView';
import { type Fold, foldPlugin, getFolds, setFolds, toggleFold } from './fold';
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
const pendingDrawings = new Map<number, (path: string | null) => void>();
// Setting mdLive.drawingDevice: draw in this webview ('mac') or on the drawing page served by the
// extension, opened on the iPad ('ipad', 'ipadUsb') or in a browser window on the Mac ('sidecar').
let drawingDevice = 'mac';

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
  return saveFile({ name: file.name, mime: file.type, data: await fileToBase64(file) });
}

function saveFile(file: DrawingFile): Promise<string> {
  const id = ++uploadCounter;
  vscode.postMessage({ type: 'saveImage', id, ...file });
  return new Promise<string>((resolve) => pendingUploads.set(id, resolve));
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

async function drawLocally(drawing: Drawing): Promise<string | null> {
  const result = await openDrawingEditor(drawing);
  return result && saveFile(drawingFile(result));
}

// The extension sends the drawing to the drawing page (iPad or browser window) and saves the result.
// `src` (the edited image, none for a new drawing) lets the extension place a late result itself.
function drawRemotely(drawing: Drawing, src?: string): Promise<string | null> {
  const id = ++uploadCounter;
  vscode.postMessage({ type: 'drawRemote', id, drawing, src: src ?? null });
  return new Promise((resolve) => pendingDrawings.set(id, resolve));
}

// Opens the drawing surface for a new drawing (inserted at the cursor), an existing one or an image
// to draw on (src + getPos; `width` = displayed width, `nodeWidth` = width attr). Every save writes
// a new file, so undo keeps working; unlinked files are cleaned up on close.
async function editDrawing(src?: string, getPos?: () => number | undefined, width?: number, nodeWidth?: number): Promise<void> {
  const drawing: Drawing = !src
    ? { strokes: [] }
    : isDrawing(src)
      ? await loadDrawing(resolveUrl(src))
      : await imageDrawing(resolveUrl(src), width!, nodeWidth!);
  const path = drawingDevice === 'mac' ? await drawLocally(drawing) : await drawRemotely(drawing, src);
  if (!path) {
    getView().focus();
    return;
  }
  const pos = getPos?.();
  if (pos === undefined) {
    crepe!.editor.action(insert(`![](${path})`));
  } else {
    const view = getView();
    const tr = view.state.tr.setNodeAttribute(pos, 'src', path);
    // Image → drawing: the image keeps its scale inside it, so the drawing is shown at its own size.
    // Drawing → plain image (all strokes erased): the image gets its original width back.
    if (!isDrawing(path)) {
      tr.setNodeAttribute(pos, 'width', drawing.image!.nodeWidth ?? 0);
    } else if (!isDrawing(src!)) {
      tr.setNodeAttribute(pos, 'width', 0);
    }
    view.dispatch(tr);
  }
  getView().focus();
}

const PEN_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/></svg>';

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

async function createEditor(text: string, folds: Fold[]): Promise<void> {
  crepe = new Crepe({
    root,
    defaultValue: text,
    featureConfigs: {
      [Crepe.Feature.ImageBlock]: { onUpload: uploadImage, proxyDomURL: resolveUrl },
      [Crepe.Feature.BlockEdit]: {
        buildMenu: (builder) => {
          builder.getGroup('advanced').addItem('handwriting', {
            label: 'Handwriting',
            icon: PEN_ICON,
            onRun: (ctx) => {
              ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key);
              editDrawing();
            },
          });
        },
      },
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
  crepe.editor
    .use(moveBlocksKeymap)
    .use(highlight)
    .use(foldPlugin((folds) => vscode.postMessage({ type: 'folds', folds })));
  await crepe.create();
  const view = getView();
  const crepeImageView = view.props.nodeViews!['image-block'];
  view.setProps({
    nodeViews: { ...view.props.nodeViews, 'image-block': createImageBlockView(crepeImageView, resolveUrl, editDrawing) },
  });
  lastSynced = crepe.getMarkdown();
  setFolds(view, folds);
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
    if (isDrawingOpen()) {
      return;
    }
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
    } else if (e.key === '¥' || e.key.toLowerCase() === 'y') {
      // Matched by key (Option+Y types ¥ on Mac), so it is the Y key on QWERTZ and QWERTY alike.
      e.preventDefault();
      e.stopPropagation();
      toggleFold(getView());
      getView().focus();
    } else if (e.code === 'KeyD') {
      e.preventDefault();
      e.stopPropagation();
      editDrawing();
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
      document.body.style.setProperty('--mdlive-font-size', `${msg.fontSize}px`);
      drawingDevice = msg.drawingDevice;
      await createEditor(msg.text, msg.folds);
      break;
    case 'update':
      if (!crepe) {
        return;
      }
      // replaceAll drops the collapsed headings, so they are restored by heading text.
      const folds = getFolds(getView().state);
      crepe.editor.action(replaceAll(msg.text));
      lastSynced = crepe.getMarkdown();
      setFolds(getView(), folds);
      break;
    case 'theme':
      document.body.dataset.theme = msg.theme;
      break;
    case 'fontSize':
      document.body.style.setProperty('--mdlive-font-size', `${msg.fontSize}px`);
      break;
    case 'drawingDevice':
      drawingDevice = msg.device;
      break;
    case 'drawingSaved':
      pendingDrawings.get(msg.id)?.(msg.path);
      pendingDrawings.delete(msg.id);
      break;
    case 'imageSaved':
      pendingUploads.get(msg.id)?.(msg.path);
      pendingUploads.delete(msg.id);
      break;
    case 'requestSelection':
      sendSelection();
      break;
    case 'insertDrawing':
      if (crepe && !isDrawingOpen()) {
        editDrawing();
      }
      break;
  }
});

vscode.postMessage({ type: 'ready' });
