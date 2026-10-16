import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as vscode from 'vscode';

// Serves the drawing page (dist/ipad.js) to an iPad in the local network. The page listens for
// drawing requests via server-sent events and posts the finished file back. All URLs live under
// a secret token, so other devices in the network can't use the server.

const FILES: Record<string, string> = {
  'ipad.js': 'text/javascript; charset=utf-8',
  'ipad.css': 'text/css; charset=utf-8',
};
// Keeps idle event streams from being dropped by Safari or the network.
const KEEPALIVE_MS = 25000;
// The server only runs on demand: it stops this long after the last drawing request.
const IDLE_MS = 2 * 60 * 1000;
// Sidecar: time for an open browser window to reconnect before a new one is opened.
const RECONNECT_GRACE_MS = 5000;
// Sidecar mode listens on the loopback interface only, so no other device can reach the server.
const LOOPBACK = '127.0.0.1';
const CHROME = '/Applications/Google Chrome.app';
// Frame of the Sidecar display in top-left based global coordinates (as Chrome expects), or ''.
const FIND_SIDECAR = `ObjC.import('AppKit');
const screens = $.NSScreen.screens.js;
const s = screens.find((s) => /ipad|sidecar/i.test(s.localizedName.js));
const f = s && s.frame;
f ? [f.origin.x, screens[0].frame.size.height - f.origin.y - f.size.height, f.size.width, f.size.height].join(',') : '';`;
// Connects the iPad named in mdLive.sidecarIpad via the private SidecarCore framework (there is
// no public API) and waits until it is connected. NSScreen doesn't update inside this process, hence the
// separate FIND_SIDECAR run afterwards.
const connectSidecar = (name: string): string => `ObjC.import('Foundation');
$.NSBundle.bundleWithPath('/System/Library/PrivateFrameworks/SidecarCore.framework').load;
const manager = $.NSClassFromString('SidecarDisplayManager').sharedManager;
// macOS appends a number like ' (6)' to the device name.
const base = (n) => n.replace(/ \\(\\d+\\)$/, '');
const name = base(${JSON.stringify(name)});
const device = manager.devices.js.find((d) => base(d.name.js) === name);
if (device) {
  manager.connectToDeviceCompletion(device, () => {});
  for (let i = 0; i < 60 && manager.connectedDevices.js.length === 0; i++) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.5));
  }
}`;
const SIDECAR_SETTLE_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jxa(script: string): Promise<string> {
  return new Promise((resolve) => execFile('osascript', ['-l', 'JavaScript', '-e', script], (_err, stdout) => resolve(stdout.trim())));
}

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="Handwriting">
  <title>Handwriting</title>
  <link rel="stylesheet" href="ipad.css">
</head>
<body>
  <div id="status">Connecting …</div>
  <script src="ipad.js"></script>
