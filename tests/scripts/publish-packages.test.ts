/* tests/scripts/publish-packages.test.ts — smoke test for the release pipeline.

   Covers:
     - release-prep lockstep version write (root + packages/*)
     - publish-packages validateLockstep against a synthesized monorepo
     - isCompatiblePeerRange behavior on the ranges release-prep produces
*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyVersionBump } from '../../scripts/release-prep.js';
import {
  isCompatiblePeerRange,
  validateLockstep,
} from '../../scripts/publish-packages.js';

interface MockManifest {
  name?: string;
  version?: string;
  files?: string[];
  peerDependencies?: Record<string, string>;
  private?: boolean;
}

function setupFakeMonorepo(rootVersion: string): string {
  const root = mkdtempSync(join(tmpdir(), 'enchanter-release-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'enchanter',
        version: rootVersion,
        private: true,
        workspaces: ['packages/*'],
      },
      null,
      2,
    ) + '\n',
  );

  mkdirSync(join(root, 'packages'), { recursive: true });

  const plugins = ['plugin-pech', 'plugin-emu', 'plugin-hydra'];
  for (const slug of plugins) {
    const dir = join(root, 'packages', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify(
        {
          name: `@enchanter-ai/plugin-${slug.replace('plugin-', '')}`,
          version: '0.3.0',
          files: ['dist', 'README.md'],
          peerDependencies: { enchanter: '>=0.2.0' },
        },
        null,
        2,
      ) + '\n',
    );
  }

  return root;
}

function readManifest(path: string): MockManifest {
  return JSON.parse(readFileSync(path, 'utf-8')) as MockManifest;
}

describe('release-prep version bump', () => {
  let root: string;

  beforeEach(() => {
    root = setupFakeMonorepo('0.3.0');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('rewrites root + every package version in lockstep', () => {
    const changes = applyVersionBump(root, '0.4.0');

    expect(readManifest(join(root, 'package.json')).version).toBe('0.4.0');
    expect(
      readManifest(join(root, 'packages/plugin-pech/package.json')).version,
    ).toBe('0.4.0');
    expect(
      readManifest(join(root, 'packages/plugin-emu/package.json')).version,
    ).toBe('0.4.0');

    // Root version + 3 plugin versions + 3 plugin peer ranges = 7 changes.
    expect(changes.length).toBe(7);
  });

  it('retightens peerDependencies.enchanter to ^<new-version>', () => {
    applyVersionBump(root, '0.4.0');
    const m = readManifest(join(root, 'packages/plugin-pech/package.json'));
    expect(m.peerDependencies?.enchanter).toBe('^0.4.0');
  });

  it('is idempotent on a second run at the same version', () => {
    applyVersionBump(root, '0.4.0');
    const second = applyVersionBump(root, '0.4.0');
    expect(second).toEqual([]);
  });

  it('rejects a non-semver argument', () => {
    expect(() => applyVersionBump(root, 'not-a-version')).toThrow();
  });
});

describe('publish-packages validation', () => {
  it('passes on a lockstep-aligned monorepo', () => {
    const issues = validateLockstep(
      { name: 'enchanter', version: '0.4.0' },
      [
        {
          dir: '/tmp/x',
          manifest: {
            name: '@enchanter-ai/plugin-pech',
            version: '0.4.0',
            files: ['dist'],
            peerDependencies: { enchanter: '^0.4.0' },
          },
        },
      ],
    );
    expect(issues).toEqual([]);
  });

  it('flags a version mismatch between root and plugin', () => {
    const issues = validateLockstep(
      { name: 'enchanter', version: '0.4.0' },
      [
        {
          dir: '/tmp/x',
          manifest: {
            name: '@enchanter-ai/plugin-pech',
            version: '0.3.0',
            files: ['dist'],
            peerDependencies: { enchanter: '^0.4.0' },
          },
        },
      ],
    );
    expect(issues.some((i) => i.field === 'version')).toBe(true);
  });

  it('flags a missing dist in files', () => {
    const issues = validateLockstep(
      { name: 'enchanter', version: '0.4.0' },
      [
        {
          dir: '/tmp/x',
          manifest: {
            name: '@enchanter-ai/plugin-pech',
            version: '0.4.0',
            files: ['README.md'],
            peerDependencies: { enchanter: '^0.4.0' },
          },
        },
      ],
    );
    expect(issues.some((i) => i.field === 'files')).toBe(true);
  });

  it('flags a non-@enchanter-ai/plugin-* name', () => {
    const issues = validateLockstep(
      { name: 'enchanter', version: '0.4.0' },
      [
        {
          dir: '/tmp/x',
          manifest: {
            name: 'random-name',
            version: '0.4.0',
            files: ['dist'],
            peerDependencies: { enchanter: '^0.4.0' },
          },
        },
      ],
    );
    expect(issues.some((i) => i.field === 'name')).toBe(true);
  });

  it('flags a private package', () => {
    const issues = validateLockstep(
      { name: 'enchanter', version: '0.4.0' },
      [
        {
          dir: '/tmp/x',
          manifest: {
            name: '@enchanter-ai/plugin-pech',
            version: '0.4.0',
            files: ['dist'],
            peerDependencies: { enchanter: '^0.4.0' },
            private: true,
          },
        },
      ],
    );
    expect(issues.some((i) => i.field === 'private')).toBe(true);
  });

  it('flags a peer range that excludes the root version', () => {
    const issues = validateLockstep(
      { name: 'enchanter', version: '0.4.0' },
      [
        {
          dir: '/tmp/x',
          manifest: {
            name: '@enchanter-ai/plugin-pech',
            version: '0.4.0',
            files: ['dist'],
            peerDependencies: { enchanter: '^0.5.0' },
          },
        },
      ],
    );
    expect(issues.some((i) => i.field === 'peerDependencies.enchanter')).toBe(true);
  });
});

describe('isCompatiblePeerRange', () => {
  it('accepts a caret range that admits the version', () => {
    expect(isCompatiblePeerRange('^0.4.0', '0.4.0')).toBe(true);
    expect(isCompatiblePeerRange('^0.4.0', '0.4.5')).toBe(true);
  });

  it('rejects a caret range whose major differs', () => {
    expect(isCompatiblePeerRange('^1.0.0', '0.4.0')).toBe(false);
  });

  it('accepts a >= range that admits the version', () => {
    expect(isCompatiblePeerRange('>=0.2.0', '0.4.0')).toBe(true);
  });

  it('rejects a >= range whose floor exceeds the version', () => {
    expect(isCompatiblePeerRange('>=0.5.0', '0.4.0')).toBe(false);
  });

  it('accepts an exact pin', () => {
    expect(isCompatiblePeerRange('0.4.0', '0.4.0')).toBe(true);
    expect(isCompatiblePeerRange('0.4.1', '0.4.0')).toBe(false);
  });
});
