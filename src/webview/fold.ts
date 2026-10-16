import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { type EditorState, Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';

// Positions of collapsed top-level headings and list items. View-only state, never written to the Markdown.
const foldKey = new PluginKey<number[]>('mdlive-fold');

// A collapsed node as stored in the note's assets folder: the `n`-th heading with this level and text,
// or for `level` 0 the `n`-th list item with this text (of its first paragraph).
export type Fold = { level: number; text: string; n: number };

function isHeading(node: ProseNode | null | undefined): boolean {
  return node?.type.name === 'heading';
}

function isItem(node: ProseNode | null | undefined): boolean {
  return node?.type.name === 'list_item';
}

function hasSublist(item: ProseNode): boolean {
  return item.childCount > 1;
}

// Range hidden by the heading at `pos`: the following top-level blocks up to the next heading of the same or a higher level.
function sectionEnd(doc: ProseNode, pos: number): number {
  const level = doc.nodeAt(pos)!.attrs.level;
  let end = pos + doc.nodeAt(pos)!.nodeSize;
  while (end < doc.content.size) {
    const next = doc.nodeAt(end)!;
    if (isHeading(next) && next.attrs.level <= level) {
      break;
    }
    end += next.nodeSize;
  }
  return end;
}

// Hidden range of a collapsed node: a heading's section, or everything of a list item after its first paragraph.
function hiddenRange(doc: ProseNode, pos: number): { from: number; to: number } {
  const node = doc.nodeAt(pos)!;
  if (isHeading(node)) {
    return { from: pos + node.nodeSize, to: sectionEnd(doc, pos) };
  }
  return { from: pos + 1 + node.firstChild!.nodeSize, to: pos + node.nodeSize - 1 };
}

// Top-level headings and all list items with the key they are stored under.
function foldables(doc: ProseNode): { pos: number; fold: Fold }[] {
  const result: { pos: number; fold: Fold }[] = [];
  const seen = new Map<string, number>();
  const add = (node: ProseNode, pos: number, level: number) => {
    const text = (level === 0 ? node.firstChild! : node).textContent;
    const id = `${level} ${text}`;
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    result.push({ pos, fold: { level, text, n } });
  };
  doc.forEach((node, pos) => {
    if (isHeading(node)) {
      add(node, pos, node.attrs.level);
    }
  });
  doc.descendants((node, pos) => {
    if (isItem(node)) {
      add(node, pos, 0);
    }
  });
  return result;
}

function sameFold(a: Fold, b: Fold): boolean {
  return a.level === b.level && a.text === b.text && a.n === b.n;
}

export function getFolds(state: EditorState): Fold[] {
  const folded = foldKey.getState(state)!;
  return foldables(state.doc)
    .filter((f) => folded.includes(f.pos))
    .map((f) => f.fold);
}

// Collapses the stored headings and items (after loading or replacing the document).
export function setFolds(view: EditorView, folds: Fold[]): void {
  const positions = foldables(view.state.doc)
    .filter((f) => folds.some((fold) => sameFold(fold, f.fold)))
    .map((f) => f.pos);
  view.dispatch(view.state.tr.setMeta(foldKey, { set: positions }));
}

// Clickable pill at `at` (end of the heading / first paragraph) that expands the node at `pos` again.
function badge(pos: number, at: number, label: string): Decoration {
  return Decoration.widget(
    at,
    (view) => {
      const el = document.createElement('span');
      el.className = 'mdlive-fold-badge';
      el.contentEditable = 'false';
      el.textContent = label;
      el.title = 'Aufklappen (Option+Y)';
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        view.dispatch(view.state.tr.setMeta(foldKey, pos));
        view.focus();
      });
      return el;
    },
    { side: 1, ignoreSelection: true, key: `fold-${pos}-${label}` },
  );
}

