#!/usr/bin/env node
/* beholder — CLI entry point.
 *
 * Routing:
 *   beholder                          → Rust TUI cockpit (auto-live if scripts/live.ts is reachable; else demo mode)
 *   beholder inspect [args]           → Rust TUI with explicit args (--from / --socket / --control-socket / --exec)
 *   beholder live                     → Rust TUI in live mode (spawns scripts/live.ts itself)
 *   beholder mcp-wrap -- <cmd>...     → TS scripts/mcp-wrap.ts
 *   beholder watch [<dir>]            → TS scripts/watch.ts
 *   beholder run -- <cmd>...          → TS scripts/run.ts (process supervisor)
 *   beholder init-hooks [<dir>]       → TS scripts/init-hooks.ts
 *
 * Cockpit subcommands (inspect/live/no-arg) dispatch to the Rust binary
 * at `inspector/target/release/beholder[.exe]`. TS-only subcommands keep
 * routing to scripts/<name>.ts via tsx.
 *
 * If the Rust binary isn't built, a clear error message walks the user
 * through `cd inspector && cargo build --release`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here       = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, '..');
const isWindows  = process.platform === 'win32';
const exe        = isWindows ? '.exe' : '';

// ---------------------------------------------------------------------------
// TS-only subcommands — routed to scripts/<name>.ts via tsx
// ---------------------------------------------------------------------------
const TS_SUBCOMMANDS = {
  'mcp-wrap':   'mcp-wrap.ts',
  watch:        'watch.ts',
  run:          'run.ts',
  'init-hooks': 'init-hooks.ts',
};

// Cockpit subcommands — routed to the Rust binary
const COCKPIT_SUBCOMMANDS = new Set(['inspect', 'live']);

// ---------------------------------------------------------------------------
// Argv shape
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const first = argv[0];

const isTsSubcommand = first && Object.prototype.hasOwnProperty.call(TS_SUBCOMMANDS, first);
const isCockpitSubcommand = first && COCKPIT_SUBCOMMANDS.has(first);
const isCockpitDefault = !first || (first.startsWith('-') && !isTsSubcommand);

// ---------------------------------------------------------------------------
// Cockpit dispatch (Rust binary)
// ---------------------------------------------------------------------------
if (isCockpitDefault || isCockpitSubcommand) {
  const candidates = [
    join(packageDir, 'inspector', 'target', 'release', `beholder${exe}`),
    join(packageDir, 'inspector', 'target', 'debug', `beholder${exe}`),
  ];
  const rustBin = candidates.find(existsSync);

  if (!rustBin) {
    console.error('[beholder] Rust cockpit binary not found.');
    console.error('[beholder] Build it: cd inspector && cargo build --release');
    console.error('[beholder] Searched:');
    for (const c of candidates) console.error('             ' + c);
    process.exit(1);
  }

  // Resolve scripts/live.ts to an absolute path so the cockpit boots into
  // live mode no matter where the user invoked `beholder` from. Without
  // this, the Rust binary's relative-path lookup falls back to demo mode
  // when cwd != client/beholder/.
  const liveScript = join(packageDir, 'scripts', 'live.ts');
  const liveScriptExists = existsSync(liveScript);

  let cockpitArgs = argv;

  // Bare `beholder` is NO LONGER auto-routed to live mode. The Rust
  // binary's default_command picks tail-of-real-Claude-hooks when hooks
  // are installed (the right default for real users) and prints a help
  // message when not. Forcing `live --script` here would mask that logic
  // and put users into the showcase loop, defeating the real-data wire-up.
  // Users who explicitly want the showcase: `beholder live` (we still
  // inject the absolute script path below).
  if (first === 'live' && !argv.includes('--script')) {
    // Explicit `beholder live` without --script: inject the package-resolved
    // absolute path so it works from any cwd.
    if (liveScriptExists) {
      cockpitArgs = ['live', '--script', liveScript, ...argv.slice(1)];
    }
  }

  const child = spawn(rustBin, cockpitArgs, {
    stdio: 'inherit',
    // Force cwd to the package dir so the spawned Node child can resolve
    // its node_modules + relative imports (`../src/...` in live.ts).
    cwd:   packageDir,
    env:   process.env,
  });

  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else        process.exit(code ?? 0);
  });
  child.on('error', (err) => {
    console.error('[beholder] failed to launch cockpit:', err.message);
    process.exit(1);
  });

} else if (isTsSubcommand) {
  // -------------------------------------------------------------------------
  // TS subcommand dispatch (tsx)
  // -------------------------------------------------------------------------
  const subcommand = first;
  const forwardArgs = argv.slice(1);
  const scriptName = TS_SUBCOMMANDS[subcommand];
  const scriptPath = join(packageDir, 'scripts', scriptName);

  if (!existsSync(scriptPath)) {
    console.error(`[beholder] no script for subcommand '${subcommand}' (looked for ${scriptPath})`);
    process.exit(1);
  }

  const localTsx = join(
    packageDir,
    'node_modules',
    '.bin',
    isWindows ? 'tsx.cmd' : 'tsx',
  );
  let cmd, args;
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
    console.error('[beholder] failed to launch:', err.message);
    process.exit(1);
  });

} else {
  console.error(`[beholder] unknown subcommand '${first}'.`);
  console.error('[beholder] Available: inspect, live, mcp-wrap, watch, run, init-hooks');
  console.error('[beholder] Bare `beholder` (no args) opens the cockpit.');
  process.exit(2);
}
