import { keymap } from '@milkdown/kit/prose/keymap';
import { Fragment, type Node as ProseNode, type NodeRange } from '@milkdown/kit/prose/model';
import { type Command, type EditorState, NodeSelection, TextSelection, type Transaction } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';

function isList(node: ProseNode): boolean {
  return node.type.name === 'bullet_list' || node.type.name === 'ordered_list';
}

// Swaps the selected blocks with their previous / next sibling. Returns the selection shift.
function swapWithSibling(tr: Transaction, range: NodeRange, direction: -1 | 1): number {
  const { parent, startIndex, endIndex } = range;
  const neighbor = parent.child(direction === -1 ? startIndex - 1 : endIndex);
  const moved: ProseNode[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    moved.push(parent.child(i));
  }
  const from = direction === -1 ? range.start - neighbor.nodeSize : range.start;
  const to = direction === -1 ? range.end : range.end + neighbor.nodeSize;
  tr.replaceWith(from, to, Fragment.fromArray(direction === -1 ? [...moved, neighbor] : [neighbor, ...moved]));
  return direction * neighbor.nodeSize;
}

// A list item flattened to one "line": its own content (without sublists) and its indentation depth.
type Row = { item: ProseNode; list: ProseNode; own: ProseNode[]; depth: number; pos: number };

function flatten(list: ProseNode, listPos: number, depth: number, rows: Row[]): void {
  list.forEach((item, offset) => {
    const pos = listPos + 1 + offset;
    const own: ProseNode[] = [];
    const subs: [ProseNode, number][] = [];
    item.forEach((child, childOffset) => {
      if (isList(child)) {
        subs.push([child, pos + 1 + childOffset]);
      } else {
        own.push(child);
      }
    });
    rows.push({ item, list, own, depth, pos });
    subs.forEach(([sub, subPos]) => flatten(sub, subPos, depth + 1, rows));
  });
}

// Rebuilds nested lists from rows; each nested list takes type and attrs from its first row.
function build(rows: Row[], start: number, depth: number): [ProseNode, number] {
  const items: ProseNode[] = [];
  let i = start;
  while (i < rows.length && rows[i].depth === depth) {
    const row = rows[i++];
    const children = [...row.own];
    if (i < rows.length && rows[i].depth > depth) {
      const [sublist, next] = build(rows, i, depth + 1);
      children.push(sublist);
      i = next;
    }
    items.push(row.item.type.create(row.item.attrs, children));
  }
  const { list } = rows[start];
  return [list.type.create(list.attrs, items), i];
}

// New row order and depths (indexed by old row) for the selected rows first..last, or null for no change.
type RowEdit = (rows: Row[], first: number, last: number) => { order: number[]; depths: number[] } | null;

// Flattens the outermost list around the selection into rows, applies `edit` and rebuilds the list.
// Returns a position mapping for the selection, or null if nothing changed.
function editListRows(tr: Transaction, state: EditorState, edit: RowEdit): ((p: number) => number) | null {
  const { $from, from, to } = state.selection;
  let rootDepth = 0;
  for (let d = $from.depth; d >= 1; d--) {
    rootDepth = isList($from.node(d)) ? d : rootDepth;
  }
  const rootPos = $from.before(rootDepth);
  const root = $from.node(rootDepth);
  const rows: Row[] = [];
  flatten(root, rootPos, 0, rows);
  // Rows are in document order and own content precedes sublists, so the last row starting before p contains it.
  const rowAt = (p: number): number => rows.findLastIndex((r) => r.pos < p);
  const result = edit(rows, rowAt(from), rowAt(to));
  if (!result) {
    return null;
  }
  const { order, depths } = result;
  const edited = order.map((i) => ({ ...rows[i], depth: depths[i] }));
  // Indentation may only grow by one level per line.
  edited.forEach((row, i) => {
    row.depth = i === 0 ? 0 : Math.min(row.depth, edited[i - 1].depth + 1);
  });

  const [newRoot] = build(edited, 0, 0);
  tr.replaceWith(rootPos, rootPos + root.nodeSize, newRoot);
  const newRows: Row[] = [];
  flatten(newRoot, rootPos, 0, newRows);
  return (p) => {
    const index = rowAt(p);
    return newRows[order.indexOf(index)].pos + (p - rows[index].pos);
  };
}

// Moves only the selected list lines one line up/down, keeping their indentation. Sublists stay in place
// and belong to whichever item ends up above them (like moving lines in VS Code or OneNote).
function moveRows(direction: -1 | 1): RowEdit {
  return (rows, first, last) => {
    if (direction === -1 ? first === 0 : last === rows.length - 1) {
      return null;
    }
    const order = rows.map((_, i) => i);
    const block = order.splice(first, last - first + 1);
    order.splice(first + direction, 0, ...block);
    return { order, depths: rows.map((r) => r.depth) };
  };
}

// Indents / outdents only the selected list lines; their sublists keep their depth.
function shiftRows(delta: -1 | 1): RowEdit {
  return (rows, first, last) => {
    const selected = rows.slice(first, last + 1);
    const blocked =
      delta === 1
        ? first === 0 || rows[first].depth > rows[first - 1].depth
        : selected.some((r) => r.depth === 0);
    if (blocked) {
      return null;
    }
    return {
      order: rows.map((_, i) => i),
      depths: rows.map((r, i) => (i >= first && i <= last ? r.depth + delta : r.depth)),
    };
  };
}

function applySelection(tr: Transaction, state: EditorState, map: (p: number) => number): Transaction {
  const sel = state.selection;
  return tr
    .setSelection(
      sel instanceof NodeSelection
        ? NodeSelection.create(tr.doc, map(sel.from))
        : TextSelection.create(tr.doc, map(sel.anchor), map(sel.head)),
    )
    .scrollIntoView();
}

// Moves the selected list lines / blocks up (-1) or down (+1), like Alt+Up/Down in VS Code.
function moveBlocks(direction: -1 | 1): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection;
    const tr = state.tr;
    let map: ((p: number) => number) | null;
    if ($from.blockRange($to, isList)) {
      map = editListRows(tr, state, moveRows(direction));
    } else {
      const range = $from.blockRange($to);
      if (!range) {
        return false;
      }
      const hasSibling = direction === -1 ? range.startIndex > 0 : range.endIndex < range.parent.childCount;
      const shift = hasSibling ? swapWithSibling(tr, range, direction) : null;
      map = shift === null ? null : (p) => p + shift;
    }
    // Nothing to move to: still swallow the key so the cursor doesn't jump.
    if (map && dispatch) {
      dispatch(applySelection(tr, state, map));
    }
    return true;
  };
}

// Tab / Shift+Tab inside a list only indents / outdents the touched lines. Returns false outside lists.
// Always consumes the key in lists, so Crepe's indent plugin can't insert spaces when indenting isn't possible.
export function indentListItems(view: EditorView, outdent: boolean): boolean {
  const { state } = view;
  if (!state.selection.$from.blockRange(state.selection.$to, isList)) {
    return false;
  }
  const tr = state.tr;
  const map = editListRows(tr, state, shiftRows(outdent ? -1 : 1));
  if (map) {
    view.dispatch(applySelection(tr, state, map));
  }
  return true;
}

export const moveBlocksKeymap = $prose(() =>
  keymap({
    'Alt-ArrowUp': moveBlocks(-1),
    'Alt-ArrowDown': moveBlocks(1),
  }),
);
