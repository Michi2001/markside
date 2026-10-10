import { markRule } from '@milkdown/kit/prose';
import { toggleMark } from '@milkdown/kit/prose/commands';
import { $command, $inputRule, $markSchema, $remark } from '@milkdown/kit/utils';

type MdNode = { type: string; children?: MdNode[]; value?: string; color?: string };

// Background colors written to the file (Obsidian Highlightr palette). Yellow is saved as `==text==`.
export const HIGHLIGHT_COLORS: Record<string, string> = {
  red: '#FF5582A6',
  yellow: '#FFF3A3A6',
  green: '#BBFABBA6',
  blue: '#ADCCFFA6',
};

// Maps a `<mark>` style attribute to a palette name, or keeps an unknown CSS color as is.
function colorFromStyle(tag: string): string {
  const background = /background(?:-color)?\s*:\s*([^;"']+)/i.exec(tag)?.[1].trim();
  if (!background) {
    return 'yellow';
  }
  const name = Object.keys(HIGHLIGHT_COLORS).find((key) => HIGHLIGHT_COLORS[key].toLowerCase() === background.toLowerCase());
  return name ?? background;
}

// Wraps `<mark style="…">…</mark>` (separate inline html nodes) into colored `highlight` nodes.
function parseHtmlMarks(children: MdNode[]): MdNode[] {
  const result: MdNode[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const end = children.findIndex((c, j) => j > i && c.type === 'html' && /^<\/mark>$/i.test(c.value ?? ''));
    if (child.type === 'html' && /^<mark(\s[^>]*)?>$/i.test(child.value ?? '') && end !== -1) {
      result.push({ type: 'highlight', color: colorFromStyle(child.value!), children: children.slice(i + 1, end) });
      i = end;
    } else {
      result.push(child);
    }
  }
  return result;
}

// Splits `==text==` inside plain text nodes into `highlight` mdast nodes (Obsidian syntax).
function parseHighlights(node: MdNode): void {
  if (!node.children) {
    return;
  }
  node.children = parseHtmlMarks(node.children).flatMap((child) => {
    if (child.type !== 'text') {
      parseHighlights(child);
      return [child];
    }
    const parts = (child.value ?? '').split(/==([^=]+)==/);
    return parts
      .map((value, i): MdNode =>
        i % 2 === 1 ? { type: 'highlight', children: [{ type: 'text', value }] } : { type: 'text', value },
      )
      .filter((n) => n.type === 'highlight' || n.value);
  });
}

export function remarkHighlightPlugin(this: any) {
  const data = this.data();
  (data.toMarkdownExtensions ??= []).push({
    handlers: {
      highlight: (node: any, _parent: any, state: any, info: any) => {
        const color = node.color ?? 'yellow';
        if (color === 'yellow') {
          return '==' + state.containerPhrasing(node, { ...info, before: '=', after: '=' }) + '==';
        }
        const background = HIGHLIGHT_COLORS[color] ?? color;
        return `<mark style="background: ${background};">` + state.containerPhrasing(node, { ...info, before: '>', after: '<' }) + '</mark>';
      },
    },
  });
  return (tree: any) => parseHighlights(tree);
}

export const remarkHighlight = $remark('remarkHighlight', () => remarkHighlightPlugin);

export const highlightSchema = $markSchema('highlight', () => ({
  attrs: { color: { default: 'yellow', validate: 'string' } },
  parseDOM: [{ tag: 'mark', getAttrs: (dom) => ({ color: (dom as HTMLElement).dataset.color ?? 'yellow' }) }],
  toDOM: (mark) => {
    const { color } = mark.attrs;
    return ['mark', HIGHLIGHT_COLORS[color] ? { 'data-color': color } : { 'data-color': color, style: `background: ${color}` }, 0];
  },
  parseMarkdown: {
    match: (node) => node.type === 'highlight',
    runner: (state, node, markType) => {
      state.openMark(markType, { color: node.color ?? 'yellow' });
      state.next(node.children);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'highlight',
    runner: (state, mark) => {
      state.withMark(mark, 'highlight', undefined, { color: mark.attrs.color });
    },
  },
}));

// Highlights the selection in `color`; removes the highlight if it already has that color.
export const toggleHighlightCommand = $command('ToggleHighlight', (ctx) => (color: string = 'yellow') => (state, dispatch) => {
  const type = highlightSchema.type(ctx);
  const mark = type.create({ color });
  if (state.selection.empty) {
    return toggleMark(type, { color })(state, dispatch);
  }
  const tr = state.tr;
  for (const { $from, $to } of state.selection.ranges) {
    if (state.doc.rangeHasMark($from.pos, $to.pos, mark)) {
      tr.removeMark($from.pos, $to.pos, type);
    } else {
      tr.addMark($from.pos, $to.pos, mark);
    }
  }
  dispatch?.(tr.scrollIntoView());
  return true;
});

export const highlightInputRule = $inputRule((ctx) => markRule(/(?:==)([^=]+)(?:==)$/, highlightSchema.type(ctx)));

export const highlight = [remarkHighlight, highlightSchema, toggleHighlightCommand, highlightInputRule].flat();
