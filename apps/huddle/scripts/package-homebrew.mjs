import { createHash } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, '..');
const releaseDir = path.join(packageDir, 'release');
const appDir = path.join(releaseDir, 'app');
const artifactsDir = path.join(releaseDir, 'artifacts');
const packageJson = JSON.parse(
  readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
);
const version = packageJson.version;
const tarballName = `huddle-${version}-macos-universal.tar.gz`;
const tarballPath = path.join(artifactsDir, tarballName);
const checksumPath = `${tarballPath}.sha256`;
const formulaPath = path.join(artifactsDir, 'huddle.rb');
const formulaTemplatePath = path.join(artifactsDir, 'huddle.rb.template');
const tarballUrl = process.env.HUDDLE_BREW_TARBALL_URL?.trim() || null;
const homepageUrl =
  process.env.HUDDLE_HOMEPAGE_URL?.trim() ||
  'https://github.com/zevstravitz/agent-huddle';
const localTarballUrl = `file://${tarballPath}`;

runCommand('node', [path.join('scripts', 'build-release.mjs')]);
runCommand('mkdir', ['-p', artifactsDir]);
rmSync(tarballPath, { force: true });
rmSync(checksumPath, { force: true });
rmSync(formulaPath, { force: true });
rmSync(formulaTemplatePath, { force: true });

runCommand('tar', ['-czf', tarballPath, '-C', appDir, '.']);

const checksum = createHash('sha256')
  .update(readFileSync(tarballPath))
  .digest('hex');
writeFileSync(checksumPath, `${checksum}  ${tarballName}\n`, 'utf8');

const formulaContents = createFormula({
  homepage: homepageUrl,
  sha256: checksum,
  url: tarballUrl ?? localTarballUrl,
  version,
});
const formulaTemplateContents = createFormula({
  homepage: homepageUrl,
  sha256: checksum,
  url: '__HUDDLE_BREW_TARBALL_URL__',
  version,
});

writeFileSync(formulaPath, formulaContents, 'utf8');
writeFileSync(formulaTemplatePath, formulaTemplateContents, 'utf8');

process.stdout.write(`Created ${tarballPath}\n`);
process.stdout.write(`Created ${checksumPath}\n`);
process.stdout.write(`Created ${formulaPath}\n`);
process.stdout.write(
  `Created ${formulaTemplatePath}. Set HUDDLE_BREW_TARBALL_URL to make ${path.basename(formulaPath)} publishable.\n`,
);

function createFormula(input) {
  return `class Huddle < Formula
  desc "Local voice-first spoken clarification CLI for coding agents"
  homepage "${input.homepage}"
  url "${input.url}"
  sha256 "${input.sha256}"
  version "${input.version}"

  depends_on macos: :monterey
  depends_on "node"

  def install
    libexec.install Dir["*"]
    bin.install_symlink libexec/"support/huddle-launcher" => "huddle"
  end

  test do
    assert_match "spoken huddle", shell_output("#{bin}/huddle --help")
  end
end
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
