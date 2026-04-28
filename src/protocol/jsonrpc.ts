/* enchanter/src/protocol/jsonrpc.ts — implements architecture-spec
   phase_3_mcp_protocol_surface.transports.envelope (MCP MUST: JSON-RPC 2.0).
   Counter: a typed RPC framework (gRPC, tRPC) would give compile-time safety
   but the MCP spec mandates JSON-RPC 2.0 wire format, so we honor the spec. */

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export class JsonRpcParseError extends Error {
  constructor(message: string, public readonly raw: string) {
    super(message);
    this.name = 'JsonRpcParseError';
  }
}

export class EmbeddedNewlineError extends Error {
  constructor() {
    super('JSON-RPC message contains embedded newline (MCP spec MUST NOT)');
    this.name = 'EmbeddedNewlineError';
  }
}

export function parseJsonRpc(raw: string): JsonRpcMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new JsonRpcParseError(`invalid JSON: ${(e as Error).message}`, raw);
  }
  if (!isObject(parsed) || parsed.jsonrpc !== '2.0') {
    throw new JsonRpcParseError('missing or invalid jsonrpc:"2.0" field', raw);
  }

  // Field shape validation — reject malformed servers before they reach plugin
  // dispatch. Catches the audit's "unchecked cast" finding on a typed boundary.
  if ('method' in parsed && typeof parsed['method'] !== 'string') {
    throw new JsonRpcParseError(`method must be string, got ${typeof parsed['method']}`, raw);
  }
  if ('id' in parsed) {
    const id = parsed['id'];
    if (id !== null && typeof id !== 'number' && typeof id !== 'string') {
      throw new JsonRpcParseError(`id must be number | string | null, got ${typeof id}`, raw);
    }
  }
  if ('error' in parsed) {
    const err = parsed['error'];
    if (!isObject(err) || typeof err['code'] !== 'number' || typeof err['message'] !== 'string') {
      throw new JsonRpcParseError('error must have number code and string message', raw);
    }
  }
  return parsed as unknown as JsonRpcMessage;
}

export function serializeJsonRpc(msg: JsonRpcMessage): string {
  const json = JSON.stringify(msg);
  if (json.includes('\n')) {
    // MCP MUST NOT for stdio transport — JSON.stringify never produces \n
    // unless the input data contained one and we set indent (we don't).
    // Defense in depth: reject if it ever appears.
    throw new EmbeddedNewlineError();
  }
  return json;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Standard JSON-RPC error codes + MCP/enchanter custom range
export const JSONRPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // enchanter custom (-32099..-32000 reserved range)
  SECURITY_VETO: -32099,
  VENDOR_UNAVAILABLE: -32098,
  SAMPLING_BOUND_EXCEEDED: -32097,
  TOOL_NAME_COLLISION: -32096,
  BUDGET_FLOOR_REFUSAL: -32095,
} as const;
