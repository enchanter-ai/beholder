#!/usr/bin/env node
/* scripts/hook-emit.mjs — git-hook → bus bridge.
 *
 * Invoked by .git/hooks/{pre-commit,pre-push,post-commit} (installed by
 * scripts/init-hooks.ts). Packages the hook payload into an EnchantedEvent
 * and forwards to a running enchanter inspector via BusClient.
 *
 *   <git-hook> ──▶ this script ──▶ BusClient ──▶ ws://127.0.0.1:3001/ws
 *
 * Why .mjs and not .ts: git hooks call this directly with `node`, no tsx.
 * Importing from the compiled dist/ keeps the call cheap and dependency-free.
 *
 * Usage:
 *   node hook-emit.mjs pre-commit  --staged "<newline-separated paths>"
 *   node hook-emit.mjs pre-push    --remote-name <n> --remote-url <u> --refs "<stdin lines>"
 *   node hook-emit.mjs post-commit --hash <sha> --author <a> --email <e> --subject <s>
 *
 * Failure mode: if the inspector isn't running, BusClient buffers and we
 * exit 0 anyway after a short flush window. Hooks must NEVER block git.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Resolve the compiled BusClient. We look in <pkg>/dist first; if missing
// (package not built), no-op cleanly so a fresh checkout doesn't break git.
// ---------------------------------------------------------------------------
const here       = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, '..');
const busClientJs = join(packageDir, 'dist', 'observability', 'bus-client.js');

if (!existsSync(busClientJs)) {
  // Silent no-op: better to ship green commits than to noisily fail because
  // the user hasn't run `npm run build` in this checkout.
  process.exit(0);
}

const { BusClient, DEFAULT_BROADCASTER_URL } = await import(pathToFileURL(busClientJs).href);

// ---------------------------------------------------------------------------
// Argv parsing — minimal, hook-specific. argv[2] is the hook name; the rest
// is a flat list of --flag value pairs.
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const hookName = argv[0];

if (!hookName) {
  process.stderr.write('hook-emit: missing hook name\n');
  process.exit(2);
}

const flags = {};
for (let i = 1; i < argv.length; i += 2) {
  const key = argv[i];
  const val = argv[i + 1] ?? '';
  if (typeof key === 'string' && key.startsWith('--')) {
    flags[key.slice(2)] = val;
  }
}

// ---------------------------------------------------------------------------
// Wire up the broadcaster — same defaults as mcp-wrap / watch.
// ---------------------------------------------------------------------------
const broadcaster = new BusClient(process.env.ENCHANTER_BUS_URL ?? DEFAULT_BROADCASTER_URL);
broadcaster.connect();

const correlationId = `hook-${randomUUID().slice(0, 8)}`;
const sessionId = 'git-hook';

function send(topic, payload) {
  const event = {
    id:             randomUUID(),
    correlation_id: correlationId,
    session_id:     sessionId,
    phase:          'cross-session',
    topic,
    source:         'git-hook',
    budget_tier:    'LOW',
    ts:             Date.now(),
    payload,
  };
  broadcaster.send(event);
}

// ---------------------------------------------------------------------------
// Per-hook event shaping
// ---------------------------------------------------------------------------
switch (hookName) {
  case 'pre-commit': {
    const staged = (flags['staged'] ?? '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    send('git.pre-commit.fired', {
      hook: 'pre-commit',
      staged_files: staged,
      staged_count: staged.length,
      cwd: process.cwd(),
    });
    break;
  }

  case 'pre-push': {
    // git pipes one line per ref-update on stdin:
    //   <local-ref> <local-sha> <remote-ref> <remote-sha>
    const refsBlob = flags['refs'] ?? '';
    const lines = refsBlob.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

    if (lines.length === 0) {
      // No refs (e.g. push --no-verify or empty stdin) — emit one summary.
      send('git.pre-push.fired', {
        hook: 'pre-push',
        remote_name: flags['remote-name'] ?? '',
        remote_url:  flags['remote-url']  ?? '',
        refs:        [],
        cwd: process.cwd(),
      });
    } else {
      // One event per ref-update for fan-out clarity in the inspector.
      for (const line of lines) {
        const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
        send('git.pre-push.fired', {
          hook: 'pre-push',
          remote_name: flags['remote-name'] ?? '',
          remote_url:  flags['remote-url']  ?? '',
          local_ref:   localRef  ?? '',
          local_sha:   localSha  ?? '',
          remote_ref:  remoteRef ?? '',
          remote_sha:  remoteSha ?? '',
          cwd: process.cwd(),
        });
      }
    }
    break;
  }

  case 'post-commit': {
    send('git.post-commit.fired', {
      hook: 'post-commit',
      hash:    flags['hash']    ?? '',
      author:  flags['author']  ?? '',
      email:   flags['email']   ?? '',
      subject: flags['subject'] ?? '',
      cwd: process.cwd(),
    });
    break;
  }

  default: {
    process.stderr.write(`hook-emit: unknown hook '${hookName}'\n`);
    broadcaster.close();
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Flush window. BusClient is fire-and-forget; give the WS a moment to send
// before the process exits. 200ms is enough for a local broadcaster and
// imperceptible to a developer running `git commit`.
// ---------------------------------------------------------------------------
setTimeout(() => {
  try { broadcaster.close(); } catch { /* ignore */ }
  process.exit(0);
}, 200);
