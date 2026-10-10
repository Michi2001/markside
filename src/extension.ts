import * as vscode from 'vscode';
import { registerAssetSync } from './assets';
import { LiveEditorProvider } from './liveEditor';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new LiveEditorProvider(context.extensionUri);

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
      provider.requestSelectionFromActivePanel(),
    ),
    vscode.commands.registerCommand('mdLive.chooseTheme', chooseTheme),
    registerAssetSync(),
  );
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
