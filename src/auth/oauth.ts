import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { defaultProjectId, loadCodeAssist } from "../client/client.js";
import { escapeHtml, antigravityEnv } from "../utils/util.js";
import { resolveCallbackHost, redactSecrets } from "../utils/security.js";
import type { AntigravityOAuthCredentials, CallbackServer } from "../types/types.js";

export const REDIRECT_URI = "http://localhost:51121/oauth-callback";
export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
export const SCOPES = [
  "https://www.googleapis.com/auth/aicode",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

/**
 * Default OAuth client is Google's public Antigravity desktop client (not a private app secret).
 * Prefer ANTIGRAVITY_CLIENT_ID / ANTIGRAVITY_CLIENT_SECRET when you manage your own OAuth app.
 */
export const CLIENT_ID =
  antigravityEnv("CLIENT_ID") ||
  atob(
    "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlc" +
      "C5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
  );
export const CLIENT_SECRET =
  antigravityEnv("CLIENT_SECRET") || atob("R09DU1BYLUs1OEZXUjQ" + "4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");

export const CALLBACK_HOST = resolveCallbackHost();

function oauthCallbackHeaders(contentType = "text/html; charset=utf-8"): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
  };
}

function sanitizeOAuthProviderError(text: string): string {
  const redacted = redactSecrets(text).trim();
  try {
    const parsed = JSON.parse(redacted) as {
      error?: string;
      error_description?: string;
    };
    const parts = [parsed.error, parsed.error_description].filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    );
    if (parts.length) return parts.join(": ").slice(0, 300);
  } catch {
    // not JSON
  }
  return redacted.slice(0, 300) || "unknown OAuth provider error";
}

function base64Url(bytes: Uint8Array): string {
  return bytes.toBase64({ alphabet: "base64url", omitPadding: true });
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64Url(
    new Uint8Array(new Bun.CryptoHasher("sha256").update(verifier).digest()),
  );
  return { verifier, challenge };
}

async function getUserEmail(token: string): Promise<string | undefined> {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { email?: string };
    return data.email;
  } catch {
    return undefined;
  }
}

function startCallbackServer(expectedState: string): CallbackServer {
  let settled = false;
  const timer: { id?: ReturnType<typeof setTimeout> } = {};
  let resolveCode!: (value: { code: string; state: string }) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<{ code: string; state: string }>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const finish = (fn: () => void) => {
    if (settled) return;
    settled = true;
    if (timer.id) clearTimeout(timer.id);
    fn();
  };

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: CALLBACK_HOST,
      port: 51121,
      // Login can take minutes; disable Bun's default 10s idle disconnect.
      idleTimeout: 0,
      fetch(req) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return new Response("Method Not Allowed", {
            status: 405,
            headers: oauthCallbackHeaders("text/plain; charset=utf-8"),
          });
        }

        const url = new URL(req.url);
        if (url.pathname !== "/oauth-callback") {
          return new Response("Antigravity OAuth callback route not found.", {
            status: 404,
            headers: oauthCallbackHeaders(),
          });
        }

        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (error) {
          const safe = escapeHtml(error.slice(0, 200));
          finish(() => rejectCode(new Error(`OAuth error: ${error.slice(0, 200)}`)));
          return new Response(`Antigravity authentication failed: ${safe}`, {
            status: 400,
            headers: oauthCallbackHeaders(),
          });
        }
        if (!code || !state) {
          finish(() => rejectCode(new Error("Missing code or state in OAuth callback")));
          return new Response("Antigravity authentication failed: missing code or state.", {
            status: 400,
            headers: oauthCallbackHeaders(),
          });
        }
        if (state !== expectedState) {
          finish(() => rejectCode(new Error("OAuth state mismatch")));
          return new Response("Antigravity authentication failed: invalid state.", {
            status: 400,
            headers: oauthCallbackHeaders(),
          });
        }

        finish(() => resolveCode({ code, state }));
        return new Response(
          "Antigravity authentication complete. You can close this window and return to Pi.",
          { status: 200, headers: oauthCallbackHeaders() },
        );
      },
    });
  } catch (err: unknown) {
    const code = typeof err === "object" && err && "code" in err ? String(err.code) : undefined;
    const message = err instanceof Error ? err.message : String(err);
    if (code === "EADDRINUSE" || /in use/i.test(message)) {
      throw new Error(
        "Port 51121 is already in use by another process. Please close the process using port 51121 and retry /login antigravity.",
        { cause: err },
      );
    }
    throw err instanceof Error ? err : new Error(message, { cause: err });
  }

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void server.stop(true);
  };
  const cleanup = () => {
    finish(() => rejectCode(new Error("OAuth callback cancelled")));
    close();
  };

  timer.id = setTimeout(() => {
    finish(() => rejectCode(new Error("OAuth callback timed out waiting for browser login")));
    close();
  }, OAUTH_CALLBACK_TIMEOUT_MS);

  return { server, waitForCode: () => codePromise, cleanup };
}

