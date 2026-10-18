import * as path from 'path';
import * as vscode from 'vscode';
import { claudeDrawingLines, cleanupAssets, explanationsUri, loadFolds, notesUri, proposalsUri, saveFolds, saveImage, writeClaudeContext } from './assets';
import { DrawingServer, getDrawingDevice } from './drawingServer';
import { type PdfView, explainSlides, isExplaining } from './explain';
import type { FontSizes } from './fontSizes';
import { applyAdopted, applyMinimalEdit, getTheme, queueEdit, sendSelectionToClaude } from './liveEditor';
import { preserveSource } from './preserve';
import {
  type Anchor,
  type Divider,
  type Proposal,
  type Rect,
  type Section,
  addNote,
  deleteNote,
  formatAnchor,
  formatProposals,
  insertAnnotation,
  parseAnchor,
  pageExplanation,
  pageKey,
  parseDividers,
  parseExplanations,
  parseProposals,
  parseSections,
  setDividers,
  setExplanation,
  setNoteBody,
} from './sidecar';
import type { Fold } from './webview/fold';
import type { ClaudeDrawing } from './webview/noteEditor';

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'editNote'; key: string; text: string }
  | { type: 'addNote'; anchor: Anchor; label: string; body: string; replace: string[] }
  | { type: 'deleteNote'; key: string; discard: boolean }
  | { type: 'undo'; redo: boolean }
  | { type: 'folds'; folds: Record<string, Fold[]> }
  | { type: 'saveImage'; id: number; name: string; mime: string; data: string }
  | { type: 'selection'; text: string }
  | { type: 'askClaude'; page: number; quote?: string; rects?: Rect[]; color?: string; key?: string; note?: boolean; explanation?: boolean; drawings?: ClaudeDrawing[] }
  | { type: 'view'; page: number; pages: number }
  | { type: 'pageTexts'; texts: string[] }
  | { type: 'deleteExplanation'; page: number }
  | { type: 'editExplanation'; page: number; text: string; undoable: boolean }
  | { type: 'editDivider'; after: number }
  | { type: 'deleteDivider'; after: number }
  | { type: 'acceptProposal'; id: string }
  | { type: 'rejectProposal'; id: string }
  | { type: 'drawRemote'; id: number; drawing: unknown; src: string | null };

const SAVE_DELAY_MS = 800;
// Proposals Claude left empty (nothing worth keeping) are dropped on the next question after this.
const EMPTY_PROPOSAL_MS = 30 * 60 * 1000;

type NoteData = { anchor: Anchor; label: string; body: string };
// One undoable step: notes added and removed together (a new mark replacing others, a deletion),
// a dismissed explanation (the explanations file before and after), changed dividers or an
// accepted annotation in a note (its body before and after).
type Step = {
  added: NoteData[];
  removed: NoteData[];
  explanations?: { before: string; after: string };
  dividers?: { before: Divider[]; after: Divider[] };
  note?: { key: string; before: string; after: string };
};

const noteData = (s: Section): NoteData => ({ anchor: s.anchor!, label: s.label, body: s.body });

