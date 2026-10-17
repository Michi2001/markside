import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import { commandsCtx, editorViewCtx, remarkPluginsCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { clearTextInCurrentBlockCommand } from '@milkdown/kit/preset/commonmark';
import { type EditorState, TextSelection } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { callCommand, insert, replaceAll } from '@milkdown/kit/utils';
import { type Drawing, drawingFile, imageDrawing, isDrawing, isDrawingOpen, loadDrawing, openDrawingEditor } from './drawing';
import { setHeading, shiftHeading } from './headings';
import { highlight } from './highlight';
import { drawRemotely, host, post, resolveUrl, saveFile, uploadImage } from './host';
import { createImageBlockView, extendImageBlockSchema, remarkHtmlImages } from './imageView';
import { indentListItems, moveBlocksKeymap } from './moveBlocks';
import './style.css';

// A Crepe editor for one piece of Markdown: the whole note in the Markdown editor, one annotation in
// the PDF view. Formatting shortcuts act on the editor that was focused last.

export type NoteEditor = {
  crepe: Crepe;
  root: HTMLElement;
  view(): EditorView;
  // Replaces the content without reporting it back as a change.
  setMarkdown(text: string): void;
};

let active: NoteEditor | undefined;

export function getActiveEditor(): NoteEditor | undefined {
  return active;
}

export function setActiveEditor(editor: NoteEditor | undefined): void {
  active = editor;
}

const PEN_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/></svg>';

function imageFiles(data: DataTransfer | null): File[] {
  return Array.from(data?.files ?? []).filter((f) => f.type.startsWith('image/'));
}

async function insertImages(editor: NoteEditor, files: File[]): Promise<void> {
  for (const file of files) {
    const path = await uploadImage(file);
    editor.crepe.editor.action(insert(`![](${path})`));
  }
}

async function drawLocally(drawing: Drawing): Promise<string | null> {
  const result = await openDrawingEditor(drawing);
  return result && saveFile(drawingFile(result));
}

// Opens the drawing surface for a new drawing (inserted at the cursor), an existing one or an image
// to draw on (src + getPos; `width` = displayed width, `nodeWidth` = width attr). Every save writes
// a new file, so undo keeps working; unlinked files are cleaned up on close.
export async function editDrawing(
  editor: NoteEditor,
  src?: string,
  getPos?: () => number | undefined,
  width?: number,
  nodeWidth?: number,
): Promise<void> {
  const drawing: Drawing = !src
    ? { strokes: [] }
    : isDrawing(src)
      ? await loadDrawing(resolveUrl(src))
      : await imageDrawing(resolveUrl(src), width!, nodeWidth!);
  const path = host.drawingDevice === 'mac' ? await drawLocally(drawing) : await drawRemotely(drawing, src);
  if (!path) {
    editor.view().focus();
    return;
  }
  const pos = getPos?.();
  if (pos === undefined) {
    editor.crepe.editor.action(insert(`![](${path})`));
  } else {
    const view = editor.view();
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
  editor.view().focus();
}

export async function createNoteEditor(
  root: HTMLElement,
  text: string,
  onChange: (markdown: string) => void,
  configure?: (crepe: Crepe) => void,
  placeholder?: string,
): Promise<NoteEditor> {
  const crepe = new Crepe({
    root,
    defaultValue: text,
    featureConfigs: {
      [Crepe.Feature.Placeholder]: placeholder ? { text: placeholder, mode: 'doc' } : {},
      [Crepe.Feature.ImageBlock]: { onUpload: uploadImage, proxyDomURL: resolveUrl },
      [Crepe.Feature.BlockEdit]: {
        buildMenu: (builder) => {
          builder.getGroup('advanced').addItem('handwriting', {
            label: 'Handwriting',
            icon: PEN_ICON,
            onRun: (ctx) => {
              ctx.get(commandsCtx).call(clearTextInCurrentBlockCommand.key);
              editDrawing(editor);
            },
          });
        },
      },
    },
  });
  // Markdown last exchanged with the extension; listener updates equal to it are not reported.
  let lastSynced = '';
  const editor: NoteEditor = {
    crepe,
    root,
    view: () => crepe.editor.action((ctx) => ctx.get(editorViewCtx)),
    setMarkdown: (markdown) => {
      crepe.editor.action(replaceAll(markdown));
      lastSynced = crepe.getMarkdown();
    },
  };
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
      onChange(markdown);
    });
  });
  crepe.editor.use(moveBlocksKeymap).use(highlight);
  configure?.(crepe);
  await crepe.create();
  const view = editor.view();
  const crepeImageView = view.props.nodeViews!['image-block'];
  view.setProps({
    nodeViews: {
      ...view.props.nodeViews,
      'image-block': createImageBlockView(crepeImageView, resolveUrl, (...args) => editDrawing(editor, ...args)),
    },
  });
  lastSynced = crepe.getMarkdown();

  root.addEventListener('focusin', () => (active = editor));
  root.addEventListener(
    'paste',
    (e) => {
      const files = imageFiles(e.clipboardData);
      if (files.length === 0) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      insertImages(editor, files);
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
      const view = editor.view();
      const pos = view.posAtCoords({ left: e.clientX, top: e.clientY });
      if (pos) {
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos.pos))));
      }
      insertImages(editor, files);
    },
    true,
  );
  return editor;
}

