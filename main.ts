// RINGFALL — round-based tactical FPS aboard the Vesper Ring.
//
// The entry point the make.fun scorer runs: it stages this directory's
// game/ folder and screenshots/ into the output directory and writes
// /output/dossier.json, the summary the judge reads, with the vendored
// make.fun library. The game itself is plain static files the browser loads
// as ES modules, three.js 0.187.0 from the import map in game/index.html.
//
// Serve it locally with `node serve.ts`, then open http://localhost:8080.
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const gameDir = join(here, 'game');
const shotsDir = join(here, 'screenshots');

// ---------- preflight: fail loudly here, not inside the scorer ----------
function fail(message: string): never {
  throw new Error(`RINGFALL entry build: ${message}`);
}
if (!existsSync(join(gameDir, 'index.html'))) fail('game/index.html is missing');
if (!existsSync(join(gameDir, 'src', 'main.js'))) fail('game/src/main.js is missing');
if (!existsSync(join(gameDir, 'vendor', 'three', 'three.module.min.js'))) fail('vendored three.js module is missing');
if (!existsSync(shotsDir)) fail('screenshots/ is missing');
// The import map is the game's only dependency link: the entry is dead in
// the browser if "three" points at a file that is not staged, and the
// module script is the only thing that boots the game.
const html = readFileSync(join(gameDir, 'index.html'), 'utf8');
const importMap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
if (!importMap) fail('game/index.html has no import map');
let threePath: string;
try {
  threePath = (JSON.parse(importMap[1]) as { imports?: Record<string, string> }).imports?.['three'] ?? '';
} catch {
  fail('game/index.html import map is not valid JSON');
}
if (!threePath || !existsSync(join(gameDir, threePath.replace(/^\.\//, '')))) fail(`import map "three" -> "${threePath}" does not resolve inside game/`);
if (!/<script type="module" src="\.\/src\/main\.js"><\/script>/.test(html)) fail('game/index.html does not boot ./src/main.js as a module');
// Every HUD id the JS queries must exist in the shell, or initHud silently
// wires a null element and the match breaks at runtime.
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
for (const src of readdirSync(join(gameDir, 'src')).filter((f) => f.endsWith('.js'))) {
  const js = readFileSync(join(gameDir, 'src', src), 'utf8');
  for (const m of js.matchAll(/getElementById\('([^']+)'\)/g)) {
    if (!htmlIds.has(m[1])) fail(`${src} queries #${m[1]} but game/index.html has no such id`);
  }
}
const shots = readdirSync(shotsDir).filter((f) => /\.(png|jpe?g)$/i.test(f));
if (shots.length < 3 || shots.length > 4) fail(`screenshots/ holds ${shots.length} images, the bounty wants 3 or 4`);
for (const f of shots) {
  if (statSync(join(shotsDir, f)).size > 262144) fail(`screenshots/${f} is over the 256 KiB cap`);
}

// ---------- stage the game and the screenshots ----------
mkdirSync(out, { recursive: true });
cpSync(gameDir, join(out, 'game'), { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });
cpSync(shotsDir, join(out, 'screenshots'), { recursive: true });

// ---------- the dossier ----------
const dossierPath = join(out, 'dossier.json');
// The scorer's own caps (reference/gate.json): only text_max_bytes shapes the bytes; the others refuse an entry the
// scorer would refuse (more than 4 screenshots or one over 256 KiB; more than 993 files in game/ or 48 MiB of game
// files, in all: game/ counts beside /output's own 1000-entry cap, its screenshots/ and dossier.json).
writeFileSync(
  dossierPath,
  buildDossier(out, { text_max_bytes: 163840, screenshots: { max: 4, max_bytes: 262144 }, game_max_files: 993, game_max_bytes: 50331648 }),
);

// ---------- build summary: prove the staged entry is what we hand in ----------
const dossier = JSON.parse(readFileSync(dossierPath, 'utf8')) as { schema?: string; text?: string; images?: unknown[] };
if (dossier.schema !== 'makefun/dossier/v1') fail('dossier.json came back with an unexpected schema');
const staged = readdirSync(join(out, 'game'), { recursive: true }) as string[];
// The staged tree must be a faithful copy of the source tree: same files,
// same bytes, nothing left behind and nothing extra smuggled in.
const sourceFiles: string[] = [];
(function walk(rel: string): void {
  for (const e of readdirSync(join(gameDir, rel), { withFileTypes: true })) {
    const p = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else sourceFiles.push(p);
  }
})('');
const stagedFiles = staged.filter((p) => statSync(join(out, 'game', p)).isFile());
const missing = sourceFiles.filter((f) => !stagedFiles.includes(f));
const extra = stagedFiles.filter((f) => !sourceFiles.includes(f));
if (missing.length || extra.length) fail(`staged game/ diverges from source (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
console.log(`RINGFALL staged: ${staged.length} game entries, ${shots.length} screenshots, dossier ${statSync(dossierPath).size} bytes`);
console.log(`dossier text: ${(dossier.text ?? '').length} chars, images: ${Array.isArray(dossier.images) ? dossier.images.length : 0}`);
// Per-kind file counts, so a bad stage (a missing module, a stray file)
// is visible in the log without opening the output tree.
const byExt = new Map<string, number>();
for (const f of stagedFiles) {
  const ext = f.includes('.') ? f.slice(f.lastIndexOf('.')) : '(no ext)';
  byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
}
console.log(`staged by kind: ${[...byExt.entries()].sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e}×${n}`).join(', ')}`);
console.log(`import map ok: "three" -> ${readFileSync(join(gameDir, 'index.html'), 'utf8').match(/"three":\s*"([^"]+)"/)?.[1] ?? '?'}`);
