import type { RemarkPlugin } from '@milkdown/kit/transformer';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { type EditorState, NodeSelection, Plugin, TextSelection } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import { gfmTaskListItemToMarkdown } from 'mdast-util-gfm-task-list-item';
import { htmlImageToBlock } from './imageView';

// Images inside list items. A list item's own content is always "paragraph block*", so
//   - Text            → paragraph "Text" + image-block
//     ![](a.png)
//   - ![](b.png)      → empty paragraph (hidden, `lead`) + image-block

type MdNode = { type: string; children?: MdNode[]; value?: string; [key: string]: unknown };

function isList(node: ProseNode): boolean {
  return node.type.name === 'bullet_list' || node.type.name === 'ordered_list';
}

// Milkdown saves an empty paragraph as `<br />`.
function isEmptyParagraph(node: MdNode | undefined): boolean {
  const kids = node?.children;
  return node?.type === 'paragraph' && (kids?.length === 0 || (kids?.length === 1 && kids[0].type === 'html' && /^<br\s*\/?>$/i.test(kids[0].value ?? '')));
}

// An inline image or a resized `<img … width>` as image-block mdast node.
function inlineToBlock(node: MdNode | undefined): MdNode | undefined {
  if (node?.type === 'image-block') {
    return node;
  }
  if (node?.type === 'image') {
    return { type: 'image-block', url: node.url, alt: node.alt ?? '', title: node.title ?? '' };
  }
  return node && htmlImageToBlock(node);
}

// Splits images standing on their own last lines off a paragraph. Returns the remaining paragraph
// (or nothing if it held only images) followed by the image blocks.
function splitParagraph(paragraph: MdNode): MdNode[] {
  const kids = [...(paragraph.children ?? [])];
  const blocks: MdNode[] = [];
  for (;;) {
    const block = inlineToBlock(kids.at(-1));
    if (!block) {
      break;
    }
    const prev = kids.at(-2);
    if (prev === undefined) {
      kids.pop();
      blocks.unshift(block);
      break;
    }
    if (prev.type === 'break') {
      kids.splice(-2, 2);
    } else if (prev.type === 'text' && /\n[ \t]*$/.test(prev.value ?? '')) {
      kids.pop();
      prev.value = prev.value!.replace(/\s*\n[ \t]*$/, '');
      if (prev.value === '') {
        kids.pop();
      }
    } else {
      break;
    }
    blocks.unshift(block);
  }
  if (blocks.length === 0) {
    return [paragraph];
  }
  const rest = { ...paragraph, children: kids };
  return kids.length > 0 && !isEmptyParagraph(rest) ? [rest, ...blocks] : blocks;
}

function convertItems(node: MdNode): void {
  for (const child of node.children ?? []) {
    convertItems(child);
  }
  if (node.type !== 'listItem' || !node.children) {
    return;
  }
  const children = node.children.flatMap((child) => (child.type === 'paragraph' ? splitParagraph(child) : [htmlImageToBlock(child) ?? child]));
  if (isEmptyParagraph(children[0]) && children[1]?.type === 'image-block') {
    children.shift();
  }
  if (children[0]?.type === 'image-block') {
    children.unshift({ type: 'paragraph', children: [] });
  }
  node.children = children;
}

// Parse side (Milkdown runs remark plugins only when parsing).
export const remarkListImages: RemarkPlugin = {
  plugin: () => (tree) => convertItems(tree as unknown as MdNode),
  options: {},
};

const taskListItem = gfmTaskListItemToMarkdown().handlers!.listItem!;

// An image block as serialized by Milkdown (a paragraph with only the image, or a resized `<img>`),
// as inline node.
function serializedImage(node: MdNode): MdNode | undefined {
  if (node.type === 'paragraph' && node.children?.length === 1 && node.children[0].type === 'image') {
    return node.children[0];
  }
  return node.type === 'html' && /^<img\s/i.test(node.value ?? '') ? node : undefined;
}

// Serialize side: images after a paragraph are written on its next lines (separate blocks would need a
// blank line, which makes the list loose); an image-only item drops its empty lead paragraph, so it is
// saved as `- ![](b.png)`. Wraps GFM's task list handler (handlers in the stringify options replace
// those of extensions).
export const listItemHandler: typeof taskListItem = (node, parent, state, info) => {
  const children: MdNode[] = [];
  for (const child of node.children as MdNode[]) {
    const image = serializedImage(child);
    const prev = children.at(-1);
    if (image && prev?.type === 'paragraph' && !isEmptyParagraph(prev)) {
      children[children.length - 1] = { ...prev, children: [...prev.children!, { type: 'text', value: '\n' }, image] };
    } else {
      children.push(child);
    }
  }
  if (isEmptyParagraph(children[0]) && children[1] && serializedImage(children[1])) {
    children.shift();
  }
  return taskListItem({ ...node, children } as typeof node, parent, state, info);
};

// Inserts an image block into the list item the cursor is in, after its own content (before sublists),
// and selects it. Returns false outside lists.
export function insertListImage(view: EditorView, src: string): boolean {
  const { $from } = view.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const item = $from.node(d);
    if (item.type.name !== 'list_item') {
      continue;
    }
    let pos = $from.start(d);
    let done = false;
    item.forEach((child) => {
      done ||= isList(child);
      pos += done ? 0 : child.nodeSize;
    });
    const tr = view.state.tr.insert(pos, view.state.schema.nodes['image-block'].create({ src }));
    view.dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)).scrollIntoView());
    return true;
  }
  return false;
}

// Empty lead paragraph of an image-only item, hidden unless the cursor is in it.
function leadDecorations(state: EditorState): DecorationSet {
  const decorations: Decoration[] = [];
  const { from, to } = state.selection;
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'list_item') {
      const lead = node.firstChild!;
      const start = pos + 1;
      const cursorInside = from <= start + lead.nodeSize - 1 && to >= start + 1;
      if (lead.content.size === 0 && node.childCount > 1 && node.child(1).type.name === 'image-block' && !cursorInside) {
        decorations.push(Decoration.node(start, start + lead.nodeSize, { class: 'mdlive-image-lead' }));
      }
    }
    return !node.isTextblock;
  });
  return DecorationSet.create(state.doc, decorations);
}

// Enter on a selected image in a list item starts a new item below it, as Enter at the end of its text would.
function enterAfterImage(view: EditorView, event: KeyboardEvent): boolean {
  const { selection } = view.state;
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) {
    return false;
  }
  if (!(selection instanceof NodeSelection) || selection.node.type.name !== 'image-block' || selection.$from.parent.type.name !== 'list_item') {
    return false;
  }
  const item = selection.$from.parent;
  const end = selection.$from.before() + item.nodeSize;
  const attrs = 'checked' in item.attrs && item.attrs.checked !== null ? { ...item.attrs, checked: false } : item.attrs;
  const tr = view.state.tr.insert(end, item.type.createAndFill(attrs)!);
  view.dispatch(tr.setSelection(TextSelection.create(tr.doc, end + 2)).scrollIntoView());
  return true;
}

export const listImages = $prose(() => new Plugin({ props: { decorations: leadDecorations, handleKeyDown: enterAfterImage } }));
