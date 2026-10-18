import './drawing.css';

// Handwritten drawings are saved as `<timestamp>.drawing.svg`; the strokes are embedded as JSON
// in <metadata>, so the drawing renders anywhere and can be reopened for editing.
export const DRAWING_SUFFIX = '.drawing.svg';
// Drawings on top of an image embed it (data URL) and get a white background; they are not
// inverted in dark themes, so the image keeps its colors.
const IMAGE_DRAWING_SUFFIX = '.image.drawing.svg';

// Empty space kept around the strokes when cropping on save.
const PADDING = 12;
// Longest side of a drawing rendered as PNG for Claude (Alt+K).
const MAX_PNG_SIZE = 2000;
// Margin shown above/left of an existing drawing when it is reopened.
const VIEW_MARGIN = 48;
const GRID = 20;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;
const GRID_COLOR = 'rgba(128, 128, 128, 0.25)';
const SELECTION_COLOR = '#1c64d6';
const ERASER_RADIUS = 10;
const PEN_COLORS = ['#1e1e1e', '#1c64d6', '#d6336c', '#2b9348'];
const HIGHLIGHTER_COLORS = ['#fff200', '#7cfc7c', '#ff7edb'];
const HIGHLIGHTER_OPACITY = 0.45;
const THINNING = 0.5;
// Colors offered when changing a pen or highlighter (plus a free color picker).
const PEN_PALETTE = ['#1e1e1e', '#5c5c5c', '#9e9e9e', '#8b5a2b', '#1c64d6', '#00a2e8', '#6f42c1', '#d6336c', '#e8590c', '#f2b705', '#2b9348', '#0ca678'];
const HIGHLIGHTER_PALETTE = ['#fff200', '#ffc94d', '#7cfc7c', '#5ef0e0', '#7fb8ff', '#c8a2ff', '#ff7edb', '#ff8a8a'];
// Size steps per tool, from fine to very bold.
const SIZES = { pen: [1, 2, 4, 8, 14], highlighter: [8, 14, 22, 32, 44] };

export type Stroke = {
  color: string;
  size: number;
  // Real pen pressure; mouse input (or Sidecar without pressure) simulates it from speed.
  pen: boolean;
  // Semi-transparent, constant width, drawn below the ink.
  highlighter?: boolean;
  points: number[][]; // [x, y, pressure]
};

// Fixed background image in world coordinates (drawing on a picture).
// `nodeWidth` is the image's width attr in the note, restored when all strokes are removed.
export type Background = { href: string; x: number; y: number; width: number; height: number; nodeWidth: number };
export type Drawing = { strokes: Stroke[]; image?: Background };
// A file for `saveImage` (base64 data).
export type DrawingFile = { name: string; mime: string; data: string };

type Tool = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'space' | 'shape';
type Ink = 'pen' | 'highlighter';

// The shapes of OneNote's shape menu.
const SHAPES = {
  line: 'M4 20 20 4',
  arrow: 'M4 20 20 4M12 4h8v8',
  doubleArrow: 'M4 20 20 4M12 4h8v8M4 12v8h8',
  rectangle: 'M3 6h18v12H3z',
  ellipse: 'M3 12a9 6 0 1 0 18 0a9 6 0 1 0-18 0',
  circle: 'M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0',
  triangle: 'M12 4l9 16H3z',
  rightTriangle: 'M4 4v16h16z',
  diamond: 'M12 3l9 9-9 9-9-9z',
  parallelogram: 'M7 6h14l-4 12H3z',
  trapezoid: 'M7 6h10l4 12H3z',
  axes: 'M5 3v16h16M2 6l3-3 3 3M18 16l3 3-3 3',
  axes4: 'M2 12h20M12 2v20M19 9l3 3-3 3M9 5l3-3 3 3',
};
type Shape = keyof typeof SHAPES;
const SHAPE_TITLES: Record<Shape, string> = {
  line: 'Line',
  arrow: 'Arrow',
  doubleArrow: 'Double arrow',
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  circle: 'Circle',
  triangle: 'Triangle',
  rightTriangle: 'Right triangle',
  diamond: 'Diamond',
  parallelogram: 'Parallelogram',
  trapezoid: 'Trapezoid',
  axes: 'Coordinate axes',
  axes4: 'Coordinate axes (4 quadrants)',
};

// A running pen/mouse interaction of the current tool, fed with world coordinates.
type Gesture = { move(p: number[]): void; end(): void };

let open = false;

export function isDrawing(src: string): boolean {
  return src.toLowerCase().endsWith(DRAWING_SUFFIX);
}

export function hasBackground(src: string): boolean {
  return src.toLowerCase().endsWith(IMAGE_DRAWING_SUFFIX);
}

// The SVG, or the plain background image again once all strokes are gone (no white border).
export function drawingFile({ strokes, image }: Drawing): DrawingFile {
  if (strokes.length === 0 && image) {
    const [, mime, data] = /^data:([^;,]+);base64,(.*)$/.exec(image.href)!;
    return { name: 'image', mime, data };
  }
  // The SVG is pure ASCII (numbers, hex colors, base64).
  return { name: `handwriting${image ? IMAGE_DRAWING_SUFFIX : DRAWING_SUFFIX}`, mime: 'image/svg+xml', data: btoa(toSvg(strokes, image)) };
}

export function isDrawingOpen(): boolean {
  return open;
}

