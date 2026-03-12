import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(packageDir, '..', '..');
const distDir = path.join(packageDir, 'dist');

rmSync(distDir, { force: true, recursive: true });

const tsc = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['exec', 'tsc', '-p', 'tsconfig.json'],
  {
    cwd: packageDir,
    stdio: 'inherit',
  },
);

if (tsc.status !== 0) {
  process.exit(tsc.status ?? 1);
}

mkdirSync(path.join(distDir, 'assets'), { recursive: true });
copyFileSync(
  path.join(packageDir, 'src', 'huddle-ui.swift'),
  path.join(distDir, 'huddle-ui.swift'),
);
copyFileSync(
  path.join(repoRoot, 'assets', 'huddle-ring.mp3'),
  path.join(distDir, 'assets', 'huddle-ring.mp3'),
);
