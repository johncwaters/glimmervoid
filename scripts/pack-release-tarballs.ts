import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pkg from '../package.json' with { type: 'json' };

const LATEST_ALIAS_ASSET_NAME = 'glimmervoid.tgz';

function versionedAssetName(version: string): string {
  return `glimmervoid-${version}.tgz`;
}

function releaseAssetNames(version: string): { latestAlias: string; versioned: string } {
  return { latestAlias: LATEST_ALIAS_ASSET_NAME, versioned: versionedAssetName(version) };
}

function packReleaseTarballs(outputDirectory: string, version: string = pkg.version): { latestAliasPath: string; versionedAssetPath: string } {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const npmPackDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'glimmervoid-npm-pack-'));
  try {
    execSync(`npm pack --pack-destination "${npmPackDirectory}"`, { stdio: ['ignore', process.stderr.fd, 'inherit'] });
    const packedTarballs = fs.readdirSync(npmPackDirectory).filter((file) => file.endsWith('.tgz'));
    if (packedTarballs.length !== 1) {
      throw new Error(`expected exactly one packed tarball, found ${packedTarballs.length}`);
    }
    const packedTarballPath = path.join(npmPackDirectory, packedTarballs[0]);
    const assetNames = releaseAssetNames(version);
    const latestAliasPath = path.join(outputDirectory, assetNames.latestAlias);
    const versionedAssetPath = path.join(outputDirectory, assetNames.versioned);
    fs.copyFileSync(packedTarballPath, latestAliasPath);
    fs.copyFileSync(packedTarballPath, versionedAssetPath);
    return { latestAliasPath, versionedAssetPath };
  } finally {
    fs.rmSync(npmPackDirectory, { recursive: true, force: true });
  }
}

function runCli(): void {
  const outputDirectoryArgument = process.argv[2];
  if (!outputDirectoryArgument) {
    console.error('usage: node scripts/pack-release-tarballs.ts <outDir>');
    process.exit(1);
  }
  const { latestAliasPath, versionedAssetPath } = packReleaseTarballs(path.resolve(outputDirectoryArgument));
  console.log(latestAliasPath);
  console.log(versionedAssetPath);
}

const isRunDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isRunDirectly) runCli();

export { LATEST_ALIAS_ASSET_NAME, versionedAssetName, releaseAssetNames, packReleaseTarballs };
