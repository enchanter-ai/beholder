#!/usr/bin/env tsx
/* scripts/publish-packages.ts — release pipeline for the @enchanter-ai/plugin-* monorepo.

   Walks packages/*, validates each manifest in lockstep with the root package
   version, runs `npm pack --dry-run` per package, and (with --publish) invokes
   `npm publish` per workspace.

   Modes:
     --dry-run  (default) Validates + pack-checks every package and prints a
                release plan. Never invokes `npm publish`.
     --publish  Requires NPM_TOKEN in env. Runs `npm publish --workspace ...
                --access public` for each package. Tolerant of partial failure:
                if package N publishes but N+1 fails, prints which succeeded so
                the operator can manually finish the rest.

   This script never invokes npm publish in --dry-run mode. The --publish path
   is the documented release ceremony (see docs/RELEASE.md) and is exercised
   only by the .github/workflows/publish.yml tag-push pipeline. */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');

interface PackageManifest {
  name: string;
  version: string;
  files?: string[];
  peerDependencies?: Record<string, string>;
  private?: boolean;
}

interface ValidationIssue {
  package: string;
  field: string;
  message: string;
}

interface PackageRecord {
  dir: string;
  manifest: PackageManifest;
}

const NAME_PATTERN = /^@enchanter-ai\/plugin-[a-z0-9-]+$/;

function readManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf-8')) as PackageManifest;
}

function loadRoot(): PackageManifest {
  return readManifest(join(ROOT, 'package.json'));
}

