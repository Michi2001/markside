import type { RemarkPlugin } from '@milkdown/kit/transformer';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView, type NodeView } from '@milkdown/kit/prose/view';
import { $nodeSchema, $prose, $view } from '@milkdown/kit/utils';
import DOMPurify from 'dompurify';
import { post, resolveUrl } from './host';

// Block-level raw HTML (README headers, badges, <details>): shown rendered, stored verbatim.
// Double-click edits the source. Inline HTML inside a paragraph stays Milkdown's plain `html` node.

type MdNode = { type: string; children?: MdNode[]; value?: string };

const CONTAINERS = ['root', 'blockquote', 'listItem'];
const VISIBLE_WITHOUT_TEXT = 'img, svg, video, br, hr';
const EXTERNAL_OR_ANCHOR = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;
// A lone <br /> is how Milkdown saves an empty paragraph; it turns it back into one itself.
const EMPTY_LINE = /^\s*<br\s*\/?\s*>\s*$/i;

// Milkdown may already have wrapped the node in a paragraph, depending on the plugin order.
function convertHtmlBlocks(node: MdNode): void {
  for (const child of node.children ?? []) {
    convertHtmlBlocks(child);
  }
  if (!CONTAINERS.includes(node.type)) {
    return;
  }
  node.children = node.children?.map((child) => {
    const html = child.type === 'paragraph' && child.children?.length === 1 ? child.children[0] : child;
    return html.type === 'html' && !EMPTY_LINE.test(html.value!) ? { type: 'html-block', value: html.value } : child;
  });
}

export const remarkHtmlBlocks: RemarkPlugin = {
  plugin: () => (tree) => convertHtmlBlocks(tree as unknown as MdNode),
  options: {},
};

