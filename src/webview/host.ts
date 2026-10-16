import type { Drawing, DrawingFile } from './drawing';

// Connection to the extension shared by all webviews (Markdown note, PDF annotations).

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

const vscode = acquireVsCodeApi();

export const host = {
  // Folder of the note as a webview URI; relative image paths are resolved against it.
  baseUri: '',
  // Setting mdLive.drawingDevice: draw in this webview ('mac') or on the drawing page served by the
  // extension, opened on the iPad ('ipad', 'ipadUsb') or in a browser window on the Mac ('sidecar').
  drawingDevice: 'mac',
};

let counter = 0;
const pendingUploads = new Map<number, (path: string) => void>();
const pendingDrawings = new Map<number, (path: string | null) => void>();

export function post(msg: unknown): void {
  vscode.postMessage(msg);
}

export function resolveUrl(url: string): string {
  if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) {
    return url;
  }
  return new URL(url, host.baseUri).toString();
}

function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.readAsDataURL(file);
  });
}

// Saves a file into the note's assets folder and resolves with its relative path.
export function saveFile(file: DrawingFile): Promise<string> {
  const id = ++counter;
  vscode.postMessage({ type: 'saveImage', id, ...file });
  return new Promise<string>((resolve) => pendingUploads.set(id, resolve));
}

export async function uploadImage(file: File): Promise<string> {
  return saveFile({ name: file.name, mime: file.type, data: await fileToBase64(file) });
}

// The extension sends the drawing to the drawing page (iPad or browser window) and saves the result.
// `src` (the edited image, none for a new drawing) lets the extension place a late result itself.
export function drawRemotely(drawing: Drawing, src?: string): Promise<string | null> {
  const id = ++counter;
  vscode.postMessage({ type: 'drawRemote', id, drawing, src: src ?? null });
  return new Promise((resolve) => pendingDrawings.set(id, resolve));
}

function setFontSize(size: number): void {
  document.body.style.setProperty('--mdlive-font-size', `${size}px`);
}

export function applyInit(msg: { baseUri: string; theme: string; fontSize: number; drawingDevice: string }): void {
  host.baseUri = msg.baseUri;
  host.drawingDevice = msg.drawingDevice;
  document.body.dataset.theme = msg.theme;
  setFontSize(msg.fontSize);
}

// Handles the messages every webview understands; returns false for the others.
export function handleHostMessage(msg: any): boolean {
  switch (msg.type) {
    case 'theme':
      document.body.dataset.theme = msg.theme;
      return true;
    case 'fontSize':
      setFontSize(msg.fontSize);
      return true;
    case 'drawingDevice':
      host.drawingDevice = msg.device;
      return true;
    case 'drawingSaved':
      pendingDrawings.get(msg.id)?.(msg.path);
      pendingDrawings.delete(msg.id);
      return true;
    case 'imageSaved':
      pendingUploads.get(msg.id)?.(msg.path);
      pendingUploads.delete(msg.id);
      return true;
  }
  return false;
}