function loadPackages(): PackageRecord[] {
  const packagesDir = join(ROOT, 'packages');
  const entries = readdirSync(packagesDir);
  const out: PackageRecord[] = [];
  for (const entry of entries) {
    const dir = join(packagesDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = join(dir, 'package.json');
    try {
      out.push({ dir, manifest: readManifest(manifestPath) });
    } catch {
      // Skip directories without package.json — not part of the publish set.
    }
  }
  out.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  return out;
}

/** Validates each package against the lockstep contract. Returns issues; empty
 *  array means the release plan is internally consistent. */
export function validateLockstep(
  root: PackageManifest,
  packages: PackageRecord[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const { manifest } of packages) {
    const pkg = manifest.name;

    if (!NAME_PATTERN.test(manifest.name)) {
      issues.push({
        package: pkg,
        field: 'name',
        message: `expected @enchanter-ai/plugin-* shape, got ${manifest.name}`,
      });
    }

    if (manifest.version !== root.version) {
      issues.push({
        package: pkg,
        field: 'version',
        message: `lockstep mismatch — root is ${root.version}, package is ${manifest.version}`,
      });
    }

    const peer = manifest.peerDependencies?.enchanter;
    if (!peer) {
      issues.push({
        package: pkg,
        field: 'peerDependencies.enchanter',
        message: 'missing peerDependencies.enchanter',
      });
    } else if (!isCompatiblePeerRange(peer, root.version)) {
      issues.push({
        package: pkg,
        field: 'peerDependencies.enchanter',
        message: `peer range ${peer} does not admit root version ${root.version}`,
      });
    }

    if (!manifest.files || !manifest.files.includes('dist')) {
      issues.push({
        package: pkg,
        field: 'files',
        message: '"files" must include "dist"',
      });
    }

    if (manifest.private === true) {
      issues.push({
        package: pkg,
        field: 'private',
        message: 'package is marked private — cannot publish',
      });
    }
  }

  return issues;
}

/** Loose semver-range admit check.
 *  Accepts: exact `x.y.z`, caret `^x.y.z`, tilde `~x.y.z`, and `>=x.y.z`.
 *  Strict enough for our lockstep contract; we don't need a full semver parser. */
export function isCompatiblePeerRange(range: string, version: string): boolean {
  const trimmed = range.trim();
  const v = parseSemver(version);
  if (!v) return false;

  if (/^\d+\.\d+\.\d+/.test(trimmed)) {
    const r = parseSemver(trimmed);
    return !!r && r.major === v.major && r.minor === v.minor && r.patch === v.patch;
  }
  if (trimmed.startsWith('^')) {
    const r = parseSemver(trimmed.slice(1));
    if (!r) return false;
    if (r.major !== v.major) return false;
    return cmp(v, r) >= 0;
  }
  if (trimmed.startsWith('~')) {
    const r = parseSemver(trimmed.slice(1));
    if (!r) return false;
    if (r.major !== v.major || r.minor !== v.minor) return false;
    return v.patch >= r.patch;
  }
  if (trimmed.startsWith('>=')) {
    const r = parseSemver(trimmed.slice(2).trim());
    if (!r) return false;
    return cmp(v, r) >= 0;
  }
  return false;
}

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

function parseSemver(s: string): Semver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

function cmp(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function packDryRun(dir: string): { ok: boolean; output: string } {
  const result = spawnSync('npm', ['pack', '--dry-run'], {
    cwd: dir,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
  return {
    ok: result.status === 0,
    output: (result.stdout || '') + (result.stderr || ''),
  };
}

function publishOne(name: string): { ok: boolean; output: string } {
  const result = spawnSync(
    'npm',
    ['publish', '--workspace', name, '--access', 'public'],
    {
      cwd: ROOT,
      encoding: 'utf-8',
      shell: process.platform === 'win32',
      env: { ...process.env, NODE_AUTH_TOKEN: process.env.NPM_TOKEN },
    },
  );
  return {
    ok: result.status === 0,
    output: (result.stdout || '') + (result.stderr || ''),
  };
}

interface RunOptions {
  publish: boolean;
}

export interface RunResult {
  ok: boolean;
  validation: ValidationIssue[];
  packed: string[];
  packFailures: string[];
  published: string[];
  publishFailures: string[];
  rootVersion: string;
}

export function runRelease(opts: RunOptions): RunResult {
  const root = loadRoot();
  const packages = loadPackages();

  const validation = validateLockstep(root, packages);
  const result: RunResult = {
    ok: false,
    validation,
    packed: [],
    packFailures: [],
    published: [],
    publishFailures: [],
    rootVersion: root.version,
  };

  console.log(`[release] root version: ${root.version}`);
  console.log(`[release] discovered ${packages.length} package(s):`);
  for (const { manifest } of packages) {
    console.log(`           - ${manifest.name}@${manifest.version}`);
  }

  if (validation.length > 0) {
    console.error('\n[release] validation FAILED:');
    for (const issue of validation) {
      console.error(`  ${issue.package} :: ${issue.field} :: ${issue.message}`);
    }
    return result;
  }
  console.log('[release] lockstep validation: OK');

  console.log('[release] running npm pack --dry-run for each package...');
  for (const { dir, manifest } of packages) {
    const { ok } = packDryRun(dir);
    if (ok) {
      result.packed.push(manifest.name);
      console.log(`           [OK] ${manifest.name}`);
    } else {
      result.packFailures.push(manifest.name);
      console.error(`           [FAIL] ${manifest.name}`);
    }
  }

  if (result.packFailures.length > 0) {
    console.error('\n[release] one or more pack dry-runs failed; aborting.');
    return result;
  }

  if (!opts.publish) {
    console.log('\n[release] DRY-RUN complete. Plan:');
    for (const { manifest } of packages) {
      console.log(`           publish ${manifest.name}@${manifest.version}`);
    }
    console.log(
      '\n[release] To execute the publish, re-run with --publish (requires NPM_TOKEN).',
    );
    result.ok = true;
    return result;
  }

  if (!process.env.NPM_TOKEN) {
    console.error(
      '\n[release] --publish requires NPM_TOKEN env var; refusing to publish.',
    );
    return result;
  }

  console.log('\n[release] publishing packages...');
  for (const { manifest } of packages) {
    const { ok, output } = publishOne(manifest.name);
    if (ok) {
      result.published.push(manifest.name);
      console.log(`           [PUBLISHED] ${manifest.name}@${manifest.version}`);
    } else {
      result.publishFailures.push(manifest.name);
      console.error(`           [FAIL] ${manifest.name}`);
      console.error(output);
    }
  }

  if (result.publishFailures.length > 0) {
    console.error('\n[release] partial-publish summary:');
    console.error(`  succeeded (${result.published.length}): ${result.published.join(', ') || '(none)'}`);
    console.error(`  failed    (${result.publishFailures.length}): ${result.publishFailures.join(', ')}`);
    console.error(
      '\n[release] re-run after fixing root cause; already-published packages will be skipped by the registry.',
    );
    return result;
  }

  console.log('\n[release] all packages published successfully.');
  result.ok = true;
  return result;
}

function parseArgs(argv: string[]): RunOptions {
  let publish = false;
  for (const arg of argv) {
    if (arg === '--publish') publish = true;
    else if (arg === '--dry-run') publish = false;
  }
  return { publish };
}

function isMainModule(): boolean {
  if (typeof process === 'undefined') return false;
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === resolve(__filename);
}

if (isMainModule()) {
  const opts = parseArgs(process.argv.slice(2));
  const out = runRelease(opts);
  process.exit(out.ok ? 0 : 1);
}
