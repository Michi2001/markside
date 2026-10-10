# CLAUDE.md

VS Code extension "Markdown Live Editor": Obsidian/Typora-style live editing of `.md` files in a custom editor (Milkdown Crepe inside a webview), with image paste and hand-off of the selection to Claude Code.

## Commands

```bash
npm install
npm run build        # esbuild: dist/extension.js + dist/webview.js/.css
npm run watch        # rebuild on change
npx tsc --noEmit     # typecheck (esbuild does not check types)
npm run package      # build .vsix (vsce)
```

`F5` (`.vscode/launch.json`) builds and launches an Extension Development Host with the `notes/` folder as test workspace. There are no automated tests; verify changes manually in that instance.

## Architecture

Two separate bundles (see `esbuild.mjs`):

- **Extension host** (`src/extension.ts`, `src/liveEditor.ts`, `src/assets.ts`): Node/CJS, `vscode` is external.
  - `extension.ts`: registers the custom editor `mdLive.editor` and the commands `mdLive.open`, `mdLive.openAsText` (swap the active tab via `vscode.openWith`), `mdLive.sendSelectionToClaude` and `mdLive.chooseTheme` (writes the `mdLive.theme` setting).
  - `liveEditor.ts`: `LiveEditorProvider` (`CustomTextEditorProvider`). The `TextDocument` is the single source of truth; the webview is only a view.
  - `assets.ts`: per-note image folders (saving, cleanup, sync on rename/copy/delete).
- **Webview** (`src/webview/`): browser/IIFE, bundles Milkdown Crepe including KaTeX fonts into `dist/assets/`.
  - `main.ts`: creates the Crepe editor, message handling, paste/drop of images, global `keydown` shortcuts.
  - `imageView.ts`: resizable image blocks. `moveBlocks.ts`: `Alt+Up/Down` and `Tab` in lists. `headings.ts`: heading level shortcuts. `highlight.ts`: `==highlight==` mark. `style.css`: maps Crepe theme variables to VS Code theme variables.

### Message protocol webview ↔ extension

