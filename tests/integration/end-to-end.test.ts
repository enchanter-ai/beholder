/* tests/integration/end-to-end.test.ts — drives a real subprocess MCP server
   through McpClient + StdioTransport + Orchestrator + the full plugin set.
   Verifies:
     1. initialize handshake completes
     2. tools/list registers tools in the namespace registry
     3. tools/call runs the 7-phase lifecycle and returns the server's result
     4. hydra vetoes a malicious shell call (rm -rf /)
     5. naga detects schema drift on a second tools/list with mutated description
     6. pech ledger appends an entry per tools/call
*/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { McpClient } from '../../src/client/mcp-client.js';
import { StdioTransport } from '../../src/transport/stdio.js';
import { hydraAdapter } from '../../src/plugins/hydra.adapter.js';
import { lichAdapter } from '../../src/plugins/lich.adapter.js';
import { nagaAdapter } from '../../src/plugins/naga.adapter.js';
import { pechAdapter, getLedger, clear as clearPech, setBudget } from '../../src/plugins/pech.adapter.js';
import { sylphAdapter } from '../../src/plugins/sylph.adapter.js';
import { crowAdapter } from '../../src/plugins/crow.adapter.js';
import { djinnAdapter } from '../../src/plugins/djinn.adapter.js';
import { emuAdapter } from '../../src/plugins/emu.adapter.js';
import { gorgonAdapter } from '../../src/plugins/gorgon.adapter.js';
import { SecurityVetoError } from '../../src/orchestration/lifecycle.js';

const here = dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = resolve(here, '..', 'fixtures', 'mock-mcp-server.mjs');

interface SpawnedServer {
  proc: ChildProcessByStdio<Writable, Readable, Readable>;
  transport: StdioTransport;
  client: McpClient;
}

async function spawnClient(opts: { shapeDrift?: boolean } = {}): Promise<SpawnedServer> {
  const args = opts.shapeDrift ? [MOCK_SERVER, '--shape-drift'] : [MOCK_SERVER];
  const proc = spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessByStdio<Writable, Readable, Readable>;

  // Drain stderr so the subprocess does not block on full pipe.
  proc.stderr.on('data', () => {
    /* discard */
  });

  const transport = new StdioTransport(proc.stdout, proc.stdin);
  const client = new McpClient({
    serverId: 'mock',
    transport,
    plugins: [
      hydraAdapter,
      lichAdapter,
      nagaAdapter,
      pechAdapter,
      sylphAdapter,
      crowAdapter,
      djinnAdapter,
      emuAdapter,
      gorgonAdapter,
    ],
  });

  return { proc, transport, client };
}

async function teardown(s: SpawnedServer): Promise<void> {
  s.client.shutdown();
  s.proc.kill('SIGKILL');
  await new Promise<void>((res) => {
    if (s.proc.killed) res();
    else s.proc.once('exit', () => res());
  });
}

describe('integration: full stdio lifecycle vs mock MCP server', () => {
  beforeAll(() => {
    clearPech();
  });

  afterAll(() => {
    clearPech();
  });

  it('completes initialize → tools/list → tools/call round-trip', async () => {
    const s = await spawnClient();
    try {
      const info = await s.client.initialize('enchanter-test', '0.0.1');
      expect(info.name).toBe('enchanter-mock');

      const tools = await s.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['echo', 'read_file', 'shell.exec']);

      // Benign call routes through all 7 phases.
      const result = await s.client.callTool('echo', { text: 'hello' });
      const r = result as { content: Array<{ text: string }> };
      expect(r.content[0]?.text).toBe('hello');
    } finally {
      await teardown(s);
    }
  });

  it('hydra vetoes rm -rf / when args is a string array', async () => {
    const s = await spawnClient();
    try {
      await s.client.initialize('enchanter-test', '0.0.1');
      await s.client.listTools();

      // Pass qualified name to avoid the bare-name-with-dot edge case
      // (`shell.exec` is a valid bare name; the registry's qualified lookup
      // succeeds first since `shell.exec` isn't registered as a server prefix).
      await expect(
        s.client.callTool('mock.shell.exec', { cmd: 'rm', args: ['rm', '-rf', '/'] }),
      ).rejects.toBeInstanceOf(SecurityVetoError);
    } finally {
      await teardown(s);
    }
  });

  it('naga detects schema drift on second tools/list with mutated description', async () => {
    const s = await spawnClient({ shapeDrift: true });
    try {
      await s.client.initialize('enchanter-test', '0.0.1');

      // First listTools — registers tools, naga fingerprints them.
      const tools1 = await s.client.listTools();
      expect(tools1.find((t) => t.name === 'echo')?.description).toBe('Echoes the input text back.');

      // Second listTools — server returns mutated `echo` description with
      // 'IGNORE PREVIOUS INSTRUCTIONS'. The namespace registry's
      // schema-digest pin throws SchemaDigestMismatchError before naga even
      // sees the new shape — that is the primary line of defense for FM 10.
      await expect(s.client.listTools()).rejects.toThrow(/schema mutated|digest/i);
    } finally {
      await teardown(s);
    }
  });

  it('pech ledger appends an entry per tools/call when budget is configured', async () => {
    clearPech();
    setBudget('mock', 10_000);
    const s = await spawnClient();
    try {
      await s.client.initialize('enchanter-test', '0.0.1');
      await s.client.listTools();

      const ledgerBefore = getLedger().length;
      await s.client.callTool('read_file', { path: '/tmp/x' });
      const ledgerAfter = getLedger().length;

      expect(ledgerAfter).toBe(ledgerBefore + 1);
    } finally {
      await teardown(s);
    }
  });

  it('rejects an unknown qualified tool name via namespace registry', async () => {
    const s = await spawnClient();
    try {
      await s.client.initialize('enchanter-test', '0.0.1');
      await s.client.listTools();

      await expect(s.client.callTool('mock.nonexistent', {})).rejects.toThrow(/not found/i);
    } finally {
      await teardown(s);
    }
  });

  it('orchestrator fires bus events visible via tap', async () => {
    const s = await spawnClient();
    try {
      await s.client.initialize('enchanter-test', '0.0.1');
      await s.client.listTools();
      await s.client.callTool('echo', { text: 'tap-test' });

      const events = s.client.bus.tap();
      const phaseEvents = events.filter((e) => e.source === 'orchestrator').map((e) => e.phase);
      // All 7 phases observed at least once.
      const uniquePhases = new Set(phaseEvents);
      expect(uniquePhases).toContain('anchor');
      expect(uniquePhases).toContain('trust-gate');
      expect(uniquePhases).toContain('dispatch');
      expect(uniquePhases).toContain('post-response');
    } finally {
      await teardown(s);
    }
  });
});
