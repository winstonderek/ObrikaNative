import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ForgeHookMap } from '@electron-forge/shared-types';

interface UpdateFile {
  url: string;
  sha512: string;
  size: number;
}

function sha512Base64(filePath: string): string {
  const hash = crypto.createHash('sha512');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('base64');
}

function toUpdateYaml(version: string, files: UpdateFile[], releaseDate: string): string {
  const primary = files[0];
  if (!primary) {
    throw new Error('Cannot write an update manifest without files');
  }

  const fileLines = files.flatMap((file) => [
    `  - url: ${file.url}`,
    `    sha512: ${file.sha512}`,
    `    size: ${file.size}`,
  ]);

  return [
    `version: ${version}`,
    'files:',
    ...fileLines,
    `path: ${primary.url}`,
    `sha512: ${primary.sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n');
}

function isMacUpdateArtifact(artifact: string): boolean {
  return artifact.endsWith('.zip');
}

function stripUtf8Bom(filePath: string): void {
  const data = fs.readFileSync(filePath);
  if (data.length < 3 || data[0] !== 0xef || data[1] !== 0xbb || data[2] !== 0xbf) return;
  fs.writeFileSync(filePath, data.subarray(3));
}

/**
 * electron-winstaller writes RELEASES as UTF-8 with a BOM. Squirrel's checksum
 * parser can treat that prefix as part of the hash and refuse to settle on the
 * installed package.
 */
function stripReleaseManifestBoms(
  makeResults: ReadonlyArray<{ artifacts: readonly string[] }>,
): void {
  const seen = new Set<string>();
  for (const result of makeResults) {
    for (const artifact of result.artifacts) {
      const candidates = [artifact, path.join(path.dirname(artifact), 'RELEASES')];
      for (const candidate of candidates) {
        if (path.basename(candidate) !== 'RELEASES' || seen.has(candidate)) continue;
        if (!fs.existsSync(candidate)) continue;
        seen.add(candidate);
        stripUtf8Bom(candidate);
      }
    }
  }
}

function isWinUpdateArtifact(artifact: string): boolean {
  const name = path.basename(artifact).toLowerCase();
  return name.endsWith('.exe') && !name.includes('uninstall');
}

/**
 * electron-updater reads latest-mac.yml / latest.yml from the GitHub Release.
 * Electron Forge does not generate those files — add them as extra artifacts.
 */
export const generateUpdateManifests: ForgeHookMap['postMake'] = async (
  _config,
  makeResults,
) => {
  if (!makeResults.length) return makeResults;

  const version = makeResults[0].packageJSON.version;
  const releaseDate = new Date().toISOString();
  const platform = makeResults[0].platform;
  const files: UpdateFile[] = [];

  for (const result of makeResults) {
    for (const artifact of result.artifacts) {
      const include =
        result.platform === 'darwin'
          ? isMacUpdateArtifact(artifact)
          : result.platform === 'win32'
            ? isWinUpdateArtifact(artifact)
            : false;
      if (!include || !fs.existsSync(artifact)) continue;

      files.push({
        url: path.basename(artifact),
        sha512: sha512Base64(artifact),
        size: fs.statSync(artifact).size,
      });
    }
  }

  stripReleaseManifestBoms(makeResults);

  if (!files.length) return makeResults;

  const manifestName = platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml';
  const firstArtifact = makeResults[0].artifacts[0];
  const manifestDir = firstArtifact
    ? path.dirname(firstArtifact)
    : path.join(process.cwd(), 'out', 'make');
  const manifestPath = path.join(manifestDir, manifestName);

  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(manifestPath, toUpdateYaml(version, files, releaseDate));

  makeResults.push({
    artifacts: [manifestPath],
    platform: makeResults[0].platform,
    arch: makeResults[0].arch,
    packageJSON: makeResults[0].packageJSON,
  });

  return makeResults;
};
