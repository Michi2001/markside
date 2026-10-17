import * as vscode from 'vscode';
import { adoptAssets, cleanupAssets, loadFolds, saveFolds, saveImage } from './assets';
import { preserveSource } from './preserve';
import { DrawingServer, type DrawingFile, type DrawingTarget, getDrawingDevice } from './drawingServer';
import type { FontSizes } from './fontSizes';
import type { Fold } from './webview/fold';

const CLAUDE_MENTION_COMMAND = 'claude-vscode.insertAtMention';

export function getTheme(): string {
  return vscode.workspace.getConfiguration('mdLive').get<string>('theme', 'auto');
}

// Obsidian-style inline title: the file name with underscores shown as spaces.
function noteTitle(note: vscode.Uri): string {
  return note.path.split('/').pop()!.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
}

// Title → file name: spaces become underscores, characters not allowed in file names become dashes.
function titleToFileName(title: string): string {
  return title.trim().replace(/\s+/g, '_').replace(/[\/\\:*?"<>|]/g, '-').replace(/^\.+/, '');
}

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'edit'; text: string }
  | { type: 'saveImage'; id: number; name: string; mime: string; data: string }
  | { type: 'selection'; text: string }
  | { type: 'folds'; folds: Fold[] }
  | { type: 'rename'; title: string }
  | { type: 'drawRemote'; id: number; drawing: unknown; src: string | null };

export class LiveEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'mdLive.editor';

  private activePanel: vscode.WebviewPanel | undefined;
  // Open panels per document; assets are cleaned up when the last one closes.
  private readonly panelCounts = new Map<string, number>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly drawingServer: DrawingServer,
    private readonly fontSizes: FontSizes,
  ) {}

  postToActivePanel(type: 'requestSelection' | 'insertDrawing'): void {
    if (!this.activePanel) {
      vscode.window.showWarningMessage('No Markdown Live Editor is active.');
      return;
    }
    this.activePanel.webview.postMessage({ type });
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const docDir = vscode.Uri.joinPath(document.uri, '..');
    const distUri = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri);

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [distUri, docDir, ...workspaceRoots],
    };
    panel.webview.html = this.getHtml(panel.webview, distUri);
    this.activePanel = panel;
    const key = document.uri.toString();
    this.panelCounts.set(key, (this.panelCounts.get(key) ?? 0) + 1);

    // Text the webview currently shows; used to avoid echoing our own edits back.
    let webviewText = document.getText();
    let editQueue: Promise<unknown> = Promise.resolve();

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString() || e.contentChanges.length === 0) {
        return;
      }
      const text = document.getText();
      if (text === webviewText) {
        return;
      }
      webviewText = text;
      panel.webview.postMessage({ type: 'update', text });
    });

    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mdLive.theme')) {
        panel.webview.postMessage({ type: 'theme', theme: getTheme() });
      }
      if (e.affectsConfiguration('mdLive.fontSize')) {
        panel.webview.postMessage({ type: 'fontSize', fontSize: this.fontSizes.get(document.uri) });
      }
      if (e.affectsConfiguration('mdLive.drawingDevice')) {
        panel.webview.postMessage({ type: 'drawingDevice', device: getDrawingDevice() });
      }
    });

    const fontSizeSub = this.fontSizes.onDidChange((uri) => {
      if (uri === document.uri.toString()) {
        panel.webview.postMessage({ type: 'fontSize', fontSize: this.fontSizes.get(document.uri) });
      }
    });

    panel.onDidChangeViewState(() => {
      if (panel.active) {
        this.activePanel = panel;
      }
    });
    panel.onDidDispose(() => {
      changeSub.dispose();
      configSub.dispose();
      fontSizeSub.dispose();
      if (this.activePanel === panel) {
        this.activePanel = undefined;
      }
      const count = this.panelCounts.get(key)! - 1;
      if (count > 0) {
        this.panelCounts.set(key, count);
        return;
      }
      this.panelCounts.delete(key);
      editQueue.then(() => cleanupAssets(document));
    });

    panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      switch (msg.type) {
        case 'ready':
          panel.webview.postMessage({
            type: 'init',
            text: document.getText(),
            baseUri: panel.webview.asWebviewUri(docDir).toString() + '/',
            theme: getTheme(),
            fontSize: this.fontSizes.get(document.uri),
            title: noteTitle(document.uri),
            drawingDevice: getDrawingDevice(),
            folds: await loadFolds(document.uri, []),
          });
          break;
        case 'folds':
          // Queued so quick successive writes (e.g. on an external update) land in order.
          editQueue = editQueue.then(() => saveFolds(document.uri, msg.folds));
          break;
        case 'edit': {
          const crlf = document.eol === vscode.EndOfLine.CRLF ? msg.text.replace(/\r?\n/g, '\r\n') : msg.text;
          editQueue = queueEdit(document.uri, async () => {
            // Unchanged blocks keep their original formatting; the webview keeps showing its own serialization.
            const text = preserveSource(document.getText(), crlf);
            webviewText = text;
            await applyMinimalEdit(document, text);
            // Changes the document again (and thus the webview) only if foreign images were pasted.
            await applyAdopted(document, text);
          });
          break;
        }
        case 'rename':
          await editQueue;
          if (!(await renameNote(document, msg.title))) {
            panel.webview.postMessage({ type: 'title', title: noteTitle(document.uri) });
          }
          break;
        case 'saveImage': {
          const relPath = await saveImage(document.uri, msg.name, msg.mime, msg.data);
          panel.webview.postMessage({ type: 'imageSaved', id: msg.id, path: relPath });
          break;
        }
        case 'drawRemote': {
          const file = await this.drawingServer.draw(msg.drawing, { note: document.uri.toString(), src: msg.src });
          const path = file ? await saveImage(document.uri, file.name, file.mime, file.data) : null;
          panel.webview.postMessage({ type: 'drawingSaved', id: msg.id, path });
          break;
        }
        case 'selection':
          // Claude reads the file from disk, and closing the temporary text tab of a dirty
          // document would prompt to save, so flush pending edits and save first.
          await editQueue;
          await document.save();
          await sendSelectionToClaude(document, panel, msg.text);
          break;
      }
    });
  }

  private getHtml(webview: vscode.Webview, distUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'webview.css'));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: http: data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      // Drawings are fetched to read their embedded strokes.
      `connect-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
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
  <div id="titlebar"></div>
  <h1 id="title" contenteditable="plaintext-only" spellcheck="false"></h1>
  <div id="editor"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// Replaces only the changed middle part, so VS Code's undo stack and dirty tracking stay sensible.
// Edits of one document from all panels (live editors, PDF views of the same notes, iPad results) run
// one after another: an edit is computed from the current text, so no other edit may land before it
// is applied (its range would be stale and garble the text).
const documentQueues = new Map<string, Promise<unknown>>();

export function queueEdit<T>(uri: vscode.Uri, task: () => Promise<T>): Promise<T> {
  const next = (documentQueues.get(uri.toString()) ?? Promise.resolve()).then(task);
  documentQueues.set(uri.toString(), next);
  return next;
}

// Copies images linked from other notes' folders into the own one and relinks them, unless the
// document changed meanwhile (applying `text` would revert that change; the next edit adopts them).
export async function applyAdopted(document: vscode.TextDocument, text: string): Promise<void> {
  const adopted = await adoptAssets(document.uri, text);
  if (adopted !== text && document.getText() === text) {
    await applyMinimalEdit(document, adopted);
  }
}

export async function applyMinimalEdit(document: vscode.TextDocument, text: string): Promise<void> {
  const old = document.getText();
  if (old === text) {
    return;
  }
  let start = 0;
  while (start < old.length && start < text.length && old[start] === text[start]) {
    start++;
  }
  let endOld = old.length;
  let endNew = text.length;
  while (endOld > start && endNew > start && old[endOld - 1] === text[endNew - 1]) {
    endOld--;
    endNew--;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(document.positionAt(start), document.positionAt(endOld)),
    text.slice(start, endNew),
  );
  await vscode.workspace.applyEdit(edit);
}

// Renames the note after its inline title; VS Code then reopens the editor for the new file and
// registerAssetSync moves the assets folder. Returns false if nothing was renamed.
async function renameNote(document: vscode.TextDocument, title: string): Promise<boolean> {
  const name = titleToFileName(title);
  const oldName = document.uri.path.split('/').pop()!;
  const newName = name + (/\.[^.]+$/.exec(oldName)?.[0] ?? '.md');
  if (!name || newName === oldName) {
    return false;
  }
  const target = vscode.Uri.joinPath(document.uri, '..', newName);
  // Case-only renames hit the same file on macOS' case-insensitive file system.
  const taken = await vscode.workspace.fs.stat(target).then(() => true, () => false);
  if (taken && newName.toLowerCase() !== oldName.toLowerCase()) {
    vscode.window.showWarningMessage(`A note named ${newName} already exists.`);
    return false;
  }
  await document.save();
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(document.uri, target);
  if (!(await vscode.workspace.applyEdit(edit))) {
    vscode.window.showWarningMessage(`Could not rename the note to ${newName}.`);
    return false;
  }
  return true;
}

// Saves a drawing the webview no longer waits for (VS Code reloaded, another drawing edited instead
// on the iPad) into its note: replaces the old link (file names are unique timestamps) or, for a new
// drawing or a removed link, appends it at the end.
export async function saveToNote(file: DrawingFile, target: DrawingTarget): Promise<void> {
  const note = vscode.Uri.parse(target.note);
  const document = await vscode.workspace.openTextDocument(note);
  const wasDirty = document.isDirty;
  const path = await saveImage(note, file.name, file.mime, file.data);
  await queueEdit(note, async () => {
    const text = document.getText();
    await applyMinimalEdit(
      document,
      target.src && text.includes(target.src) ? text.split(target.src).join(path) : `${text.trimEnd()}\n\n![](${path})\n`,
    );
  });
  if (!wasDirty) {
    await document.save();
  }
  vscode.window.showInformationMessage(`Drawing from the iPad saved in ${decodeURIComponent(note.path.split('/').pop()!)}.`);
}

// Approximates rendered text for comparing against the webview's plain-text selection.
function stripMarkdown(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(#{1,6}\s+|>\s*|[-+*]\s+(\[[ xX]\]\s+)?|\d+\.\s+)/, '')
    .replace(/[*_`~\\|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// Maps plain text selected in the rendered view back to a line range in the Markdown source.
