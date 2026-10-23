import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import type { Suggestion } from '../suggestions';
import { post } from './host';

// Changes Claude suggests (Alt+Shift+K) are shown as cards below the block they change; the note's
// text only changes when one is accepted (by the extension, in the Markdown source).
let suggestions: Suggestion[] = [];
const suggestionKey = new PluginKey<DecorationSet>('mdlive-suggestions');

// Words shown around a change.
const CONTEXT_WORDS = 8;

export function setSuggestions(view: EditorView, list: Suggestion[]): void {
  suggestions = list;
  view.dispatch(view.state.tr.setMeta(suggestionKey, true));
}

export const suggestionPlugin = $prose(
  () =>
    new Plugin<DecorationSet>({
      key: suggestionKey,
      state: {
        init: (_, state) => build(state.doc),
        apply: (tr, set, _old, state) => (tr.docChanged || tr.getMeta(suggestionKey) ? build(state.doc) : set),
      },
      props: {
        decorations: (state) => suggestionKey.getState(state),
      },
    }),
);

function build(doc: ProseNode): DecorationSet {
  return DecorationSet.create(
    doc,
    suggestions.map((s) =>
      Decoration.widget(anchorPos(doc, s), (view) => card(view, s), {
        side: 1,
        ignoreSelection: true,
        stopEvent: () => true,
        key: `suggestion-${s.id}-${s.quote}-${s.body}-${s.why}`,
      }),
    ),
  );
}

function words(text: string): Set<string> {
  return new Set(
    text
      .replace(/\]\([^)]*\)/g, ' ')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2),
  );
}

// After the textblock containing most words of the quote's last line (the quote is Markdown source,
// the document rendered text; a quote spanning several blocks ends there), else at the end of the note.
// Of equally good blocks (the same text twice) the one whose place in the note is closest to where
// the extension found the quote (`position`, share of the source lines).
function anchorPos(doc: ProseNode, { quote, position }: Suggestion): number {
  const lines = quote.split('\n').map(words).filter((w) => w.size > 0);
  const wanted = lines[lines.length - 1] ?? new Set<string>();
  const blocks: { end: number; score: number }[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) {
      return true;
    }
    const have = words(node.textContent);
    blocks.push({ end: pos + node.nodeSize, score: [...wanted].filter((w) => have.has(w)).length / (wanted.size || 1) });
    return false;
  });
  const top = Math.max(...blocks.map((b) => b.score));
  if (!(top > 0.5)) {
    return doc.content.size;
  }
  const distance = (i: number) => (position === undefined ? i : Math.abs((i + 0.5) / blocks.length - position));
  let best = -1;
  blocks.forEach((b, i) => {
    if (b.score === top && (best === -1 || distance(i) < distance(best))) {
      best = i;
    }
  });
  return blocks[best].end;
}

const escape = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Old and new source with only the changed middle marked, cut to a few words around it.
function diffHtml(old: string, next: string): string {
  const a = old.split(/(\s+)/);
  const b = next.split(/(\s+)/);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) {
    pre++;
  }
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) {
    suf++;
  }
  const keep = CONTEXT_WORDS * 2;
  const before = a.slice(Math.max(0, pre - keep), pre).join('');
  const after = a.slice(a.length - suf, a.length - suf + keep).join('');
  const removed = a.slice(pre, a.length - suf).join('');
  const added = b.slice(pre, b.length - suf).join('');
  return [
    pre > keep ? '…' : '',
    escape(before),
    removed && `<del>${escape(removed)}</del>`,
    added && `<ins>${escape(added)}</ins>`,
    escape(after),
    suf > keep ? '…' : '',
  ].join('');
}

function card(view: EditorView, s: Suggestion): HTMLElement {
  const box = document.createElement('div');
  box.className = 'mdlive-suggestion';
  box.contentEditable = 'false';
  box.dataset.id = s.id;
  box.innerHTML = `
    <div class="suggestion-head"><span class="suggestion-label">Suggested by Claude</span><span class="suggestion-title"></span></div>
    <div class="suggestion-diff">${diffHtml(s.quote, s.body)}</div>
    ${s.why ? '<div class="suggestion-why"></div>' : ''}
    <div class="suggestion-actions"><button class="suggestion-accept">Apply</button><button>Dismiss</button></div>`;
  box.querySelector('.suggestion-title')!.textContent = s.title;
  const why = box.querySelector('.suggestion-why');
  if (why) {
    why.textContent = s.why;
  }
  const [accept, reject] = box.querySelectorAll('button');
  const answer = (type: 'acceptSuggestion' | 'rejectSuggestion') => (e: MouseEvent) => {
    e.preventDefault();
    post({ type, id: s.id });
    setSuggestions(view, suggestions.filter((q) => q !== s));
  };
  accept.addEventListener('mousedown', answer('acceptSuggestion'));
  reject.addEventListener('mousedown', answer('rejectSuggestion'));
  return box;
}
