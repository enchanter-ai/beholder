#!/usr/bin/env tsx
/* scripts/release-prep.ts — bumps the root + every packages/* manifest to a
   new semver in lockstep, and updates each package's peerDependencies.enchanter
   to ^<new-version>.

   Usage:
     tsx scripts/release-prep.ts --version 0.4.0

   Prints a unified-diff-style summary and exits 0. The caller commits + tags. */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');

interface Manifest {
  name?: string;
  version?: string;
  peerDependencies?: Record<string, string>;
  [k: string]: unknown;
}

interface Change {
  file: string;
  field: string;
  before: string;
  after: string;
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/;

export function applyVersionBump(
  rootDir: string,
  newVersion: string,
): Change[] {
  if (!SEMVER_RE.test(newVersion)) {
    throw new Error(`invalid semver: ${newVersion}`);
  }

  const changes: Change[] = [];
  const peerRange = `^${newVersion}`;

  // Root manifest.
  const rootPath = join(rootDir, 'package.json');
  const root: Manifest = JSON.parse(readFileSync(rootPath, 'utf-8'));
  if (root.version !== newVersion) {
    changes.push({
      file: 'package.json',
      field: 'version',
      before: root.version ?? '(unset)',
      after: newVersion,
    });
    root.version = newVersion;
    writeFileSync(rootPath, JSON.stringify(root, null, 2) + '\n', 'utf-8');
  }

  // Plugin packages.
  const packagesDir = join(rootDir, 'packages');
  const entries = readdirSync(packagesDir);
  for (const entry of entries.sort()) {
    const dir = join(packagesDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = join(dir, 'package.json');
    let manifest: Manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    } catch {
      continue;
    }
    const rel = `packages/${entry}/package.json`;

    if (manifest.version !== newVersion) {
      changes.push({
        file: rel,
        field: 'version',
        before: manifest.version ?? '(unset)',
        after: newVersion,
      });
      manifest.version = newVersion;
    }

    const currentPeer = manifest.peerDependencies?.enchanter;
    if (currentPeer !== peerRange) {
      changes.push({
        file: rel,
        field: 'peerDependencies.enchanter',
        before: currentPeer ?? '(unset)',
        after: peerRange,
      });
      manifest.peerDependencies = {
        ...(manifest.peerDependencies ?? {}),
        enchanter: peerRange,
      };
    }

    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  }

  return changes;
}

function parseArgs(argv: string[]): { version: string | null } {
  let version: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version' && i + 1 < argv.length) {
      version = argv[i + 1] ?? null;
      i++;
    }
  }
  return { version };
}

function isMainModule(): boolean {
  if (typeof process === 'undefined') return false;
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === resolve(__filename);
}

if (isMainModule()) {
  const { version } = parseArgs(process.argv.slice(2));
  if (!version) {
    console.error('usage: tsx scripts/release-prep.ts --version <semver>');
    process.exit(2);
  }
  const changes = applyVersionBump(ROOT, version);
  if (changes.length === 0) {
    console.log(`[release-prep] no changes — already at ${version}`);
  } else {
    console.log(`[release-prep] applied ${changes.length} change(s):`);
    for (const c of changes) {
      console.log(`  ${c.file}`);
      console.log(`    ${c.field}: ${c.before} -> ${c.after}`);
    }
    console.log('\n[release-prep] commit + tag now:');
    console.log(`  git commit -am "chore: bump to v${version}"`);
    console.log(`  git tag v${version}`);
    console.log(`  git push origin main --tags`);
  }
  process.exit(0);
}
