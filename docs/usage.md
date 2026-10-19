# Markside manual

All features in detail. For an overview and installation, see the [README](../README.md). `Alt` is the `Option` key on a Mac.

## Markdown notes

- **Open the live editor:** in a `.md` file, click the pencil icon in the editor title (or Command Palette → *Markside: Open in Live Editor*). The `</>` icon switches back to the raw Markdown.
- **Title:** like in Obsidian, the file name is shown as the note's title (underscores as spaces). Editing the title renames the file once you leave it (`Enter` jumps to the start of the note, `Esc` discards the change). Spaces become `_` in the file name, characters not allowed in file names (`/ : * ? " < > |`) become `-`. If the name is taken, the old one stays. The `.assets` folder moves along. While scrolling, the title stays visible as a slim bar at the top; clicking it scrolls back up.
- **Images:** paste a screenshot or image with `Cmd+V`, or drag and drop it (from Finder with `Shift` held). The image is saved in the folder `<note>.assets/` next to the note and linked relatively. When the note is closed, images no longer linked go to the trash. When the note is renamed, moved, copied or deleted in VS Code, the folder moves, is copied or is deleted with it (in Finder, move note and folder together).
- **Resize images:** hover over an image and drag one of its four corners; the width is shown live in pixels. Resized images are saved as `<img src="…" width="…">`, which VS Code's preview, GitHub and Obsidian understand as well.
- **Move list items:** `Alt+↑` / `Alt+↓` moves only the line of the item under the cursor (or of the selected items) by one line, keeping its indentation, like moving lines in raw Markdown or in OneNote. Sub-items stay where they are and then belong to the item above them. Outside lists, whole paragraphs, headings or images are moved. `Tab` / `Shift+Tab` indents/outdents only the line itself; sub-items keep their level.
- **Font size:** the *Aa* icon in the editor title (or *Markside: Choose Font Size*) sets the font size of the open note or PDF only (it follows the file when renamed in VS Code). *Default* uses the setting `mdLive.fontSize` again.
- **Color mode:** *Markside: Choose Color Mode* (setting `mdLive.theme`: `auto`, `light`, `dark`).

## Keyboard shortcuts

They work in the live editor and in the notes next to PDFs (there only in the note that has focus). Formatting shortcuts toggle: pressing them again removes the formatting.

In lists, all shortcuts except `Alt+M` apply to the whole item under the cursor, even without or with only a partial selection. Exception, highlighting (`Alt+Q/W/E/R/H`): without a selection the whole item, with a selection only the selected text. Outside lists, shortcuts apply to the selected text only.

| Shortcut | Action | In Markdown |
|---|---|---|
| `Alt+B` | Bold | `**text**` |
| `Alt+I` | Italic | `*text*` |
| `Alt+S` | Strikethrough | `~~text~~` |
| `Alt+W` (or `Alt+H`) | Yellow highlight | `==text==` |
| `Alt+Q` / `Alt+E` / `Alt+R` | Red / green / blue highlight (same color again = remove, other color = recolor) | `<mark style="background: #FF5582A6;">text</mark>` |
| `Alt+X` | Remove highlights of any color | – |
| `Alt+C` | Inline code (replaces other formatting) | `` `text` `` |
| `Alt+M` | Inline math (clicking a formula turns it back into text) | `$text$` |
| `Alt+1` … `Alt+6` | Heading level 1–6 (same level again = paragraph) | `# text` … `###### text` |
| `Alt+^` (key left of 1) | Back to paragraph | – |
| `Alt+Y` | Collapse/expand the section of the heading the cursor is in; in a sub-item only that item (or its parent if it has no sub-items). Collapsed content shows a pill with the number of hidden blocks/items (click to expand); collapsed list items get a ring around their bullet. Remembered per note | – (view only) |
| `Alt+K` | Ask Claude Code about the selection | – |
| `Alt+D` | Insert handwriting | Image link to `note.assets/….drawing.svg` |
| `Alt+↑` / `Alt+↓` | Move list item or block up/down | – |
| `Tab` / `Shift+Tab` | Indent/outdent list item | – |
| `Tab` / `Shift+Tab` in a heading | Heading one level lower/higher | – |

## Handwriting