export function parseDrawing(svg: string): Drawing {
  const json = /<metadata id="mdlive-drawing">([\s\S]*?)<\/metadata>/.exec(svg)?.[1];
  if (!json) {
    console.warn('No drawing data in SVG');
    return { strokes: [] };
  }
  const { strokes, image, gridShift = [0, 0] } = JSON.parse(json);
  const href = /<image id="mdlive-background"[^>]*\shref="([^"]*)"/.exec(svg)?.[1];
  // Undoes the crop's shift modulo the grid, so the strokes sit on the grid as when they were drawn.
  const [sx, sy] = gridShift;
  return {
    strokes: strokes.map((s: Stroke) => translate(s, -sx, -sy)),
    ...(image && href ? { image: { ...image, href, x: image.x - sx, y: image.y - sy } } : {}),
  };
}

export async function loadDrawing(url: string): Promise<Drawing> {
  return parseDrawing(await (await fetch(url)).text());
}

// A drawing as PNG (base64) on white, for Claude: the ink is stored dark, a background image is embedded.
export async function drawingPng(url: string): Promise<string> {
  const svg = new Blob([await (await fetch(url)).text()], { type: 'image/svg+xml' });
  const img = new Image();
  img.src = await blobToDataUrl(svg);
  await img.decode();
  const scale = Math.min(2, MAX_PNG_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png').split(',')[1];
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(blob);
  });
}

// A new drawing on top of an image, shown `width` px wide (as in the note).
export async function imageDrawing(url: string, width: number, nodeWidth: number): Promise<Drawing> {
  const href = await blobToDataUrl(await (await fetch(url)).blob());
  const img = new Image();
  img.src = href;
  await img.decode();
  const w = Math.round(width);
  return { strokes: [], image: { href, x: 0, y: 0, width: w, height: Math.round((img.naturalHeight * w) / img.naturalWidth), nodeWidth } };
}

// A stroke is drawn as round-capped polylines, one per run of equal width; the same runs are used
// on the canvas (while writing and afterwards) and in the SVG, so nothing changes on pen-up.
// Pen width follows pressure: size * (1 - THINNING * (1 - 2 * pressure)), rounded to 0.25px.
function runs(stroke: Stroke): { width: number; points: number[][] }[] {
  const width = (p: number): number =>
    stroke.highlighter ? stroke.size : Math.round(stroke.size * (1 - THINNING * (1 - 2 * (stroke.pen ? p : 0.5))) * 4) / 4;
  const pts = stroke.points;
  // A single point (a dot) needs a tiny second point to be drawn with round caps.
  if (pts.length === 1) {
    return [{ width: width(pts[0][2]), points: [pts[0], [pts[0][0] + 0.01, pts[0][1]]] }];
  }
  const result: { width: number; points: number[][] }[] = [];
  for (let i = 1; i < pts.length; i++) {
    const w = width(pts[i][2]);
    const last = result[result.length - 1];
    if (last && last.width === w) {
      last.points.push(pts[i]);
    } else {
      result.push({ width: w, points: [pts[i - 1], pts[i]] });
    }
  }
  return result;
}

// Highlighters first, so they stay below the ink.
function paintOrder(strokes: Stroke[]): Stroke[] {
  return [...strokes.filter((s) => s.highlighter), ...strokes.filter((s) => !s.highlighter)];
}

