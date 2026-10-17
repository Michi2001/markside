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
// Rectangles are optional: Claude's explanations (`paper.pdf.claude.md`) name the term only.
const NOTE_HEADING = /^### \[((?:\\.|[^\]\\])*)\]\(#(p\d+(?:=[^)\s]*)?)\)[ \t]*$/;
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
  const [, page, boxes = ''] = /^p(\d+)(?:=(.*))?$/.exec(main)!;
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
  const s = parseSections(text).find((s) => s.key === key);
  return s ? deleteSection(text, s) : text;
}

// Explanations by Claude (`paper.pdf.claude.md`): the same format, `## Page N` explains the slide,
// `### [term](#pN)` a term on it (looked up on the page by its text). Keys include the term, since
// all terms on a page share the anchor.
export function parseExplanations(text: string): Section[] {
  return parseSections(text).map((s) => (s.anchor ? { ...s, key: `${s.key}|${s.label}` } : s));
}

// Removes a text/area note or term explanation found by parseSections/parseExplanations.
export function deleteSection(text: string, s: Section): string {
  if (!s.anchor) {
    return setNoteBody(text, s.key, '');
  }
  text = removeRange(text, s.start, s.end);
  const after = parseSections(text);
  const index = after.findIndex((p) => !p.anchor && p.page === s.page);
  if (index !== -1 && !after[index].body && after[index + 1]?.anchor === undefined) {
    text = removeRange(text, after[index].start, after[index].end);
  }
  return text;
}

// Claude's explanation of a page as one Markdown text. Older files explain terms in own
// `### [term](#pN)` sections; they become bullets below the page's text.
export function pageExplanation(sections: Section[], page: number): string {
  const own = sections.filter((s) => s.page === page);
  const body = own.find((s) => !s.anchor)?.body.trim() ?? '';
  const terms = own.filter((s) => s.anchor && s.body.trim()).map((s) => `- **${s.label}:** ${s.body.trim().replace(/\s*\n\s*/g, ' ')}`);
  return [body, terms.join('\n')].filter(Boolean).join('\n\n');
}

// Replaces a page's explanation (older term sections are merged into it); an empty body keeps the
// empty heading, so the page still counts as explained.
export function setExplanation(text: string, page: number, body: string): string {
  const own = parseSections(text).filter((s) => s.page === page);
  if (own.length === 0) {
    return text;
  }
  const tail = text.slice(Math.max(...own.map((s) => s.end)));
  return text.slice(0, Math.min(...own.map((s) => s.start))) + `## Page ${page}\n` + (body ? `\n${body}\n` : '') + (tail ? `\n${tail}` : '');
}

// Dividers between pages (lecture ends, own sections) as a list before the first page:
//
//   ## Sections
//
//   - After page 23 · 2026-10-14 · Introduction   ← lecture end (dated), optional title
//   - After page 30 · Bayesian uncertainty        ← own section starting on page 31
export type Divider = { after: number; date?: string; title: string };

const DIVIDERS_HEADING = '## Sections';
const DIVIDER = /^- After page (\d+)(?: · (\d{4}-\d{2}-\d{2}))?(?: · (.*?))?[ \t]*$/;

export function formatDivider({ after, date, title }: Divider): string {
  return [`- After page ${after}`, date, title].filter(Boolean).join(' · ');
}

// The `## Sections` block in the text before the first page, with the dividers it lists.
function dividersBlock(text: string): { start: number; end: number; dividers: Divider[] } | undefined {
  const preamble = text.slice(0, parseSections(text)[0]?.start ?? text.length);
  let offset = 0;
  let block: { start: number; end: number; dividers: Divider[] } | undefined;
  for (const line of preamble.split('\n')) {
    const start = offset;
    offset += line.length + 1;
    const clean = line.replace(/\r$/, '');
    if (!block) {
      if (clean.trim() === DIVIDERS_HEADING) {
        block = { start, end: start + line.length, dividers: [] };
      }
      continue;
    }
    const match = DIVIDER.exec(clean);
    if (match) {
      block.dividers.push({ after: Number(match[1]), date: match[2], title: match[3] ?? '' });
      block.end = start + line.length;
    } else if (clean.trim()) {
      break;
    }
  }
  return block;
}

export function parseDividers(text: string): Divider[] {
  return dividersBlock(text)?.dividers ?? [];
}

// Rewrites the `## Sections` block (at the top of the file if there is none); no dividers → no block.
export function setDividers(text: string, dividers: Divider[]): string {
  const block = dividersBlock(text) ?? { start: 0, end: 0 };
  const list = [...dividers].sort((a, b) => a.after - b.after).map(formatDivider);
  const head = text.slice(0, block.start).trimEnd();
  const tail = text.slice(block.end).replace(/^\s+/, '');
  const content = list.length > 0 ? `${DIVIDERS_HEADING}\n\n${list.join('\n')}` : '';
  const result = [head, content, tail].filter(Boolean).join('\n\n');
  return tail ? result : result && result + '\n';
}
