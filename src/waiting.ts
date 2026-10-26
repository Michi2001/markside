import * as vscode from 'vscode';

// Long waits (drawing on the iPad, Claude explaining slides) are shown as a status bar item instead
// of a progress notification: VS Code plays a looping sound (accessibility signal "progress") for
// every progress bar visible longer than 3 s.

const CANCEL_COMMAND = 'mdLive.cancelWaiting';
const cancels = new Map<number, () => void>();
let nextId = 0;

export function registerWaiting(): vscode.Disposable {
  return vscode.commands.registerCommand(CANCEL_COMMAND, (id: number) => cancels.get(id)?.());
}

// Shows `title` with a spinner until `task` settles; clicking the item calls `cancel`.
export async function showWaiting<T>(title: string, cancel: () => void, task: Promise<T>): Promise<T> {
  const id = nextId++;
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  item.text = `$(loading~spin) ${title}`;
  item.tooltip = 'Click to cancel';
  item.command = { command: CANCEL_COMMAND, title: 'Cancel', arguments: [id] };
  cancels.set(id, cancel);
  item.show();
  try {
    return await task;
  } finally {
    cancels.delete(id);
    item.dispose();
  }
}
