import type { Root, RootContent } from 'mdast';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

// Plain remark only serves as a normalizer: a block of the original text and a block of the editor's
// output are the same if they normalize to the same Markdown.
const processor = remark().use(remarkGfm).use(remarkMath);

type Block = { start: number; end: number; key: string };

function blocks(text: string): Block[] {
  const root = processor.parse(text) as Root;
  return root.children.map((node: RootContent) => ({
    start: node.position!.start.offset!,
    end: node.position!.end.offset!,
    key: processor.stringify({ type: 'root', children: [node] }),
  }));
}

// The editor re-serializes the whole note on every change. This keeps the original source of every
// top-level block (and the gaps between them) the user did not change, so only edited blocks get
// Crepe's formatting.
export function preserveSource(source: string, edited: string): string {
  const old = blocks(source);
  const next = blocks(edited);
  if (old.length === 0 || next.length === 0) {
    return edited;
  }
  // Longest common subsequence of block keys.
  const lcs = Array.from({ length: old.length + 1 }, () => new Array<number>(next.length + 1).fill(0));
  for (let i = old.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      lcs[i][j] = old[i].key === next[j].key ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const match = new Array<number>(next.length).fill(-1);
  for (let i = 0, j = 0; i < old.length && j < next.length; ) {
    if (old[i].key === next[j].key) {
      match[j++] = i++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  let result = match[0] === 0 ? source.slice(0, old[0].start) : edited.slice(0, next[0].start);
  for (let j = 0; j < next.length; j++) {
    const i = match[j];
    if (j > 0) {
      const adjacent = i > 0 && match[j - 1] === i - 1;
      result += adjacent ? source.slice(old[i - 1].end, old[i].start) : edited.slice(next[j - 1].end, next[j].start);
    }
    result += i >= 0 ? source.slice(old[i].start, old[i].end) : edited.slice(next[j].start, next[j].end);
  }
  const last = next.length - 1;
  result += match[last] === old.length - 1 ? source.slice(old[old.length - 1].end) : edited.slice(next[last].end);
  return result;
}
