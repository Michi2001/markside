import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { type EditorState, Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';

// Positions of collapsed top-level headings, list items and paragraphs introducing a list. View-only state, never written to the Markdown.
const foldKey = new PluginKey<number[]>('mdlive-fold');

// A collapsed node as stored in the note's assets folder: the `n`-th heading with this level and text,
// for `level` 0 the `n`-th list item with this text (of its first paragraph), for `level` -1 the `n`-th
// top-level paragraph with this text that is directly followed by a list.
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

function isList(node: ProseNode | null | undefined): boolean {
  return node?.type.name === 'bullet_list' || node?.type.name === 'ordered_list';
}

// Top-level paragraph at `pos` directly followed by a list (which it collapses).
function leadsList(doc: ProseNode, pos: number): boolean {
  const node = doc.nodeAt(pos);
  return node?.type.name === 'paragraph' && doc.resolve(pos).depth === 0 && isList(doc.nodeAt(pos + node.nodeSize));
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
  if (!isItem(node)) {
    const list = doc.nodeAt(pos + node.nodeSize)!;
    return { from: pos + node.nodeSize, to: pos + node.nodeSize + list.nodeSize };
  }
  return { from: pos + 1 + node.firstChild!.nodeSize, to: pos + node.nodeSize - 1 };
}

// Top-level headings, paragraphs introducing a list and all list items with the key they are stored under.
function foldables(doc: ProseNode): { pos: number; fold: Fold }[] {
  const result: { pos: number; fold: Fold }[] = [];
  const seen = new Map<string, number>();
  const add = (node: ProseNode, pos: number, level: number) => {
    const text = (isItem(node) ? node.firstChild! : node).textContent;
    const id = `${level} ${text}`;
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    result.push({ pos, fold: { level, text, n } });
  };
  doc.forEach((node, pos) => {
    if (isHeading(node)) {
      add(node, pos, node.attrs.level);
    } else if (leadsList(doc, pos)) {
      add(node, pos, -1);
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
          apply(tr, folded, old, state) {
            const meta = tr.getMeta(foldKey) as number | { set: number[] } | undefined;
            if (typeof meta === 'object') {
              return meta.set;
            }
            // Nodes inside a replaced range (Tab/Alt+Up/Down rebuild the whole list) are found again by text.
            const lost = folded.filter((pos) => tr.mapping.mapResult(pos).deleted);
            const before = lost.length > 0 ? foldables(old.doc).filter((f) => lost.includes(f.pos)) : [];
            const found = before.length > 0 ? foldables(state.doc).filter((f) => before.some((b) => sameFold(b.fold, f.fold))) : [];
            let next = folded
              .map((pos) => tr.mapping.mapResult(pos))
              .filter((r) => !r.deleted)
              .map((r) => r.pos)
              .concat(found.map((f) => f.pos))
              .filter((pos, i, all) => {
                const node = state.doc.nodeAt(pos);
                return all.indexOf(pos) === i && (isHeading(node) || (isItem(node) && hasSublist(node!)) || leadsList(state.doc, pos));
              });
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
                decorations.push(badge(pos, pos + node.nodeSize - 1, count === 1 ? '1 block' : `${count} blocks`));
                continue;
              }
              if (!isItem(node)) {
                // Paragraph introducing a list: the list is hidden, badge after the paragraph.
                const list = state.doc.nodeAt(pos + node.nodeSize)!;
                hide(pos + node.nodeSize, list);
                let count = 0;
                list.descendants((n) => {
                  count += isItem(n) ? 1 : 0;
                });
                decorations.push(badge(pos, pos + node.nodeSize - 1, count === 1 ? '1 item' : `${count} items`));
                continue;
              }
              // List item: ring around its bullet, badge after its first paragraph, sublists hidden.
              decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'mdlive-collapsed-item' }));
              let count = 0;
              let images = 0;
              node.forEach((child, offset) => {
                if (offset > 0) {
                  hide(pos + 1 + offset, child);
                  images += child.type.name === 'image-block' ? 1 : 0;
                  child.descendants((n) => {
                    count += isItem(n) ? 1 : 0;
                  });
                }
              });
              const end = pos + node.firstChild!.nodeSize;
              const label = count > 0 ? (count === 1 ? '1 sub-item' : `${count} sub-items`) : images === 1 ? '1 image' : `${images} images`;
              decorations.push(badge(pos, end, label));
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

// Top-level paragraph introducing a list, if the cursor is in it or in a top-level item of that list.
function currentLead(state: EditorState): number | null {
  const { $head } = state.selection;
  if ($head.depth === 0) {
    return null;
  }
  const index = $head.index(0);
  const pos = $head.posAtIndex(index, 0);
  if (leadsList(state.doc, pos)) {
    return pos;
  }
  if (isList(state.doc.child(index)) && index > 0) {
    const before = pos - state.doc.child(index - 1).nodeSize;
    return leadsList(state.doc, before) ? before : null;
  }
  return null;
}

// Alt+Y: collapses/expands the list item, the paragraph introducing a list or the heading section the
// cursor is in; the cursor moves to the end of that item's first paragraph, the paragraph or the heading.
export function toggleFold(view: EditorView): void {
  const { state } = view;
  const item = currentItem(state);
  const pos = item ?? currentLead(state) ?? currentHeading(state);
  if (pos === null) {
    return;
  }
  const node = state.doc.nodeAt(pos)!;
  const end = item === null ? pos + node.nodeSize - 1 : pos + 1 + node.firstChild!.nodeSize - 1;
  view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(end), -1)).setMeta(foldKey, pos));
}
