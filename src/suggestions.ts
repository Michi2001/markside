// Changes Claude suggests for a note after Alt+Shift+K (`foo.assets/.proposals.md`). Claude writes one
// section per change; accepting one replaces the quoted text of the note with the replacement:
//
//   ## s3 · line 42 · Loss compares with the    ← id + line the quote starts at + short title
//                     original
//
//   > Loss = Differenz zur Eingabe              ← exact Markdown source it replaces (one or more lines)
//
//   Loss = Differenz zum originalen Input       ← the replacement (empty: delete the quoted text)
//
//   Why: The loss uses the uncorrupted input.
// `line` (1-based, as Claude saw the note) only picks among several occurrences of the quote, since
// accepting other changes shifts lines. `position`: where the quote ends, as share of the note's lines
// (set by the extension for the webview, which has no source lines).
export type Suggestion = { id: string; title: string; quote: string; body: string; why: string; line?: number; position?: number };

const HEADING = /^## (s\d+)(?:[ \t]*·[ \t]*(.*))?$/;
const LINE = /^line[ \t]+(\d+)[ \t]*(?:·[ \t]*)?/i;
const WHY = /^Why:\s*/;

export function parseSuggestions(text: string): Suggestion[] {
  const sections: (Suggestion & { lines: string[] })[] = [];
  for (const line of text.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      const title = heading[2]?.trim() ?? '';
      const line = LINE.exec(title);
      sections.push({ id: heading[1], title: title.replace(LINE, ''), line: line ? Number(line[1]) : undefined, quote: '', body: '', why: '', lines: [] });
    } else {
      sections[sections.length - 1]?.lines.push(line);
    }
  }
  return sections
    .map(({ lines, ...s }) => {
      let i = lines.findIndex((l) => l.trim());
      const quote: string[] = [];
      while (i !== -1 && i < lines.length && lines[i].startsWith('>')) {
        quote.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      const rest = i === -1 ? [] : lines.slice(i);
      const why = rest.findIndex((l) => WHY.test(l));
      return {
        ...s,
        quote: quote.join('\n').trim(),
        body: (why === -1 ? rest : rest.slice(0, why)).join('\n').trim(),
        why: why === -1 ? '' : rest.slice(why).join(' ').replace(WHY, '').trim(),
      };
    })
    .filter((s) => s.quote);
}

// The file without the section `id` (Claude's text of the other sections stays as it is).
export function removeSuggestion(text: string, id: string): string {
  let skip = false;
  const kept = text.split(/\r?\n/).filter((line) => {
    const heading = HEADING.exec(line);
    if (heading) {
      skip = heading[1] === id;
    }
    return !skip;
  });
  const result = kept.join('\n').trim();
  return result && result + '\n';
}

// Raw text of the section `id`, for questions about it.
export function suggestionSource(text: string, id: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => HEADING.exec(l)?.[1] === id);
  if (start === -1) {
    return undefined;
  }
  const end = lines.findIndex((l, i) => i > start && HEADING.test(l));
  return lines.slice(start, end === -1 ? undefined : end).join('\n').trim();
}

// Where the quoted source occurs in the note: exactly, else with any whitespace (line breaks, indentation).
// Of several occurrences the one starting closest to `line` (1-based), else the first.
export function findQuote(text: string, quote: string, line?: number): { start: number; end: number } | undefined {
  const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const anySpace = quote.trim().split(/\s+/).map(escape).join('\\s+');
  for (const regex of [new RegExp(escape(quote), 'g'), new RegExp(anySpace, 'g')]) {
    const matches = [...text.matchAll(regex)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
    if (matches.length) {
      const distance = (m: { start: number }) => (line === undefined ? 0 : Math.abs(lineAt(text, m.start) - line));
      return matches.reduce((best, m) => (distance(m) < distance(best) ? m : best));
    }
  }
  return undefined;
}

// 1-based line of the offset.
export function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}
