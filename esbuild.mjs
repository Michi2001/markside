import * as esbuild from 'esbuild';
import { cpSync } from 'fs';

const watch = process.argv.includes('--watch');

const configs = [
  {
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    sourcemap: true,
  },
  {
    entryPoints: ['src/webview/main.ts'],
    bundle: true,
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: !watch,
    sourcemap: watch,
    loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
    assetNames: 'assets/[name]-[hash]',
  },
  {
    // PDF view with notes (src/pdfEditor.ts).
    entryPoints: ['src/webview/pdf/main.ts'],
    bundle: true,
    outfile: 'dist/pdf.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: !watch,
    sourcemap: watch,
    loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
    assetNames: 'assets/[name]-[hash]',
  },
  {
    // Drawing page for the iPad, served by src/drawingServer.ts.
    entryPoints: ['src/ipad/main.ts'],
    bundle: true,
    outfile: 'dist/ipad.js',
    platform: 'browser',
    format: 'iife',
    target: 'safari16',
    minify: !watch,
  },
];

// pdf.js loads its worker, CMaps, standard fonts and image decoders at runtime.
const pdfjs = 'node_modules/pdfjs-dist';
cpSync(`${pdfjs}/build/pdf.worker.min.mjs`, 'dist/pdf.worker.min.mjs');
for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
  cpSync(`${pdfjs}/${dir}`, `dist/pdfjs/${dir}`, { recursive: true });
}

if (watch) {
  for (const config of configs) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
  }
  console.log('Watching...');
} else {
  await Promise.all(configs.map((config) => esbuild.build(config)));
}
