import { setBlockType } from '@milkdown/kit/prose/commands';
import type { EditorView } from '@milkdown/kit/prose/view';

// Alt+1..6: turns the selected blocks into headings of `level`; the same level again (or level 0) turns them back into text.
export function setHeading(view: EditorView, level: number): void {
  const { state } = view;
  const { heading, paragraph } = state.schema.nodes;
  const parent = state.selection.$from.parent;
  const toText = level === 0 || (parent.type === heading && parent.attrs.level === level);
  const command = toText ? setBlockType(paragraph) : setBlockType(heading, { level });
  command(state, view.dispatch);
}

// Tab/Shift+Tab in a heading: one level deeper/higher (clamped to H1..H6). Returns false outside headings.
export function shiftHeading(view: EditorView, up: boolean): boolean {
  const { $from } = view.state.selection;
  const node = $from.parent;
  if (node.type.name !== 'heading') {
    return false;
  }
  const level = Math.min(6, Math.max(1, node.attrs.level + (up ? -1 : 1)));
  view.dispatch(view.state.tr.setNodeMarkup($from.before(), undefined, { ...node.attrs, level }));
  return true;
}
