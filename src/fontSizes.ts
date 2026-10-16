import * as vscode from 'vscode';

const KEY = 'fontSizes';

// Font size per note (Markdown note or PDF), kept in the extension's global state by file URI; notes
// without their own size use the setting mdLive.fontSize.
export class FontSizes {
  private readonly changed = new vscode.EventEmitter<string>();
  // Fires with the URI of the note whose size changed.
  readonly onDidChange = this.changed.event;

  constructor(private readonly state: vscode.Memento) {}

  private sizes(): Record<string, number> {
    return this.state.get<Record<string, number>>(KEY, {});
  }

  // Undefined: the note follows the default.
  own(note: vscode.Uri): number | undefined {
    return this.sizes()[note.toString()];
  }

  get(note: vscode.Uri): number {
    return this.own(note) ?? vscode.workspace.getConfiguration('mdLive').get<number>('fontSize', 16);
  }

  async set(note: vscode.Uri, size: number | undefined): Promise<void> {
    const sizes = { ...this.sizes(), [note.toString()]: size };
    if (size === undefined) {
      delete sizes[note.toString()];
    }
    await this.state.update(KEY, sizes);
    this.changed.fire(note.toString());
  }

  // Keeps the size when a note is renamed or moved in VS Code.
  async rename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    const size = this.own(oldUri);
    if (size === undefined) {
      return;
    }
    const sizes = { ...this.sizes(), [newUri.toString()]: size };
    delete sizes[oldUri.toString()];
    await this.state.update(KEY, sizes);
  }
}