| Direction | Type | Purpose |
|---|---|---|
| Webview → Ext | `ready` | Webview loaded, requests `init` |
| Ext → Webview | `init` | Document text + `baseUri` (note's folder) + `theme` |
| Ext → Webview | `theme` | Color mode changed (`mdLive.theme`: `auto`/`light`/`dark`) → `body[data-theme]` |
| Webview → Ext | `edit` | Full Markdown after a change |
| Ext → Webview | `update` | External change to the document (`replaceAll`) |
| Webview → Ext | `saveImage` / Ext → Webview `imageSaved` | Save image (base64), return relative path |
| Ext → Webview | `requestSelection` / Webview → Ext `selection` | Selected plain text for Claude |

Types for messages to the extension live in `WebviewMessage` (`liveEditor.ts`); when adding messages, update both sides.

### Key details

- **Echo prevention:** `webviewText` (extension) and `lastSynced` (webview) prevent own changes from being mirrored back. Keep this in mind when changing the sync logic.
- **Minimal edits:** `applyMinimalEdit` replaces only the changed middle part so VS Code's undo and dirty state stay sensible. Edits run serially via `editQueue`. CRLF documents are converted on `edit`.
- **Markdown normalization:** Crepe serializes the Markdown itself; bullets are set to `-` via `remarkStringifyOptionsCtx`. Existing notes may get reformatted on first edit.
- **Images:** each note `foo.md` owns a sibling folder `foo.assets/`; images are saved there as `<timestamp>.<ext>` and linked relatively (`foo.assets/123.png`, note name URI-encoded). Relative image paths are resolved in the webview via `baseUri`; `localResourceRoots` and the CSP in `getHtml` must allow this. `assets.ts` keeps a single owner per folder: when the last panel of a note closes, `cleanupAssets` moves files not referenced in the note (disk + unsaved text) to the trash; `adoptAssets` copies images linked from another note's folder (pasted image, copied note) into the own folder and relinks them (on every `edit`; on `onDidCreateFiles` it also searches the workspace via `findFiles`, so notes copied into another folder get their images); `registerAssetSync` moves/renames the folder with the note (`onDidRenameFiles`, relinks on rename) and trashes it when the note is deleted. Only operations inside VS Code are tracked; in Finder note and folder must be moved together. Known limitation (documented in README): `findFiles` only searches the current workspace, so a note copied from another workspace/window gets broken image links. The user hides the folders via `files.exclude` `"**/*.assets": { "when": "$(basename).md" }`.
- **Resizable images:** `imageView.ts` extends Crepe's `image-block` schema (`extendImageBlockSchema`, adds `width` and a real `alt`; Crepe's `ratio`-in-alt is ignored) and replaces its node view after `crepe.create()` via `view.setProps` (`createImageBlockView`; empty image blocks keep Crepe's upload placeholder). Corner handles set `width` in px. Unresized images serialize as `![alt](src)`, resized ones as `<img src="…" width="N">`; `remarkHtmlImages` parses standalone `<img>` tags with a numeric width back into image blocks.
- **Moving blocks (`Alt+Up/Down`):** `src/webview/moveBlocks.ts`. In lists, `editListRows` flattens the outermost list into rows (item's own content + depth), applies a row edit and rebuilds the nested lists via `build` (depth clamped to previous depth + 1). `moveRows` moves only the selected rows by one row (sublists stay in place). Outside lists, blocks are swapped with their sibling. Registered as a `$prose` keymap before `crepe.create()`.
- **Tab in lists:** `indentListItems` (`moveBlocks.ts`) uses `editListRows` + `shiftRows` to change only the depth of the selected rows (sublists keep their depth; no-op on the first row or at depth 0) and always consumes `Tab`/`Shift+Tab` inside lists, so Crepe's `indent` plugin can't insert spaces. Called from the global capture `keydown` listener in `main.ts` (skipped inside CodeMirror code blocks); outside lists `Tab` keeps the default behavior.
- **Formatting shortcuts:** `Alt+B` bold, `Alt+I` italic, `Alt+S` strikethrough, `Alt+W`/`Alt+H` yellow highlight, `Alt+Q`/`Alt+E`/`Alt+R` red/green/blue highlight (`HIGHLIGHT_KEYS`), `Alt+C` inline code, `Alt+M` inline math. Mapped to Milkdown command names in `FORMAT_COMMANDS` (`main.ts`) and handled in the global `keydown` listener (with `Alt+K`), because clicking a formula focuses its tooltip, not ProseMirror. In lists, `listItemRange` expands the selection to the whole text of the touched items for all formatting commands except `ToggleLatex` (and `ToggleHighlight` with a non-empty selection) and for `Alt+K` (`runFormatCommand` restores the cursor afterwards).
- **Headings:** `Alt+1..6` set the heading level of the selected blocks (same level again → paragraph), `Alt+^` (key left of 1: `Backquote`/`IntlBackslash`, see `HEADING_KEYS` in `main.ts`) → paragraph, via `setHeading` (`headings.ts`). `Tab`/`Shift+Tab` in a heading shift its level by one (`shiftHeading`, called after `indentListItems` in the `Tab` branch of the `keydown` listener).
- **Highlight:** `src/webview/highlight.ts` adds an Obsidian-style `==text==` mark with a `color` attr (remark plugin splitting text nodes + `<mark>` schema, `ToggleHighlight` command taking a color, input rule). Only `==…==` within a single text node is parsed. Yellow serializes as `==text==`, other colors as `<mark style="background: …;">` using the Obsidian Highlightr hex values in `HIGHLIGHT_COLORS`; `parseHtmlMarks` merges the separate inline `<mark …>`/`</mark>` html nodes back into colored highlights (unknown colors are kept as raw CSS). In the editor, `style.css` shows theme-neutral colors via `mark[data-color]`.
- **Claude hand-off (`Alt+K`):** the Claude Code extension only reads selections from real text editors. So: save the document (avoids a save prompt when closing the temp tab; Claude reads from disk), map the plain-text selection heuristically to source lines via `findSourceRange`/`stripMarkdown`, briefly open the file as a text editor, select the lines, run `claude-vscode.insertAtMention`, then close the temporary tab.

## Conventions

- TypeScript strict, 2 spaces, single quotes, trailing commas; short English comments only for non-obvious logic.
- Minimal error handling: report problems via `vscode.window.showWarningMessage` rather than catching errors.
- `dist/`, `node_modules/` and `*.vsix` are generated; do not edit by hand.
- `notes/` only contains test notes for the development instance.
