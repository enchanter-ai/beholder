#!/usr/bin/env node
/* enchanter — CLI entry point.
 *
 * Subcommands:
 *   enchanter [inspect]                 Long-running boxed TUI monitor (default)
 *   enchanter mcp-wrap -- <cmd>...      MCP stdio middleware for any server
 *   enchanter watch [<dir>]             Filesystem + git watcher
 *   enchanter run -- <cmd>...           Process supervisor
 *   enchanter init-hooks [<dir>]        Install git hooks for the repo
 *
 * After `npm link` (once), `enchanter` is in PATH. Subcommand routing
 * forwards argv to the matching scripts/<name>.ts via tsx.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here       = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, '..');
const isWindows  = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Subcommand routing
// ---------------------------------------------------------------------------
const SUBCOMMANDS = {
  inspect:      'inspect.ts',
  'mcp-wrap':   'mcp-wrap.ts',
  watch:        'watch.ts',
  run:          'run.ts',
  'init-hooks': 'init-hooks.ts',
};

const argv = process.argv.slice(2);
const first = argv[0];
const isSubcommand = first && Object.prototype.hasOwnProperty.call(SUBCOMMANDS, first);
const subcommand = isSubcommand ? first : 'inspect';
const forwardArgs = isSubcommand ? argv.slice(1) : argv;

const scriptName = SUBCOMMANDS[subcommand];
const scriptPath = join(packageDir, 'scripts', scriptName);

if (!existsSync(scriptPath)) {
  console.error(`[enchanter] no script for subcommand '${subcommand}' (looked for ${scriptPath})`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Resolve tsx — prefer the package's local copy so the tool works from any
// cwd. Fall back to npx if the local copy is missing.
// ---------------------------------------------------------------------------
const localTsx = join(
  packageDir,
  'node_modules',
  '.bin',
  isWindows ? 'tsx.cmd' : 'tsx',
);

let cmd;
let args;
if (existsSync(localTsx)) {
  cmd  = localTsx;
  args = [scriptPath, ...forwardArgs];
} else {
  cmd  = isWindows ? 'npx.cmd' : 'npx';
  args = ['-y', 'tsx', scriptPath, ...forwardArgs];
}

const child = spawn(cmd, args, {
  stdio: 'inherit',
  cwd:   process.cwd(),
  env:   process.env,
  shell: isWindows,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else        process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error('[enchanter] failed to launch:', err.message);
  process.exit(1);
});
