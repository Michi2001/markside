import * as vscode from 'vscode';

const KEY = 'fontSizes';

// Font size per note (Markdown note or PDF), kept in the extension's global state by file URI; notes
// without their own size use the setting mdLive.fontSize, PDFs 'auto': the size of the PDF's body text
// as shown when the PDF is opened, worked out by the PDF view.
export type FontSize = number | 'auto';

export function isPdf(uri: vscode.Uri): boolean {
  return uri.path.toLowerCase().endsWith('.pdf');
}

export class FontSizes {
  private readonly changed = new vscode.EventEmitter<string>();
  // Fires with the URI of the note whose size changed.
  readonly onDidChange = this.changed.event;

  constructor(private readonly state: vscode.Memento) {}

  private sizes(): Record<string, FontSize> {
    return this.state.get<Record<string, FontSize>>(KEY, {});
  }

  // Undefined: the note follows the default.
  own(note: vscode.Uri): FontSize | undefined {
    return this.sizes()[note.toString()];
  }

  get(note: vscode.Uri): FontSize {
    return this.own(note) ?? (isPdf(note) ? 'auto' : vscode.workspace.getConfiguration('mdLive').get<number>('fontSize', 16));
  }

  async set(note: vscode.Uri, size: FontSize | undefined): Promise<void> {
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