- **Canvas:** `Alt+D`, the pen icon in the editor title or `/` → *Handwriting* opens a drawing surface. It is infinite (grid paper): pan with the trackpad or mouse wheel on the Mac, with one finger on the iPad; zoom with two fingers (iPad, trackpad) or `Ctrl`+wheel. Zooming only changes the view, not the saved size. On saving, the drawing is cropped tightly to its strokes; only that ends up in the note.
- **Toolbar** (like OneNote): undo/redo, lasso (circle strokes, then drag inside the selection to move them; copy/paste with the buttons or `Cmd+C`/`Cmd+V`), insert/remove space (put the pen down and drag up/down: everything below moves along), eraser (tap again: the stroke eraser removes whole strokes, the point eraser only what it touches), 4 pens and 3 highlighters (highlighters lie below the ink; tap the selected one again to pick a color from the palette or freely via the rainbow circle; colors are remembered), shapes (line, arrows, rectangle, ellipse, circle, triangles, diamond, parallelogram, trapezoid, coordinate axes; drag from corner to corner, in the current pen color and width), and 5 stroke widths next to the pens (one width for all pens and one for all highlighters). *Done* saves, *Cancel* discards.
- **Files:** drawings are saved as `<note>.assets/<time>.drawing.svg` with the stroke data embedded in the SVG: the drawing displays everywhere like a normal image and can be edited again in Markside with a **double-click**. Ink is stored dark and shown inverted in dark themes (other programs show it dark in dark mode).
- **Drawing on images:** double-clicking an image in a note opens the canvas with the image as a fixed background, at the size it is shown in the note. You can draw on the image and on the white area around it. *Done* replaces the image with `<time>.image.drawing.svg` (image embedded, not inverted in dark mode; a white margin only if you drew beyond the image), editable again by double-click. If all strokes are removed, *Done* restores the original image (without margin, at its original width). Local images only, no `http(s)` links.
- **Choosing the device:** the drawing device entry in the status bar (shows Mac/iPad/Sidecar) or the device icon in the editor title (*Choose Drawing Device*, setting `mdLive.drawingDevice`).

### Drawing on an iPad

1. Set `mdLive.drawingDevice` to `ipad` (or run *Markside: Draw on iPad: Show Address*, which switches it as well).
2. Open the address from that command in Safari on the iPad (it is copied to the clipboard; paste it on the iPad via Universal Clipboard). Ideally add it to the home screen via *Share → Add to Home Screen*.
3. The page then waits. `Alt+D` or a double-click on a drawing or image on the Mac opens the canvas on the iPad; *Done* inserts the drawing into the note. A notification on the Mac shows that a drawing is in progress (with *Cancel*).

Notes:
- Mac and iPad must be able to reach each other on the network (same Wi-Fi, or e.g. Tailscale). On first start, the macOS firewall may ask whether VS Code may accept incoming connections: allow it.
- Only the Pencil draws; one finger pans, two fingers zoom.
- The address contains a secret token that stays the same (*Draw on iPad: New Address* creates a new one and invalidates the old address). Port: `mdLive.ipadPort`, default 8765.
- The server only runs on demand: it starts with `Alt+D`/double-click (or *Show Address*) and stops 2 minutes after the last drawing; then the port is closed. The open iPad page reconnects by itself as soon as it runs again; reloading the page only works while it runs.
- Nothing drawn on the iPad gets lost: unfinished drawings are kept as drafts on the iPad, and finished ones are resent until the Mac has saved them, even across VS Code reloads.
- **`ipadUsb`:** like `ipad`, but the server only accepts connections over the USB cable to the iPad. Recommended in public networks such as eduroam. Use the `169.254.x.x` address from *Show Address*.

### Drawing via Sidecar

Set `mdLive.drawingDevice` to `sidecar`. `Alt+D`/double-click opens the same drawing page as for the iPad in its own Chrome app window (separate profile, no toolbars), full screen on the Sidecar display (detected by a name containing "iPad" or "Sidecar"; without Chrome in the default browser).