const htmlBlockSchema = $nodeSchema('html-block', () => ({
  group: 'block',
  atom: true,
  attrs: { value: { default: '', validate: 'string' } },
  parseDOM: [
    {
      tag: 'div[data-type="html-block"]',
      getAttrs: (dom) => ({ value: (dom as HTMLElement).dataset.value ?? '' }),
    },
  ],
  toDOM: (node) => ['div', { 'data-type': 'html-block', 'data-value': node.attrs.value }],
  parseMarkdown: {
    match: ({ type }) => type === 'html-block',
    runner: (state, node, type) => {
      state.addNode(type, { value: node.value as string });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'html-block',
    runner: (state, node) => {
      state.addNode('html', undefined, node.attrs.value);
    },
  },
}));

// ---------- <details> spread over several blocks ----------

// Markdown inside <details> makes three parts: `<details><summary>…`, the blocks, `</details>`.
// Which sections differ from their default is view-only state, never written to the Markdown.
const detailsKey = new PluginKey<number[]>('mdlive-details');

function isDetailsStart(node: ProseNode): boolean {
  return node.type.name === 'html-block' && /^\s*<details[\s>]/i.test(node.attrs.value) && !/<\/details>/i.test(node.attrs.value);
}

function isDetailsEnd(node: ProseNode): boolean {
  return node.type.name === 'html-block' && /^\s*<\/details>\s*$/i.test(node.attrs.value);
}

function detailsRanges(doc: ProseNode): { pos: number; end: number; to: number }[] {
  const ranges: { pos: number; end: number; to: number }[] = [];
  const starts: number[] = [];
  doc.forEach((node, pos) => {
    if (isDetailsStart(node)) {
      starts.push(pos);
    } else if (isDetailsEnd(node) && starts.length > 0) {
      ranges.push({ pos: starts.pop()!, end: pos, to: pos + node.nodeSize });
    }
  });
  return ranges;
}

function isOpen(doc: ProseNode, pos: number, toggled: number[]): boolean {
  return /^\s*<details[^>]*\sopen\b/i.test(doc.nodeAt(pos)!.attrs.value) !== toggled.includes(pos);
}

const detailsPlugin = $prose(
  () =>
    new Plugin<number[]>({
      key: detailsKey,
      state: {
        init: () => [],
        apply(tr, toggled, _old, state) {
          let next = toggled.map((pos) => tr.mapping.map(pos));
          const meta = tr.getMeta(detailsKey) as number | undefined;
          if (meta !== undefined) {
            next = next.includes(meta) ? next.filter((pos) => pos !== meta) : [...next, meta];
          }
          if (tr.selectionSet) {
            // A cursor landing in a collapsed section (search, arrow keys) opens it.
            const { from } = state.selection;
            for (const { pos, to } of detailsRanges(state.doc)) {
              if (from > pos && from < to && !isOpen(state.doc, pos, next)) {
                next = next.includes(pos) ? next.filter((p) => p !== pos) : [...next, pos];
              }
            }
          }
          return next;
        },
      },
      props: {
        decorations(state) {
          const toggled = detailsKey.getState(state)!;
          const decorations: Decoration[] = [];
          for (const { pos, end, to } of detailsRanges(state.doc)) {
            const start = pos + state.doc.nodeAt(pos)!.nodeSize;
            if (isOpen(state.doc, pos, toggled)) {
              decorations.push(Decoration.node(pos, start, { class: 'mdlive-details-open' }));
            } else {
              state.doc.nodesBetween(start, end, (_node, at) => {
                decorations.push(Decoration.node(at, at + _node.nodeSize, { class: 'mdlive-folded' }));
                return false;
              });
            }
            decorations.push(Decoration.node(end, to, { class: 'mdlive-folded' }));
          }
          return DecorationSet.create(state.doc, decorations);
        },
      },
    }),
);

// ---------- Node view ----------

class HtmlBlockView implements NodeView {
  dom = document.createElement('div');

  constructor(
    private node: ProseNode,
    private view: EditorView,
    private getPos: () => number | undefined,
  ) {
    this.dom.title = 'Double-click to edit the HTML';
    this.dom.addEventListener('click', (e) => this.onClick(e));
    this.dom.addEventListener('dblclick', () => this.edit());
    this.render();
  }

  private render(): void {
    const source: string = this.node.attrs.value;
    this.dom.className = 'mdlive-html';
    this.dom.innerHTML = DOMPurify.sanitize(source);
    for (const img of this.dom.querySelectorAll('img[src]')) {
      img.setAttribute('src', resolveUrl(img.getAttribute('src')!));
    }
    // Comments and the like would be invisible and could never be edited again.
    if (!this.dom.textContent!.trim() && !this.dom.querySelector(VISIBLE_WITHOUT_TEXT)) {
      this.dom.classList.add('mdlive-html-raw');
      this.dom.textContent = source;
    }
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as Element;
    const href = target.closest('a')?.getAttribute('href');
    if (href && !EXTERNAL_OR_ANCHOR.test(href)) {
      // VS Code would open the webview's resource URL in the browser.
      e.preventDefault();
      e.stopPropagation();
      post({ type: 'openFile', path: href });
    } else if (target.closest('summary') && isDetailsStart(this.node)) {
      e.preventDefault();
      this.view.dispatch(this.view.state.tr.setMeta(detailsKey, this.getPos()));
    }
  }

  private edit(): void {
    const source: string = this.node.attrs.value;
    const area = document.createElement('textarea');
    area.className = 'mdlive-html-source';
    area.value = source;
    area.rows = source.split('\n').length;
    area.spellcheck = false;
    area.addEventListener('blur', () => this.commit(area.value));
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        area.value = source;
      }
      if (e.key === 'Escape' || (e.key === 'Enter' && e.metaKey)) {
        e.preventDefault();
        area.blur();
      }
    });
    this.dom.replaceChildren(area);
    area.focus();
  }

  private commit(value: string): void {
    const pos = this.getPos();
    if (pos === undefined) {
      return;
    }
    if (!value.trim()) {
      this.view.dispatch(this.view.state.tr.delete(pos, pos + this.node.nodeSize));
    } else if (value === this.node.attrs.value) {
      this.render();
    } else {
      this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { value }));
    }
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) {
      return false;
    }
    const changed = node.attrs.value !== this.node.attrs.value;
    this.node = node;
    if (changed) {
      this.render();
    }
    return true;
  }

  stopEvent(e: Event): boolean {
    return !!(e.target as Element).closest?.('a, summary, textarea');
  }

  ignoreMutation(): boolean {
    return true;
  }
}

const htmlBlockView = $view(htmlBlockSchema.node, () => (node, view, getPos) => new HtmlBlockView(node, view, getPos));

export const htmlBlock = [htmlBlockSchema, htmlBlockView, detailsPlugin].flat();
