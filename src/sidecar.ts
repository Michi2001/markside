// Notes on a PDF live in a Markdown file next to it (`paper.pdf` → `paper.pdf.md`):
//
//   ## Page 3                                       ← note on the whole page (its body)
//   ### [quoted text](#p3=x,y,w,h;x,y,w,h&c=green)  ← note on marked text
//   ### [Area](#p3=x,y,w,h&area)                    ← note on an area of the page
//
// Rectangles are fractions of the page size (0..1, origin top left). Everything else in the file
// (text before the first page, other headings inside a note) is kept as it is.
// Shared by the extension and the PDF webview; no vscode imports.

export type Rect = { x: number; y: number; w: number; h: number };

export type Anchor = { page: number; rects: Rect[]; area: boolean; color: string };

export type Section = {
  // `page:3` for page notes, the anchor (`p3=…`) for text and area notes.
  key: string;
  page: number;
  anchor?: Anchor;
  label: string;
  body: string;
  // Offsets: heading line start, end of the heading line, end of the section.
  start: number;
  bodyStart: number;
  end: number;
};

const PAGE_HEADING = /^## Page (\d+)[ \t]*$/;
const NOTE_HEADING = /^### \[((?:\\.|[^\]\\])*)\]\(#(p\d+=[^)\s]*)\)[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,}|\$\$)/;

export function pageKey(page: number): string {
  return `page:${page}`;
}

const round = (n: number): string => String(Math.round(n * 10000) / 10000);

export function formatAnchor({ page, rects, area, color }: Anchor): string {
  const boxes = rects.map((r) => [r.x, r.y, r.w, r.h].map(round).join(',')).join(';');
  return `p${page}=${boxes}${area ? '&area' : ''}${color !== 'yellow' ? `&c=${color}` : ''}`;
}

export function parseAnchor(anchor: string): Anchor {
  const [main, ...params] = anchor.split('&');
  const [, page, boxes] = /^p(\d+)=(.*)$/.exec(main)!;
  const rects = boxes
    .split(';')
    .map((b) => b.split(',').map(Number))
    .filter((n) => n.length === 4 && n.every(Number.isFinite))
    .map(([x, y, w, h]) => ({ x, y, w, h }));
  const color = params.find((p) => p.startsWith('c='))?.slice(2) ?? 'yellow';
  return { page: Number(page), rects, area: params.includes('area'), color };
}

export function escapeLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim().replace(/[\\[\]]/g, '\\$&');
}

function noteBody(text: string, from: number, to: number): string {
  return text.slice(from, to).replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
}

export function parseSections(text: string): Section[] {
  const sections: Section[] = [];
  let fence: string | undefined;
  let offset = 0;
  for (const line of text.split('\n')) {
    const start = offset;
    offset += line.length + 1;
    const clean = line.replace(/\r$/, '');
    const marker = FENCE.exec(clean)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    const page = PAGE_HEADING.exec(clean);
    const note = NOTE_HEADING.exec(clean);
    if (!page && !note) {
      continue;
    }
    const previous = sections[sections.length - 1];
    if (previous) {
      previous.end = start;
    }
    const anchor = note ? parseAnchor(note[2]) : undefined;
    sections.push({
      key: note ? note[2] : pageKey(Number(page![1])),
      page: anchor ? anchor.page : Number(page![1]),
      anchor,
      label: note ? note[1].replace(/\\(.)/g, '$1') : '',
      body: '',
      start,
      bodyStart: start + line.length,
      end: text.length,
    });
  }
  for (const s of sections) {
    s.body = noteBody(text, s.bodyStart, s.end);
  }
  return sections;
}

// Inserts a block at a section boundary with one blank line on each side.
function insertBlock(text: string, pos: number, block: string): string {
  const head = text.slice(0, pos).trimEnd();
  const tail = text.slice(pos);
  return (head ? head + '\n\n' : '') + block + (tail ? '\n\n' + tail : '\n');
}

function removeRange(text: string, from: number, to: number): string {
  const head = text.slice(0, from).trimEnd();
  const tail = text.slice(to);
  return head + (head && tail ? '\n\n' : head ? '\n' : '') + tail;
}

function setBody(text: string, s: Section, body: string): string {
  const next = s.end < text.length;
  return text.slice(0, s.bodyStart) + '\n' + (body ? `\n${body}\n` : '') + (next ? '\n' : '') + text.slice(s.end);
}

// Position for a new page section: before the first page with a higher number, else at the end.
function pageInsertPos(text: string, sections: Section[], page: number): number {
  const next = sections.find((s) => !s.anchor && s.page > page);
  return next ? next.start : text.length;
}

function topOf(anchor: Anchor): number {
  return Math.min(...anchor.rects.map((r) => r.y));
}

// Adds a text or area note below its page heading, ordered by its position on the page.
export function addNote(text: string, anchor: Anchor, label: string, body: string): string {
  let sections = parseSections(text);
  if (!sections.some((s) => !s.anchor && s.page === anchor.page)) {
    text = insertBlock(text, pageInsertPos(text, sections, anchor.page), `## Page ${anchor.page}`);
    sections = parseSections(text);
  }
  const pageIndex = sections.findIndex((s) => !s.anchor && s.page === anchor.page);
  let pos = text.length;
  for (const s of sections.slice(pageIndex + 1)) {
    if (!s.anchor || (s.page === anchor.page && topOf(s.anchor) > topOf(anchor))) {
      pos = s.start;
      break;
    }
  }
  const heading = `### [${escapeLabel(label)}](#${formatAnchor(anchor)})`;
  return insertBlock(text, pos, body ? `${heading}\n\n${body}` : heading);
}

// Replaces the body of a note; a page note is created on demand and an empty page section without
// notes is removed again.
export function setNoteBody(text: string, key: string, body: string): string {
  const sections = parseSections(text);
  const index = sections.findIndex((s) => s.key === key);
  if (index === -1) {
    const page = Number(/^page:(\d+)$/.exec(key)?.[1]);
    if (!page || !body) {
      return text;
    }
    return insertBlock(text, pageInsertPos(text, sections, page), `## Page ${page}\n\n${body}`);
  }
  const s = sections[index];
  const hasNotes = sections[index + 1]?.anchor !== undefined;
  if (!s.anchor && !body && !hasNotes) {
    return removeRange(text, s.start, s.end);
  }
  return setBody(text, s, body);
}

// Removes a note; its page section goes too once it has neither a page note nor other notes.
export function deleteNote(text: string, key: string): string {
  const sections = parseSections(text);
  const s = sections.find((s) => s.key === key);
  if (!s) {
    return text;
  }
  text = removeRange(text, s.start, s.end);
  const after = parseSections(text);
  const index = after.findIndex((p) => !p.anchor && p.page === s.page);
  if (index !== -1 && !after[index].body && after[index + 1]?.anchor === undefined) {
    text = removeRange(text, after[index].start, after[index].end);
  }
  return text;
}
