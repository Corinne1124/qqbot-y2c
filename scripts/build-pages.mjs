/**
 * 构建 Cloudflare Pages 高级模式所需的 dist/_worker.js
 * - 单文件 ESM，无外部 import
 * - 直接复用 src/index.ts，业务逻辑零改动
 */
import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

rmSync(outDir, { recursive: true, force: true });

execFileSync(process.execPath, [
  tsc,
  join(root, 'src', 'index.ts'),
  '--outDir', outDir,
  '--module', 'esnext',
  '--target', 'es2022',
  '--lib', 'esnext',
  '--types', '@cloudflare/workers-types',
  '--skipLibCheck',
  '--strict',
], { stdio: 'inherit', cwd: root });

const emitted = join(outDir, 'index.js');
const target = join(outDir, '_worker.js');

if (!existsSync(emitted)) {
  console.error('build failed: dist/index.js was not emitted');
  process.exit(1);
}

renameSync(emitted, target);
console.log('built dist/_worker.js');
