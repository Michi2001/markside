import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view';
import { $prose } from '@milkdown/kit/utils';
import katex from 'katex';
import type { Suggestion } from '../suggestions';
import { post } from './host';

// Changes Claude suggests (Alt+Shift+K) are shown as cards below the block they change; the note's
// text only changes when one is accepted (by the extension, in the Markdown source). Each editor
// keeps its own list (PDF view: one per note card and explanation).
type State = { list: Suggestion[]; set: DecorationSet };
const suggestionKey = new PluginKey<State>('mdlive-suggestions');

// Words shown around a change.
const CONTEXT_WORDS = 8;

export function setSuggestions(view: EditorView, list: Suggestion[]): void {
  view.dispatch(view.state.tr.setMeta(suggestionKey, list));
}

export const suggestionPlugin = $prose(
  () =>
    new Plugin<State>({
      key: suggestionKey,
      state: {
        init: () => ({ list: [], set: DecorationSet.empty }),
        apply: (tr, old, _old, state) => {
          const list: Suggestion[] | undefined = tr.getMeta(suggestionKey);
          return list || tr.docChanged ? { list: list ?? old.list, set: build(state.doc, list ?? old.list) } : old;
        },
      },
      props: {
        decorations: (state) => suggestionKey.getState(state)?.set,
      },
    }),
);

function build(doc: ProseNode, suggestions: Suggestion[]): DecorationSet {
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
// the document rendered text; a quote spanning several blocks ends there). Of equally good blocks (the
// same text twice) the one whose place in the note is closest to where the extension found the quote
// (`position`, share of the source lines). A quote without matching words (a code fence, a formula)
// goes by `position` alone; one the extension didn't find (stale) to the end of the note.
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
  const byWords = top > 0.5;
  if (!blocks.length || (!byWords && position === undefined)) {
    return doc.content.size;
  }
  // Share of the document's size approximates the share of source lines better than the block index
  // (a code block is one textblock but many lines).
  const distance = (i: number) => (position === undefined ? i : Math.abs(blocks[i].end / doc.content.size - position));
  let best = -1;
  blocks.forEach((b, i) => {
    if ((!byWords || b.score === top) && (best === -1 || distance(i) < distance(best))) {
      best = i;
    }
  });
  return blocks[best].end;
}

const escape = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const MATH = /^(\$\$[\s\S]+?\$\$|\$[^$\n]+\$)$/;

// Words and whitespace runs; a formula stays one token, so it is diffed and rendered as a whole.
function tokens(text: string): string[] {
  return text
    .split(/(\$\$[\s\S]+?\$\$|\$[^$\n]+\$)/)
    .flatMap((part, i) => (i % 2 ? [part] : part.split(/(\s+)/)))
    .filter((t) => t !== '');
}

// Tokens as HTML, formulas via KaTeX.
function render(list: string[]): string {
  return list
    .map((t) => {
      if (!MATH.test(t)) {
        return escape(t);
      }
      const display = t.startsWith('$$');
      return katex.renderToString(t.slice(display ? 2 : 1, display ? -2 : -1), { throwOnError: false, displayMode: display });
    })
    .join('');
}

// Old and new source with only the changed middle marked, cut to a few words around it.
function diffHtml(old: string, next: string): string {
  const a = tokens(old);
  const b = tokens(next);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) {
    pre++;
  }
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) {
    suf++;
  }
  const keep = CONTEXT_WORDS * 2;
  const before = render(a.slice(Math.max(0, pre - keep), pre));
  const after = render(a.slice(a.length - suf, a.length - suf + keep));
  const removed = render(a.slice(pre, a.length - suf));
  const added = render(b.slice(pre, b.length - suf));
  return [
    pre > keep ? '…' : '',
    before,
    removed && `<del>${removed}</del>`,
    added && `<ins>${added}</ins>`,
    after,
    suf > keep ? '…' : '',
  ].join('');
}

function card(view: EditorView, s: Suggestion): HTMLElement {
  const box = document.createElement('div');
  // The extension sets `position` only when it found the quote; without it Apply could only fail.
  const stale = s.position === undefined;
  box.className = stale ? 'mdlive-suggestion stale' : 'mdlive-suggestion';
  box.contentEditable = 'false';
  box.dataset.id = s.id;
  box.innerHTML = `
    <div class="suggestion-head"><span class="suggestion-label">Suggested by Claude</span><span class="suggestion-title"></span></div>
    ${stale ? '<div class="suggestion-stale">The quoted text is no longer in the note.</div>' : ''}
    <div class="suggestion-diff">${diffHtml(s.quote, s.body)}</div>
    ${s.why ? '<div class="suggestion-why"></div>' : ''}
    <div class="suggestion-actions">${stale ? '' : '<button class="suggestion-accept">Apply</button>'}<button class="suggestion-reject">Dismiss</button></div>`;
  box.querySelector('.suggestion-title')!.textContent = s.title;
  const why = box.querySelector('.suggestion-why');
  if (why) {
    why.textContent = s.why;
  }
  const answer = (type: 'acceptSuggestion' | 'rejectSuggestion') => (e: Event) => {
    e.preventDefault();
    post({ type, id: s.id });
    setSuggestions(view, (suggestionKey.getState(view.state)?.list ?? []).filter((q) => q.id !== s.id));
  };
  box.querySelector('.suggestion-accept')?.addEventListener('mousedown', answer('acceptSuggestion'));
  box.querySelector('.suggestion-reject')!.addEventListener('mousedown', answer('rejectSuggestion'));
  return box;
}
