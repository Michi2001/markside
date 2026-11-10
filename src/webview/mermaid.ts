import type Mermaid from 'mermaid';

// Renders ```mermaid code blocks as diagrams via the code block's preview (Crepe's CodeMirror
// feature, `renderPreview`). Milkdown sanitizes the SVG and keeps foreignObject labels.
// Mermaid is large, so it is its own bundle (dist/mermaid.js), loaded next to this script on the
// first diagram with the same CSP nonce.

type MermaidApi = typeof Mermaid;

const script = document.currentScript as HTMLScriptElement | null;
let loading: Promise<MermaidApi> | undefined;
let counter = 0;

function loadMermaid(): Promise<MermaidApi> {
  loading ??= new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = script!.src.replace(/[^/]*$/, 'mermaid.js');
    tag.nonce = script!.nonce;
    tag.onload = () => resolve((window as unknown as { mdliveMermaid: MermaidApi }).mdliveMermaid);
    tag.onerror = () => reject(new Error('Could not load Mermaid'));
    document.head.appendChild(tag);
  });
  return loading;
}

function isDark(): boolean {
  const theme = document.body.dataset.theme;
  if (theme) {
    return theme === 'dark';
  }
  return document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
}

export function renderMermaid(
  language: string,
  content: string,
  applyPreview: (value: null | string | HTMLElement) => void,
): void | null {
  if (language.toLowerCase() !== 'mermaid' || !content.trim()) {
    return null;
  }
  const id = `mdlive-mermaid-${counter++}`;
  loadMermaid()
    .then((mermaid) => {
      // The theme is read on every render, so a diagram follows the color mode once re-rendered.
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: isDark() ? 'dark' : 'default', suppressErrorRendering: true });
      return mermaid.render(id, content);
    })
    .then(({ svg }) => applyPreview(svg))
    .catch((error: unknown) => {
      const div = document.createElement('div');
      div.className = 'mdlive-mermaid-error';
      div.textContent = error instanceof Error ? error.message : String(error);
      applyPreview(div);
    });
}
