# Markside

**Markside turns VS Code into a note-taking app for studying.**

Live Markdown editing and PDF margin notes, with handwriting and Claude Code integration. Markdown notes are edited in their rendered form (like Obsidian or Typora), and lecture slides open as PDFs with always-visible notes next to every page. Everything is stored as plain Markdown next to your files, so notes stay readable on GitHub, in Obsidian or in any text editor.

> **Status:** personal project, work in progress. Developed and tested on macOS only; the iPad/Sidecar features require a Mac. File formats may still change.

<!-- TODO: screenshots / GIFs (docs/images/) -->

## Features

### Live Markdown editor
- Edit `.md` files in their rendered form, in a single tab (built on [Milkdown Crepe](https://milkdown.dev)): headings, lists, tables, code blocks, math (KaTeX), task lists.
- **Raw Markdown stays untouched:** only the blocks you actually change are reformatted; everything else keeps its original source, so diffs stay small.
- Inline title like Obsidian: editing it renames the file.
- Paste or drop images; they are saved in a per-note folder `note.assets/` and moved, copied and cleaned up together with the note.
- Resize images by dragging their corners.
- Colored highlights (`==text==`, compatible with Obsidian Highlightr), collapsible sections, moving list items with `Alt+↑/↓`, keyboard shortcuts for all formatting.

### PDF margin notes
- PDFs open with a notes column next to every page. Each page has its own note, and text or areas you highlight get their own notes.
- Notes are full Markdown editors (images, math, lists, handwriting) and are placed **directly on the slide** when there is free space next to the highlight, otherwise in the margin, connected by a line.
- Highlights in four colors or random custom colors; area snapshots; undo/redo; lecture-end markers between pages.
- Stored in `paper.pdf.md` next to the PDF; the PDF itself is never modified.

### Handwriting
- An infinite, OneNote-like canvas for handwritten notes and sketches (pen, highlighter, eraser, lasso, shapes, insert space), saved as SVG with the stroke data embedded, so drawings stay editable.
- Draw on top of images in a note.
- **Draw on an iPad with Apple Pencil:** either in Safari on the iPad (local server, Wi-Fi or USB) or full screen on a Sidecar display.

### Claude Code integration (optional)
- `Alt+K` sends the selected passage, highlight or page, together with your notes on it, to [Claude Code](https://claude.com/claude-code) as context for a question.
- Claude can explain slides in advance: every slide gets its key message and a short explanation, shown in the page's note card. Your own additions are kept apart (italics).
- After answering, Claude proposes a short annotation that you can accept into your notes with one click.

## Installation

Markside is not on the VS Code Marketplace yet. Install it from a release:

1. Download `markside-<version>.vsix` from the [Releases](../../releases) page.
2. Run `code --install-extension markside-<version>.vsix` (or in VS Code: *Extensions* → `…` → *Install from VSIX…*).

Or build it yourself:

```bash
npm install
npm run package
code --install-extension markside-0.1.0.vsix
```

### Requirements
- VS Code 1.95 or newer.
- Optional, for the Claude features: the [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) extension and the `claude` CLI. To let Claude explain slides, copy [`skills/explain-slides`](skills/explain-slides/SKILL.md) to `~/.claude/skills/`. Claude writes explanations and annotations in English; set `mdLive.claudeLanguage` (e.g. `German`) for another language.
- Optional, for drawing on the Sidecar display: Google Chrome.

### Recommended settings

Hide the helper files Markside creates next to your notes and PDFs:

```json
"files.exclude": {
  "**/*.assets": { "when": "$(basename).md" },
  "**/*.pdf.md": { "when": "$(basename)" },
  "**/*.pdf.claude.md": true
}
```

## Usage

- Open a `.md` file and click the pencil icon in the editor title (or *Markside: Open in Live Editor*). The `</>` icon switches back to the raw Markdown.
- PDFs open in Markside by default. Select text and press `Alt+W` to highlight it, `Alt+Shift+W` to highlight it and write a note.
- `Alt+D` opens the handwriting canvas.

The full manual with all features and settings is in [docs/usage.md](docs/usage.md).

### Keyboard shortcuts

`Alt` is the `Option` key on a Mac. Formatting shortcuts toggle; in lists they apply to the whole item under the cursor.

| Shortcut | Action |
|---|---|
| `Alt+B` / `Alt+I` / `Alt+S` | Bold / italic / strikethrough |
| `Alt+W` (or `Alt+H`) | Yellow highlight |
| `Alt+Q` / `Alt+E` / `Alt+R` | Red / green / blue highlight |
| `Alt+X` | Remove highlights |
| `Alt+C` / `Alt+M` | Inline code / inline math |
| `Alt+1` … `Alt+6`, `Alt+^` | Heading level 1–6, back to paragraph |
| `Alt+Y` | Collapse/expand the section or list item at the cursor |
| `Alt+↑` / `Alt+↓` | Move list item or block up/down |
| `Tab` / `Shift+Tab` | Indent/outdent list item; in a heading, change its level |
| `Alt+D` | Insert handwriting |
| `Alt+K` | Ask Claude Code about the selection |

In the PDF view (text selected in the PDF):

| Shortcut | Action |
|---|---|
| `Alt+Q` / `W` / `E` / `R` | Highlight red / yellow / green / blue |
| `Alt+Shift+Q` / `W` / `E` / `R`, `Alt+A` | Highlight and open a note (`Alt+A`: random color) |
| `Alt` + drag | Note on an area of the page (with snapshot) |
| `Alt+K` | Ask Claude about the selection, the highlight under the pointer or the page |
| `Delete` (pointer over a highlight), `Shift+Delete` (in a note) | Delete highlight and note |
| `Cmd+Z` / `Cmd+Shift+Z` (outside notes) | Undo/redo creating and deleting notes |
| `Ctrl`+wheel / pinch | Zoom pages and notes together |

## Files on disk

| File | Content |
|---|---|
| `note.md` | The note itself (standard Markdown; resized images as `<img width>`, colored highlights as `<mark>`) |
| `note.assets/` | Images and drawings of the note (`*.drawing.svg`, strokes embedded in `<metadata>`), collapsed sections (`.folds.json`) |
| `paper.pdf.md` | Notes of a PDF: `## Page N` = page note, `### [quote](#p3=x,y,w,h)` = note on a highlight |
| `paper.pdf.assets/` | Images and area snapshots of the PDF notes, context files for Claude |
| `paper.pdf.claude.md` | Claude's explanations of the slides |

## How it works

Markside consists of two custom editors (Markdown and PDF) whose webviews talk to the extension host over `postMessage`, plus a separate drawing page for the iPad. A few parts that were more interesting to build:

- **The `TextDocument` is the single source of truth.** The webview is only a view; every change is sent as full Markdown and applied as a minimal edit (only the changed middle part), so VS Code's undo, dirty state and Git diffs behave like in a normal text editor. Echo prevention on both sides keeps changes from bouncing back.
- **Source preservation** ([`preserve.ts`](src/preserve.ts)): the Markdown serializer normalizes the whole document on every keystroke. To avoid that, the extension splits old and new text into top-level blocks with remark, matches them by their normalized form (LCS), and keeps the original source of every unchanged block.
- **Placing notes on the slide** ([`pdf/main.ts`](src/webview/pdf/main.ts)): free space on a rendered page is detected from the canvas pixels, and a summed-area table over a grid finds the closest free spot for each note whose connector line crosses no content and no other note.
- **Drawings as editable SVGs** ([`drawing.ts`](src/webview/drawing.ts)): strokes are stored as pressure-dependent polylines inside the SVG's metadata, so a drawing displays everywhere as a normal image and reopens with all strokes.
- **iPad drawing** ([`drawingServer.ts`](src/drawingServer.ts)): an on-demand local HTTP server with a secret token pushes drawing requests to the iPad via server-sent events. Drafts and finished drawings are kept in the iPad's local storage and resent until the Mac confirms them, so nothing gets lost when VS Code reloads or the connection drops.

[CLAUDE.md](CLAUDE.md) describes the architecture and message protocol in full detail.

## Security notes

- The iPad drawing server only runs when the drawing device is set to `ipad`, `ipadUsb` or `sidecar`, and stops two minutes after the last drawing. All routes require a secret token in the URL; the connection is plain HTTP. In public networks, use `ipadUsb` (USB cable only) or `sidecar` (localhost only).
- Explaining slides runs `claude -p` in the PDF's folder with read access and write access to the explanations file only.

## Known limitations

- Developed on macOS only; Windows and Linux are untested.
- `Alt` shortcuts block some characters typed with `Option` on a Mac (e.g. `[`, `]` and `€` on German keyboards, accent dead keys on US keyboards).
- File operations outside VS Code (Finder, terminal, Git) are not tracked: move or copy a note together with its `.assets` folder.
- When a note is copied from another workspace, its images are not found and the links in the copy break.
- Sidecar auto-connect uses a private macOS framework and may break with macOS updates.

## Development

```bash
npm install
npm run build        # or: npm run watch
npx tsc --noEmit     # typecheck
npm run package      # build the .vsix
```

`F5` launches an Extension Development Host with the `notes/` folder as test workspace.

## License

[MIT](LICENSE)
