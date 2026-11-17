import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const out = 'dist';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const copyStatic = () => {
  fs.copyFileSync('index.html', path.join(out, 'index.html'));
  for (const f of fs.readdirSync('public')) fs.copyFileSync(path.join('public', f), path.join(out, f));
};

const options = {
  entryPoints: { app: 'src/main.jsx' },
  bundle: true, outdir: out, format: 'esm', target: 'es2020', jsx: 'automatic',
  minify: !watch, sourcemap: watch ? 'inline' : false, logLevel: 'info',
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
};

copyStatic();
if (watch) {
  const ctx = await esbuild.context({ ...options, plugins: [{ name: 'copy', setup: (b) => b.onEnd(copyStatic) }] });
  await ctx.watch();
  console.log('Observando cambios… (el backend sirve /frontend/dist)');
} else {
  await esbuild.build(options);
}
