---
name: explain-slides
description: Explain lecture slides of a PDF in advance, as study help next to the slides in the PDF view of the Markside VS Code extension. Writes `<file>.pdf.claude.md` with the key message of every slide and a short explanation in bullet points, including terms a CS master's student likely doesn't know. Use when the user asks to explain slides/a PDF ("erklär mir die Folien", "/explain-slides lecture.pdf").
argument-hint: <path to PDF> [page range]
---

# Explain slides

Goal: before the user works through a lecture, every slide gets its key message and a short explanation in the PDF view (VS Code extension "Markside"). The reader is a **computer science master's student**: explain what the slide means and why it matters, in your own words, not a paraphrase of its bullet points.

## Output file

Write `<file>.pdf.claude.md` next to the PDF (e.g. `lecture.pdf` → `lecture.pdf.claude.md`). Never touch the user's own notes `<file>.pdf.md`, but read it if it exists: questions in it (e.g. "Versteh ich nicht??") show what needs explaining.

Format (exactly this, the extension parses it):

```markdown
## Page 5

**Frühe Expertensysteme haben Unsicherheit mit ad-hoc-Zahlen an Regeln modelliert.**

- Oben eine rein logische Regel, unten dieselbe Regel abgeschwächt mit „suggestive evidence (0.7)“.
- Certainty Factor = Belief − Disbelief: eine Heuristik ohne probabilistische Grundlage.
- Über viele Regeln verkettet wird das inkonsistent, daher die Bayes-Netze auf der nächsten Folie.
- **MYCIN:** Expertensystem der 1970er zur Diagnose bakterieller Infektionen, aus dem die Regel stammt.
```

- One `## Page N` section per slide, nothing else (no `###` sections). N is the physical page number in the PDF (1-based, as in the Read tool's `pages`), not the number printed on the slide.
- First paragraph: the slide's **key message** as one bold sentence. It is always visible; the bullets only when expanded.
- Then 1–5 bullets explaining it: what the slide shows (figures, formulas, examples), why it matters, how it connects to the previous/next slides, what is implicit. Keep it short (under ~100 words per slide).
- Terms a CS master's student likely doesn't know (niche systems, field-specific jargon, non-obvious abbreviations) get their own bullet `- **Term:** explanation`, after the other bullets. Skip standard CS knowledge and terms the lecture explains on a later slide (see the outline in the prompt or the agenda slide).
- Title slides and pure agenda/"Questions?" slides: just the key message, no bullets.
- Markdown and math (`$…$`) are allowed.
- Never use italics (`*…*`, `_…_`): italic text in the file marks the user's own additions. Emphasize with bold instead.
- Language: the one the prompt names (the extension always names one, from its setting `mdLive.claudeLanguage`), otherwise English; the same for slides in another language. Keep established English technical terms.
- Pages in ascending order.

## Process

1. Read the PDF in chunks of at most 20 pages (Read tool with `pages`, e.g. `"1-20"`). Use the given page range if any.
2. After each chunk, append its pages to the output file right away (the PDF view updates live, so the user sees progress).
3. If the output file already exists, keep its pages and only add missing ones, unless the user asks to redo them. An empty `## Page N` means the user dismissed that page's explanation: leave it empty. Existing pages may contain the user's highlights (`==text==`, `<mark style="…">text</mark>`), own italic additions, and passages the user deleted: keep them exactly as they are.
4. At the end, report in one or two sentences how many slides were explained.
