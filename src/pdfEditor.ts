import * as vscode from 'vscode';
import { adoptAssets, cleanupAssets, loadFolds, notesUri, saveFolds, saveImage, writeClaudeContext } from './assets';
import { DrawingServer, getDrawingDevice } from './drawingServer';
import type { FontSizes } from './fontSizes';
import { applyMinimalEdit, getTheme, sendSelectionToClaude } from './liveEditor';
import { preserveSource } from './preserve';
import { type Anchor, type Rect, type Section, addNote, deleteNote, formatAnchor, parseSections, setNoteBody } from './sidecar';
import type { Fold } from './webview/fold';

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'editNote'; key: string; text: string }
  | { type: 'addNote'; anchor: Anchor; label: string; body: string; replace: string[] }
  | { type: 'deleteNote'; key: string; discard: boolean }
  | { type: 'undo'; redo: boolean }
  | { type: 'folds'; folds: Record<string, Fold[]> }
  | { type: 'saveImage'; id: number; name: string; mime: string; data: string }
  | { type: 'selection'; text: string }
  | { type: 'askClaude'; page: number; quote?: string; rects?: Rect[]; key?: string }
  | { type: 'drawRemote'; id: number; drawing: unknown; src: string | null };

const SAVE_DELAY_MS = 800;

type NoteData = { anchor: Anchor; label: string; body: string };
// One undoable step: notes added and removed together (a new mark replacing others, a deletion).
type Step = { added: NoteData[]; removed: NoteData[] };

const noteData = (s: Section): NoteData => ({ anchor: s.anchor!, label: s.label, body: s.body });