// `onChange` gets the collapsed nodes whenever they change (toggled, heading renamed, …).
export const foldPlugin = (onChange: (folds: Fold[]) => void) =>
  $prose(
    () =>
      new Plugin<number[]>({
        key: foldKey,
        view: () => {
          let last = '[]';
          return {
            update(view) {
              const folds = getFolds(view.state);
              const json = JSON.stringify(folds);
              if (json !== last) {
                last = json;
                onChange(folds);
              }
            },
          };
        },
        state: {
          init: () => [],
          apply(tr, folded, _old, state) {
            const meta = tr.getMeta(foldKey) as number | { set: number[] } | undefined;
            if (typeof meta === 'object') {
              return meta.set;
            }
            let next = folded
              .map((pos) => tr.mapping.mapResult(pos))
              .filter((r) => {
                const node = state.doc.nodeAt(r.pos);
                return !r.deleted && (isHeading(node) || (isItem(node) && hasSublist(node!)));
              })
              .map((r) => r.pos);
            if (meta !== undefined) {
              next = next.includes(meta) ? next.filter((pos) => pos !== meta) : [...next, meta];
            }
            // Unfold when the cursor ends up inside a hidden range (arrow keys, search, undo).
            const head = state.selection.head;
            return next.filter((pos) => {
              const { from, to } = hiddenRange(state.doc, pos);
              return head < from || head > to;
            });
          },
        },
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            const hide = (from: number, node: ProseNode) =>
              decorations.push(Decoration.node(from, from + node.nodeSize, { class: 'mdlive-folded' }));
            for (const pos of foldKey.getState(state)!) {
              const node = state.doc.nodeAt(pos)!;
              if (isHeading(node)) {
                const end = sectionEnd(state.doc, pos);
                let count = 0;
                for (let p = pos + node.nodeSize; p < end; p += state.doc.nodeAt(p)!.nodeSize) {
                  hide(p, state.doc.nodeAt(p)!);
                  count++;
                }
                decorations.push(badge(pos, pos + node.nodeSize - 1, count === 1 ? '1 Block' : `${count} Blöcke`));
                continue;
              }
              // List item: ring around its bullet, badge after its first paragraph, sublists hidden.
              decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'mdlive-collapsed-item' }));
              let count = 0;
              node.forEach((child, offset) => {
                if (offset > 0) {
                  hide(pos + 1 + offset, child);
                  child.descendants((n) => {
                    count += isItem(n) ? 1 : 0;
                  });
                }
              });
              const end = pos + node.firstChild!.nodeSize;
              decorations.push(badge(pos, end, count === 1 ? '1 Unterpunkt' : `${count} Unterpunkte`));
            }
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
  );

// Top-level heading whose section contains the cursor (the heading itself or the nearest one above).
function currentHeading(state: EditorState): number | null {
  const head = state.selection.head;
  let result: number | null = null;
  state.doc.forEach((node, pos) => {
    if (isHeading(node) && pos < head) {
      result = pos;
    }
  });
  return result;
}

// List item to toggle: a collapsed item the cursor is in, otherwise in a sub-item the innermost item
// with a sublist (the sub-item itself, or the item it belongs to). Top-level items fold their heading.
function currentItem(state: EditorState): number | null {
  const { $head } = state.selection;
  const folded = foldKey.getState(state)!;
  const items: number[] = [];
  for (let d = $head.depth; d > 0; d--) {
    if (isItem($head.node(d))) {
      items.push($head.before(d));
    }
  }
  const collapsed = items.find((pos) => folded.includes(pos));
  if (collapsed !== undefined) {
    return collapsed;
  }
  if (items.length < 2) {
    return null;
  }
  return items.find((pos) => hasSublist(state.doc.nodeAt(pos)!)) ?? null;
}

// Alt+Y: collapses/expands the list item or heading section the cursor is in; the cursor moves to the end
// of that item's first paragraph or of the heading.
export function toggleFold(view: EditorView): void {
  const { state } = view;
  const item = currentItem(state);
  const pos = item ?? currentHeading(state);
  if (pos === null) {
    return;
  }
  const node = state.doc.nodeAt(pos)!;
  const end = item === null ? pos + node.nodeSize - 1 : pos + 1 + node.firstChild!.nodeSize - 1;
  view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(end), -1)).setMeta(foldKey, pos));
}
