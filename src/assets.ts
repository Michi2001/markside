import * as path from 'path';
import * as vscode from 'vscode';
import type { Fold } from './webview/fold';

// Each note `foo.md` keeps its images in a sibling folder `foo.assets/`, linked relatively.
const ASSETS_SUFFIX = '.assets';
// Relative link to a sibling assets folder: `(foo.assets/123.png`, `"foo.assets/…`, `<foo.assets/…`.
const ASSET_REF = /(?<=[("'<])([^\s/()"'<>]+)\.assets\/([\w.-]+)/g;

// Collapsed headings of the note (view state of the live editor), kept with the images so it moves with the note.
const FOLDS_FILE = '.folds.json';

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
};

const fs = vscode.workspace.fs;

function noteBase(note: vscode.Uri): string {
  return path.basename(note.path, path.extname(note.path));
}

function assetsDir(note: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(note, '..', noteBase(note) + ASSETS_SUFFIX);
}

function assetsRef(note: vscode.Uri): string {
  return encodeURIComponent(noteBase(note)) + ASSETS_SUFFIX + '/';
}

// The notes file of a PDF: `paper.pdf` → `paper.pdf.md` (images in `paper.pdf.assets/`).
export function notesUri(pdf: vscode.Uri): vscode.Uri {
  return pdf.with({ path: pdf.path + '.md' });
}

function isPdf(uri: vscode.Uri): boolean {
  return uri.path.toLowerCase().endsWith('.pdf');
}

function isNote(uri: vscode.Uri): boolean {
  return uri.path.toLowerCase().endsWith('.md');
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  return fs.stat(uri).then(
    () => true,
    () => false,
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await fs.readFile(uri));
}

// Saves image bytes into the note's assets folder and returns the Markdown-relative path.
export async function saveImage(note: vscode.Uri, name: string, mime: string, data: string): Promise<string> {
  const dir = assetsDir(note);
  await fs.createDirectory(dir);
  // Handwritten drawings keep their double extension so the webview can reopen them for editing.
  const ext = /(\.image)?\.drawing\.svg$/i.exec(name)?.[0].toLowerCase() ?? (path.extname(name).toLowerCase() || MIME_EXTENSIONS[mime] || '.png');
  const fileName = `${Date.now()}${ext}`;
  await fs.writeFile(vscode.Uri.joinPath(dir, fileName), Buffer.from(data, 'base64'));
  return assetsRef(note) + fileName;
}

// Collapsed headings: a list for a note, a list per card (keyed by section) for PDF notes.
type Folds = Fold[] | Record<string, Fold[]>;

export async function loadFolds<T extends Folds>(note: vscode.Uri, empty: T): Promise<T> {
  const file = vscode.Uri.joinPath(assetsDir(note), FOLDS_FILE);
  return (await exists(file)) ? JSON.parse(await readText(file)) : empty;
}

// Writes the collapsed headings; with none left the file (and an otherwise empty folder) goes away.
export async function saveFolds(note: vscode.Uri, folds: Folds): Promise<void> {
  const dir = assetsDir(note);
  const file = vscode.Uri.joinPath(dir, FOLDS_FILE);
  if (Object.keys(folds).length > 0) {
    await fs.createDirectory(dir);
    await fs.writeFile(file, Buffer.from(JSON.stringify(folds)));
    return;
  }
  if (await exists(file)) {
    await fs.delete(file);
    if ((await fs.readDirectory(dir)).length === 0) {
      await fs.delete(dir, { recursive: true });
    }
  }
}

// Looks next to the note first; a note copied into another folder only finds its images via search.
async function findAsset(note: vscode.Uri, folder: string, file: string, search: boolean): Promise<vscode.Uri | undefined> {
  const sibling = vscode.Uri.joinPath(note, '..', folder, file);
  if (await exists(sibling)) {
    return sibling;
  }
  if (!search) {
    return undefined;
  }
  // `null` exclude: assets folders are usually hidden via files.exclude.
  const [found] = await vscode.workspace.findFiles(`**/${folder}/${file}`, null, 1);
  return found;
}

// Copies images linked from other notes' assets folders (e.g. after copying a note or pasting an image
// from another note) into this note's own folder and relinks them, so every folder has a single owner.
// `search` also looks for missing images in the whole workspace (too slow to run on every edit).
export async function adoptAssets(note: vscode.Uri, text: string, search = false): Promise<string> {
  const own = noteBase(note);
  let result = text;
  for (const [ref, folder, file] of text.matchAll(ASSET_REF)) {
    const name = decodeURIComponent(folder);
    const target = vscode.Uri.joinPath(assetsDir(note), file);
    if (name === own && (!search || (await exists(target)))) {
      continue;
    }
    const src = await findAsset(note, name + ASSETS_SUFFIX, file, search);
    if (!src) {
      continue;
    }
    await fs.createDirectory(assetsDir(note));
    await fs.copy(src, target, { overwrite: true });
    result = result.replaceAll(ref, assetsRef(note) + file);
  }
  return result;
}

// Moves images that are no longer linked from the note to the trash.
export async function cleanupAssets(document: vscode.TextDocument): Promise<void> {
  const dir = assetsDir(document.uri);
  if (!(await exists(document.uri)) || !(await exists(dir))) {
    return;
  }
  // Unsaved text counts too, so an image pasted right before closing survives until the save lands.
  const text = (await readText(document.uri)) + document.getText();
  for (const [name, type] of await fs.readDirectory(dir)) {
    if (type === vscode.FileType.File && name !== FOLDS_FILE && !text.includes(name)) {
      await fs.delete(vscode.Uri.joinPath(dir, name), { useTrash: true });
    }
  }
  if ((await fs.readDirectory(dir)).length === 0) {
    await fs.delete(dir, { recursive: true, useTrash: true });
  }
}

async function rewriteNote(note: vscode.Uri, change: (text: string) => Promise<string> | string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(note);
  const text = await change(document.getText());
  if (text === document.getText()) {
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(note, new vscode.Range(0, 0, document.lineCount, 0), text);
  await vscode.workspace.applyEdit(edit);
  await document.save();
}

// Keeps assets folders next to their notes when notes are renamed, moved, copied or deleted in VS Code.
export function registerAssetSync(): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.workspace.onDidRenameFiles(async (e) => {
      for (const { oldUri, newUri } of e.files) {
        // The notes of a PDF follow it; renaming them in turn moves their assets folder.
        if (isPdf(oldUri) && isPdf(newUri) && (await exists(notesUri(oldUri))) && !(await exists(notesUri(newUri)))) {
          const edit = new vscode.WorkspaceEdit();
          edit.renameFile(notesUri(oldUri), notesUri(newUri));
          await vscode.workspace.applyEdit(edit);
          continue;
        }
        if (!isNote(oldUri) || !isNote(newUri)) {
          continue;
        }
        const oldDir = assetsDir(oldUri);
        const newDir = assetsDir(newUri);
        if (!(await exists(oldDir)) || (await exists(newDir))) {
          continue;
        }
        await fs.rename(oldDir, newDir);
        const oldRef = new RegExp(`(?<=[("'<])${escapeRegExp(assetsRef(oldUri))}`, 'g');
        await rewriteNote(newUri, (text) => text.replace(oldRef, assetsRef(newUri)));
      }
    }),
    vscode.workspace.onDidCreateFiles(async (e) => {
      for (const uri of e.files.filter(isNote)) {
        await rewriteNote(uri, (text) => adoptAssets(uri, text, true));
      }
    }),
    vscode.workspace.onDidDeleteFiles(async (e) => {
      // A deleted PDF takes its notes file (and thus its assets folder) along.
      const notes = await Promise.all(e.files.filter(isPdf).map(async (pdf) => ((await exists(notesUri(pdf))) ? [notesUri(pdf)] : [])));
      for (const uri of notes.flat()) {
        await fs.delete(uri, { useTrash: true });
      }
      for (const uri of [...e.files.filter(isNote), ...notes.flat()]) {
        if (await exists(assetsDir(uri))) {
          await fs.delete(assetsDir(uri), { recursive: true, useTrash: true });
        }
      }
    }),
  );
}