function credentialProjectId(credentials: OAuthCredentials): string | undefined {
  const projectId = (credentials as AntigravityOAuthCredentials).projectId;
  return typeof projectId === "string" ? projectId : undefined;
}

function credentialEmail(credentials: OAuthCredentials): string | undefined {
  const email = (credentials as AntigravityOAuthCredentials).email;
  return typeof email === "string" ? email : undefined;
}

/**
 * Parse a callback URL (or bare query string) pasted by the user from a
 * remote/headless browser that could not reach the local callback server.
 * Returns the validated {code, state} or throws a descriptive error. The checks
 * mirror the local callback server so a pasted URL is accepted under the exact
 * same rules as a same-machine browser redirect.
 */
function parsePastedCallback(raw: string, expectedState: string): { code: string; state: string } {
  const text = (raw ?? "").trim();
  if (!text) {
    throw new Error(
      "No callback pasted. Paste the full URL from your browser's address bar (http://localhost:51121/oauth-callback?…).",
    );
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    // Bare query string: "state=…&code=…" or "?state=…&code=…"
    const qs = text.startsWith("?") ? text.slice(1) : text;
    url = new URL(`http://localhost:51121/oauth-callback?${qs}`);
  }
  const error = url.searchParams.get("error");
  if (error) throw new Error(`OAuth error from browser: ${error.slice(0, 200)}`);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    throw new Error(
      "Pasted text is missing 'code' or 'state'. Paste the FULL callback URL from your browser's address bar (http://localhost:51121/oauth-callback?…).",
    );
  }
  if (state !== expectedState) {
    throw new Error(
      "State mismatch: that callback is from a different sign-in. Re-run /login antigravity, sign in again, and paste the new URL.",
    );
  }
  return { code, state };
}

/**
 * Resolve the authorization code from either the local callback server (browser
 * on the same machine) or a pasted callback URL (browser on a remote/headless
 * machine that cannot reach localhost:51121). Whichever provides a valid code
 * first wins; the losing path is cancelled. Honors callbacks.signal for cancel.
 */
