// Typed AI errors. Messages never contain secrets (see redact()).
export type AiErrorCode =
  | 'CONFIG'             // provider misconfigured or not approved
  | 'AUTH'               // 401
  | 'CREDITS_EXHAUSTED'  // 402 from provider (credits or provider-side spend limit)
  | 'RATE_LIMITED'       // 429
  | 'UPSTREAM'           // 4xx/5xx other than above
  | 'TIMEOUT'
  | 'NETWORK'
  | 'SCHEMA_INVALID'     // model output is not valid JSON / does not match schema
  | 'TRUNCATED'          // finish_reason = length
  | 'NO_TOOL_CALL'       // tool task returned no / multiple / malformed tool calls
  | 'BUDGET_CAP'         // local daily USD cap would be exceeded
  | 'CALL_LIMIT'         // local max-calls ceiling reached
  | 'USAGE_MISSING'      // response lacks usage → spending cannot be capped reliably
  | 'PRICE_UNKNOWN';     // no catalogue price for the model → refuse

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly status?: number;
  readonly provider: string;
  constructor(code: AiErrorCode, provider: string, message: string, status?: number) {
    super(redact(message));
    this.name = 'AiError';
    this.code = code;
    this.provider = provider;
    this.status = status;
  }
}

const secrets = new Set<string>();
/** Register a secret so it is scrubbed from every error message. */
export function registerSecret(s: string | undefined) { if (s) secrets.add(s); }
export function redact(text: string): string {
  let out = String(text ?? '');
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  return out.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]');
}
