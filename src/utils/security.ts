import { antigravityEnv, isRecord } from "./util.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const ALLOWED_API_HOST_SUFFIXES = [".googleapis.com", ".sandbox.googleapis.com"];

/** Only loopback binds are allowed so OAuth codes cannot be stolen off-machine. */
export function resolveCallbackHost(raw = antigravityEnv("CALLBACK_HOST")): string {
  const host = (raw || "127.0.0.1").trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Unsafe ANTIGRAVITY_CALLBACK_HOST="${host}". Only loopback hosts are allowed: 127.0.0.1, ::1, localhost.`,
    );
  }
  return host === "localhost" ? "127.0.0.1" : host;
}

/** Prevent token exfiltration via poisoned BASE_URL (SSRF / credential leak). */
export function assertSafeApiBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ANTIGRAVITY_BASE_URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`ANTIGRAVITY_BASE_URL must use https (got ${url.protocol})`);
  }
  if (url.username || url.password) {
    throw new Error("ANTIGRAVITY_BASE_URL must not include credentials");
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    host === "googleapis.com" || ALLOWED_API_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (!allowed) {
    throw new Error(
      `ANTIGRAVITY_BASE_URL host "${host}" is not allowed. Use a *.googleapis.com endpoint.`,
    );
  }
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path === "/" ? "" : path}`;
}

/**
 * Query parameter names whose values carry credentials. A fragment carries the same
 * kind of value as a query string, so `#access_token=...` is covered too.
 */
const SECRET_QUERY_NAME =
  /^(?:access_token|refresh_token|id_token|token|client_secret|code_verifier|code|authorization|api[_-]?key|key|secret|password|passwd|signature|sig|credential|oauth_token|oauth_signature|oauth_consumer_key|auth|jwt|session|sid|awsaccesskeyid|state|nonce|x-amz-credential|x-amz-signature|x-amz-security-token|x-goog-credential|x-goog-signature)$/i;

/**
 * Redact URL userinfo and sensitive query values embedded in text. This is one layer
 * of {@link redactSecrets}: model-facing text must go through the stronger redactor.
 */
function redactUrlSecrets(text: string): string {
  return text
    .replace(/\b(https?:\/\/)[^/?#\s]*@/gi, "$1[redacted]@")
    .replace(/([?&#])([^=&#\s]+)=([^&#\s]*)/g, (match, separator: string, name: string) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(name.replace(/\+/g, " "));
      } catch {
        return match;
      }
      return SECRET_QUERY_NAME.test(decoded) ? `${separator}${name}=[redacted]` : match;
    });
}

/**
 * Credential names redacted from free-form diagnostics. `code` is deliberately absent:
 * it is far too common in prose ("exit code=1"), and URLs are covered by the URL
 * layer, which does redact `?code=`.
 */
const SECRET_ASSIGNMENT_NAME =
  /"?(?:access_token|refresh_token|id_token|token|client_secret|code_verifier|authorization|password|passwd|secret|api[_-]?key|signature|sig|oauth_token|oauth_signature|oauth_consumer_key|auth|jwt|session|sid|awsaccesskeyid|state|nonce)"?\s*[:=]\s*/gi;

/** Redact bearer tokens, refresh tokens, and similar secrets from diagnostics/errors. */
export function redactSecrets(text: string): string {
  return redactUrlSecrets(
    text
      .replace(/\bya29\.[A-Za-z0-9._~+/-]+=*/g, "[redacted-access-token]")
      .replace(/\b1\/[A-Za-z0-9_-]{20,}/g, "[redacted-refresh-token]")
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
      .replace(new RegExp(`(${SECRET_ASSIGNMENT_NAME.source}")[^"]*(")`, "gi"), "$1[redacted]$2")
      .replace(new RegExp(`(${SECRET_ASSIGNMENT_NAME.source})[^\\s&,}]+`, "gi"), "$1[redacted]"),
  );
}

const VALIDATION_URL_HOST = "accounts.google.com";

/** Accept only the Google account-verification host, never an arbitrary redirect. */
export function safeValidationUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /\s/.test(value))
    return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password) return undefined;
  if (url.hostname !== VALIDATION_URL_HOST) return undefined;
  return url.toString();
}

/** Pull `validation_url` from a 403 body before message slicing can drop it. */
export function extractValidationUrl(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: { details?: unknown } };
    const details = parsed.error?.details;
    if (Array.isArray(details)) {
      for (const detail of details) {
        if (!isRecord(detail) || !isRecord(detail.metadata)) continue;
        const safe = safeValidationUrl(detail.metadata.validation_url);
        if (safe) return safe;
      }
    }
  } catch {
    // not JSON
  }
  const match = text.match(/https:\/\/accounts\.google\.com\/[^\s"'<>\\]+/);
  return match ? safeValidationUrl(match[0].replace(/[),.;]+$/, "")) : undefined;
}

/** Keep session-bearing verification links out of doctor output and stored diagnostics. */
export function stripValidationUrls(text: string): string {
  return text
    .replace(/https:\/\/accounts\.google\.com\/[^\s"'<>\\]+/g, "[redacted-validation-url]")
    .replace(
      / Open this link in a browser signed in to the same Google account to verify: \[redacted-validation-url\]/g,
      "",
    );
}

export function maskEmail(email: string | undefined): string | undefined {
  if (!email || typeof email !== "string") return undefined;
  const parts = email.split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return "[redacted-email]";
  const name = parts[0];
  const domain = parts[1];
  const lastChar = name.at(-1) || "";
  const maskedName = name.length > 2 ? `${name[0]}***${lastChar}` : `${name[0]}***`;
  return `${maskedName}@${domain}`;
}

export function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecrets(raw);
}
