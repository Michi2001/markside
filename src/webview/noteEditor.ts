import { Crepe } from '@milkdown/crepe';
import '@milkdown/crepe/theme/common/style.css';
import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import { commandsCtx, editorViewCtx, remarkPluginsCtx, remarkStringifyOptionsCtx } from '@milkdown/kit/core';
import { clearTextInCurrentBlockCommand, listItemSchema } from '@milkdown/kit/preset/commonmark';
import { type EditorState, NodeSelection, Plugin, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { $prose, callCommand, insert, replaceAll } from '@milkdown/kit/utils';
import { AI_MARK } from '../sidecar';
import { type Drawing, drawingFile, drawingPng, imageDrawing, isDrawing, isDrawingOpen, loadDrawing, openDrawingEditor } from './drawing';
import { setHeading, shiftHeading } from './headings';
import { dim } from './dim';
import { highlight } from './highlight';
import { drawRemotely, host, post, readClipboard, resolveUrl, saveFile, uploadImage } from './host';
import { htmlBlock, remarkHtmlBlocks } from './htmlBlock';
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

// OneNote-style bullets: one shape per nesting level (`.mdlive-b1`..`.mdlive-b9`, picked in style.css),
// `ring` marks a collapsed item.
const BULLET_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <circle class="ring" cx="12" cy="12" r="7.5" />
  <rect class="mdlive-b1" x="8.5" y="11.25" width="6" height="1.5" />
  <circle class="mdlive-b2" cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.2" />
  <rect class="mdlive-b3" x="9.75" y="9.75" width="4.5" height="4.5" />
  <rect class="mdlive-b4" x="8.9" y="8.9" width="6.2" height="6.2" fill="none" stroke="currentColor" stroke-width="1.2" />
  <path class="mdlive-b5" d="M12 7.6 16.4 12 12 16.4 7.6 12Z" />
  <path class="mdlive-b6" d="M12 8 16 12 12 16 8 12Z" fill="none" stroke="currentColor" stroke-width="1.2" />
  <path class="mdlive-b7" d="M9.5 8 15.5 12 9.5 16Z" />
  <rect class="mdlive-b8" x="6.5" y="11.25" width="11" height="1.5" />
  <path class="mdlive-b9" d="M12 9 15 12 12 15 9 12Z" />
</svg>`;

// Annotations accepted from Claude start with AI_MARK; they are shown in Claude's color (a bullet
// with its sub-bullets).
const aiAnnotations = $prose(
  () =>
    new Plugin({
      props: {
        decorations: (state) => {
          const decorations: Decoration[] = [];
          state.doc.descendants((node, pos) => {
            const paragraph = node.type.name === 'list_item' ? node.firstChild : node;
            if (['list_item', 'paragraph'].includes(node.type.name) && paragraph?.type.name === 'paragraph' && paragraph.textContent.startsWith(AI_MARK)) {
              decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'mdlive-ai' }));
              return false;
            }
            return !node.isTextblock;
          });
          return DecorationSet.create(state.doc, decorations);
        },
      },
    }),
);

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
  // Resized while drawing: that size wins over a width set in the note.
  const resized = drawing.image && isDrawing(path) && (await loadDrawing(resolveUrl(path))).image?.width !== drawing.image.width;
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
    } else if (!isDrawing(src!) || resized) {
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
      [Crepe.Feature.ListItem]: { bulletIcon: BULLET_ICON },
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
    ctx.update(remarkPluginsCtx, (prev) => [...prev, remarkHtmlImages, remarkHtmlBlocks]);
    ctx.update(imageBlockSchema.key, extendImageBlockSchema);
    // Milkdown creates new list items as loose (`spread: true`), so an item that gets a sublist was
    // saved with a blank line before it. Parsed items keep the spread of their Markdown.
    ctx.update(listItemSchema.key, (prev) => (c) => {
      const base = prev(c);
      return { ...base, attrs: { ...base.attrs, spread: { default: false, validate: 'boolean' } } };
    });
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
  crepe.editor.use(moveBlocksKeymap).use(highlight).use(dim).use(htmlBlock).use(aiAnnotations);
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
  // Crepe's formula tooltip stays open as long as the formula is selected: Escape or a click outside
  // it closes it, keeping what was typed.
  root.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && closeFormula(editor, true)) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
  document.addEventListener(
    'pointerdown',
    (e) => {
      const target = e.target as Element;
      if (!target.closest?.('.milkdown-latex-inline-edit') && !target.closest?.('.ProseMirror-selectednode')) {
        closeFormula(editor, false);
      }
    },
    true,
  );
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

// Moves the cursor behind a selected inline formula, which hides its tooltip, and stores the
// tooltip's text. Returns false if no formula is selected.
function closeFormula(editor: NoteEditor, focus: boolean): boolean {
  const view = editor.view();
  const { selection } = view.state;
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'math_inline') {
    return false;
  }
  const input = editor.root.querySelector('.milkdown-latex-inline-edit[data-show="true"] .ProseMirror');
  const tr = view.state.tr;
  if (input && input.textContent !== selection.node.attrs.value) {
    tr.setNodeAttribute(selection.from, 'value', input.textContent);
  }
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, selection.to)));
  if (focus) {
    view.focus();
  }
  return true;
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

// A drawing asked about with Alt+K: its link in the note and the drawing as PNG (base64).
export type ClaudeDrawing = { src: string; png: string };

// Drawings in the selection (a clicked drawing is selected as a node), rendered as PNG for Claude.
export function selectedDrawings(state: EditorState): Promise<ClaudeDrawing[]> {
  const srcs: string[] = [];
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node) => {
    if ((node.type.name === 'image-block' || node.type.name === 'image') && isDrawing(node.attrs.src)) {
      srcs.push(node.attrs.src);
    }
  });
  return Promise.all(srcs.map(async (src) => ({ src, png: await drawingPng(resolveUrl(src)) })));
}

// Sends the selected plain text of the active editor (and the drawings in it) to the extension (Alt+K → Claude);
// `propose` (Alt+Shift+K) lets Claude suggest changes. A selection in a suggestion card, or the card
// under the pointer, asks about that suggestion.
export async function sendSelection(propose = false): Promise<void> {
  const selection = window.getSelection();
  const selected = selection && !selection.isCollapsed ? selection.anchorNode?.parentElement?.closest<HTMLElement>('.mdlive-suggestion') : null;
  const suggestion = selected ?? document.querySelector<HTMLElement>('.mdlive-suggestion:hover');
  if (suggestion) {
    post({ type: 'selection', text: selected ? selection!.toString() : '', propose, suggestion: suggestion.dataset.id });
    return;
  }
  if (!active) {
    post({ type: 'selection', text: '' });
    return;
  }
  const { state } = active.view();
  const { from, to } = listItemRange(state) ?? state.selection;
  post({ type: 'selection', text: state.doc.textBetween(from, to, '\n', ' '), drawings: await selectedDrawings(state), propose });
}

// Alt+<key> formatting commands (Crepe/Milkdown command names).
const FORMAT_COMMANDS: Record<string, string> = {
  KeyB: 'ToggleStrong',
  KeyI: 'ToggleEmphasis',
  KeyS: 'ToggleStrikeThrough',
  KeyC: 'ToggleInlineCode',
  KeyM: 'ToggleLatex',
  KeyG: 'ToggleDim',
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

// Alt+<key> heading levels. The key left of 1 (^ on German Macs, clears formatting) reports
// IntlBackslash or Backquote depending on the keyboard, so both are accepted.
const CLEAR_KEYS = ['Backquote', 'IntlBackslash'];
const HEADING_KEYS: Record<string, number> = {
  Digit1: 1,
  Digit2: 2,
  Digit3: 3,
  Digit4: 4,
  Digit5: 5,
  Digit6: 6,
};

// Runs a formatting command; in lists it applies to the whole item text, then restores the cursor.
// Highlights (and removing them) only expand to the whole item when nothing is selected. In an empty
// item the format applies to what is typed next (stored marks, which a selection change would drop).
export function runFormatCommand(editor: NoteEditor, command: string, payload?: unknown): void {
  const view = editor.view();
  const keepSelection = command === 'ToggleLatex' || (['ToggleHighlight', 'RemoveHighlight'].includes(command) && !view.state.selection.empty);
  const item = keepSelection ? null : listItemRange(view.state);
  const range = item && item.from < item.to ? item : null;
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

// Alt+^: removes all formatting (marks except links, headings become text) from the selection; with
// only a cursor from the whole list item or block.
function clearFormatting(view: EditorView): void {
  const { state } = view;
  const { selection } = state;
  const { from, to } = selection.empty ? (listItemRange(state) ?? { from: selection.$from.start(), to: selection.$from.end() }) : selection;
  const tr = state.tr;
  for (const mark of Object.values(state.schema.marks)) {
    if (mark.name !== 'link') {
      tr.removeMark(from, to, mark);
    }
  }
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'heading') {
      tr.setNodeMarkup(pos, state.schema.nodes.paragraph);
    }
  });
  view.dispatch(tr.setStoredMarks([]));
}

// Handled on the window (not as a ProseMirror keymap) so Alt+M also works while the formula tooltip
// has focus. `ignore` skips keys meant for other parts of the page.
// Alt+K mirrors the Claude Code shortcut for "Insert @-Mention Reference"; with Shift Claude may suggest changes.
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
      // Cmd+Shift+V: paste without formatting (ProseMirror's plain text paste: one paragraph per line).
      if (e.code === 'KeyV' && e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && !inCodeBlock) {
        e.preventDefault();
        e.stopPropagation();
        readClipboard().then((text) => editor.view().pasteText(text));
        return;
      }
      if (!e.altKey || e.metaKey || e.ctrlKey) {
        return;
      }
      const command = FORMAT_COMMANDS[e.code];
      if (e.code === 'KeyK') {
        e.preventDefault();
        e.stopPropagation();
        sendSelection(e.shiftKey);
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
      } else if (CLEAR_KEYS.includes(e.code)) {
        e.preventDefault();
        e.stopPropagation();
        clearFormatting(editor.view());
        editor.view().focus();
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