</body>
</html>`;

// `drawing` is the webview's Drawing (strokes + optional background image), passed through as is.
// `file` is the drawing (or restored image) to save: name, mime and base64 data.
export type DrawingFile = { name: string; mime: string; data: string };
// Where a drawing belongs: the note (URI) and the image link in it (null for a new drawing).
export type DrawingTarget = { note: string; src: string | null };
type Pending = { id: number; drawing: unknown; target: DrawingTarget; resolve: (file: DrawingFile | null) => void };

export function getDrawingDevice(): string {
  return vscode.workspace.getConfiguration('mdLive').get<string>('drawingDevice', 'mac');
}

function getPort(): number {
  return vscode.workspace.getConfiguration('mdLive').get<number>('ipadPort', 8765);
}

export class DrawingServer implements vscode.Disposable {
  private server: http.Server | undefined;
  private keepalive: NodeJS.Timeout | undefined;
  private idle: NodeJS.Timeout | undefined;
  private readonly clients = new Set<http.ServerResponse>();
  private pending: Pending | undefined;
  // Results already handled: a resend (response lost on the way) is acknowledged but not saved twice.
  private readonly handled = new Set<number>();

  constructor(
    private readonly distUri: vscode.Uri,
    private readonly token: string,
    // Profile of the separate Chrome instance for the Sidecar window.
    private readonly browserDir: string,
    // Saves a result nobody waits for anymore into its note.
    private readonly saveToNote: (file: DrawingFile, target: DrawingTarget) => Promise<void>,
  ) {}

  // Starts the server (if needed) and (re)arms the idle timeout.
  start(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => !this.pending && this.stop(), IDLE_MS);
    if (this.server) {
      return;
    }
    const server = http.createServer((req, res) => this.handle(req, res));
    server.on('error', (err) => {
      vscode.window.showWarningMessage(`iPad drawing server: ${err.message}`);
      this.stop();
    });
    server.listen(getPort(), getDrawingDevice() === 'sidecar' ? LOOPBACK : undefined);
    this.server = server;
    this.keepalive = setInterval(() => this.clients.forEach((c) => c.write(': keepalive\n\n')), KEEPALIVE_MS);
  }

  stop(): void {
    clearTimeout(this.idle);
    // No `cancel` to the iPad: its canvas stays open (VS Code reload, setting change), and the
    // result it sends later is saved into its note via `saveToNote`.
    this.pending?.resolve(null);
    this.pending = undefined;
    clearInterval(this.keepalive);
    this.clients.forEach((c) => c.end());
    this.clients.clear();
    this.server?.close();
    this.server = undefined;
  }

  dispose(): void {
    this.stop();
  }

  // Bonjour name first (stays valid when the IP changes), then the IPv4 addresses.
  urls(): string[] {
    if (getDrawingDevice() === 'sidecar') {
      return [`http://${LOOPBACK}:${getPort()}/${this.token}/`];
    }
    const name = os.hostname().replace(/\.local$/, '') + '.local';
    const ips = Object.values(os.networkInterfaces())
      .flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal)
      .map((a) => a!.address);
    return [name, ...ips].map((host) => `http://${host}:${getPort()}/${this.token}/`);
  }

  // Opens the drawing surface on the iPad and waits for the result (null = cancelled/empty).
  draw(drawing: unknown, target: DrawingTarget): Promise<DrawingFile | null> {
    this.start();
    const sidecar = getDrawingDevice() === 'sidecar';
    const title = sidecar
      ? 'Drawing in the browser window …'
      : this.clients.size > 0
        ? 'Drawing on the iPad …'
        : `Waiting for the iPad – open ${this.urls()[0]} there`;
    if (sidecar) {
      this.showOnSidecar();
    }
    return Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        (_progress, cancel) => {
          cancel.onCancellationRequested(() => this.cancel());
          // The idle timeout counts from the end of the request.
          return this.request(drawing, target).finally(() => this.server && this.start());
        },
      ),
    );
  }

  // Connects the iPad via Sidecar if needed and makes sure the drawing page is open on it.
  private async showOnSidecar(): Promise<void> {
    let frame = await jxa(FIND_SIDECAR);
    const ipad = vscode.workspace.getConfiguration('mdLive').get<string>('sidecarIpad', '');
    let connected = false;
    if (!frame && ipad) {
      await jxa(connectSidecar(ipad));
      await sleep(SIDECAR_SETTLE_MS);
      frame = await jxa(FIND_SIDECAR);
      connected = !!frame;
    }
    if (!frame) {
      vscode.window.showWarningMessage('No Sidecar display (iPad not reachable?) – opening the drawing page on the Mac.');
    }
    if (connected) {
      // A window that is still open sits on the Mac display; replace it.
      await new Promise((r) => execFile('pkill', ['-f', `--user-data-dir=${this.browserDir}`], r));
      await sleep(1000);
    } else {
      // Gives an open window time to reconnect (the server may just have started).
      await sleep(RECONNECT_GRACE_MS);
      if (this.clients.size > 0) {
        return;
      }
    }
    if (this.pending) {
      this.openSidecarWindow(frame);
    }
  }

  // A separate Chrome instance (own profile, so the flags apply even while Chrome runs) opens
  // the page as a full screen app window on the Sidecar display.
  private openSidecarWindow(frame: string): void {
    const url = this.urls()[0];
    if (!fs.existsSync(CHROME)) {
      vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }
    const [x, y, w, h] = frame ? frame.split(',') : [];
    const args = [`--user-data-dir=${this.browserDir}`, '--no-first-run', '--no-default-browser-check', `--app=${url}`];
    if (frame) {
      args.push(`--window-position=${x},${y}`, `--window-size=${w},${h}`, '--start-fullscreen');
    }
    spawn('open', ['-na', CHROME, '--args', ...args], { detached: true, stdio: 'ignore' }).unref();
  }

  private request(drawing: unknown, target: DrawingTarget): Promise<DrawingFile | null> {
    this.cancel();
    return new Promise((resolve) => {
      // Unique across restarts of the extension, so the iPad's draft never matches a wrong request.
      const id = Date.now();
      this.pending = { id, drawing, target, resolve };
      this.broadcast('draw', { id, drawing, target });
    });
  }

  private cancel(): void {
    if (!this.pending) {
      return;
    }
    const { id, resolve } = this.pending;
    this.pending = undefined;
    this.broadcast('cancel', { id });
    resolve(null);
  }

  private broadcast(event: string, data: unknown, clients: Iterable<http.ServerResponse> = this.clients): void {
    for (const client of clients) {
      client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const prefix = `/${this.token}/`;
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (!path.startsWith(prefix)) {
      res.writeHead(404).end();
      return;
    }
    const route = path.slice(prefix.length);
    if (route === '') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
    } else if (route in FILES) {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.distUri, route));
      res.writeHead(200, { 'Content-Type': FILES[route], 'Cache-Control': 'no-cache' }).end(data);
    } else if (route === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      // Short reconnect delay, so the page finds the server quickly once it runs again.
      res.write('retry: 3000\n: connected\n\n');
      this.clients.add(res);
      req.on('close', () => this.clients.delete(res));
      if (this.pending) {
        const { id, drawing, target } = this.pending;
        this.broadcast('draw', { id, drawing, target }, [res]);
      }
    } else if (route === 'result' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const { id, file, target } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(204).end();
      if (this.handled.has(id)) {
        return;
      }
      const pending = this.pending;
      if (pending && pending.id === id) {
        this.handled.add(id);
        this.pending = undefined;
        // Closes the canvas on other open iPad pages.
        this.broadcast('cancel', { id });
        pending.resolve(file);
      } else if (file) {
        this.handled.add(id);
        await this.saveToNote(file, target);
      }
    } else if (route === 'asset') {
      // The original image of a drawing the iPad reopens from its draft (the draft keeps no image data).
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
      const uri = vscode.Uri.joinPath(vscode.Uri.parse(params.get('note')!), '..', decodeURIComponent(params.get('src')!));
      if (fs.existsSync(uri.fsPath)) {
        res.writeHead(200).end(await vscode.workspace.fs.readFile(uri));
      } else {
        res.writeHead(404).end();
      }
    } else {
      res.writeHead(404).end();
    }
  }
}
