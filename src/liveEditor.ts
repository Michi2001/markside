import * as vscode from 'vscode';
import { adoptAssets, cleanupAssets, saveImage } from './assets';
import { DrawingServer, type DrawingFile, type DrawingTarget, getDrawingDevice } from './drawingServer';

const CLAUDE_MENTION_COMMAND = 'claude-vscode.insertAtMention';

function getTheme(): string {
  return vscode.workspace.getConfiguration('mdLive').get<string>('theme', 'auto');
}

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'edit'; text: string }
  | { type: 'saveImage'; id: number; name: string; mime: string; data: string }
  | { type: 'selection'; text: string }
  | { type: 'drawRemote'; id: number; drawing: unknown; src: string | null };

export class LiveEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'mdLive.editor';

  private activePanel: vscode.WebviewPanel | undefined;
  // Open panels per document; assets are cleaned up when the last one closes.
  private readonly panelCounts = new Map<string, number>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly drawingServer: DrawingServer,
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
      if (e.affectsConfiguration('mdLive.drawingDevice')) {
        panel.webview.postMessage({ type: 'drawingDevice', device: getDrawingDevice() });
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
            drawingDevice: getDrawingDevice(),
          });
          break;
        case 'edit': {
          const text = document.eol === vscode.EndOfLine.CRLF ? msg.text.replace(/\r?\n/g, '\r\n') : msg.text;
          webviewText = text;
          editQueue = editQueue.then(async () => {
            await applyMinimalEdit(document, text);
            // Changes the document again (and thus the webview) only if foreign images were pasted.
            await applyMinimalEdit(document, await adoptAssets(document.uri, text));
          });
          break;
        }
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
  <div id="editor"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// Replaces only the changed middle part, so VS Code's undo stack and dirty tracking stay sensible.
async function applyMinimalEdit(document: vscode.TextDocument, text: string): Promise<void> {
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

// Saves a drawing the webview no longer waits for (VS Code reloaded, another drawing edited instead
// on the iPad) into its note: replaces the old link (file names are unique timestamps) or, for a new
// drawing or a removed link, appends it at the end.
export async function saveToNote(file: DrawingFile, target: DrawingTarget): Promise<void> {
  const note = vscode.Uri.parse(target.note);
  const document = await vscode.workspace.openTextDocument(note);
  const wasDirty = document.isDirty;
  const path = await saveImage(note, file.name, file.mime, file.data);
  const text = document.getText();
  await applyMinimalEdit(
    document,
    target.src && text.includes(target.src) ? text.split(target.src).join(path) : `${text.trimEnd()}\n\n![](${path})\n`,
  );
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
async function sendSelectionToClaude(
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
  panel.reveal(column, true);
}