// Inside a bullet list the shortcuts act on the whole text of the touched items, even if only part
// of it (or nothing) is selected. Returns null outside lists.
export function listItemRange(state: EditorState): { from: number; to: number } | null {
  const { $from, $to } = state.selection;
  const inItem = ($pos: typeof $from) => $pos.parent.isTextblock && $pos.depth > 1 && $pos.node(-1).type.name === 'list_item';
  if (!inItem($from) || !inItem($to)) {
    return null;
  }
  return { from: $from.start(), to: $to.end() };
}

// Sends the selected plain text of the active editor to the extension (Alt+K → Claude).
export function sendSelection(): void {
  if (!active) {
    post({ type: 'selection', text: '' });
    return;
  }
  const { state } = active.view();
  const { from, to } = listItemRange(state) ?? state.selection;
  post({ type: 'selection', text: state.doc.textBetween(from, to, '\n', ' ') });
}

// Alt+<key> formatting commands (Crepe/Milkdown command names).
const FORMAT_COMMANDS: Record<string, string> = {
  KeyB: 'ToggleStrong',
  KeyI: 'ToggleEmphasis',
  KeyS: 'ToggleStrikeThrough',
  KeyC: 'ToggleInlineCode',
  KeyM: 'ToggleLatex',
};

// Alt+<key> highlight colors (see HIGHLIGHT_COLORS in highlight.ts).
export const HIGHLIGHT_KEYS: Record<string, string> = {
  KeyQ: 'red',
  KeyW: 'yellow',
  KeyH: 'yellow',
  KeyE: 'green',
  KeyR: 'blue',
};

// Alt+X removes highlights (any color).
export const REMOVE_HIGHLIGHT_KEY = 'KeyX';

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
// Highlights (and removing them) only expand to the whole item when nothing is selected.
export function runFormatCommand(editor: NoteEditor, command: string, payload?: unknown): void {
  const view = editor.view();
  const keepSelection = command === 'ToggleLatex' || (['ToggleHighlight', 'RemoveHighlight'].includes(command) && !view.state.selection.empty);
  const range = keepSelection ? null : listItemRange(view.state);
  const { anchor, head } = view.state.selection;
  if (range) {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to)));
  }
  editor.crepe.editor.action(callCommand(command, payload));
  if (range) {
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)));
  }
  view.focus();
}

// Handled on the window (not as a ProseMirror keymap) so Alt+M also works while the formula tooltip
// has focus. `ignore` skips keys meant for other parts of the page.
// Alt+K mirrors the Claude Code shortcut for "Insert @-Mention Reference".
export function installShortcuts(ignore: (e: KeyboardEvent) => boolean): void {
  window.addEventListener(
    'keydown',
    (e) => {
      const editor = active;
      if (isDrawingOpen() || !editor || ignore(e)) {
        return;
      }
      const inCodeBlock = (e.target as HTMLElement).closest?.('.cm-editor');
      if (e.key === 'Tab' && !e.altKey && !e.metaKey && !e.ctrlKey && !inCodeBlock) {
        const view = editor.view();
        if (indentListItems(view, e.shiftKey) || shiftHeading(view, e.shiftKey)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (!e.altKey || e.metaKey || e.ctrlKey) {
        return;
      }
      const command = FORMAT_COMMANDS[e.code];
      if (e.code === 'KeyK') {
        e.preventDefault();
        e.stopPropagation();
        sendSelection();
      } else if (e.code === 'KeyD') {
        e.preventDefault();
        e.stopPropagation();
        editDrawing(editor);
      } else if (command) {
        e.preventDefault();
        e.stopPropagation();
        runFormatCommand(editor, command);
      } else if (e.code === REMOVE_HIGHLIGHT_KEY) {
        e.preventDefault();
        e.stopPropagation();
        runFormatCommand(editor, 'RemoveHighlight');
      } else if (HIGHLIGHT_KEYS[e.code]) {
        e.preventDefault();
        e.stopPropagation();
        runFormatCommand(editor, 'ToggleHighlight', HIGHLIGHT_KEYS[e.code]);
      } else if (e.code in HEADING_KEYS) {
        e.preventDefault();
        e.stopPropagation();
        setHeading(editor.view(), HEADING_KEYS[e.code]);
        editor.view().focus();
      }
    },
    true,
  );
}
