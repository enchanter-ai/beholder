#!/usr/bin/env node
/* enchanter — CLI entry point.
 *
 *   npm link        once, from this package's dir
 *   enchanter       run from any cwd; spawns the boxed inspector TUI
 *
 * Forwards argv to scripts/inspect.ts via tsx (a devDependency that ships
 * with the package). The inspector reads `process.cwd()` to determine the
 * watched scope, so running `enchanter` from a project root makes that
 * project the inspector's target. */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here       = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, '..');
const scriptPath = join(packageDir, 'scripts', 'inspect.ts');
const isWindows  = process.platform === 'win32';

// Resolve tsx from the package's own node_modules so the launcher works
// regardless of the user's current cwd. Fall back to npx if tsx isn't
// installed locally (covers npm link edge cases).
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
  args = [scriptPath, ...process.argv.slice(2)];
} else {
  cmd  = isWindows ? 'npx.cmd' : 'npx';
  args = ['-y', 'tsx', scriptPath, ...process.argv.slice(2)];
}

// Windows .cmd shims (npx.cmd, tsx.cmd) only work with shell: true. On POSIX
// shell:false is preferred for argv hygiene.
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