- If no Sidecar display is connected, the Mac connects automatically to the iPad named in `mdLive.sidecarIpad` (name as shown in Control Center under *Display*; empty = never connect automatically). This uses the private macOS framework SidecarCore and may break with macOS updates; if it fails, the page opens on the Mac.
- While the window stays open, every further drawing appears there (it reconnects by itself; only after ~5 s without a connection a new one is opened). VS Code stays on the Mac display with all its tabs.
- The server only listens on `127.0.0.1`, so no other device can reach it; suitable for foreign networks.

## PDF notes

- `.pdf` files open with notes in the right margin that are always visible.
- **Highlighting:** select text, then `Alt+Q`/`W`/`E`/`R` highlights it red/yellow/green/blue like in the live editor. With `Alt+Shift+Q`/`W`/`E`/`R` (or one of the color dots next to the selection) a note is opened right away; `Alt+A` uses a random custom color instead, so highlights can be told apart. A selection over an existing highlight replaces it (e.g. to change its color); its note is kept.
- **Opening notes:** clicking a highlight opens its note. If a note stays empty, only the highlight remains (a highlight just created together with its note disappears as well).
- **Areas:** hold `Alt` and drag a rectangle: a note on that area. A snapshot of the region is saved in the notes file (for Claude), but not shown in the note; the frame gets a random color like with `Alt+A`.
- **Page notes:** every page has a text field at the top of the margin for a note on the whole page.
- **Notes are full Markdown** with everything the live editor can do (images, lists, math, handwriting with `Alt+D`, also on the iPad). `Shift+Enter` finishes editing a note. In notes, `Alt+Y` collapses list items and headings.
- **Placement:** notes on highlights are placed directly on the slide when there is enough free space near the highlight (without covering text, images or other notes), otherwise in the margin. Only in the margin do they show the highlighted text at the top. New notes are written in the margin; only once you leave them do they move onto the slide if there is room. `Alt+P` in a note moves it to the margin for editing; afterwards it is placed again. Notes in the margin that overlap slide down; if they are longer than the page, the gap to the next page grows.
- **Deleting:** `×` deletes note and highlight; faster: pointer over a highlight and `Delete`/`Backspace`, or `Shift+Delete`/`Shift+Backspace` inside a note (a page note is emptied instead). `Cmd+Z` / `Cmd+Shift+Z` (outside a note) undoes/redoes creating and deleting highlights.
- **Zooming:** `Ctrl`+wheel or pinch enlarges pages and notes together (the font size setting applies at 100 %). The notes column always reaches to the right edge of the window; its default width is `mdLive.pdfNotesWidth`.
- **Storage:** notes are saved automatically in `<file>.pdf.md` next to the PDF (images in `<file>.pdf.assets/`); the PDF itself stays unchanged. The file is a normal note: `## Page 3` holds the page note, `### [highlighted text](#p3=…)` a highlight with its note (the numbers are its position on the page). When the PDF is renamed in VS Code, the notes move along; when it is deleted, the notes file and images go to the trash with it.

| Shortcut (text selected in the PDF) | Action | In `<file>.pdf.md` |
|---|---|---|
| `Alt+Q` / `Alt+W` / `Alt+E` / `Alt+R` (`Alt+H` = yellow) | Highlight red / yellow / green / blue | `### [text](#p3=…&c=red)` (yellow without `&c=`) |
| `Alt+Shift+Q` / `W` / `E` / `R`, `Alt+A` (random color) or color dot | Highlight and write a note | Heading as above, the note below it |
| `Alt` + drag a rectangle | Note on an area, with a snapshot | `### [Area](#p3=…&area)` |
| `Alt+K` | Ask Claude Code about the selection, the highlight under the pointer or the visible page | – (`<file>.pdf.assets/.claude.md`) |
| `Ctrl`+wheel / pinch | Zoom pages and notes | – |
| `Shift+Delete` / `Shift+Backspace` (in a note) | Delete note and highlight (page note: empty it) | Section removed |
| `Alt+P` (in a note) | Move the note to the margin for editing | – |

### Lecture ends and sections

Hovering the gap below a page shows a `+` (or use the milestone icon in the editor title, which adds one after the visible page). It asks for a date and/or title: with a date (prefilled with today) it is a lecture end, shown as a red line below the slide; a title only starts an own section (neutral line). Clicking the line edits it, `×` deletes it (undo with `Cmd+Z`). The milestone menu jumps to every line. They are stored as a list `## Sections` at the top of `<file>.pdf.md`.