// Read-only PDF view with the notes of `paper.pdf.md` next to the pages. Like the Markdown editor,
// the notes' TextDocument is the single source of truth; it is saved automatically, since the PDF
// tab never shows it as dirty.
export class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'mdLive.pdf';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly drawingServer: DrawingServer,
    private readonly fontSizes: FontSizes,
  ) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const pdf = document.uri;
    const notes = notesUri(pdf);
    const docDir = vscode.Uri.joinPath(pdf, '..');
    const distUri = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri);

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [distUri, docDir, ...workspaceRoots],
    };
    panel.webview.html = this.getHtml(panel.webview, distUri);

    // Created on the first note.
    let note = (await exists(notes)) ? await vscode.workspace.openTextDocument(notes) : undefined;
    let editQueue: Promise<unknown> = Promise.resolve();
    let saveTimer: NodeJS.Timeout | undefined;
    // Text after our own last edit; changes to anything else are sent to the webview.
    let ownText: string | undefined;
    // Per note: the body as stored (source formatting kept) and as the webview sent it, so resending
    // the notes doesn't overwrite a card with its own, differently formatted content.
    const echo = new Map<string, { stored: string; webview: string }>();
    // Adding and deleting marks/notes; text inside a card has the card editor's own undo.
    const undoStack: Step[] = [];
    const redoStack: Step[] = [];

    const queue = (task: () => Promise<unknown>): void => {
      editQueue = editQueue.then(task);
    };

    const openNote = async (): Promise<vscode.TextDocument> => {
      if (!note) {
        if (!(await exists(notes))) {
          await vscode.workspace.fs.writeFile(notes, new Uint8Array());
        }
        note = await vscode.workspace.openTextDocument(notes);
      }
      return note;
    };

    const sections = () =>
      parseSections(note?.getText() ?? '').map((s) => {
        const e = echo.get(s.key);
        return { ...s, body: e && e.stored === s.body ? e.webview : s.body };
      });

    const sendNotes = (): void => {
      panel.webview.postMessage({ type: 'notes', sections: sections() });
    };

    const scheduleSave = (): void => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => queue(async () => note?.isDirty && note.save()), SAVE_DELAY_MS);
    };

    // Applies a change of the notes text; foreign images (pasted from other notes) are adopted.
    const write = async (change: (text: string) => string): Promise<void> => {
      const doc = await openNote();
      const text = change(doc.getText());
      ownText = text;
      await applyMinimalEdit(doc, text);
      await applyMinimalEdit(doc, await adoptAssets(doc.uri, text));
      scheduleSave();
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== notes.toString() || e.contentChanges.length === 0) {
        return;
      }
      note = e.document;
      if (e.document.getText() !== ownText) {
        sendNotes();
      }
    });

    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mdLive.theme')) {
        panel.webview.postMessage({ type: 'theme', theme: getTheme() });
      }
      if (e.affectsConfiguration('mdLive.pdfNotesWidth')) {
        panel.webview.postMessage({ type: 'notesWidth', width: getNotesWidth() });
      }
      if (e.affectsConfiguration('mdLive.fontSize')) {
        panel.webview.postMessage({ type: 'fontSize', fontSize: this.fontSizes.get(pdf) });
      }
      if (e.affectsConfiguration('mdLive.drawingDevice')) {
        panel.webview.postMessage({ type: 'drawingDevice', device: getDrawingDevice() });
      }
    });

    const fontSizeSub = this.fontSizes.onDidChange((uri) => {
      if (uri === pdf.toString()) {
        panel.webview.postMessage({ type: 'fontSize', fontSize: this.fontSizes.get(pdf) });
      }
    });

    panel.onDidDispose(() => {
      changeSub.dispose();
      configSub.dispose();
      fontSizeSub.dispose();
      clearTimeout(saveTimer);
      queue(async () => {
        if (note?.isDirty) {
          await note.save();
        }
        if (note) {
          await cleanupAssets(note);
        }
      });
    });

    panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      switch (msg.type) {
        case 'ready':
          panel.webview.postMessage({
            type: 'init',
            pdfUrl: panel.webview.asWebviewUri(pdf).toString(),
            distUri: panel.webview.asWebviewUri(distUri).toString() + '/',
            baseUri: panel.webview.asWebviewUri(docDir).toString() + '/',
            theme: getTheme(),
            fontSize: this.fontSizes.get(pdf),
            notesWidth: getNotesWidth(),
            drawingDevice: getDrawingDevice(),
            sections: sections(),
            folds: await loadFolds(notes, {}),
          });
          break;
        case 'editNote':
          queue(() =>
            write((text) => {
              const old = parseSections(text).find((s) => s.key === msg.key)?.body ?? '';
              // Unchanged blocks keep their original formatting.
              const body = preserveSource(old, msg.text.trimEnd()).trimEnd();
              echo.set(msg.key, { stored: body, webview: msg.text });
              return setNoteBody(text, msg.key, body);
            }),
          );
          break;
        case 'addNote':
          queue(async () => {
            // Marks the new one was drawn over are replaced by it.
            await write((text) => {
              const removed = parseSections(text).filter((s) => msg.replace.includes(s.key));
              undoStack.push({ added: [{ anchor: msg.anchor, label: msg.label, body: msg.body }], removed: removed.map(noteData) });
              redoStack.length = 0;
              return addNote(msg.replace.reduce(deleteNote, text), msg.anchor, msg.label, msg.body);
            });
            msg.replace.forEach((key) => echo.delete(key));
            sendNotes();
          });
          break;
        case 'deleteNote':
          queue(async () => {
            await write((text) => {
              const section = parseSections(text).find((s) => s.key === msg.key);
              const last = undoStack[undoStack.length - 1];
              // A mark created for a note that stayed empty: as if it was never added.
              if (msg.discard && last?.added.length === 1 && formatAnchor(last.added[0].anchor) === msg.key) {
                undoStack.pop();
              } else if (section?.anchor) {
                undoStack.push({ added: [], removed: [noteData(section)] });
                redoStack.length = 0;
              }
              return deleteNote(text, msg.key);
            });
            echo.delete(msg.key);
            sendNotes();
          });
          break;
        case 'undo':
          queue(async () => {
            const step = (msg.redo ? redoStack : undoStack).pop();
            if (!step) {
              return;
            }
            const [remove, add] = msg.redo ? [step.removed, step.added] : [step.added, step.removed];
            await write((text) => {
              // Notes edited since keep their current text when they are removed (and come back with it).
              const sections = parseSections(text);
              for (const n of remove) {
                const current = sections.find((s) => s.key === formatAnchor(n.anchor));
                if (current) {
                  n.body = current.body;
                }
              }
              const rest = remove.map((n) => formatAnchor(n.anchor)).reduce(deleteNote, text);
              return add.reduce((t, n) => addNote(t, n.anchor, n.label, n.body), rest);
            });
            [...remove, ...add].forEach((n) => echo.delete(formatAnchor(n.anchor)));
            (msg.redo ? undoStack : redoStack).push(step);
            sendNotes();
          });
          break;
        case 'folds':
          queue(() => saveFolds(notes, msg.folds));
          break;
        case 'saveImage': {
          const relPath = await saveImage(notes, msg.name, msg.mime, msg.data);
          panel.webview.postMessage({ type: 'imageSaved', id: msg.id, path: relPath });
          break;
        }
        case 'drawRemote': {
          const file = await this.drawingServer.draw(msg.drawing, { note: notes.toString(), src: msg.src });
          const path = file ? await saveImage(notes, file.name, file.mime, file.data) : null;
          panel.webview.postMessage({ type: 'drawingSaved', id: msg.id, path });
          break;
        }
        case 'selection':
          await editQueue;
          if (!note) {
            vscode.window.showWarningMessage('This PDF has no notes yet.');
            return;
          }
          // Claude reads the file from disk.
          await note.save();
          await sendSelectionToClaude(note, panel, msg.text);
          break;
        case 'askClaude': {
          await editQueue;
          if (note?.isDirty) {
            await note.save();
          }
          const context = claudeContext(pdf, note?.getText(), msg);
          const file = await writeClaudeContext(notes, context);
          await sendSelectionToClaude(await vscode.workspace.openTextDocument(file), panel, '');
          break;
        }
      }
    });
  }

  private getHtml(webview: vscode.Webview, distUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'pdf.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'pdf.css'));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: http: data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      // The PDF, pdf.js' worker and its font/CMap data, drawings (embedded strokes).
      `connect-src ${webview.cspSource}`,
      // pdf.js' worker is started from a blob, since the webview can't load workers from resource URIs.
      'worker-src blob:',
      `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
</head>
<body>
  <div id="viewer"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// Tells Claude where the question points (page, passage or mark) and which pages to read, so it
// loads only those pages of the PDF; the notes on that page are included.
function claudeContext(
  pdf: vscode.Uri,
  notesText: string | undefined,
  { page, quote, rects, key }: { page: number; quote?: string; rects?: Rect[]; key?: string },
): string {
  const rel = (uri: vscode.Uri) => vscode.workspace.asRelativePath(uri, false);
  const sections = parseSections(notesText ?? '').filter((s) => s.page === page && (s.anchor || s.body.trim()));
  const mark = sections.find((s) => s.key === key);
  const lines = [
    `# Question about \`${rel(pdf)}\`, page ${page}`,
    '',
    `Read only the pages you need from \`${rel(pdf)}\` (Read tool with \`pages\`): page ${page} first, other pages only if the question needs them.`,
  ];
  if (notesText !== undefined) {
    lines.push(
      `My notes on the whole PDF are in \`${rel(notesUri(pdf))}\`: \`## Page N\` is a note on page N, \`### [quote](#pN=x,y,w,h;…)\` a note on a marked passage (or area, \`&area\`) of page N, rectangles as fractions of the page from the top left.`,
    );
  }
  // The position tells apart passages that occur more than once on the page.
  const anchor = rects ? formatAnchor({ page, rects, area: false, color: 'yellow' }) : mark?.key;
  const passage = quote ?? (mark?.anchor?.area ? undefined : mark?.label);
  if (passage) {
    lines.push('', '## Marked passage', '', `> ${passage}`, '', `Position: \`#${anchor}\``);
  }
  if (mark?.anchor?.area) {
    lines.push('', '## Marked area', '', `\`#${mark.key}\` on page ${page}; its snapshot is the image at the start of that note below.`);
  }
  if (sections.length > 0) {
    lines.push(
      '',
      `## My notes on page ${page}`,
      '',
      `Excerpt from \`${rel(notesUri(pdf))}\` (image paths are relative to its folder):`,
      '',
      fenced(sections.map((s) => notesText!.slice(s.start, s.end).trim()).join('\n\n')),
    );
  }
  return lines.join('\n').trimEnd() + '\n';
}

// A code fence longer than any backtick run inside, so the notes' own headings and fences stay quoted.
function fenced(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}markdown\n${text}\n${fence}`;
}

function getNotesWidth(): number {
  return vscode.workspace.getConfiguration('mdLive').get<number>('pdfNotesWidth', 360);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  return vscode.workspace.fs.stat(uri).then(
    () => true,
    () => false,
  );
}
