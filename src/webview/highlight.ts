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
export function colorFromStyle(tag: string): string {
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

// Turns `==text==` into `highlight` mdast nodes (Obsidian syntax). The highlight may span several
// nodes of one paragraph (`==a $x$ **b**==`): text nodes are split at `==` and each pair of
// delimiters wraps the nodes between them; an unpaired `==` stays text.
function parseHighlights(node: MdNode): void {
  if (!node.children) {
    return;
  }
  const items: (MdNode | 'delimiter')[] = [];
  for (const child of parseHtmlMarks(node.children)) {
    if (child.type !== 'text') {
      parseHighlights(child);
      items.push(child);
      continue;
    }
    (child.value ?? '').split('==').forEach((value, i) => {
      if (i > 0) {
        items.push('delimiter');
      }
      if (value) {
        items.push({ type: 'text', value });
      }
    });
  }
  const result: MdNode[] = [];
  const pushText = (value: string) => {
    const last = result[result.length - 1];
    if (last?.type === 'text') {
      last.value += value;
    } else {
      result.push({ type: 'text', value });
    }
  };
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const end = item === 'delimiter' ? items.indexOf('delimiter', i + 1) : -1;
    if (item !== 'delimiter') {
      if (item.type === 'text') {
        pushText(item.value!);
      } else {
        result.push(item);
      }
    } else if (end > i + 1) {
      result.push({ type: 'highlight', children: items.slice(i + 1, end) as MdNode[] });
      i = end;
    } else {
      pushText('==');
    }
  }
  node.children = result;
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

// Removes highlights from the selection; with only a cursor, the highlight around it.
export const removeHighlightCommand = $command('RemoveHighlight', (ctx) => () => (state, dispatch) => {
  const type = highlightSchema.type(ctx);
  let { from, to } = state.selection;
  if (from === to) {
    const $pos = state.selection.$from;
    let runStart = -1;
    let range: { from: number; to: number } | undefined;
    $pos.parent.forEach((child, offset) => {
      const pos = $pos.start() + offset;
      if (!type.isInSet(child.marks)) {
        runStart = -1;
        return;
      }
      if (runStart < 0) {
        runStart = pos;
      }
      if (runStart <= from && from <= pos + child.nodeSize) {
        range = { from: runStart, to: pos + child.nodeSize };
      }
    });
    if (!range) {
      return false;
    }
    ({ from, to } = range);
  }
  dispatch?.(state.tr.removeMark(from, to, type));
  return true;
});

export const highlightInputRule = $inputRule((ctx) => markRule(/(?:==)([^=]+)(?:==)$/, highlightSchema.type(ctx)));

export const highlight = [remarkHighlight, highlightSchema, toggleHighlightCommand, removeHighlightCommand, highlightInputRule].flat();
