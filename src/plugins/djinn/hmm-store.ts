/* enchanter/src/plugins/djinn/hmm-store.ts — v0.4 carry-over #3.
   Persists per-session HMM forward state across enchanter restarts so D2
   drift labelling is continuous, not reset-on-restart. v0.3.1 deferred
   persistence (docs/v0.3/djinn-d2-hmm.md "Open questions"); this module
   closes that gap.

   Two implementations:
     - InMemoryHmmStore: pure Map<sessionId, snapshot>. Default + back-compat.
     - PersistentHmmStore: append-only JSONL with replay-on-construct. The
       latest record per sessionId wins; corrupt trailing line is tolerated.

   The pattern mirrors src/oauth/replay-store.ts (ReplayStore) and
   src/plugins/pech/ledger-store.ts (LedgerStore): line-atomic appendFileSync,
   tolerant replay, no multi-process semantics. Stdlib only — node:fs +
   node:path. */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HmmStateSnapshot } from './hmm.js';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface HmmStore {
  /** Return the latest snapshot for the session, or undefined if none. */
  load(sessionId: string): HmmStateSnapshot | undefined;
  /** Persist a snapshot for the session. Overwrites any prior snapshot. */
  save(sessionId: string, snap: HmmStateSnapshot): void;
  /** Drop the session's snapshot. */
  clear(sessionId: string): void;
}

// ---------------------------------------------------------------------------
// InMemoryHmmStore — pure process-local state.
// ---------------------------------------------------------------------------

export class InMemoryHmmStore implements HmmStore {
  protected readonly entries = new Map<string, HmmStateSnapshot>();

  load(sessionId: string): HmmStateSnapshot | undefined {
    return this.entries.get(sessionId);
  }

  save(sessionId: string, snap: HmmStateSnapshot): void {
    this.entries.set(sessionId, snap);
    this.onSave(sessionId, snap);
  }

  clear(sessionId: string): void {
    this.entries.delete(sessionId);
    this.onClear(sessionId);
  }

  // Hooks for the persistent subclass; in-memory is a no-op.
  protected onSave(_sessionId: string, _snap: HmmStateSnapshot): void {
    /* no-op */
  }
  protected onClear(_sessionId: string): void {
    /* no-op */
  }
}

// ---------------------------------------------------------------------------
// PersistentHmmStore — JSONL append-only on disk.
// ---------------------------------------------------------------------------

/**
 * One JSONL line is either a save or a clear. Replay-on-construct walks the
 * file top-to-bottom; later records for the same sessionId overwrite earlier
 * ones (last-writer-wins), and a clear record removes any prior save.
 */
type JsonlLine =
  | { op: 'save'; sessionId: string; snap: HmmStateSnapshot; ts: number }
  | { op: 'clear'; sessionId: string; ts: number };

export class PersistentHmmStore extends InMemoryHmmStore {
  readonly path: string;

  constructor(path: string) {
    super();
    this.path = path;
    const dir = dirname(path);
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.replayFromDisk();
  }

  protected override onSave(sessionId: string, snap: HmmStateSnapshot): void {
    const line: JsonlLine = { op: 'save', sessionId, snap, ts: Date.now() };
    this.appendLine(line);
  }

  protected override onClear(sessionId: string): void {
    const line: JsonlLine = { op: 'clear', sessionId, ts: Date.now() };
    this.appendLine(line);
  }

  private appendLine(line: JsonlLine): void {
    try {
      appendFileSync(this.path, JSON.stringify(line) + '\n', { encoding: 'utf8' });
    } catch {
      // Best-effort: persistence failures must not break the in-memory path.
      // Mirrors pech ledger-store / replay-store fail-soft posture — the HMM
      // is advisory and a write error here only degrades restart durability,
      // not the live drift signal.
    }
  }

  private replayFromDisk(): void {
    if (!existsSync(this.path)) return;
    let raw: string;
    try {
      raw = readFileSync(this.path, { encoding: 'utf8' });
    } catch {
      return;
    }
    if (raw.length === 0) return;

    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      let parsed: JsonlLine;
      try {
        parsed = JSON.parse(line) as JsonlLine;
      } catch {
        // Tolerate a corrupt trailing line (crash mid-write). Mirrors
        // PersistentReplayStore.replayFromDisk.
        continue;
      }

      if (parsed && typeof parsed === 'object' && 'op' in parsed) {
        if (parsed.op === 'save' && isValidSnapshot(parsed.snap)) {
          this.entries.set(parsed.sessionId, parsed.snap);
        } else if (parsed.op === 'clear') {
          this.entries.delete(parsed.sessionId);
        }
        // Anything else is silently skipped — schema drift across versions
        // shouldn't poison live state.
      }
    }
  }
}

function isValidSnapshot(snap: unknown): snap is HmmStateSnapshot {
  if (!snap || typeof snap !== 'object') return false;
  const s = snap as { posterior?: unknown; initialized?: unknown };
  if (!Array.isArray(s.posterior) || s.posterior.length !== 3) return false;
  if (!s.posterior.every((x) => typeof x === 'number' && Number.isFinite(x))) return false;
  if (typeof s.initialized !== 'boolean') return false;
  return true;
}
