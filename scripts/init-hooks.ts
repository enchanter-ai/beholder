/* scripts/init-hooks.ts — Stage C of the dogfood plan.
 *
 * Installs git lifecycle hooks (pre-commit, pre-push, post-commit) into a
 * repo so commits/pushes flow into the Enchanter bus. Each hook is a small
 * POSIX sh script that shells out to `node <pkg>/scripts/hook-emit.mjs`,
 * which packages the event and forwards it to a running inspector.
 *
 *   git event ──▶ .git/hooks/<hook> ──▶ hook-emit.mjs ──▶ BusClient ──▶ inspector
 *
 * Usage:
 *   enchanter init-hooks              # install into process.cwd()
 *   enchanter init-hooks ./some/repo  # install into a specific repo
 *
 * Behavior:
 *   - Detects pre-existing hooks not written by us and backs them up to
 *     <hook>.pre-enchanter so user customizations are preserved.
 *   - Idempotent: re-running overwrites our own marker-bearing hooks
 *     in place; never duplicates or stacks backups.
 *   - Failure mode: if the inspector isn't running, the helper's BusClient
 *     buffers and the hook still exits 0. We never block git on observability.
 *
 * Limitations (v1):
 *   - Honors `.git/hooks/` only. `core.hooksPath` overrides are TODO.
 *   - Single-file POSIX sh script; on Windows, git invokes hooks through
 *     Git Bash, so a portable shebang `#!/usr/bin/env sh` works there too.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Argv: optional repo root; default to cwd
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const repoRoot = args[0] ? resolve(args[0]) : process.cwd();

const gitDir = join(repoRoot, '.git');
if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) {
  process.stderr.write(
    `[enchanter init-hooks] not a git repo: ${repoRoot}\n` +
    `usage: enchanter init-hooks [<dir>]\n`,
  );
  process.exit(2);
}

// TODO: respect core.hooksPath from .git/config (v1 uses .git/hooks/).
const hooksDir = join(gitDir, 'hooks');
if (!existsSync(hooksDir)) {
  mkdirSync(hooksDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Locate the package directory (so the hook can call into our helper).
// __dirname for this script after resolution is <pkg>/scripts.
// ---------------------------------------------------------------------------
const here       = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, '..');
const helperPath = join(packageDir, 'scripts', 'hook-emit.mjs');

// ---------------------------------------------------------------------------
// Hook bodies. Each script:
//   1. carries the marker comment so we can detect our own writes.
//   2. gathers the per-hook payload via git plumbing.
//   3. invokes node <helperPath> <hook-name> -- <payload-args>.
//   4. exits 0 unconditionally — observability must never block git.
//
// The helper path is embedded as a single-quoted POSIX literal; we escape
// any embedded single quote by closing/reopening the literal.
// ---------------------------------------------------------------------------
const MARKER = '# enchanter-hook v1';

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const helperLiteral = shQuote(helperPath);

const PRE_COMMIT_BODY = `#!/usr/bin/env sh
${MARKER}
# Emits git.pre-commit.fired with the staged file list.
set -u
STAGED=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)
node ${helperLiteral} pre-commit --staged "$STAGED" >/dev/null 2>&1 || true
exit 0
`;

const PRE_PUSH_BODY = `#!/usr/bin/env sh
${MARKER}
# Emits one git.pre-push.fired event per ref-update line on stdin.
# git provides lines: <local-ref> <local-sha> <remote-ref> <remote-sha>
set -u
REMOTE_NAME="\${1:-}"
REMOTE_URL="\${2:-}"
STDIN_DATA=$(cat || true)
node ${helperLiteral} pre-push --remote-name "$REMOTE_NAME" --remote-url "$REMOTE_URL" --refs "$STDIN_DATA" >/dev/null 2>&1 || true
exit 0
`;

const POST_COMMIT_BODY = `#!/usr/bin/env sh
${MARKER}
# Emits git.post-commit.fired with the new commit hash + author.
set -u
HASH=$(git log -1 --format=%H 2>/dev/null || echo "")
AUTHOR=$(git log -1 --format=%an 2>/dev/null || echo "")
EMAIL=$(git log -1 --format=%ae 2>/dev/null || echo "")
SUBJECT=$(git log -1 --format=%s 2>/dev/null || echo "")
node ${helperLiteral} post-commit --hash "$HASH" --author "$AUTHOR" --email "$EMAIL" --subject "$SUBJECT" >/dev/null 2>&1 || true
exit 0
`;

interface HookSpec {
  readonly name: string;
  readonly body: string;
}

const HOOKS: ReadonlyArray<HookSpec> = [
  { name: 'pre-commit',  body: PRE_COMMIT_BODY  },
  { name: 'pre-push',    body: PRE_PUSH_BODY    },
  { name: 'post-commit', body: POST_COMMIT_BODY },
];

// ---------------------------------------------------------------------------
// Install loop
// ---------------------------------------------------------------------------
interface InstallResult {
  readonly hook: string;
  readonly path: string;
  readonly action: 'wrote-fresh' | 'replaced-own' | 'replaced-after-backup';
  readonly backupPath?: string;
}

const results: InstallResult[] = [];

for (const spec of HOOKS) {
  const hookPath = join(hooksDir, spec.name);
  let action: InstallResult['action'] = 'wrote-fresh';
  let backupPath: string | undefined;

  if (existsSync(hookPath)) {
    let existing = '';
    try { existing = readFileSync(hookPath, 'utf8'); }
    catch { existing = ''; }

    if (existing.includes(MARKER)) {
      // We wrote it last time; safe to overwrite in place. Idempotent.
      action = 'replaced-own';
    } else {
      // User-authored or another tool's hook. Preserve before overwrite.
      backupPath = `${hookPath}.pre-enchanter`;
      // Don't clobber an existing backup — leave the first one in place,
      // since re-running this script must remain idempotent.
      if (!existsSync(backupPath)) {
        renameSync(hookPath, backupPath);
      }
      action = 'replaced-after-backup';
    }
  }

  writeFileSync(hookPath, spec.body, { encoding: 'utf8' });
  // 0o755 — readable + executable by all, writable by owner.
  try { chmodSync(hookPath, 0o755); }
  catch { /* Windows ignores chmod; git for windows runs sh hooks anyway */ }

  const result: InstallResult = backupPath !== undefined
    ? { hook: spec.name, path: hookPath, action, backupPath }
    : { hook: spec.name, path: hookPath, action };
  results.push(result);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
process.stdout.write(`[enchanter init-hooks] installed into ${hooksDir}\n`);
for (const r of results) {
  let line = `  ${r.hook.padEnd(12)} ${r.path}`;
  if (r.action === 'replaced-after-backup' && r.backupPath) {
    line += `\n    (existing hook backed up to ${r.backupPath})`;
  } else if (r.action === 'replaced-own') {
    line += '  [refreshed]';
  }
  process.stdout.write(line + '\n');
}

process.stdout.write(
  '\n' +
  'Test it:\n' +
  '  cd ' + repoRoot + '\n' +
  '  echo test > /tmp/enchanter-hook-smoke && git add -A && git commit -m test\n' +
  '\n' +
  'Then check `enchanter inspect` for git.pre-commit.fired / git.post-commit.fired events.\n',
);

process.exit(0);
