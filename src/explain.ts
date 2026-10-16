import { type ChildProcess, spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { explanationsUri } from './assets';
import { parseExplanations } from './sidecar';

// Slides explained per run by default.
const CHUNK = 10;
// Characters of each page's text sent along for choosing pages by topic.
const PAGE_TEXT_LENGTH = 400;

// The state of a PDF view the explain command acts on.
export type PdfView = {
  pdf: vscode.Uri;
  // Page taking up most of the window, and the page count (from the webview).
  page: number;
  pages: number;
  pageTexts: () => Promise<string[]>;
};

const running = new Map<string, ChildProcess>();

export function isExplaining(pdf: vscode.Uri): boolean {
  return running.has(pdf.toString());
}

// `5, 6, 7, 9` → `5–7, 9`.
function formatPages(pages: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) {
      j++;
    }
    parts.push(i === j ? `${pages[i]}` : `${pages[i]}–${pages[j]}`);
    i = j;
  }
  return parts.join(', ');
}

// `5-7, 9` → [5, 6, 7, 9]; undefined if it doesn't parse.
function parsePages(input: string, count: number): number[] | undefined {
  const pages = new Set<number>();
  for (const part of input.split(/[,;\s]+/).filter(Boolean)) {
    const match = /^(\d+)(?:[-–](\d+))?$/.exec(part);
    if (!match) {
      return undefined;
    }
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    for (let p = from; p <= Math.min(to, count); p++) {
      pages.add(p);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

async function readText(uri: vscode.Uri): Promise<string> {
  return vscode.workspace.fs.readFile(uri).then(
    (data) => new TextDecoder().decode(data),
    () => '',
  );
}

type Choice = vscode.QuickPickItem & { run: () => Promise<string | undefined> };

// Lets the user pick which slides Claude explains (next chunk, a page range, a topic or all
// unexplained ones) and runs Claude Code in the background; the PDF view shows the explanations as
// soon as Claude writes them.
export async function explainSlides(view: PdfView, onRunningChange: () => void): Promise<void> {
  const key = view.pdf.toString();
  const current = running.get(key);
  if (current) {
    if (await vscode.window.showWarningMessage('Claude is still explaining slides of this PDF.', 'Stop')) {
      current.kill();
    }
    return;
  }
  const file = explanationsUri(view.pdf);
  const explained = new Set(parseExplanations(await readText(file)).map((s) => s.page));
  const open = Array.from({ length: view.pages }, (_, i) => i + 1).filter((p) => !explained.has(p));
  const ahead = open.filter((p) => p >= view.page);
  const next = (ahead.length > 0 ? ahead : open).slice(0, CHUNK);
  const pdfName = path.basename(view.pdf.fsPath);
  const fileName = path.basename(file.fsPath);
  const pagesPrompt = (pages: number[]) =>
    `Use the explain-slides skill: explain pages ${pages.join(', ')} of "${pdfName}" and add them to "${fileName}" ` +
    'in ascending page order; keep everything already in that file unchanged.';

  const choices: Choice[] = [];
  if (next.length > 0) {
    choices.push({
      label: `$(sparkle) Explain slides ${formatPages(next)}`,
      description: `next ${next.length} unexplained`,
      run: async () => pagesPrompt(next),
    });
  }
  choices.push({
    label: '$(list-ordered) Explain pages…',
    run: async () => {
      const input = await vscode.window.showInputBox({ prompt: `Pages to explain (1–${view.pages})`, placeHolder: 'e.g. 5-12, 20' });
      const pages = input === undefined ? undefined : parsePages(input, view.pages);
      if (input !== undefined && !pages?.length) {
        vscode.window.showWarningMessage(`"${input}" is not a page range like 5-12, 20.`);
      }
      return pages?.length ? pagesPrompt(pages) : undefined;
    },
  });
  choices.push({
    label: '$(search) Explain slides about…',
    run: async () => {
      const topic = await vscode.window.showInputBox({ prompt: 'Which slides should Claude explain?', placeHolder: 'e.g. everything about the Internet worm' });
      if (!topic?.trim()) {
        return undefined;
      }
      // The page texts let Claude pick the pages without reading the whole PDF.
      const texts = (await view.pageTexts()).map((t, i) => `--- Page ${i + 1} ---\n${t.slice(0, PAGE_TEXT_LENGTH)}`);
      return (
        `Use the explain-slides skill for "${pdfName}", but only for the slides about: ${topic.trim()}\n` +
        `Choose those slides from the page texts below (physical page numbers) and read only them. ` +
        `Skip pages already in "${fileName}"${explained.size > 0 ? ` (${formatPages([...explained].sort((a, b) => a - b))})` : ''}; ` +
        'add the new pages in ascending page order and keep everything already in that file unchanged.\n\n' +
        texts.join('\n\n')
      );
    },
  });
  if (open.length > next.length) {
    choices.push({ label: '$(files) Explain all unexplained slides', description: `${open.length} slides`, run: async () => pagesPrompt(open) });
  }

  const choice = await vscode.window.showQuickPick(choices, { placeHolder: `Claude explains slides of ${pdfName}` });
  const prompt = await choice?.run();
  if (!prompt) {
    return;
  }
  await vscode.workspace.getConfiguration('mdLive').update('pdfExplanations', true, vscode.ConfigurationTarget.Global);
  await run(view.pdf, file, prompt, onRunningChange);
}

async function run(pdf: vscode.Uri, file: vscode.Uri, prompt: string, onRunningChange: () => void): Promise<void> {
  // Claude may read anything but only write the explanations file (`//` = absolute path; Edit rules
  // cover all file-writing tools).
  const tools = ['Read', 'Skill', `Edit(/${file.fsPath})`].join(',');
  // VS Code started from the Dock doesn't see the shell's PATH.
  const home = os.homedir();
  const env = { ...process.env, PATH: [process.env.PATH, `${home}/.local/bin`, `${home}/.claude/local`, '/opt/homebrew/bin', '/usr/local/bin'].join(':') };
  const child = spawn('claude', ['-p', '--allowedTools', tools], { cwd: path.dirname(pdf.fsPath), env });
  const key = pdf.toString();
  running.set(key, child);
  onRunningChange();
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.end(prompt);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Claude is explaining slides of ${path.basename(pdf.fsPath)}…`, cancellable: true },
    (_, token) =>
      new Promise<void>((resolve) => {
        token.onCancellationRequested(() => child.kill());
        child.on('error', (e) => {
          vscode.window.showWarningMessage(`Could not start Claude Code (claude): ${e.message}`);
          resolve();
        });
        child.on('close', (code, signal) => {
          if (code !== 0 && !signal) {
            vscode.window.showWarningMessage(`Claude stopped explaining (exit code ${code}): ${stderr.slice(-300)}`);
          }
          resolve();
        });
      }),
  );
  running.delete(key);
  onRunningChange();
}
