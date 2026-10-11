import type { RemarkPlugin } from '@milkdown/kit/transformer';
import type { Ctx } from '@milkdown/kit/ctx';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView, NodeView, NodeViewConstructor } from '@milkdown/kit/prose/view';
import { isDrawing } from './drawing';

const MIN_WIDTH = 40;
const CORNERS = ['nw', 'ne', 'sw', 'se'] as const;

type EditDrawing = (src: string, getPos: () => number | undefined) => void;

type MdNode = { type: string; children?: MdNode[]; value?: string; [key: string]: unknown };
type NodeSpecFactory = (ctx: Ctx) => any;

// ---------- Markdown <-> node conversion ----------

function decodeEntities(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Turns a standalone `<img src=".." width="300">` HTML node into an image-block mdast node.
function htmlImageToBlock(node: MdNode): MdNode | undefined {
  const html = (node.value ?? '').trim();
  if (node.type !== 'html' || !/^<img\s[^>]*>$/i.test(html)) {
    return undefined;
  }
  const attrs: Record<string, string> = {};
  for (const m of html.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3]);
  }
  const width = Number(attrs.width?.replace(/px$/, ''));
  if (!attrs.src || !Number.isFinite(width)) {
    return undefined;
  }
  return { type: 'image-block', url: attrs.src, alt: attrs.alt ?? '', title: attrs.title ?? '', width };
}

function convertHtmlImages(node: MdNode): void {
  const children = node.children ?? [];
  children.forEach((child, i) => {
    const target = child.type === 'paragraph' && child.children?.length === 1 ? child.children[0] : child;
    const block = htmlImageToBlock(target);
    if (block) {
      children[i] = block;
    } else {
      convertHtmlImages(child);
    }
  });
}

export const remarkHtmlImages: RemarkPlugin = {
  plugin: () => (tree) => convertHtmlImages(tree as unknown as MdNode),
  options: {},
};

// Adds `width` and a real `alt` to Crepe's image-block; resized images are saved as HTML <img>.
export function extendImageBlockSchema(prev: NodeSpecFactory): NodeSpecFactory {
  return (ctx) => {
    const base = prev(ctx);
    return {
      ...base,
      attrs: {
        ...base.attrs,
        alt: { default: '', validate: 'string' },
        width: { default: 0, validate: 'number' },
      },
      parseMarkdown: {
        match: ({ type }: MdNode) => type === 'image-block',
        runner: (state: any, node: MdNode, type: any) => {
          const alt = String(node.alt ?? '');
          state.addNode(type, {
            src: node.url,
            caption: node.title ?? '',
            ratio: 1,
            // Crepe used to store a resize ratio as alt text; don't treat that as a description.
            alt: Number.isNaN(Number(alt)) ? alt : '',
            width: Number(node.width ?? 0),
          });
        },
      },
      toMarkdown: {
        match: (node: ProseNode) => node.type.name === 'image-block',
        runner: (state: any, node: ProseNode) => {
          const { src, alt, caption, width } = node.attrs;
          if (width > 0) {
            const altAttr = alt ? ` alt="${escapeAttr(alt)}"` : '';
            const titleAttr = caption ? ` title="${escapeAttr(caption)}"` : '';
            state.addNode('html', undefined, `<img src="${escapeAttr(src)}"${altAttr}${titleAttr} width="${width}">`);
            return;
          }
          state.openNode('paragraph');
          state.addNode('image', undefined, undefined, { url: src, alt, title: caption || null });
          state.closeNode();
        },
      },
    };
  };
}

// ---------- Resizable node view ----------

class ResizableImageView implements NodeView {
  dom: HTMLElement;
  private img: HTMLImageElement;
  private sizeLabel: HTMLElement;

  constructor(
    private node: ProseNode,
    private view: EditorView,
    private getPos: () => number | undefined,
    private resolveUrl: (url: string) => string,
    editDrawing: EditDrawing,
  ) {
    this.dom = document.createElement('div');
    this.dom.className = 'mdlive-image';
    const wrapper = document.createElement('div');
    wrapper.className = 'mdlive-image-wrapper';
    this.img = document.createElement('img');
    this.img.draggable = false;
    this.sizeLabel = document.createElement('div');
    this.sizeLabel.className = 'mdlive-size';
    wrapper.append(this.img, this.sizeLabel);
    for (const corner of CORNERS) {
      const handle = document.createElement('div');
      handle.className = `mdlive-handle ${corner}`;
      handle.addEventListener('pointerdown', (e) => this.startResize(e, corner));
      wrapper.append(handle);
    }
    this.dom.append(wrapper);
    this.dom.addEventListener('dblclick', () => {
      if (isDrawing(this.node.attrs.src)) {
        editDrawing(this.node.attrs.src, this.getPos);
      }
    });
    this.render();
  }

  private render(): void {
    const { src, alt, width } = this.node.attrs;
    const url = this.resolveUrl(src);
    if (this.img.getAttribute('src') !== url) {
      this.img.src = url;
    }
    this.img.alt = alt;
    this.img.classList.toggle('mdlive-ink', isDrawing(src));
    this.img.title = isDrawing(src) ? 'Double-click to edit' : '';
    this.img.style.width = width > 0 ? `${width}px` : '';
  }

  private startResize(e: PointerEvent, corner: (typeof CORNERS)[number]): void {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.target as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = this.img.getBoundingClientRect().width;
    const maxWidth = this.dom.clientWidth;
    const direction = corner.endsWith('w') ? -1 : 1;
    let width = startWidth;
    this.dom.classList.add('resizing');

    const onMove = (ev: PointerEvent): void => {
      width = Math.round(Math.min(maxWidth, Math.max(MIN_WIDTH, startWidth + direction * (ev.clientX - startX))));
      this.img.style.width = `${width}px`;
      this.sizeLabel.textContent = `${width} px`;
    };
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      this.dom.classList.remove('resizing');
      const pos = this.getPos();
      if (pos !== undefined && width !== startWidth) {
        this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, 'width', width));
      }
    };
    this.sizeLabel.textContent = `${Math.round(startWidth)} px`;
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type || !node.attrs.src) {
      return false;
    }
    this.node = node;
    this.render();
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('selected');
  }

  deselectNode(): void {
    this.dom.classList.remove('selected');
  }

  stopEvent(e: Event): boolean {
    return (e.target as HTMLElement).classList?.contains('mdlive-handle') ?? false;
  }

  ignoreMutation(): boolean {
    return true;
  }
}

// Uses our resizable view for images; empty image blocks keep Crepe's upload placeholder.
export function createImageBlockView(
  crepeView: NodeViewConstructor,
  resolveUrl: (url: string) => string,
  editDrawing: EditDrawing,
): NodeViewConstructor {
  return (node, view, getPos, decorations, innerDecorations) => {
    if (node.attrs.src) {
      return new ResizableImageView(node, view, getPos, resolveUrl, editDrawing);
    }
    const placeholder = crepeView(node, view, getPos, decorations, innerDecorations);
    const update = placeholder.update?.bind(placeholder);
    // Once an image is chosen, returning false makes ProseMirror recreate it with our view.
    placeholder.update = (n, ...rest) => (n.attrs.src ? false : (update?.(n, ...rest) ?? false));
    return placeholder;
  };
}
