import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(packageDir, '..', '..');
const releaseDir = path.join(packageDir, 'release');
const appDir = path.join(releaseDir, 'app');
const distDir = path.join(appDir, 'dist');
const binDir = path.join(appDir, 'bin');
const assetsDir = path.join(appDir, 'assets');
const supportDir = path.join(appDir, 'support');
const tempDir = path.join(releaseDir, '.tmp');
const packageJson = JSON.parse(
  readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
);
const version = packageJson.version;
const helperInfoPlistPath = path.join(supportDir, 'huddle-ui-Info.plist');
const helperBinaryPath = path.join(binDir, 'huddle-ui');
const launcherPath = path.join(supportDir, 'huddle-launcher');
const bundledCliPath = path.join(distDir, 'huddle.js');

rmSync(appDir, { force: true, recursive: true });
rmSync(tempDir, { force: true, recursive: true });

mkdirSync(distDir, { recursive: true });
mkdirSync(binDir, { recursive: true });
mkdirSync(assetsDir, { recursive: true });
mkdirSync(supportDir, { recursive: true });
mkdirSync(tempDir, { recursive: true });

runCommand(
  pnpmCommand(),
  [
    'exec',
    'esbuild',
    path.join('src', 'huddle.ts'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node22.14',
    '--outfile=release/app/dist/huddle.js',
  ],
  {
    cwd: packageDir,
  },
);
writeFileSync(
  bundledCliPath,
  `#!/usr/bin/env node\n${readFileSync(bundledCliPath, 'utf8')
    .replace(/^(#!.*\n)+/, '')
    .replace(/^\n+/, '')}`,
  'utf8',
);
chmodSync(bundledCliPath, 0o755);

copyFileSync(
  path.join(repoRoot, 'assets', 'huddle-ring.mp3'),
  path.join(assetsDir, 'huddle-ring.mp3'),
);
writeFileSync(
  path.join(appDir, 'package.json'),
  `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
  'utf8',
);
writeFileSync(path.join(appDir, 'VERSION'), `${version}\n`, 'utf8');
writeFileSync(helperInfoPlistPath, createHelperInfoPlist(version), 'utf8');
writeFileSync(launcherPath, createLauncherScript(), 'utf8');
chmodSync(launcherPath, 0o755);

buildUniversalHelper({
  infoPlistPath: helperInfoPlistPath,
  outputPath: helperBinaryPath,
  tempDir,
});

const helperSigningIdentity = process.env.APPLE_APPLICATION_IDENTITY?.trim();
if (helperSigningIdentity) {
  runCommand('codesign', [
    '--force',
    '--sign',
    helperSigningIdentity,
    '--options',
    'runtime',
    helperBinaryPath,
  ]);
} else {
  runCommand('codesign', [
    '--force',
    '--sign',
    '-',
    '--timestamp=none',
    helperBinaryPath,
  ]);
}

process.stdout.write(`Built release assets in ${appDir}\n`);

function buildUniversalHelper(input) {
  const sdkPath = runCommand('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], {
    capture: true,
  }).trim();
  const archOutputs = [];

  for (const arch of ['arm64', 'x86_64']) {
    const archOutput = path.join(input.tempDir, `huddle-ui-${arch}`);
    runCommand('xcrun', [
      'swiftc',
      '-O',
      '-sdk',
      sdkPath,
      '-target',
      `${arch}-apple-macos12.0`,
      '-framework',
      'AppKit',
      '-framework',
      'AVFoundation',
      path.join(packageDir, 'src', 'huddle-ui.swift'),
      '-o',
      archOutput,
      '-Xlinker',
      '-sectcreate',
      '-Xlinker',
      '__TEXT',
      '-Xlinker',
      '__info_plist',
      '-Xlinker',
      input.infoPlistPath,
    ]);
    archOutputs.push(archOutput);
  }

  runCommand('xcrun', [
    'lipo',
    '-create',
    '-output',
    input.outputPath,
    ...archOutputs,
  ]);
  chmodSync(input.outputPath, 0o755);
}

function createHelperInfoPlist(versionValue) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>huddle-ui</string>
  <key>CFBundleIdentifier</key>
  <string>run.huddle.huddle-ui</string>
  <key>CFBundleName</key>
  <string>Huddle UI</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${versionValue}</string>
  <key>CFBundleVersion</key>
  <string>${versionValue}</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Huddle records your spoken replies so it can send them back to the CLI.</string>
</dict>
</plist>
`;
}

function createLauncherScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

SOURCE_PATH="\${BASH_SOURCE[0]}"
while [[ -L "$SOURCE_PATH" ]]; do
  SOURCE_DIR="$(cd "$(dirname "$SOURCE_PATH")" && pwd)"
  SOURCE_PATH="$(readlink "$SOURCE_PATH")"
  [[ "$SOURCE_PATH" != /* ]] && SOURCE_PATH="$SOURCE_DIR/$SOURCE_PATH"
done

INSTALL_DIR="$(cd "$(dirname "$SOURCE_PATH")/.." && pwd)"

if [[ ! -f "$INSTALL_DIR/dist/huddle.js" ]]; then
  echo "Huddle is not installed correctly. Reinstall Huddle and try again." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Huddle requires Node.js 22.14 or newer. Install Node, then run huddle again." >&2
  exit 1
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major > 22 || (major === 22 && minor >= 14)) process.exit(0); process.exit(1);'; then
  echo "Huddle requires Node.js 22.14 or newer. Current version: $(node -p 'process.versions.node')" >&2
  exit 1
fi

exec node "$INSTALL_DIR/dist/huddle.js" "$@"
`;
}

function pnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? packageDir,
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  if (options.capture) {
    return result.stdout ?? '';
  }

  return '';
}
