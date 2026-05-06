/* src/observability/control-protocol.ts — typed control messages exchanged
 * over the bidirectional bridge channel.
 *
 * Direction is inferred from `kind`:
 *   - inbound to runtime (from inspector): { kind: "control.command", command: "approval.response", ... }
 *   - outbound to inspector              : standard event JSONL (see bridge.ts)
 *
 * The control channel is OPT-IN. When no ControlChannel is attached the
 * trust-gate behaves identically to v0.4 (no approval prompt, plugins decide
 * alone). When attached, the orchestrator emits a `request.approval` event
 * AND awaits a matching `approval.response` keyed by `correlation_id`.
 *
 * Default timeout for the await: 30 seconds. On timeout we fail closed
 * (decision = veto) — the channel is configured by an operator who wants
 * the human in the loop, so missing decisions must not silently approve.
 */

export type ApprovalDecision = 'approve' | 'veto';

/** Inbound message from the inspector to the runtime. */
export interface ApprovalResponse {
  readonly kind: 'control.command';
  readonly command: 'approval.response';
  readonly correlation_id: string;
  readonly decision: ApprovalDecision;
  readonly reason?: string;
}

export type ControlCommand = ApprovalResponse;

/** Default timeout for trust-gate approval awaits (ms). */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;

/** Tolerant decoder: returns null on shape mismatch so the caller can log+skip. */
export function parseControlLine(line: string): ControlCommand | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (o.kind !== 'control.command') return null;
  if (o.command === 'approval.response') {
    if (typeof o.correlation_id !== 'string') return null;
    if (o.decision !== 'approve' && o.decision !== 'veto') return null;
    const out: ApprovalResponse = {
      kind: 'control.command',
      command: 'approval.response',
      correlation_id: o.correlation_id,
      decision: o.decision,
    };
    if (typeof o.reason === 'string') {
      return { ...out, reason: o.reason };
    }
    return out;
  }
  return null;
}

/**
 * In-process dispatcher: keeps a map of pending approval correlation_ids and
 * resolves them when a matching `approval.response` arrives. Producers call
 * `awaitDecision(correlation_id)` to get a Promise<ApprovalResponse>;
 * consumers (the read half of the channel) call `dispatch(line)` for each
 * inbound JSONL line.
 */
export class ControlDispatcher {
  private readonly pending = new Map<
    string,
    {
      resolve: (r: ApprovalResponse) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  /** Register a wait. Returns a Promise that resolves on matching response or
   *  rejects on timeout / cancel. */
  awaitDecision(correlation_id: string, timeoutMs: number): Promise<ApprovalResponse> {
    return new Promise<ApprovalResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlation_id);
        reject(new Error(`approval timeout after ${timeoutMs}ms for ${correlation_id}`));
      }, timeoutMs);
      this.pending.set(correlation_id, { resolve, reject, timer });
    });
  }

  /** Feed an inbound JSONL line. Returns true when it resolved a pending wait. */
  dispatch(line: string): boolean {
    const cmd = parseControlLine(line);
    if (!cmd) return false;
    if (cmd.command !== 'approval.response') return false;
    const slot = this.pending.get(cmd.correlation_id);
    if (!slot) return false;
    clearTimeout(slot.timer);
    this.pending.delete(cmd.correlation_id);
    slot.resolve(cmd);
    return true;
  }

  /** Cancel every pending wait — used at shutdown. */
  cancelAll(reason: string): void {
    for (const [, slot] of this.pending) {
      clearTimeout(slot.timer);
      slot.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /** Test/inspection helper. */
  pendingCount(): number {
    return this.pending.size;
  }
}

/**
 * Minimal contract for the bidirectional channel the orchestrator awaits on.
 * The bridge implements this; tests can stub it with paired in-memory sockets.
 */
export interface ControlChannel {
  /** Emit a `request.approval` event line out to the inspector. */
  sendRequestApproval(req: {
    correlation_id: string;
    plugin: string;
    reason: string;
    phase: string;
    payload?: Record<string, unknown>;
    time?: number;
  }): void | Promise<void>;

  /** Await a decision matching correlation_id. Rejects on timeout. */
  awaitDecision(correlation_id: string, timeoutMs?: number): Promise<ApprovalResponse>;
}
