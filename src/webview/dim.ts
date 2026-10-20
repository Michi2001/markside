import { toggleMark } from '@milkdown/kit/prose/commands';
import { $command, $markSchema, $remark } from '@milkdown/kit/utils';

type MdNode = { type: string; children?: MdNode[]; value?: string };

// Grayed-out text for less important information (Alt+G), saved as inline HTML.
const OPEN = '<span style="color: gray;">';
const OPEN_TAG = /^<span\s+style="color:\s*gray;?">$/i;
const CLOSE_TAG = /^<\/span>$/i;

// Wraps `<span style="color: gray;">…</span>` (separate inline html nodes) into `dim` nodes.
function parseDim(node: MdNode): void {
  if (!node.children) {
    return;
  }
  const result: MdNode[] = [];
  const children = node.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const end = children.findIndex((c, j) => j > i && c.type === 'html' && CLOSE_TAG.test(c.value ?? ''));
    if (child.type === 'html' && OPEN_TAG.test(child.value ?? '') && end !== -1) {
      const dim = { type: 'dim', children: children.slice(i + 1, end) };
      parseDim(dim);
      result.push(dim);
      i = end;
    } else {
      parseDim(child);
      result.push(child);
    }
  }
  node.children = result;
}

export function remarkDimPlugin(this: any) {
  const data = this.data();
  (data.toMarkdownExtensions ??= []).push({
    handlers: {
      dim: (node: any, _parent: any, state: any, info: any) =>
        OPEN + state.containerPhrasing(node, { ...info, before: '>', after: '<' }) + '</span>',
    },
  });
  return (tree: any) => parseDim(tree);
}

const remarkDim = $remark('remarkDim', () => remarkDimPlugin);

const dimSchema = $markSchema('dim', () => ({
  parseDOM: [{ tag: 'span.mdlive-dim' }],
  toDOM: () => ['span', { class: 'mdlive-dim' }, 0],
  parseMarkdown: {
    match: (node) => node.type === 'dim',
    runner: (state, node, markType) => {
      state.openMark(markType);
      state.next(node.children);
      state.closeMark(markType);
    },
  },
  toMarkdown: {
    match: (mark) => mark.type.name === 'dim',
    runner: (state, mark) => {
      state.withMark(mark, 'dim');
    },
  },
}));

const toggleDimCommand = $command('ToggleDim', (ctx) => () => toggleMark(dimSchema.type(ctx)));

export const dim = [remarkDim, dimSchema, toggleDimCommand].flat();