// Read-only PDF view with the notes of `paper.pdf.md` next to the pages. Like the Markdown editor,
// the notes' TextDocument is the single source of truth; it is saved automatically, since the PDF
// tab never shows it as dirty.
export class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider {
  static readonly viewType = 'mdLive.pdf';
  // The focused PDF view (for the explain command).
  private active: PdfView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly drawingServer: DrawingServer,
    private readonly fontSizes: FontSizes,
  ) {}

  // Quick pick: add a divider after the page in view or jump to one.
  async dividers(): Promise<void> {
    const view = this.active;
    if (!view) {
      vscode.window.showWarningMessage('No PDF is active.');
      return;
    }
    type Item = vscode.QuickPickItem & { after: number; add?: boolean };
    const items: Item[] = [
      { label: `$(add) Add divider after page ${view.page}`, after: view.page, add: true },
      ...view.dividers().map((d) => ({
        label: `${d.date ? '$(mortar-board)' : '$(list-tree)'} ${[d.date, d.title].filter(Boolean).join(' · ')}`,
        description: `after page ${d.after}`,
        after: d.after,
      })),
    ];
    const item = await vscode.window.showQuickPick(items, { placeHolder: 'Lecture ends and sections' });
    if (item?.add) {
      await view.editDivider(item.after);
    } else if (item) {
      view.reveal(item.after);
    }
  }

  explainSlides(): void {
    if (!this.active) {
      vscode.window.showWarningMessage('No PDF is active.');
      return;
    }
    explainSlides(this.active, () => this.updateContext());
  }

  // Shows the running spinner in the editor title instead of the explain button.
  private updateContext(): void {
    vscode.commands.executeCommand('setContext', 'mdLive.explaining', !!this.active && isExplaining(this.active.pdf));
  }

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const pdf = document.uri;
    const notes = notesUri(pdf);
    const explanations = explanationsUri(pdf);
    const docDir = vscode.Uri.joinPath(pdf, '..');
    const distUri = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri);

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [distUri, docDir, ...workspaceRoots],
    };
    panel.webview.html = this.getHtml(panel.webview, distUri);

    // Created on the first note.
    let note = (await exists(notes)) ? await vscode.workspace.openTextDocument(notes) : undefined;
    let editQueue: Promise<unknown> = Promise.resolve();
    let saveTimer: NodeJS.Timeout | undefined;
    // Text after our own last edit; changes to anything else are sent to the webview.
    let ownText: string | undefined;
    // Per note: the body as stored (source formatting kept) and as the webview sent it, so resending
    // the notes doesn't overwrite a card with its own, differently formatted content.
    const echo = new Map<string, { stored: string; webview: string }>();
    // Adding and deleting marks/notes; text inside a card has the card editor's own undo.
    const undoStack: Step[] = [];
    const redoStack: Step[] = [];

    // Shared with other panels on the same notes (split view, the notes open in a live editor).
    const queue = (task: () => Promise<unknown>): void => {
      editQueue = queueEdit(notes, task);
    };

    const openNote = async (): Promise<vscode.TextDocument> => {
      if (!note) {
        if (!(await exists(notes))) {
          await vscode.workspace.fs.writeFile(notes, new Uint8Array());
        }
        note = await vscode.workspace.openTextDocument(notes);
      }
      return note;
    };

    const sections = () =>
      parseSections(note?.getText() ?? '').map((s) => {
        const e = echo.get(s.key);
        return { ...s, body: e && e.stored === s.body ? e.webview : s.body };
      });

    // `reset`: notes changed by undo; their cards take the new body
    // even if they sent it themselves before (it is no late echo then).
    const sendNotes = (reset: string[] = []): void => {
      panel.webview.postMessage({ type: 'notes', sections: sections(), dividers: parseDividers(note?.getText() ?? ''), reset });
    };

    const scheduleSave = (): void => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => queue(async () => note?.isDirty && note.save()), SAVE_DELAY_MS);
    };

    // Applies a change of the notes text; foreign images (pasted from other notes) are adopted.
    const write = async (change: (text: string) => string): Promise<void> => {
      const doc = await openNote();
      const text = change(doc.getText());
      ownText = text;
      await applyMinimalEdit(doc, text);
      await applyAdopted(doc, text);
      scheduleSave();
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== notes.toString() || e.contentChanges.length === 0) {
        return;
      }
      note = e.document;
      if (e.document.getText() !== ownText) {
        sendNotes();
      }
    });

    const changeDividers = (change: (list: Divider[]) => Divider[]): void =>
      queue(async () => {
        await write((text) => {
          const before = parseDividers(text);
          const after = change(before);
          undoStack.push({ added: [], removed: [], dividers: { before, after } });
          redoStack.length = 0;
          return setDividers(text, after);
        });
        sendNotes();
      });

    let resolveTexts: ((texts: string[]) => void) | undefined;
    const view: PdfView = {
      pdf,
      page: 1,
      pages: 0,
      pageTexts: () =>
        new Promise((resolve) => {
          resolveTexts = resolve;
          panel.webview.postMessage({ type: 'requestPageTexts' });
        }),
      dividers: () => parseDividers(note?.getText() ?? ''),
      editDivider: async (after) => {
        const current = view.dividers().find((d) => d.after === after);
        const value = current ? [current.date, current.title].filter(Boolean).join(' ') : `${today()} `;
        const input = await vscode.window.showInputBox({
          title: `${current ? 'Divider' : 'New divider'} after page ${after}`,
          prompt: 'Date = end of a lecture, title alone = start of an own section; empty removes the divider',
          placeHolder: 'e.g. 2026-10-14 Introduction, or Bayesian uncertainty',
          value,
          valueSelection: current ? undefined : [value.length, value.length],
        });
        if (input === undefined || (!current && !input.trim())) {
          return;
        }
        const [, date, title] = /^(\d{4}-\d{2}-\d{2})?\s*(.*)$/.exec(input.trim())!;
        changeDividers((list) => [...list.filter((d) => d.after !== after), ...(input.trim() ? [{ after, date, title }] : [])]);
      },
      reveal: (after) => {
        panel.reveal();
        panel.webview.postMessage({ type: 'revealDivider', after });
      },
    };
    if (panel.active) {
      this.active = view;
      this.updateContext();
    }
    const viewStateSub = panel.onDidChangeViewState(() => {
      if (panel.active) {
        this.active = view;
        this.updateContext();
      }
    });

    // Claude writes the explanations file directly on disk.
    const readExplanations = async (): Promise<string | undefined> => ((await exists(explanations)) ? readText(explanations) : undefined);
    // Per page: the explanation as stored after the webview's last edit and as the webview sent it,
    // so the file's own formatting doesn't reset the editor.
    const explanationEcho = new Map<number, { stored: string; webview: string }>();
    const ownExplanations = (sections: Section[]): Record<number, string> => {
      const own: Record<number, string> = {};
      for (const [page, e] of explanationEcho) {
        if (pageExplanation(sections, page) === e.stored) {
          own[page] = e.webview;
        }
      }
      return own;
    };
    const sendExplanations = async (): Promise<void> => {
      const sections = parseExplanations((await readExplanations()) ?? '');
      panel.webview.postMessage({ type: 'explanations', sections, own: ownExplanations(sections) });
    };
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(docDir, path.basename(explanations.path)));
    watcher.onDidCreate(sendExplanations);
    watcher.onDidChange(sendExplanations);
    watcher.onDidDelete(sendExplanations);

    // Claude writes its proposed annotations on disk too; only filled ones are shown.
    const proposals = proposalsUri(notes);
    const readProposals = async (): Promise<Proposal[]> => ((await exists(proposals)) ? parseProposals(await readText(proposals)) : []);
    const writeProposals = (list: Proposal[]) => vscode.workspace.fs.writeFile(proposals, Buffer.from(formatProposals(list)));
    const filledProposals = async (): Promise<Proposal[]> => (await readProposals()).filter((p) => p.body);
    const sendProposals = async (): Promise<void> => {
      panel.webview.postMessage({ type: 'proposals', proposals: await filledProposals() });
    };
    const proposalWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(docDir, path.relative(docDir.path, proposals.path)));
    proposalWatcher.onDidCreate(sendProposals);
    proposalWatcher.onDidChange(sendProposals);
    proposalWatcher.onDidDelete(sendProposals);
    const removeProposal = async (id: string): Promise<void> => {
      await writeProposals((await readProposals()).filter((p) => p.id !== id));
      sendProposals();
    };

    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('mdLive.theme')) {
        panel.webview.postMessage({ type: 'theme', theme: getTheme() });
      }
      if (e.affectsConfiguration('mdLive.pdfExplanations') || e.affectsConfiguration('mdLive.pdfExplanationsExpanded')) {
        panel.webview.postMessage({ type: 'showExplanations', show: getShowExplanations(), expand: getExpandExplanations() });
      }
      if (e.affectsConfiguration('mdLive.pdfNotesWidth')) {
        panel.webview.postMessage({ type: 'notesWidth', width: getNotesWidth() });
      }
      if (e.affectsConfiguration('mdLive.fontSize')) {
        panel.webview.postMessage({ type: 'fontSize', fontSize: this.fontSizes.get(pdf) });
      }
      if (e.affectsConfiguration('mdLive.drawingDevice')) {
        panel.webview.postMessage({ type: 'drawingDevice', device: getDrawingDevice() });
      }
    });

    const fontSizeSub = this.fontSizes.onDidChange((uri) => {
      if (uri === pdf.toString()) {
        panel.webview.postMessage({ type: 'fontSize', fontSize: this.fontSizes.get(pdf) });
      }
    });

    panel.onDidDispose(() => {
      changeSub.dispose();
      watcher.dispose();
      proposalWatcher.dispose();
      viewStateSub.dispose();
      if (this.active === view) {
        this.active = undefined;
      }
      configSub.dispose();
      fontSizeSub.dispose();
      clearTimeout(saveTimer);
      queue(async () => {
        if (note?.isDirty) {
          await note.save();
        }
        if (note) {
          await cleanupAssets(note);
        }
      });
    });

    panel.webview.onDidReceiveMessage(async (msg: WebviewMessage) => {
      switch (msg.type) {
        case 'ready':
          panel.webview.postMessage({
            type: 'init',
            pdfUrl: panel.webview.asWebviewUri(pdf).toString(),
            distUri: panel.webview.asWebviewUri(distUri).toString() + '/',
            baseUri: panel.webview.asWebviewUri(docDir).toString() + '/',
            theme: getTheme(),
            fontSize: this.fontSizes.get(pdf),
            notesWidth: getNotesWidth(),
            drawingDevice: getDrawingDevice(),
            sections: sections(),
            dividers: parseDividers(note?.getText() ?? ''),
            explanations: parseExplanations((await readExplanations()) ?? ''),
            ownExplanations: {},
            showExplanations: getShowExplanations(),
            expandExplanations: getExpandExplanations(),
            folds: await loadFolds(notes, {}),
            proposals: await filledProposals(),
          });
          break;
        case 'editNote':
          queue(() =>
            write((text) => {
              const old = parseSections(text).find((s) => s.key === msg.key)?.body ?? '';
              // Unchanged blocks keep their original formatting.
              const body = preserveSource(old, msg.text.trimEnd()).trimEnd();
              echo.set(msg.key, { stored: body, webview: msg.text });
              return setNoteBody(text, msg.key, body);
            }),
          );
          break;
        case 'addNote':
          queue(async () => {
            // Marks the new one was drawn over are replaced by it.
            await write((text) => {
              const removed = parseSections(text).filter((s) => msg.replace.includes(s.key));
              undoStack.push({ added: [{ anchor: msg.anchor, label: msg.label, body: msg.body }], removed: removed.map(noteData) });
              redoStack.length = 0;
              return addNote(msg.replace.reduce(deleteNote, text), msg.anchor, msg.label, msg.body);
            });
            msg.replace.forEach((key) => echo.delete(key));
            sendNotes();
          });
          break;
        case 'deleteNote':
          queue(async () => {
            await write((text) => {
              const section = parseSections(text).find((s) => s.key === msg.key);
              const last = undoStack[undoStack.length - 1];
              // A mark created for a note that stayed empty: as if it was never added.
              if (msg.discard && last?.added.length === 1 && formatAnchor(last.added[0].anchor) === msg.key) {
                undoStack.pop();
              } else if (section?.anchor) {
                undoStack.push({ added: [], removed: [noteData(section)] });
                redoStack.length = 0;
              }
              return deleteNote(text, msg.key);
            });
            echo.delete(msg.key);
            sendNotes();
          });
          break;
        case 'undo':
          queue(async () => {
            const step = (msg.redo ? redoStack : undoStack).pop();
            if (!step) {
              return;
            }
            const [remove, add] = msg.redo ? [step.removed, step.added] : [step.added, step.removed];
            await write((text) => {
              // Notes edited since keep their current text when they are removed (and come back with it).
              const sections = parseSections(text);
              for (const n of remove) {
                const current = sections.find((s) => s.key === formatAnchor(n.anchor));
                if (current) {
                  n.body = current.body;
                }
              }
              const rest = remove.map((n) => formatAnchor(n.anchor)).reduce(deleteNote, text);
              let result = add.reduce((t, n) => addNote(t, n.anchor, n.label, n.body), rest);
              if (step.note) {
                const [from, to] = msg.redo ? [step.note.before, step.note.after] : [step.note.after, step.note.before];
                // Edited since: undoing would drop those edits.
                if (parseSections(result).find((s) => s.key === step.note!.key)?.body === from) {
                  result = setNoteBody(result, step.note.key, to);
                } else {
                  vscode.window.showWarningMessage('The note changed meanwhile; the annotation was not undone.');
                }
              }
              return step.dividers ? setDividers(result, msg.redo ? step.dividers.after : step.dividers.before) : result;
            });
            if (step.explanations) {
              const [from, to] = msg.redo ? [step.explanations.before, step.explanations.after] : [step.explanations.after, step.explanations.before];
              // Claude may have written the file since; then restoring the old text would drop that.
              if (((await readExplanations()) ?? '') === from) {
                await vscode.workspace.fs.writeFile(explanations, Buffer.from(to));
              } else {
                vscode.window.showWarningMessage('The explanations file changed meanwhile; the explanation was not restored.');
              }
            }
            const changed = [...remove, ...add].map((n) => formatAnchor(n.anchor)).concat(step.note ? [step.note.key] : []);
            changed.forEach((key) => echo.delete(key));
            (msg.redo ? undoStack : redoStack).push(step);
            sendNotes(changed);
          });
          break;
        case 'view':
          view.page = msg.page;
          view.pages = msg.pages;
          break;
        case 'pageTexts':
          resolveTexts?.(msg.texts);
          resolveTexts = undefined;
          break;
        case 'deleteExplanation':
          queue(async () => {
            const text = (await readExplanations()) ?? '';
            const after = setExplanation(text, msg.page, '');
            if (after !== text) {
              undoStack.push({ added: [], removed: [], explanations: { before: text, after } });
              redoStack.length = 0;
              await vscode.workspace.fs.writeFile(explanations, Buffer.from(after));
            }
          });
          break;
        case 'editExplanation':
          // Edited in its card (own text, highlights, deletions); unchanged blocks keep their source.
          // Typing has the editor's own undo; only highlighting the collapsed key message is a step.
          queue(async () => {
            const text = (await readExplanations()) ?? '';
            const old = pageExplanation(parseExplanations(text), msg.page);
            const after = setExplanation(text, msg.page, preserveSource(old, msg.text.trimEnd()).trimEnd());
            explanationEcho.set(msg.page, { stored: pageExplanation(parseExplanations(after), msg.page), webview: msg.text });
            if (after !== text) {
              if (msg.undoable) {
                undoStack.push({ added: [], removed: [], explanations: { before: text, after } });
                redoStack.length = 0;
              }
              await vscode.workspace.fs.writeFile(explanations, Buffer.from(after));
            }
          });
          break;
        case 'acceptProposal':
          queue(async () => {
            const proposal = (await readProposals()).find((p) => p.id === msg.id);
            if (!proposal?.body) {
              return;
            }
            if (proposal.explanation) {
              const text = (await readExplanations()) ?? '';
              const old = pageExplanation(parseExplanations(text), proposal.page);
              const after = setExplanation(text, proposal.page, insertAnnotation(old, proposal.quote, proposal.body, { mark: false, replace: proposal.replace }));
              if (after === text) {
                vscode.window.showWarningMessage(`Page ${proposal.page} has no explanation to add the annotation to.`);
                return;
              }
              undoStack.push({ added: [], removed: [], explanations: { before: text, after } });
              redoStack.length = 0;
              await vscode.workspace.fs.writeFile(explanations, Buffer.from(after));
            } else {
              const before = parseSections(note?.getText() ?? '').find((s) => s.key === proposal.key)?.body;
              if (before === undefined && !proposal.key.startsWith('page:')) {
                // A selected passage without a mark yet: a new note on it.
                const data = { anchor: parseAnchor(proposal.key), label: proposal.quote, body: insertAnnotation('', '', proposal.body, { mark: true, replace: false }) };
                await write((text) => addNote(text, data.anchor, data.label, data.body));
                undoStack.push({ added: [data], removed: [] });
                redoStack.length = 0;
                sendNotes([proposal.key]);
                await removeProposal(proposal.id);
                return;
              }
              const after = insertAnnotation(before ?? '', proposal.quote, proposal.body, { mark: true, replace: proposal.replace });
              await write((text) => setNoteBody(text, proposal.key, after));
              undoStack.push({ added: [], removed: [], note: { key: proposal.key, before: before ?? '', after } });
              redoStack.length = 0;
              echo.delete(proposal.key);
              sendNotes([proposal.key]);
            }
            await removeProposal(proposal.id);
          });
          break;
        case 'rejectProposal':
          queue(() => removeProposal(msg.id));
          break;
        case 'editDivider':
          await view.editDivider(msg.after);
          break;
        case 'deleteDivider':
          changeDividers((list) => list.filter((d) => d.after !== msg.after));
          break;
        case 'folds':
          queue(() => saveFolds(notes, msg.folds));
          break;
        case 'saveImage': {
          const relPath = await saveImage(notes, msg.name, msg.mime, msg.data);
          panel.webview.postMessage({ type: 'imageSaved', id: msg.id, path: relPath });
          break;
        }
        case 'drawRemote': {
          const file = await this.drawingServer.draw(msg.drawing, { note: notes.toString(), src: msg.src });
          const path = file ? await saveImage(notes, file.name, file.mime, file.data) : null;
          panel.webview.postMessage({ type: 'drawingSaved', id: msg.id, path });
          break;
        }
        case 'selection':
          await editQueue;
          if (!note) {
            vscode.window.showWarningMessage('This PDF has no notes yet.');
            return;
          }
          // Claude reads the file from disk.
          await note.save();
          await sendSelectionToClaude(note, panel, msg.text);
          break;
        case 'askClaude': {
          await editQueue;
          if (note?.isDirty) {
            await note.save();
          }
          // Every question gets a proposed annotation: in the explanation, in the note (card or mark)
          // asked about, as a new note on the selected passage, else in the page note.
          const id = `q${Date.now()}`;
          const key = msg.explanation
            ? pageKey(msg.page)
            : (msg.key ?? (msg.rects ? formatAnchor({ page: msg.page, rects: msg.rects, area: false, color: msg.color ?? 'yellow' }) : pageKey(msg.page)));
          const mark = parseSections(note?.getText() ?? '').find((s) => s.key === key && s.anchor && !s.anchor.area);
          const proposal: Proposal = { id, page: msg.page, key, explanation: !!msg.explanation, quote: msg.quote ?? mark?.label ?? '', body: '', replace: false };
          const kept = (await readProposals()).filter((p) => p.body || Date.now() - Number(p.id.slice(1)) < EMPTY_PROPOSAL_MS);
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(proposals, '..'));
          await writeProposals([...kept, proposal]);
          const context = claudeContext(pdf, note?.getText(), await readExplanations(), msg, { id, file: proposals });
          const drawing = (await claudeDrawingLines(notes, msg.drawings ?? [])).join('\n');
          const file = await writeClaudeContext(notes, drawing ? `${context}${drawing}\n` : context);
          await sendSelectionToClaude(await vscode.workspace.openTextDocument(file), panel, '');
          break;
        }
      }
    });
  }

  private getHtml(webview: vscode.Webview, distUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'pdf.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, 'pdf.css'));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: http: data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      // The PDF, pdf.js' worker and its font/CMap data, drawings (embedded strokes).
      `connect-src ${webview.cspSource}`,
      // pdf.js' worker is started from a blob, since the webview can't load workers from resource URIs.
      'worker-src blob:',
      `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
</head>
<body>
  <div id="viewer"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// Tells Claude where the question points (page, passage or mark) and which pages to read, so it
// loads only those pages of the PDF; the notes on that page are included.
function claudeContext(
  pdf: vscode.Uri,
  notesText: string | undefined,
  explanationsText: string | undefined,
  { page, quote, rects, key, note, explanation }: { page: number; quote?: string; rects?: Rect[]; key?: string; note?: boolean; explanation?: boolean },
  proposal?: { id: string; file: vscode.Uri },
): string {
  const rel = (uri: vscode.Uri) => vscode.workspace.asRelativePath(uri, false);
  const sections = parseSections(notesText ?? '').filter((s) => s.page === page && (s.anchor || s.body.trim()));
  const mark = sections.find((s) => s.key === key);
  const lines = [
    `# Question about \`${rel(pdf)}\`, page ${page}`,
    '',
    `Read only the pages you need from \`${rel(pdf)}\` (Read tool with \`pages\`): page ${page} first, other pages only if the question needs them.`,
  ];
  if (notesText !== undefined) {
    lines.push(
      `My notes on the whole PDF are in \`${rel(notesUri(pdf))}\`: \`## Page N\` is a note on page N, \`### [quote](#pN=x,y,w,h;…)\` a note on a marked passage (or area, \`&area\`) of page N, rectangles as fractions of the page from the top left.`,
    );
  }
  // The position tells apart passages that occur more than once on the page.
  const anchor = rects ? formatAnchor({ page, rects, area: false, color: 'yellow' }) : mark?.key;
  if (explanation) {
    lines.push(
      '',
      '## Your explanation in question',
      '',
      quote
        ? `The question is about this passage of your explanation of page ${page} (full explanation below):\n\n> ${quote}`
        : `The question is about your explanation of page ${page} (below).`,
    );
  }
  const passage = explanation || note ? undefined : (quote ?? (mark?.anchor?.area ? undefined : mark?.label));
  if (passage) {
    lines.push('', '## Marked passage', '', `> ${passage}`, '', `Position: \`#${anchor}\``);
  }
  if (mark?.anchor?.area) {
    lines.push('', '## Marked area', '', `\`#${mark.key}\` on page ${page}; its snapshot is the image at the start of that note below.`);
  }
  if (note && mark) {
    const heading = mark.anchor ? `### [${mark.label}](#${mark.key})` : `## Page ${page}`;
    const about = quote ? `this passage of my note \`${heading}\` (full note below):\n\n> ${quote}` : `my note \`${heading}\`:`;
    lines.push('', '## My note in question', '', `The question is about ${about}`, '', fenced(mark.body));
  }
  if (sections.length > 0) {
    lines.push(
      '',
      `## My notes on page ${page}`,
      '',
      `Excerpt from \`${rel(notesUri(pdf))}\` (image paths are relative to its folder):`,
      '',
      fenced(sections.map((s) => notesText!.slice(s.start, s.end).trim()).join('\n\n')),
    );
  }
  const explained = parseExplanations(explanationsText ?? '').filter((s) => s.page === page && s.body.trim());
  if (explained.length > 0) {
    lines.push(
      '',
      `## Your earlier explanations of page ${page}`,
      '',
      `Excerpt from \`${rel(explanationsUri(pdf))}\` (italic text there is mine, the rest is yours):`,
      '',
      fenced(explained.map((s) => explanationsText!.slice(s.start, s.end).trim()).join('\n\n')),
    );
  }
  if (proposal) {
    const bullet = explanation || note;
    const target = quote ? (bullet ? 'the bullet in question' : 'the marked passage') : explanation ? 'your explanation' : note || mark ? 'my note' : `page ${page}`;
    const where = explanation ? 'your explanation' : mark || note ? 'my note' : quote ? 'my notes as a note on that passage' : `my note on page ${page}`;
    lines.push(
      '',
      '## Proposed annotation',
      '',
      `After answering in the chat, propose an annotation on ${target}: write it into \`${rel(proposal.file)}\`, in section \`## ${proposal.id}\` below ${quote ? 'the quoted line' : 'its heading'} (Edit tool, change nothing else in that file). Once I accept it, it is added to ${where}${quote && bullet ? ' as a sub-bullet below that bullet' : ''}${explanation ? '' : ', marked as written by you'}.${quote && bullet ? ' If I ask you to change, correct or rephrase that bullet instead, write `REPLACE` on its own line followed by the new version of the bullet (in the format below, its sub-bullets included); accepted, it replaces the bullet with its sub-bullets.' : ''}`,
      '',
      'Keep it short: only what your answer adds, in German like the explanations (technical terms in English), no repetition of what it annotates, no heading, no italics (italic text is mine). Format: one short line; when it covers several things (terms, cases, steps, examples), that line as a lead-in followed by a Markdown bullet list, one point per bullet. If the answer adds nothing worth keeping, leave the section empty.',
    );
  }
  return lines.join('\n').trimEnd() + '\n';
}

// A code fence longer than any backtick run inside, so the notes' own headings and fences stay quoted.
function fenced(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}markdown\n${text}\n${fence}`;
}

// Local date as YYYY-MM-DD.
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getShowExplanations(): boolean {
  return vscode.workspace.getConfiguration('mdLive').get<boolean>('pdfExplanations', true);
}

function getExpandExplanations(): boolean {
  return vscode.workspace.getConfiguration('mdLive').get<boolean>('pdfExplanationsExpanded', false);
}

async function readText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

function getNotesWidth(): number {
  return vscode.workspace.getConfiguration('mdLive').get<number>('pdfNotesWidth', 360);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  return vscode.workspace.fs.stat(uri).then(
    () => true,
    () => false,
  );
}