async function acquireAuthCode(
  expectedState: string,
  opts: {
    waitForCode: () => Promise<{ code: string; state: string }>;
    callbacks: OAuthLoginCallbacks;
  },
): Promise<{ code: string; state: string }> {
  const { waitForCode, callbacks } = opts;
  // Signals the losing candidate(s) to stop once the race settles.
  const settle = new AbortController();
  const candidates: Promise<{ code: string; state: string }>[] = [waitForCode()];

  // Manual paste path: offered whenever the callback surface can prompt.
  if (typeof callbacks.onPrompt === "function") {
    const promptLoop = async (): Promise<{ code: string; state: string }> => {
      let promptMessage =
        "Remote/headless machine (your browser can't reach localhost:51121)? " +
        "After signing in, paste the full callback URL shown in your browser's address bar.";
      while (true) {
        if (callbacks.signal?.aborted || settle.signal.aborted) {
          throw new Error("Login cancelled");
        }
        let text: string;
        try {
          text = await callbacks.onPrompt({
            message: promptMessage,
            placeholder: "http://localhost:51121/oauth-callback?state=…&code=…",
          });
        } catch (err: unknown) {
          // Prompt/transport failure — propagate, do not retry.
          throw err instanceof Error ? err : new Error(String(err));
        }
        if (callbacks.signal?.aborted || settle.signal.aborted) {
          throw new Error("Login cancelled");
        }
        try {
          return parsePastedCallback(text, expectedState);
        } catch (err: unknown) {
          if (callbacks.signal?.aborted || settle.signal.aborted) {
            throw new Error("Login cancelled", { cause: err });
          }
          const errorMessage = err instanceof Error ? err.message : String(err);
          promptMessage = `Invalid callback (${errorMessage}). Please paste the full URL:`;
        }
      }
    };
    candidates.push(promptLoop());
  }

  // Flow cancellation (escape) aborts the whole login when a signal is provided.
  let removeAbortListener: (() => void) | undefined;
  if (callbacks.signal) {
    candidates.push(
      new Promise<never>((_resolve, reject) => {
        const signal = callbacks.signal as AbortSignal;
        if (signal.aborted) return reject(new Error("Login cancelled"));
        const onAbort = () => reject(new Error("Login cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }),
    );
  }

  // Suppress unhandled rejections from losing candidates after the race settles.
  for (const candidate of candidates) {
    candidate.catch(() => {});
  }

  try {
    return await Promise.race(candidates);
  } finally {
    settle.abort();
    removeAbortListener?.();
  }
}

export async function loginAntigravity(
  callbacks: OAuthLoginCallbacks,
): Promise<AntigravityOAuthCredentials> {
  const { verifier, challenge } = generatePKCE();
  // State must be independent of the PKCE verifier so a leaked callback URL
  // cannot also disclose the code_verifier needed to mint tokens.
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const { waitForCode, cleanup } = startCallbackServer(state);
  try {
    const authParams = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: SCOPES.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      prompt: "consent",
    });
    callbacks.onAuth({
      url: `${AUTH_URL}?${authParams.toString()}`,
      instructions:
        "Complete Google sign-in. Pi captures the local callback automatically — or, on a remote/headless machine, paste the callback URL when prompted.",
    });

    const { code, state: returnedState } = await acquireAuthCode(state, {
      waitForCode,
      callbacks,
    });
    if (returnedState !== state) throw new Error("OAuth state mismatch");

    const tokenResponse = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }).toString(),
    });
    if (!tokenResponse.ok) {
      throw new Error(
        `Token exchange failed: ${sanitizeOAuthProviderError(await tokenResponse.text())}`,
      );
    }
    const tokenData = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };
    if (!tokenData.refresh_token) {
      throw new Error(
        "No refresh token received. Re-run /login antigravity and allow offline access.",
      );
    }

    const [email, discoveredProject] = await Promise.all([
      getUserEmail(tokenData.access_token),
      loadCodeAssist(tokenData.access_token),
    ]);
    return {
      refresh: tokenData.refresh_token,
      access: tokenData.access_token,
      expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
      projectId: discoveredProject || defaultProjectId(email || "antigravity-default"),
      email,
    };
  } finally {
    cleanup();
  }
}

export async function refreshAntigravityToken(
  credentials: OAuthCredentials,
): Promise<AntigravityOAuthCredentials> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: credentials.refresh,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(
      `Antigravity token refresh failed: ${sanitizeOAuthProviderError(await response.text())}`,
    );
  }
  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };
  // Every refresh mints a brand-new access token, so loadCodeAssist's token-keyed cache
  // can never hit here — skip the extra round-trip entirely when we already know the
  // project id (the normal case; it's set at login and doesn't change token to token).
  const existingProjectId = credentialProjectId(credentials);
  const discoveredProject = existingProjectId ? undefined : await loadCodeAssist(data.access_token);
  const email = credentialEmail(credentials);
  return {
    ...credentials,
    refresh: data.refresh_token || credentials.refresh,
    access: data.access_token,
    expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    projectId:
      existingProjectId || discoveredProject || defaultProjectId(email || "antigravity-default"),
  };
}

export function getApiKey(credentials: OAuthCredentials): string {
  const email = credentialEmail(credentials);
  return JSON.stringify({
    token: credentials.access,
    projectId: credentialProjectId(credentials) || defaultProjectId(email || "antigravity-default"),
  });
}

export type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