function bounds(strokes: Stroke[]): { x1: number; y1: number; x2: number; y2: number } {
  const xs = strokes.flatMap((s) => s.points.flatMap((p) => [p[0] - s.size, p[0] + s.size]));
  const ys = strokes.flatMap((s) => s.points.flatMap((p) => [p[1] - s.size, p[1] + s.size]));
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

function translate(stroke: Stroke, dx: number, dy: number): Stroke {
  const round = (v: number): number => Number(v.toFixed(1));
  return { ...stroke, points: stroke.points.map(([x, y, p]) => [round(x + dx), round(y + dy), p]) };
}

// Cropped to the strokes (and image): they are moved so the bounding box starts at PADDING.
// On an image whose strokes all lie inside it, the SVG is exactly the image: no padding, no white border.
function toSvg(strokes: Stroke[], image?: Background): string {
  const imageBox = image && { x1: image.x, y1: image.y, x2: image.x + image.width, y2: image.y + image.height };
  const inside =
    imageBox && strokes.every((s) => s.points.every(([x, y]) => x >= imageBox.x1 && x <= imageBox.x2 && y >= imageBox.y1 && y <= imageBox.y2));
  const boxes = [...(strokes.length > 0 ? [bounds(strokes)] : []), ...(imageBox ? [imageBox] : [])];
  const box = inside
    ? imageBox
    : {
        x1: Math.min(...boxes.map((b) => b.x1)),
        y1: Math.min(...boxes.map((b) => b.y1)),
        x2: Math.max(...boxes.map((b) => b.x2)),
        y2: Math.max(...boxes.map((b) => b.y2)),
      };
  const pad = inside ? 0 : PADDING;
  const moved = paintOrder(strokes).map((s) => translate(s, pad - box.x1, pad - box.y1));
  const phase = (v: number): number => Number((((v % GRID) + GRID) % GRID).toFixed(1));
  const gridShift = [phase(pad - box.x1), phase(pad - box.y1)];
  const placed = image && { x: Number((image.x + pad - box.x1).toFixed(1)), y: Number((image.y + pad - box.y1).toFixed(1)), width: image.width, height: image.height, nodeWidth: image.nodeWidth };
  const width = Math.ceil(box.x2 - box.x1 + 2 * pad);
  const height = Math.ceil(box.y2 - box.y1 + 2 * pad);
  const paths = moved
    .map((s) => {
      const opacity = s.highlighter ? ` stroke-opacity="${HIGHLIGHTER_OPACITY}"` : '';
      const lines = runs(s).map((r) => `<polyline stroke-width="${r.width}" points="${r.points.map((p) => `${p[0]},${p[1]}`).join(' ')}"/>`);
      return `<g fill="none" stroke="${s.color}"${opacity} stroke-linecap="round" stroke-linejoin="round">${lines.join('')}</g>`;
    })
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<metadata id="mdlive-drawing">${JSON.stringify({ version: 1, strokes: moved, gridShift, ...(placed ? { image: placed } : {}) })}</metadata>
${placed ? `${inside ? '' : '<rect width="100%" height="100%" fill="#fff"/>\n'}<image id="mdlive-background" x="${placed.x}" y="${placed.y}" width="${placed.width}" height="${placed.height}" preserveAspectRatio="none" href="${image!.href}"/>\n` : ''}${paths}
</svg>
`;
}

// Shape dragged from a to b as a single polyline; arrow heads and axes retrace their path, which
// is invisible with round joins and keeps every shape one ordinary stroke (erasable, movable).
function shapePoints(shape: Shape, a: number[], b: number[], size: number): number[][] {
  const [l, r] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
  const [t, btm] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
  const [cx, cy] = [(l + r) / 2, (t + btm) / 2];
  const d = (r - l) / 4;
  // Arrow head at `to`, as [wing, tip, wing].
  const head = (from: number[], to: number[]): number[][] => {
    const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
    const len = Math.max(10, size * 4);
    const wing = (spread: number): number[] => [to[0] - len * Math.cos(angle - spread), to[1] - len * Math.sin(angle - spread)];
    return [wing(0.45), to, wing(-0.45)];
  };
  const points: Record<Shape, () => number[][]> = {
    line: () => [a, b],
    arrow: () => [a, b, ...head(a, b)],
    doubleArrow: () => [...head(b, a), a, b, ...head(a, b)],
    rectangle: () => [[l, t], [r, t], [r, btm], [l, btm], [l, t]],
    ellipse: () =>
      Array.from({ length: 73 }, (_, i) => [cx + ((r - l) / 2) * Math.cos((i / 36) * Math.PI), cy + ((btm - t) / 2) * Math.sin((i / 36) * Math.PI)]),
    // Square box from the start point in the drag direction, sized by the larger side.
    circle: () => {
      const side = Math.max(r - l, btm - t);
      const ccx = a[0] + (Math.sign(b[0] - a[0]) * side) / 2;
      const ccy = a[1] + (Math.sign(b[1] - a[1]) * side) / 2;
      return Array.from({ length: 73 }, (_, i) => [ccx + (side / 2) * Math.cos((i / 36) * Math.PI), ccy + (side / 2) * Math.sin((i / 36) * Math.PI)]);
    },
    triangle: () => [[cx, t], [r, btm], [l, btm], [cx, t]],
    rightTriangle: () => [[l, t], [r, btm], [l, btm], [l, t]],
    diamond: () => [[cx, t], [r, cy], [cx, btm], [l, cy], [cx, t]],
    parallelogram: () => [[l + d, t], [r, t], [r - d, btm], [l, btm], [l + d, t]],
    trapezoid: () => [[l + d, t], [r - d, t], [r, btm], [l, btm], [l + d, t]],
    axes: () => [...head([l, btm], [l, t]), [l, t], [l, btm], [r, btm], ...head([l, btm], [r, btm])],
    axes4: () => [[l, cy], [r, cy], ...head([cx, cy], [r, cy]), [r, cy], [cx, cy], [cx, btm], [cx, t], ...head([cx, cy], [cx, t])],
  };
  const round = (v: number): number => Number(v.toFixed(1));
  return points[shape]().map(([x, y]) => [round(x), round(y), 0.5]);
}

function distanceToSegment(x: number, y: number, [ax, ay]: number[], [bx, by]: number[]): number {
  const length2 = (bx - ax) ** 2 + (by - ay) ** 2;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / length2));
  return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)));
}

// Point eraser: removes the parts of a stroke within `reach` of (x, y) and splits the rest.
function eraseFrom(stroke: Stroke, x: number, y: number, reach: number): Stroke[] {
  const round = (v: number, digits: number): number => Number(v.toFixed(digits));
  // Densify first, so long straight segments (shapes) can be cut in the middle.
  const dense = [stroke.points[0]];
  for (let i = 1; i < stroke.points.length; i++) {
    const [ax, ay, ap] = stroke.points[i - 1];
    const [bx, by, bp] = stroke.points[i];
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / (reach / 2));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      dense.push([round(ax + (bx - ax) * t, 1), round(ay + (by - ay) * t, 1), round(ap + (bp - ap) * t, 2)]);
    }
  }
  const pieces: number[][][] = [[]];
  for (const q of dense) {
    if (Math.hypot(q[0] - x, q[1] - y) < reach) {
      if (pieces[pieces.length - 1].length > 0) {
        pieces.push([]);
      }
    } else {
      pieces[pieces.length - 1].push(q);
    }
  }
  return pieces.filter((points) => points.length > 1).map((points) => ({ ...stroke, points }));
}

// Changed pen/highlighter colors are a per-device convenience; without storage the defaults are used.
function loadColors(kind: Ink, defaults: string[]): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(`mdlive-${kind}-colors`) ?? 'null');
    return Array.isArray(saved) && saved.length === defaults.length ? saved : [...defaults];
  } catch {
    return [...defaults];
  }
}

function saveColors(kind: Ink, colors: string[]): void {
  try {
    localStorage.setItem(`mdlive-${kind}-colors`, JSON.stringify(colors));
  } catch {
    console.warn('Could not save pen colors');
  }
}

// Strokes copied with the lasso, kept across drawings (and reloads of the iPad page) on this device.
function loadClipboard(): Stroke[] {
  try {
    const saved = JSON.parse(localStorage.getItem('mdlive-drawing-clipboard') ?? 'null');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveClipboard(strokes: Stroke[]): void {
  try {
    localStorage.setItem('mdlive-drawing-clipboard', JSON.stringify(strokes));
  } catch {
    console.warn('Could not save copied strokes');
  }
}

function insidePolygon(x: number, y: number, polygon: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ---------- Toolbar ----------

const svgIcon = (body: string): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICONS = {
  undo: svgIcon('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: svgIcon('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  lasso: svgIcon(
    '<path d="M4.5 15.5C3 14.2 2 12.6 2 10.8 2 6.5 6.5 3 12 3s10 3.5 10 7.8-4.5 7.8-10 7.8c-1.6 0-3.2-.3-4.5-.8" stroke-dasharray="3 2.5"/><circle cx="5.5" cy="17.5" r="2"/><path d="M5.5 19.5c0 1.2.5 2 1.5 2.5"/>',
  ),
  copy: svgIcon('<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>'),
  paste: svgIcon(
    '<path d="M9 4H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M9 13h6M12 10v6"/>',
  ),
  space: svgIcon('<path d="M12 3v18"/><path d="m8 7 4-4 4 4"/><path d="m8 17 4 4 4-4"/><path d="M3 12h3M18 12h3"/>'),
  eraser: svgIcon(
    '<path d="m7 21-4.3-4.3a2.4 2.4 0 0 1 0-3.4l9.6-9.6a2.4 2.4 0 0 1 3.4 0l5.6 5.6a2.4 2.4 0 0 1 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  ),
  shape: (shape: Shape): string => svgIcon(`<path d="${SHAPES[shape]}"/>`),
  strokeEraser: svgIcon('<path d="M14 2.5 19.5 8 13 14.5 7.5 9z"/><path d="M3 20c3-4 6 1 9-2s5-2 9-4" stroke-dasharray="1.5 2.5"/>'),
  pointEraser: svgIcon('<path d="M14 2.5 19.5 8 13 14.5 7.5 9z"/><path d="M3 20c2-3 4-1 6-1.5M15.5 17.5c2-1 3.5-1.5 5.5-3"/>'),
  shapes: svgIcon('<rect x="2.5" y="9.5" width="11" height="11" rx="1.5"/><circle cx="15" cy="9" r="6.5"/>'),
  pen: (color: string): string =>
    `<svg viewBox="0 0 24 40"><path d="M7 40V18l5-14 5 14v22z" fill="#e8e8e8" stroke="#9a9a9a" stroke-width="1"/><path d="M9.6 11 12 4l2.4 7z" fill="${color}"/><rect x="7.5" y="30" width="9" height="5" fill="${color}"/></svg>`,
  highlighter: (color: string): string =>
    `<svg viewBox="0 0 24 40"><path d="M5 40V20h14v20z" fill="#e8e8e8" stroke="#9a9a9a" stroke-width="1"/><path d="M7 20l2-12h7l1 12z" fill="${color}" stroke="#9a9a9a" stroke-width="1"/><rect x="5.5" y="30" width="13" height="5" fill="${color}"/></svg>`,
};

function button(className: string, title: string, html: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button');
  el.className = className;
  el.title = title;
  el.innerHTML = html;
  el.addEventListener('click', onClick);
  return el;
}

function separator(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'mdlive-sep';
  return el;
}

// ---------- Editor ----------

// Opens a full-window, infinite drawing surface. The canvas always covers the visible area and
// is redrawn with the view offset and zoom; scrolling only moves the view (wheel/trackpad on the
// Mac, one finger on the iPad), zooming only scales it (pinch, Ctrl+wheel). Saved sizes don't change.
// With a background image the surface is white and the image lies fixed under the strokes.
// Resolves with the drawing, or null if cancelled (also via `signal`) or empty.
// `onChange` gets the strokes after every change (the iPad page keeps a draft with them).
export function openDrawingEditor(
  initial: Drawing,
  signal?: AbortSignal,
  onChange?: (strokes: Stroke[]) => void,
): Promise<Drawing | null> {
  open = true;
  let strokes = initial.strokes;
  const image = initial.image;
  const undoStack: Stroke[][] = [];
  const redoStack: Stroke[][] = [];
  let tool: Tool = 'pen';
  // Colors of the tray's pens and highlighters (changeable) and which one is selected.
  const colors = { pen: loadColors('pen', PEN_COLORS), highlighter: loadColors('highlighter', HIGHLIGHTER_COLORS) };
  const slot = { pen: 0, highlighter: 0 };
  // Thin by default.
  const sizes = { pen: SIZES.pen[1], highlighter: SIZES.highlighter[1] };
  let eraserMode: 'stroke' | 'point' = 'stroke';
  let shape: Shape = 'line';
  // Strokes picked with the lasso (or below the space-tool line); `offset` previews a move.
  let selection = new Set<Stroke>();
  let offset = { dx: 0, dy: 0 };
  let clipboard = loadClipboard();
  // Drawn on top while a gesture runs: the stroke being drawn, the lasso loop, the space-tool line.
  let preview: { stroke?: Stroke; lasso?: number[][]; spaceY?: number; eraser?: number[] } = {};
  let gesture: Gesture | null = null;
  // Only this pointer draws; iOS implicitly captures palm touches too, so they must be ignored.
  let gesturePointer: number | null = null;
  // Active finger touches (screen coordinates): one pans, two pinch-zoom.
  const touches = new Map<number, { x: number; y: number }>();
  // World coordinates of the canvas' top-left corner; screen = (world - view) * zoom.
  let viewX = strokes.length > 0 || image ? -VIEW_MARGIN : 0;
  let viewY = viewX;
  let zoom = 1;

  const overlay = document.createElement('div');
  overlay.className = 'mdlive-drawing';
  const toolbar = document.createElement('div');
  toolbar.className = 'mdlive-drawing-toolbar';
  const stage = document.createElement('div');
  stage.className = 'mdlive-drawing-stage';
  const canvas = document.createElement('canvas');
  // Ink is inverted in dark themes, but not on top of an image.
  canvas.className = image ? '' : 'mdlive-ink';
  stage.append(canvas);
  overlay.append(toolbar, stage);
  document.body.append(overlay);
  const ctx = canvas.getContext('2d')!;
  const background = image && new Image();

  const selectionBox = (): ReturnType<typeof bounds> | null => {
    if (selection.size === 0) {
      return null;
    }
    const box = bounds([...selection]);
    const pad = 6 / zoom;
    return { x1: box.x1 + offset.dx - pad, y1: box.y1 + offset.dy - pad, x2: box.x2 + offset.dx + pad, y2: box.y2 + offset.dy + pad };
  };

  // Finished strokes never change (moves create new objects), so their runs are cached.
  const runCache = new WeakMap<Stroke, ReturnType<typeof runs>>();
  const drawStroke = (stroke: Stroke, cache = true): void => {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = stroke.color;
    // Highlighters are a single run, so overlapping segments don't add up their transparency.
    ctx.globalAlpha = stroke.highlighter ? HIGHLIGHTER_OPACITY : 1;
    if (cache && !runCache.has(stroke)) {
      runCache.set(stroke, runs(stroke));
    }
    for (const run of cache ? runCache.get(stroke)! : runs(stroke)) {
      ctx.lineWidth = run.width;
      ctx.beginPath();
      run.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  const redraw = (): void => {
    copyButton.disabled = selection.size === 0;
    pasteButton.disabled = clipboard.length === 0;
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = stage.getBoundingClientRect();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (image) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.beginPath();
    for (let gx = Math.floor(viewX / GRID) * GRID; (gx - viewX) * zoom < width; gx += GRID) {
      ctx.rect(Math.round((gx - viewX) * zoom), 0, 1, height);
    }
    for (let gy = Math.floor(viewY / GRID) * GRID; (gy - viewY) * zoom < height; gy += GRID) {
      ctx.rect(0, Math.round((gy - viewY) * zoom), width, 1);
    }
    ctx.fillStyle = GRID_COLOR;
    ctx.fill();
    ctx.scale(zoom, zoom);
    ctx.translate(-viewX, -viewY);
    if (image && background!.naturalWidth > 0) {
      ctx.drawImage(background!, image.x, image.y, image.width, image.height);
    }
    for (const stroke of paintOrder(strokes)) {
      const moving = selection.has(stroke);
      if (moving) {
        ctx.save();
        ctx.translate(offset.dx, offset.dy);
      }
      drawStroke(stroke);
      if (moving) {
        ctx.restore();
      }
    }
    if (preview.stroke) {
      drawStroke(preview.stroke, false);
    }
    ctx.lineWidth = 1.5 / zoom;
    ctx.setLineDash([6 / zoom, 4 / zoom]);
    ctx.strokeStyle = SELECTION_COLOR;
    if (preview.lasso) {
      ctx.beginPath();
      preview.lasso.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.stroke();
    }
    if (preview.spaceY !== undefined) {
      ctx.beginPath();
      ctx.moveTo(viewX, preview.spaceY);
      ctx.lineTo(viewX + width / zoom, preview.spaceY);
      ctx.stroke();
    } else if (selection.size > 0) {
      const box = selectionBox()!;
      ctx.strokeRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1);
    }
    ctx.setLineDash([]);
    if (preview.eraser) {
      const [x, y, r] = preview.eraser;
      ctx.strokeStyle = 'rgba(128, 128, 128, 0.9)';
      ctx.lineWidth = 1 / zoom;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.stroke();
    }
  };

  const resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = stage.getBoundingClientRect();
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    redraw();
  };
  if (background) {
    background.onload = redraw;
    background.src = image.href;
  }
  const observer = new ResizeObserver(resize);
  observer.observe(stage);

  // dx/dy in screen pixels.
  const scrollBy = (dx: number, dy: number): void => {
    viewX += dx / zoom;
    viewY += dy / zoom;
    redraw();
  };

  // Zooms by `factor` keeping the world point under screen position (sx, sy) in place.
  const zoomAt = (sx: number, sy: number, factor: number): void => {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
    viewX += sx / zoom - sx / next;
    viewY += sy / zoom - sy / next;
    zoom = next;
    redraw();
  };

  const commit = (next: Stroke[]): void => {
    undoStack.push(strokes);
    redoStack.length = 0;
    strokes = next;
    onChange?.(strokes);
  };

  const clearSelection = (): void => {
    selection = new Set();
    offset = { dx: 0, dy: 0 };
  };

  // ---------- Gestures per tool ----------

  const drawGesture = (p: number[], pen: boolean): Gesture => {
    const highlighter = tool === 'highlighter';
    const stroke: Stroke = {
      color: highlighter ? colors.highlighter[slot.highlighter] : colors.pen[slot.pen],
      size: sizes[highlighter ? 'highlighter' : 'pen'],
      pen,
      ...(highlighter ? { highlighter } : {}),
      points: [p],
    };
    preview = { stroke };
    return {
      move(q) {
        const last = stroke.points[stroke.points.length - 1];
        // Safari repeats positions.
        if (q[0] !== last[0] || q[1] !== last[1]) {
          stroke.points.push(q);
        }
      },
      end() {
        preview = {};
        commit([...strokes, stroke]);
      },
    };
  };

  // Drag from corner to corner (or start to end); uses the current pen color and size.
  const shapeGesture = (p: number[]): Gesture => {
    const size = sizes.pen;
    const stroke: Stroke = { color: colors.pen[slot.pen], size, pen: false, points: [] };
    preview = { stroke };
    return {
      move(q) {
        stroke.points = shapePoints(shape, p, q, size);
      },
      end() {
        preview = {};
        if (stroke.points.length > 0) {
          commit([...strokes, stroke]);
        }
      },
    };
  };

  // Stroke eraser removes every stroke it touches, the point eraser only the touched parts.
  const eraseGesture = (p: number[]): Gesture => {
    const before = strokes;
    const radius = ERASER_RADIUS / zoom;
    let last = p;
    const eraseAt = (x: number, y: number): void => {
      const reach = (s: Stroke): number => radius + s.size / 2;
      // Distance to the line segments, not just the points: long straight shape edges have none in between.
      const touched = (s: Stroke): boolean => s.points.some((q, i) => distanceToSegment(x, y, s.points[Math.max(0, i - 1)], q) < reach(s));
      if (strokes.some(touched)) {
        strokes = strokes.flatMap((s) => (!touched(s) ? [s] : eraserMode === 'stroke' ? [] : eraseFrom(s, x, y, reach(s))));
      }
    };
    // Fast moves skip ground between events, so erase along the way.
    const move = (q: number[]): void => {
      const steps = Math.max(1, Math.ceil(Math.hypot(q[0] - last[0], q[1] - last[1]) / (radius / 2)));
      for (let k = 1; k <= steps; k++) {
        eraseAt(last[0] + ((q[0] - last[0]) * k) / steps, last[1] + ((q[1] - last[1]) * k) / steps);
      }
      last = q;
      preview = { eraser: [q[0], q[1], radius] };
    };
    eraseAt(p[0], p[1]);
    preview = { eraser: [p[0], p[1], radius] };
    return {
      move,
      end() {
        preview = {};
        if (strokes !== before) {
          const after = strokes;
          strokes = before;
          commit(after);
        }
      },
    };
  };

  // Pen-down inside the selection box moves the selection, elsewhere it starts a new lasso.
  const lassoGesture = (p: number[]): Gesture => {
    const box = selectionBox();
    if (box && p[0] >= box.x1 && p[0] <= box.x2 && p[1] >= box.y1 && p[1] <= box.y2) {
      return {
        move(q) {
          offset = { dx: q[0] - p[0], dy: q[1] - p[1] };
        },
        end() {
          const moved = strokes.map((s) => (selection.has(s) ? translate(s, offset.dx, offset.dy) : s));
          selection = new Set(moved.filter((_s, i) => selection.has(strokes[i])));
          offset = { dx: 0, dy: 0 };
          commit(moved);
        },
      };
    }
    clearSelection();
    const loop = [p];
    preview = { lasso: loop };
    return {
      move(q) {
        loop.push(q);
      },
      end() {
        preview = {};
        // A stroke is picked when most of its points lie inside the loop.
        const picked = strokes.filter((s) => s.points.filter(([x, y]) => insidePolygon(x, y, loop)).length > s.points.length / 2);
        selection = new Set(picked);
      },
    };
  };

  // Moves everything below the pen-down line up or down (OneNote's "insert space").
  const spaceGesture = (p: number[]): Gesture => {
    selection = new Set(strokes.filter((s) => Math.min(...s.points.map((q) => q[1])) >= p[1]));
    preview = { spaceY: p[1] };
    return {
      move(q) {
        offset = { dx: 0, dy: q[1] - p[1] };
        preview = { spaceY: q[1] };
      },
      end() {
        const moved = strokes.map((s) => (selection.has(s) ? translate(s, 0, offset.dy) : s));
        preview = {};
        clearSelection();
        commit(moved);
      },
    };
  };

  // ---------- Toolbar ----------

  let resolve: (drawing: Drawing | null) => void;
  const result = new Promise<Drawing | null>((r) => (resolve = r));
  const finish = (drawing: Drawing | null): void => {
    open = false;
    observer.disconnect();
    window.removeEventListener('keydown', onKey);
    overlay.remove();
    resolve(drawing);
  };
  signal?.addEventListener('abort', () => finish(null));

  const toolButtons: { el: HTMLElement; active: () => boolean }[] = [];
  const updateToolbar = (): void => {
    toolButtons.forEach(({ el, active }) => el.classList.toggle('active', active()));
  };
  const toolButton = (className: string, title: string, html: string, active: () => boolean, select: () => void): HTMLButtonElement => {
    const el = button(className, title, html, () => {
      select();
      clearSelection();
      updateToolbar();
      redraw();
    });
    toolButtons.push({ el, active });
    return el;
  };
  const history = (from: Stroke[][], to: Stroke[][]): void => {
    if (from.length > 0) {
      to.push(strokes);
      strokes = from.pop()!;
      onChange?.(strokes);
      clearSelection();
      redraw();
    }
  };

  const copySelection = (): void => {
    if (selection.size > 0) {
      clipboard = strokes.filter((s) => selection.has(s));
      saveClipboard(clipboard);
      redraw();
    }
  };
  // Pastes the copied strokes centered in the view and selects them with the lasso, ready to move.
  const paste = (): void => {
    if (clipboard.length === 0) {
      return;
    }
    const { width, height } = stage.getBoundingClientRect();
    const box = bounds(clipboard);
    const dx = viewX + width / zoom / 2 - (box.x1 + box.x2) / 2;
    const dy = viewY + height / zoom / 2 - (box.y1 + box.y2) / 2;
    const pasted = clipboard.map((s) => translate(s, dx, dy));
    commit([...strokes, ...pasted]);
    tool = 'lasso';
    updateToolbar();
    clearSelection();
    selection = new Set(pasted);
    redraw();
  };
  const copyButton = button('mdlive-tool', 'Copy selected strokes (Cmd+C)', ICONS.copy, copySelection);
  const pasteButton = button('mdlive-tool', 'Paste copied strokes (Cmd+V)', ICONS.paste, paste);
  const onKey = (e: KeyboardEvent): void => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) {
      return;
    }
    const key = e.key.toLowerCase();
    if (key === 'c' || key === 'v') {
      e.preventDefault();
      (key === 'c' ? copySelection : paste)();
    }
  };
  window.addEventListener('keydown', onKey);

  const spacer = document.createElement('div');
  spacer.className = 'mdlive-spacer';

  // One popover below the toolbar for tool options (shapes, eraser mode, pen color and size).
  const popover = document.createElement('div');
  popover.className = 'mdlive-popover';
  popover.hidden = true;
  overlay.append(popover);
  let popoverAnchor: HTMLElement | null = null;
  const togglePopover = (anchor: HTMLElement, content: HTMLElement[]): void => {
    if (!popover.hidden && popoverAnchor === anchor) {
      popover.hidden = true;
      return;
    }
    popoverAnchor = anchor;
    popover.replaceChildren(...content);
    popover.hidden = false;
    const left = anchor.getBoundingClientRect().left;
    popover.style.left = `${Math.max(8, Math.min(left, window.innerWidth - popover.offsetWidth - 8))}px`;
    popover.style.top = `${toolbar.getBoundingClientRect().bottom + 6}px`;
  };
  overlay.addEventListener('pointerdown', (e) => {
    if (!popover.contains(e.target as Node) && !popoverAnchor?.contains(e.target as Node)) {
      popover.hidden = true;
    }
  });
  const element = (tag: string, className: string, ...children: (Node | string)[]): HTMLElement => {
    const el = document.createElement(tag);
    el.className = className;
    el.append(...children);
    return el;
  };

  // Size steps apply to all pens (and shapes) or, while a highlighter is selected, to all highlighters.
  const inkKind = (): Ink => (tool === 'highlighter' ? 'highlighter' : 'pen');

  // Color palette of one pen/highlighter in the tray; the last swatch opens the free color picker.
  const RAINBOW = 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)';
  const inkOptions = (kind: Ink, index: number): HTMLElement[] => {
    const palette = kind === 'pen' ? PEN_PALETTE : HIGHLIGHTER_PALETTE;
    const picker = document.createElement('input');
    picker.type = 'color';
    const custom = element('label', 'mdlive-swatch mdlive-custom', picker);
    custom.title = 'Custom color';
    const setColor = (color: string): void => {
      colors[kind][index] = color;
      saveColors(kind, colors[kind]);
      trayButtons[kind][index].innerHTML = ICONS[kind](color);
      swatches.forEach((el) => el.classList.toggle('active', el.dataset.color === color));
      // A custom color shows as a dot inside the rainbow ring.
      const isCustom = !palette.includes(color);
      custom.classList.toggle('active', isCustom);
      custom.style.background = isCustom ? `radial-gradient(circle, ${color} 0 42%, transparent 44%), ${RAINBOW}` : RAINBOW;
      picker.value = color;
    };
    const swatches = palette.map((color) => {
      const el = button('mdlive-swatch mdlive-ink', color, '', () => setColor(color));
      el.style.background = color;
      el.dataset.color = color;
      return el;
    });
    picker.addEventListener('input', () => setColor(picker.value));
    setColor(colors[kind][index]);
    const grid = element('div', 'mdlive-grid', ...swatches, custom);
    // Two rows.
    grid.style.gridTemplateColumns = `repeat(${Math.ceil((swatches.length + 1) / 2)}, auto)`;
    return [grid];
  };

  // Pens and highlighters sit in a tray at the bottom edge; the selected one slides up.
  // Tapping the selected one again opens its color/size options.
  const trayButton = (kind: Ink, index: number): HTMLButtonElement => {
    const el: HTMLButtonElement = toolButton('mdlive-pen mdlive-ink', kind === 'pen' ? 'Pen' : 'Highlighter', ICONS[kind](colors[kind][index]), () => tool === kind && slot[kind] === index, () => {
      if (tool === kind && slot[kind] === index) {
        togglePopover(el, inkOptions(kind, index));
      }
      tool = kind;
      slot[kind] = index;
    });
    return el;
  };
  const trayButtons = {
    pen: colors.pen.map((_c, i) => trayButton('pen', i)),
    highlighter: colors.highlighter.map((_c, i) => trayButton('highlighter', i)),
  };
  const tray = element('div', 'mdlive-pen-tray', ...trayButtons.pen, ...trayButtons.highlighter);

  // Shapes: the button opens a menu with all shapes; the current one is marked there.
  const shapeGrid = element(
    'div',
    'mdlive-grid',
    ...(Object.keys(SHAPES) as Shape[]).map((s) =>
      toolButton('mdlive-tool', SHAPE_TITLES[s], ICONS.shape(s), () => shape === s, () => {
        tool = 'shape';
        shape = s;
        popover.hidden = true;
      }),
    ),
  );
  const shapeButton: HTMLButtonElement = toolButton('mdlive-tool', 'Shapes', ICONS.shapes, () => tool === 'shape', () => {
    tool = 'shape';
    togglePopover(shapeButton, [shapeGrid]);
  });

  // Eraser: tapping it again while selected switches between stroke and point eraser.
  const eraserModes = element(
    'div',
    'mdlive-list',
    ...(['stroke', 'point'] as const).map((mode) =>
      toolButton(
        'mdlive-option',
        mode === 'stroke' ? 'Removes whole strokes' : 'Removes only what it touches',
        mode === 'stroke' ? `${ICONS.strokeEraser}<span>Stroke eraser</span>` : `${ICONS.pointEraser}<span>Point eraser</span>`,
        () => eraserMode === mode,
        () => {
          tool = 'eraser';
          eraserMode = mode;
          popover.hidden = true;
        },
      ),
    ),
  );
  const eraserButton: HTMLButtonElement = toolButton('mdlive-tool mdlive-has-options', 'Eraser (tap again for stroke/point eraser)', ICONS.eraser, () => tool === 'eraser', () => {
    if (tool === 'eraser') {
      togglePopover(eraserButton, [eraserModes]);
    }
    tool = 'eraser';
  });


  toolbar.append(
    button('mdlive-tool', 'Undo', ICONS.undo, () => history(undoStack, redoStack)),
    button('mdlive-tool', 'Redo', ICONS.redo, () => history(redoStack, undoStack)),
    separator(),
    toolButton('mdlive-tool', 'Lasso: select and move strokes', ICONS.lasso, () => tool === 'lasso', () => (tool = 'lasso')),
    copyButton,
    pasteButton,
    toolButton('mdlive-tool', 'Insert/remove space: drag everything below up or down', ICONS.space, () => tool === 'space', () => (tool = 'space')),
    eraserButton,
    separator(),
    tray,
    separator(),
    ...SIZES.pen.map((_size, level) => {
      const dot = `<span class="mdlive-dot" style="width:${3 + level * 3}px;height:${3 + level * 3}px"></span>`;
      return toolButton('mdlive-tool mdlive-size', `Size ${level + 1}`, dot, () => sizes[inkKind()] === SIZES[inkKind()][level], () => {
        if (tool !== 'highlighter' && tool !== 'shape') {
          tool = 'pen';
        }
        sizes[inkKind()] = SIZES[inkKind()][level];
      });
    }),
    separator(),
    shapeButton,
    spacer,
    button('mdlive-text', 'Discard changes', 'Cancel', () => finish(null)),
    button('mdlive-text primary', 'Save drawing', 'Done', () => finish(strokes.length > 0 || image ? { strokes, image } : null)),
  );
  updateToolbar();

  // ---------- Pointer input ----------

  const point = (e: PointerEvent): number[] => {
    const rect = canvas.getBoundingClientRect();
    const round = (v: number, digits: number): number => Number(v.toFixed(digits));
    const x = (e.clientX - rect.left) / zoom + viewX;
    const y = (e.clientY - rect.top) / zoom + viewY;
    return [round(x, 1), round(y, 1), round(e.pressure || 0.5, 2)];
  };

  const endGesture = (): void => {
    gesture?.end();
    gesture = null;
    gesturePointer = null;
    redraw();
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    // Fingers scroll and zoom (only while the pen is up); palms that slip through iOS' own
    // rejection therefore can't draw, at worst they nudge the view before the pen lands.
    if (e.pointerType === 'touch') {
      if (gesturePointer !== null || touches.size >= 2) {
        return;
      }
      // Like OneNote: a finger inside the lasso selection drags it.
      const box = touches.size === 0 && selectionBox();
      const p = point(e);
      if (box && p[0] >= box.x1 && p[0] <= box.x2 && p[1] >= box.y1 && p[1] <= box.y2) {
        gesturePointer = e.pointerId;
        gesture = lassoGesture(p);
        return;
      }
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      return;
    }
    touches.clear();
    // A new pen-down means the previous gesture is over, even if its pointerup got lost.
    if (gesture) {
      endGesture();
    }
    gesturePointer = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    const p = point(e);
    // A pen without pressure support reports a constant 0.5 like a mouse.
    const pen = e.pointerType === 'pen' && e.pressure !== 0.5;
    const start = { eraser: eraseGesture, lasso: lassoGesture, space: spaceGesture, shape: shapeGesture, pen: drawGesture, highlighter: drawGesture };
    gesture = start[tool](p, pen);
    redraw();
  });

  canvas.addEventListener('pointermove', (e) => {
    const touch = touches.get(e.pointerId);
    if (touch) {
      const rect = canvas.getBoundingClientRect();
      const [a, b] = [...touches.values()];
      if (!b) {
        scrollBy(touch.x - e.clientX, touch.y - e.clientY);
        touch.x = e.clientX;
        touch.y = e.clientY;
        return;
      }
      // Two fingers: zoom by the change of their distance around their midpoint, pan by its movement.
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      touch.x = e.clientX;
      touch.y = e.clientY;
      const nmx = (a.x + b.x) / 2;
      const nmy = (a.y + b.y) / 2;
      zoomAt(nmx - rect.left, nmy - rect.top, Math.hypot(a.x - b.x, a.y - b.y) / distance || 1);
      scrollBy(mx - nmx, my - nmy);
      return;
    }
    if (e.pointerId !== gesturePointer || !gesture) {
      return;
    }
    for (const ev of e.getCoalescedEvents?.() ?? [e]) {
      gesture.move(point(ev));
    }
    redraw();
  });

  const endPointer = (e: PointerEvent): void => {
    touches.delete(e.pointerId);
    if (e.pointerId === gesturePointer) {
      endGesture();
    }
  };
  // Blocks long-press selection, magnifier and callout menus for touches on the canvas (iPad).
  canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  // Trackpad / mouse wheel on the Mac.
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (e.ctrlKey) {
        // Trackpad pinch (and Ctrl+wheel) arrive as wheel events with ctrlKey.
        const rect = canvas.getBoundingClientRect();
        zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.01));
      } else {
        scrollBy(e.deltaX, e.deltaY);
      }
    },
    { passive: false },
  );

  return result;
}