function findSourceRange(document: vscode.TextDocument, selected: string): vscode.Range | undefined {
  const parts = selected.split('\n').map(normalize).filter((p) => p.length > 0);
  if (parts.length === 0) {
    return undefined;
  }
  const lines = Array.from({ length: document.lineCount }, (_, i) => stripMarkdown(document.lineAt(i).text));
  const startProbe = parts[0].slice(0, 30);
  const endProbe = parts[parts.length - 1].slice(-30);

  const startLine = lines.findIndex((l) => l.includes(startProbe));
  if (startLine === -1) {
    return undefined;
  }
  let endLine = startLine;
  for (let i = startLine; i < lines.length; i++) {
    if (lines[i].includes(endProbe)) {
      endLine = i;
      break;
    }
  }
  return new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
}

// The Claude extension only reads selections from real text editors, so we briefly open one,
// select the matching lines, trigger Claude's own @-mention command and close it again.
export async function sendSelectionToClaude(
  document: vscode.TextDocument,
  panel: vscode.WebviewPanel,
  selected: string,
): Promise<void> {
  const commands = await vscode.commands.getCommands(true);
  if (!commands.includes(CLAUDE_MENTION_COMMAND)) {
    vscode.window.showWarningMessage('Claude Code extension not found (command claude-vscode.insertAtMention missing).');
    return;
  }

  const range = findSourceRange(document, selected);
  if (selected.trim() && !range) {
    vscode.window.showWarningMessage('Could not locate the selection in the Markdown source; mentioning the whole file.');
  }

  const column = panel.viewColumn ?? vscode.ViewColumn.Active;
  const isOurTextTab = (t: vscode.Tab): boolean =>
    t.input instanceof vscode.TabInputText && t.input.uri.toString() === document.uri.toString();
  const group = vscode.window.tabGroups.all.find((g) => g.viewColumn === column);
  const hadTextTab = group?.tabs.some(isOurTextTab) ?? false;
  const original = group?.activeTab?.input;

  const editor = await vscode.window.showTextDocument(document, { viewColumn: column, preview: true });
  const sel = range ?? new vscode.Range(0, 0, 0, 0);
  editor.selection = new vscode.Selection(sel.start, sel.end);
  await vscode.commands.executeCommand(CLAUDE_MENTION_COMMAND);

  if (!hadTextTab) {
    const tempTab = vscode.window.tabGroups.all
      .find((g) => g.viewColumn === column)
      ?.tabs.find(isOurTextTab);
    if (tempTab) {
      await vscode.window.tabGroups.close(tempTab, true);
    }
  }
  // Closing the temporary tab activates the group's previous editor (e.g. another file), and
  // panel.reveal doesn't reliably bring a custom editor back, so the original tab is reopened.
  if (original instanceof vscode.TabInputCustom) {
    await vscode.commands.executeCommand('vscode.openWith', original.uri, original.viewType, { viewColumn: column, preserveFocus: true });
  } else {
    panel.reveal(column, true);
  }
}
