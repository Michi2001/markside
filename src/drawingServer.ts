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
type Pending = { id: number; drawing: unknown; resolve: (file: DrawingFile | null) => void };

export function getDrawingDevice(): string {
  return vscode.workspace.getConfiguration('mdLive').get<string>('drawingDevice', 'mac');
}

function getPort(): number {
  return vscode.workspace.getConfiguration('mdLive').get<number>('ipadPort', 8765);
}

export class DrawingServer implements vscode.Disposable {
  private server: http.Server | undefined;
  private keepalive: NodeJS.Timeout | undefined;
  private readonly clients = new Set<http.ServerResponse>();
  private pending: Pending | undefined;
  private nextId = 1;

  constructor(
    private readonly distUri: vscode.Uri,
    private readonly token: string,
  ) {}

  start(): void {
    if (this.server) {
      return;
    }
    const server = http.createServer((req, res) => this.handle(req, res));
    server.on('error', (err) => {
      vscode.window.showWarningMessage(`iPad drawing server: ${err.message}`);
      this.stop();
    });
    server.listen(getPort());
    this.server = server;
    this.keepalive = setInterval(() => this.clients.forEach((c) => c.write(': keepalive\n\n')), KEEPALIVE_MS);
  }

  stop(): void {
    this.cancel();
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
    const name = os.hostname().replace(/\.local$/, '') + '.local';
    const ips = Object.values(os.networkInterfaces())
      .flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal)
      .map((a) => a!.address);
    return [name, ...ips].map((host) => `http://${host}:${getPort()}/${this.token}/`);
  }

  // Opens the drawing surface on the iPad and waits for the result (null = cancelled/empty).
  draw(drawing: unknown): Promise<DrawingFile | null> {
    this.start();
    const title = this.clients.size > 0 ? 'Drawing on the iPad …' : `Waiting for the iPad – open ${this.urls()[0]} there`;
    return Promise.resolve(
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        (_progress, cancel) => {
          cancel.onCancellationRequested(() => this.cancel());
          return this.request(drawing);
        },
      ),
    );
  }

  private request(drawing: unknown): Promise<DrawingFile | null> {
    this.cancel();
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending = { id, drawing, resolve };
      this.broadcast('draw', { id, drawing });
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
      res.write(': connected\n\n');
      this.clients.add(res);
      req.on('close', () => this.clients.delete(res));
      if (this.pending) {
        this.broadcast('draw', { id: this.pending.id, drawing: this.pending.drawing }, [res]);
      }
    } else if (route === 'result' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const { id, file } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(204).end();
      const pending = this.pending;
      if (pending && pending.id === id) {
        this.pending = undefined;
        // Closes the canvas on other open iPad pages.
        this.broadcast('cancel', { id });
        pending.resolve(file);
      }
    } else {
      res.writeHead(404).end();
    }
  }
}