## Claude Code

Requires the [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) extension; explaining slides also requires the `claude` CLI and the skill [`skills/explain-slides`](../skills/explain-slides/SKILL.md) copied to `~/.claude/skills/`.

### Asking about a selection

- **In notes:** select text and press `Alt+K` (or the sparkle icon in the editor title). The file is briefly opened as a text editor, the matching lines are selected and passed to Claude Code as `@file.md#Lx-y`. Drawings in the selection are sent along as PNG images.
- **In PDFs:** `Alt+K` passes the selected text, otherwise the note or highlight under the pointer, otherwise the visible page. In a note or explanation it is about the selected text, otherwise the bullet at the cursor, otherwise the whole note or explanation. Markside writes `<file>.pdf.assets/.claude.md` with the page number, quote and all notes on that page and passes it as an `@` mention; it also tells Claude to read only that page of the PDF (and neighboring pages if needed). Then just type your question.

### Proposed annotations

For every question, Claude additionally proposes a short annotation after answering in the chat (in `<file>.pdf.assets/.proposals.md`). It appears dashed in violet with ✦ below the note or explanation (for a passage on the slide without a note of its own: in the page note). *Add* inserts it as a sub-bullet below the bullet you asked about, for a selected passage as a new note on that passage (random color like `Alt+A`), for a highlight into its note, otherwise into the page note (undo with `Cmd+Z`); *Dismiss* discards it. If you ask Claude to change a bullet (e.g. rephrase an annotation), it proposes a new version instead, which *Replace* swaps in. Accepted annotations in your notes start with `✦` and are violet, so it stays visible what came from Claude; in Claude's explanations the `✦` is omitted.

To keep Claude Code from asking for write permission every time, allow it in the workspace of your lectures in `.claude/settings.json`:

```json
{ "permissions": { "allow": ["Edit(**/*.pdf.assets/.proposals.md)"] } }
```

### Explaining slides in advance

- The sparkle icon in the PDF's editor title opens a menu: the next 10 unexplained slides from the visible page, a page range (`5-12, 20`), slides about a topic ("everything about the Internet worm"; Claude picks the pages by their text), all unexplained ones, or the next lecture (after the last lecture end up to the next line). Claude Code (`claude` CLI) then runs in the background (progress at the bottom right, cancellable; the sparkle turns into a spinner) and may only write `<file>.pdf.claude.md`; slides already explained are skipped. The same works in Claude Code with `/explain-slides path/to/file.pdf`.
- Every slide gets its key message and a short explanation in bullets (in the language of the setting `mdLive.claudeLanguage`, default English; unknown terms as their own bullet). It appears live as a tinted box with a ✦ at the top of the page note: collapsed only the key message, a click (or the arrow on the right) expands the bullets. The lightbulb in the editor title expands/collapses all explanations; hide them completely with the setting `mdLive.pdfExplanations`.
- The text can be selected: `Alt+K` sends the selected passage (or, with the pointer over the box, the whole explanation) as a question to Claude Code.
- Expanded, the explanation can be edited directly: what you type there is automatically italic (Claude never writes italics), so it always stays clear what is yours; you can also delete Claude's text. Highlight it like notes with `Alt+W`/`Q`/`E`/`R` (cursor in a bullet = whole bullet) or a color dot; `Alt+X` removes highlights. A double-click selects a whole bullet; the collapsed key message is highlighted as a whole. Everything is saved in `<file>.pdf.claude.md`. `×` dismisses an explanation (undo with `Cmd+Z`). Your own notes file is never touched.

## Known limitations

- **Copying between workspaces/windows:** when a note is copied, Markside searches for its linked images only in the current workspace and copies them into the copy's `.assets` folder. If the original lies in another workspace (e.g. copied from another repository or VS Code window), the images are not found and the links in the copy break. Workaround: copy the `.assets` folder in Finder as well, or open both folders in a multi-root workspace.
- **File operations outside VS Code** (Finder, terminal, Git) are not tracked: move or copy a note together with its `<note>.assets/` folder.
- **`Alt` shortcuts and the Mac keyboard:** `Option` combinations that type characters (e.g. `[`, `]`, `€` on German keyboards) are used as shortcuts in the editor.
