import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');
const releaseDir = path.join(packageDir, 'release');
const appDir = path.join(releaseDir, 'app');
const pkgRoot = path.join(releaseDir, 'pkgroot');
const pkgScriptsDir = path.join(releaseDir, 'pkg-scripts');
const artifactsDir = path.join(releaseDir, 'artifacts');
const intermediatesDir = path.join(releaseDir, 'intermediates');
const version = JSON.parse(
  readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
).version;
const installBase = path.posix.join('/usr/local/lib/huddle', version);
const componentPkgPath = path.join(
  intermediatesDir,
  `Huddle-${version}-component.pkg`,
);
const finalPkgPath = path.join(artifactsDir, `Huddle-${version}.pkg`);
const checksumPath = `${finalPkgPath}.sha256`;

runCommand('node', [path.join('scripts', 'build-release.mjs')]);

rmSync(pkgRoot, { force: true, recursive: true });
rmSync(pkgScriptsDir, { force: true, recursive: true });
rmSync(intermediatesDir, { force: true, recursive: true });
rmSync(finalPkgPath, { force: true });
rmSync(checksumPath, { force: true });

mkdirSync(path.join(pkgRoot, installBase.slice(1)), { recursive: true });
mkdirSync(pkgScriptsDir, { recursive: true });
mkdirSync(artifactsDir, { recursive: true });
mkdirSync(intermediatesDir, { recursive: true });

cpSync(appDir, path.join(pkgRoot, installBase.slice(1)), { recursive: true });
writeFileSync(
  path.join(pkgScriptsDir, 'postinstall'),
  createPostinstallScript(version),
  'utf8',
);
runCommand('chmod', ['755', path.join(pkgScriptsDir, 'postinstall')]);

runCommand('pkgbuild', [
  '--root',
  pkgRoot,
  '--scripts',
  pkgScriptsDir,
  '--identifier',
  process.env.HUDDLE_PKG_IDENTIFIER?.trim() || 'run.huddle.cli',
  '--version',
  version,
  '--install-location',
  '/',
  componentPkgPath,
]);

const productbuildArgs = ['--package', componentPkgPath];
const installerIdentity = process.env.APPLE_INSTALLER_IDENTITY?.trim();
if (installerIdentity) {
  productbuildArgs.push('--sign', installerIdentity);
}
productbuildArgs.push(finalPkgPath);
runCommand('productbuild', productbuildArgs);

const notaryProfile = process.env.APPLE_NOTARY_PROFILE?.trim();
if (installerIdentity && notaryProfile) {
  runCommand('xcrun', [
    'notarytool',
    'submit',
    finalPkgPath,
    '--keychain-profile',
    notaryProfile,
    '--wait',
  ]);
  runCommand('xcrun', ['stapler', 'staple', finalPkgPath]);
}

const checksum = createHash('sha256')
  .update(readFileSync(finalPkgPath))
  .digest('hex');
writeFileSync(
  checksumPath,
  `${checksum}  ${path.basename(finalPkgPath)}\n`,
  'utf8',
);

process.stdout.write(`Created ${finalPkgPath}\n`);
process.stdout.write(`Created ${checksumPath}\n`);
if (!installerIdentity) {
  process.stdout.write(
    'Package is unsigned. Set APPLE_INSTALLER_IDENTITY and APPLE_NOTARY_PROFILE for signed, notarized release builds.\n',
  );
}

function createPostinstallScript(versionValue) {
  return `#!/bin/bash
set -euo pipefail

PREFIX="/usr/local/lib/huddle"
VERSION="${versionValue}"
CURRENT_DIR="$PREFIX/$VERSION"
CURRENT_LINK="$PREFIX/current"
LAUNCHER_SOURCE="$CURRENT_DIR/support/huddle-launcher"
LAUNCHER_TARGET="/usr/local/bin/huddle"

mkdir -p "$PREFIX" "/usr/local/bin"
ln -sfn "$CURRENT_DIR" "$CURRENT_LINK"
ln -sfn "$LAUNCHER_SOURCE" "$LAUNCHER_TARGET"

find "$PREFIX" -mindepth 1 -maxdepth 1 \\
  \\( -type d -o -type l \\) \\
  ! -name "$VERSION" \\
  ! -name "current" \\
  -exec rm -rf {} +
`;
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: packageDir,
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
