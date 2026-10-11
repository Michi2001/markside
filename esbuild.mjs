import * as esbuild from 'esbuild';

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

if (watch) {
  for (const config of configs) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
  }
  console.log('Watching...');
} else {
  await Promise.all(configs.map((config) => esbuild.build(config)));
}
