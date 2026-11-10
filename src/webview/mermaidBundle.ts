import mermaid from 'mermaid';

// Separate bundle (dist/mermaid.js), loaded by mermaid.ts on the first diagram.
(window as unknown as { mdliveMermaid: typeof mermaid }).mdliveMermaid = mermaid;
