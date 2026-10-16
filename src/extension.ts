import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { registerAssetSync } from './assets';
import { DrawingServer, getDrawingDevice, usbAddresses } from './drawingServer';
import { FontSizes } from './fontSizes';
import { LiveEditorProvider, saveToNote } from './liveEditor';
import { PdfEditorProvider } from './pdfEditor';

export function activate(context: vscode.ExtensionContext): void {
  // Persisted so the URL bookmarked on the iPad stays valid.
  let token = context.globalState.get<string>('ipadToken');
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    context.globalState.update('ipadToken', token);
  }
  // Started on demand (drawing request, showing the address) and stopped again when idle.
  const drawingServer = new DrawingServer(
    vscode.Uri.joinPath(context.extensionUri, 'dist'),
    token,
    vscode.Uri.joinPath(context.globalStorageUri, 'sidecar-browser').fsPath,
    saveToNote,
  );
  const fontSizes = new FontSizes(context.globalState);
  const provider = new LiveEditorProvider(context.extensionUri, drawingServer, fontSizes);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(LiveEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerCustomEditorProvider(PdfEditorProvider.viewType, new PdfEditorProvider(context.extensionUri, drawingServer, fontSizes), {
      webviewOptions: { retainContextWhenHidden: true },
      // Split view on the same PDF; every panel syncs through the shared notes TextDocument.
      supportsMultipleEditorsPerDocument: true,
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
    vscode.commands.registerCommand('mdLive.chooseFontSize', () => chooseFontSize(fontSizes)),
    // Before the rename, so the reopened editor already finds the note's size.
    vscode.workspace.onWillRenameFiles((e) => e.waitUntil(Promise.all(e.files.map((f) => fontSizes.rename(f.oldUri, f.newUri))))),
    vscode.commands.registerCommand('mdLive.chooseDrawingDevice', chooseDrawingDevice),
    // One variant per device, so the editor title shows the current device's icon.
    ...DEVICES.map((d) => vscode.commands.registerCommand(`mdLive.chooseDrawingDevice.${d.value}`, chooseDrawingDevice)),
    ...registerDeviceStatus(),
    vscode.commands.registerCommand('mdLive.showIpadUrl', () => showIpadUrl(drawingServer)),
    vscode.commands.registerCommand('mdLive.renewIpadUrl', async () => {
      const token = crypto.randomBytes(16).toString('hex');
      await context.globalState.update('ipadToken', token);
      drawingServer.setToken(token);
      await showIpadUrl(drawingServer);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      // Restarted on the next request (sidecar listens on another interface).
      if (e.affectsConfiguration('mdLive.drawingDevice') || e.affectsConfiguration('mdLive.ipadPort')) {
        drawingServer.stop();
      }
    }),
    drawingServer,
    registerAssetSync(),
  );
}

async function showIpadUrl(server: DrawingServer): Promise<void> {
  if (!['ipad', 'ipadUsb'].includes(getDrawingDevice())) {
    await vscode.workspace.getConfiguration('mdLive').update('drawingDevice', 'ipad', vscode.ConfigurationTarget.Global);
  }
  // Runs for a while, so the page can be opened and bookmarked on the iPad.
  server.start();
  if (getDrawingDevice() === 'ipadUsb' && usbAddresses().length === 0) {
    vscode.window.showWarningMessage('No USB connection to the iPad found – connect it with a cable (the server follows once it is there).');
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

const DEVICES = [
  { label: '$(device-desktop) Mac', description: 'Draw in the editor window', value: 'mac' },
  { label: '$(device-mobile) iPad', description: 'Safari on the iPad (same network)', value: 'ipad' },
  { label: '$(plug) iPad (USB)', description: 'Safari on the iPad, only via USB cable (public networks)', value: 'ipadUsb' },
  { label: '$(screen-full) Sidecar', description: 'Full screen window on the Sidecar display', value: 'sidecar' },
];

async function chooseDrawingDevice(): Promise<void> {
  const current = getDrawingDevice();
  const items = DEVICES.map((d) => ({ ...d, picked: d.value === current }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Where handwriting (Alt+D) opens' });
  if (picked) {
    await vscode.workspace.getConfiguration('mdLive').update('drawingDevice', picked.value, vscode.ConfigurationTarget.Global);
  }
}

// Status bar entry showing the drawing device while a live editor is active; click to switch.
function registerDeviceStatus(): vscode.Disposable[] {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'mdLive.chooseDrawingDevice';
  item.tooltip = 'Drawing device for handwriting (click to switch)';
  const update = (): void => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputCustom && [LiveEditorProvider.viewType, PdfEditorProvider.viewType].includes(input.viewType))) {
      item.hide();
      return;
    }
    const device = DEVICES.find((d) => d.value === getDrawingDevice()) ?? DEVICES[0];
    item.text = device.label;
    item.show();
  };
  update();
  return [
    item,
    vscode.window.tabGroups.onDidChangeTabs(update),
    vscode.window.tabGroups.onDidChangeTabGroups(update),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('mdLive.drawingDevice') && update()),
  ];
}

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

// Sets the font size of the active note or PDF only; "Default" makes it follow mdLive.fontSize again.
async function chooseFontSize(fontSizes: FontSizes): Promise<void> {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (!(input instanceof vscode.TabInputCustom && [LiveEditorProvider.viewType, PdfEditorProvider.viewType].includes(input.viewType))) {
    vscode.window.showWarningMessage('No Markdown Live Editor or PDF is active.');
    return;
  }
  const own = fontSizes.own(input.uri);
  const fallback = vscode.workspace.getConfiguration('mdLive').get<number>('fontSize', 16);
  const items = [
    { label: `Default (${fallback} px)`, description: own === undefined ? 'current' : 'setting mdLive.fontSize', value: undefined },
    ...[8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24].map((size) => ({
      label: `${size} px`,
      description: size === own ? 'current' : '',
      value: size as number | undefined,
    })),
  ];
  const name = decodeURIComponent(input.uri.path.split('/').pop()!);
  const picked = await vscode.window.showQuickPick(items, { placeHolder: `Font size of ${name} (current: ${fontSizes.get(input.uri)} px)` });
  if (picked) {
    await fontSizes.set(input.uri, picked.value);
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
