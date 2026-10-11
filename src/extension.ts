import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { registerAssetSync } from './assets';
import { DrawingServer, getDrawingDevice } from './drawingServer';
import { LiveEditorProvider } from './liveEditor';

export function activate(context: vscode.ExtensionContext): void {
  // Persisted so the URL bookmarked on the iPad stays valid.
  let token = context.globalState.get<string>('ipadToken');
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    context.globalState.update('ipadToken', token);
  }
  const drawingServer = new DrawingServer(vscode.Uri.joinPath(context.extensionUri, 'dist'), token);
  // Runs while drawings go to the iPad, so the page there can stay connected.
  const syncServer = (): void => (getDrawingDevice() === 'ipad' ? drawingServer.start() : drawingServer.stop());
  syncServer();
  const provider = new LiveEditorProvider(context.extensionUri, drawingServer);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(LiveEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('mdLive.open', (uri?: vscode.Uri) =>
      switchEditor(uri, LiveEditorProvider.viewType),
    ),
    vscode.commands.registerCommand('mdLive.openAsText', (uri?: vscode.Uri) =>
      switchEditor(uri, 'default'),
    ),
    vscode.commands.registerCommand('mdLive.sendSelectionToClaude', () =>
      provider.postToActivePanel('requestSelection'),
    ),
    vscode.commands.registerCommand('mdLive.insertDrawing', () => provider.postToActivePanel('insertDrawing')),
    vscode.commands.registerCommand('mdLive.chooseTheme', chooseTheme),
    vscode.commands.registerCommand('mdLive.showIpadUrl', () => showIpadUrl(drawingServer)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mdLive.drawingDevice') || e.affectsConfiguration('mdLive.ipadPort')) {
        drawingServer.stop();
        syncServer();
      }
    }),
    drawingServer,
    registerAssetSync(),
  );
}

async function showIpadUrl(server: DrawingServer): Promise<void> {
  if (getDrawingDevice() !== 'ipad') {
    await vscode.workspace.getConfiguration('mdLive').update('drawingDevice', 'ipad', vscode.ConfigurationTarget.Global);
  }
  const url = await vscode.window.showQuickPick(server.urls(), {
    placeHolder: 'Copy the address for the iPad (the .local name keeps working when the IP changes)',
  });
  if (url) {
    await vscode.env.clipboard.writeText(url);
    vscode.window.showInformationMessage(`Copied ${url} – open it in Safari on the iPad (Universal Clipboard: just paste there).`);
  }
}

export function deactivate(): void {}

async function chooseTheme(): Promise<void> {
  const items = [
    { label: 'Auto', description: 'Follow VS Code theme', value: 'auto' },
    { label: 'Light', description: 'Always light', value: 'light' },
    { label: 'Dark', description: 'Always dark', value: 'dark' },
  ];
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Color mode of the Markdown Live Editor' });
  if (picked) {
    await vscode.workspace.getConfiguration('mdLive').update('theme', picked.value, vscode.ConfigurationTarget.Global);
  }
}

function tabUri(tab: vscode.Tab | undefined): vscode.Uri | undefined {
  const input = tab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) {
    return input.uri;
  }
  return undefined;
}

// Replaces the active tab with the same file opened in another editor type.
async function switchEditor(uri: vscode.Uri | undefined, viewType: string): Promise<void> {
  const oldTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const target = uri ?? tabUri(oldTab);
  if (!target) {
    vscode.window.showWarningMessage('No Markdown file is active.');
    return;
  }
  await vscode.commands.executeCommand('vscode.openWith', target, viewType);
  if (oldTab && tabUri(oldTab)?.toString() === target.toString()) {
    await vscode.window.tabGroups.close(oldTab);
  }
}
