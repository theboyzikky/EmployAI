// Typed AI errors (ported from PoC-A0). Messages never contain secrets (see redact()).
export type AiErrorCode =
  | "CONFIG"             // provider missing, misconfigured or not approved
  | "AUTH"               // 401
  | "CREDITS_EXHAUSTED"  // 402 from the provider (credits or provider-side spend limit)
  | "RATE_LIMITED"       // 429
  | "UPSTREAM"           // other 4xx/5xx
  | "TIMEOUT"
  | "NETWORK"
  | "SCHEMA_INVALID"     // model output is not valid JSON or does not match the schema
  | "TRUNCATED"          // finish_reason = length
  | "BUDGET_CAP"         // local daily USD cap would be exceeded
  | "CALL_LIMIT"         // local max-calls ceiling reached
  | "USAGE_MISSING"      // response lacks usage → spending cannot be capped reliably
  | "PRICE_UNKNOWN";     // no catalogue price for the model → refuse

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly status?: number;
  readonly provider: string;
  constructor(code: AiErrorCode, provider: string, message: string, status?: number) {
    super(redact(message));
    this.name = "AiError";
    this.code = code;
    this.provider = provider;
    this.status = status;
  }
}

const secrets = new Set<string>();
/** Register a secret so it is scrubbed from every error message. */
export function registerSecret(s: string | undefined) { if (s) secrets.add(s); }
export function redact(text: string): string {
  let out = String(text ?? "");
  for (const s of secrets) out = out.split(s).join("[REDACTED]");
  return out.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[REDACTED]");
}

/** Plain-language explanation for the UI. Never includes provider responses or secrets. */
export function describeAiError(code: AiErrorCode | "UNKNOWN"): string {
  switch (code) {
    case "CONFIG": return "The AI provider isn't configured or approved on this server.";
    case "AUTH": return "The AI provider rejected the server's credentials.";
    case "CREDITS_EXHAUSTED": return "The AI provider's credit or spending limit has been reached.";
    case "RATE_LIMITED": return "The AI provider is busy. Please try again in a moment.";
    case "TIMEOUT": return "The AI provider took too long to answer.";
    case "NETWORK": return "The server couldn't reach the AI provider.";
    case "UPSTREAM": return "The AI provider returned an error.";
    case "SCHEMA_INVALID":
    case "TRUNCATED": return "The AI's answer didn't pass validation, so it wasn't used.";
    case "BUDGET_CAP": return "Today's AI spending cap has been reached.";
    case "CALL_LIMIT": return "The approved number of AI calls has been used.";
    case "USAGE_MISSING":
    case "PRICE_UNKNOWN": return "AI spending couldn't be measured reliably, so further calls are stopped.";
    default: return "The AI consultant is unavailable right now.";
  }
}
