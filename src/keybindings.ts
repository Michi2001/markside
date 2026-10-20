import * as fs from 'fs';
import * as path from 'path';

// VS Code's "Go Back"/"Go Forward" keys (with the user's own bindings from keybindings.json), so
// the webviews' search can jump back to where it started with the same keys. The API doesn't expose
// keybindings, hence the file.

export type NavigationKeys = { back: string[]; forward: string[] };

let file = '';

// keybindings.json lies next to globalStorage in the user folder.
export function setKeybindingsFile(globalStorage: string): void {
  file = path.resolve(globalStorage, '..', '..', 'keybindings.json');
}

// Removes comments and trailing commas (keybindings.json is JSONC); strings stay untouched.
function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = i;
      const str = end.exec(text)?.[0] ?? c;
      out += str;
      i += str.length - 1;
    } else if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i) - 1;
      if (i < 0) {
        break;
      }
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i) + 1;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[\]}])/g, '$1');
}

export function navigationKeys(): NavigationKeys {
  const mac = process.platform === 'darwin';
  const keys: NavigationKeys = { back: [mac ? 'ctrl+-' : 'alt+left'], forward: [mac ? 'ctrl+shift+-' : 'alt+right'] };
  if (!fs.existsSync(file)) {
    return keys;
  }
  const bindings: { key: string; command: string }[] = JSON.parse(stripJsonc(fs.readFileSync(file, 'utf8')) || '[]');
  for (const { key, command } of bindings) {
    const removed = command.startsWith('-');
    const name = command.replace(/^-/, '');
    const list = name === 'workbench.action.navigateBack' ? keys.back : name === 'workbench.action.navigateForward' ? keys.forward : undefined;
    if (list && removed) {
      list.splice(0, list.length, ...list.filter((k) => k !== key));
    } else if (list) {
      list.push(key);
    }
  }
  return keys;
}
