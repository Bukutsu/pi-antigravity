# Changelog

All notable changes to this project are documented in this file.

## [0.2.9] - 2026-08-15

### Fixed

- **Gemini 3.7 Flash runtime routing:** Route every displayed effort through the live `gemini-3.7-flash-tiered` runtime and send Low, Medium, or High via `generationConfig.thinkingConfig`. Add the `aicode` OAuth scope used by the current Antigravity CLI so future logins receive the complete model catalog.

## [0.2.8] - 2026-08-14

### Added

- **Gemini 3.7 Flash Support:** Added public model `gemini-3.7-flash` with Low, Medium, and High thinking-effort routing to `gemini-3.7-flash-low|medium|high` and 65,536 output token budget.
- **Graceful Runtime Fallback:** Added automatic runtime candidate fallback (e.g. falling back to Gemini 3.6 Flash when 3.7 Flash is requested before backend deployment/activation) to prevent 404 stream rejections during server-side model rollouts.

## [0.2.7] - 2026-08-14

### Added

- **Gemini 3.7 Flash Support:** Added public model `gemini-3.7-flash` with Low, Medium, and High thinking-effort routing to `gemini-3.7-flash-low|medium|high` and 65,536 output token budget.

## [0.2.6] - 2026-08-04

### Fixed

- **Claude/GPT tool schema 400s:** Normalize custom-tool bridge schemas with an allowlist (`type`, `description`, `properties`, `required`, `items`, `enum`) instead of a denylist, so keywords like `nullable` and JSON Schema type unions (`["string","null"]`) no longer trigger `Unknown name` / Invalid JSON payload rejections from Cloud Code Assist.
- **Request-format error diagnostics:** Include the backend rejection message in friendly 400 errors so the unknown field is visible without digging through raw API responses.

## [0.2.5] - 2026-07-27

### Fixed

- **Maximum Output Token Limit (#6):** Default `maxOutputTokens` request budget now uses the model's full verified maximum output capacity instead of an arbitrary 8192-token fallback limit, preventing premature completion cut-offs on long responses. Added request-side token clamping matching exact backend per-runtime limits (65,536 for Gemini 3.6/3.5 Flash, 65,535 for Gemini 3.1 Pro, 64,000 for Claude Opus/Sonnet, 32,768 for GPT-OSS 120B) to prevent 400 Bad Request errors when caller options exceed model ceilings.
- **Thinking Model Accessibility & Routing (#7):** Added unit regression tests ensuring all public model IDs and thinking levels expose backend-supported routing and hiding unavailable levels. Recorded live model map keys and display labels across all advertised efforts.

## [0.2.4] - 2026-07-23

### Performance

- Skip redundant `loadCodeAssist` HTTP call per inference when credentials already carry a project ID.
- Cache `fetchAvailableRuntimeModel` results for 10 minutes, eliminating 2–6 repeated HTTP calls on every stream request.
- Rewrite SSE stream parser to use index-based scanning instead of `split('\n')`, removing per-chunk array allocations.
- Consolidate `loadCodeAssist` in `/antigravity.usage`: reuse a single response for both project ID resolution and tier info, and run quota summary fetch in parallel.
- Replace O(n) `projectCache` eviction with O(1) LRU (insertion-order delete).

## [0.2.3] - 2026-07-23

### Fixed

- Show only the thinking levels supported by each Antigravity model instead of every Pi level.

## [0.2.2] - 2026-07-21

### Added

- Gemini 3.6 Flash (`gemini-3.6-flash`) with Low/Medium/High thinking-effort routing to `gemini-3.6-flash-low|medium|high`.

### Changed

- Runtime model discovery keeps searching endpoint candidates so daily/sandbox-only models (currently 3.6 Flash) resolve correctly.

## [0.2.0] - 2026-07-21

### Added

- Isolated per-request diagnostics and the `/antigravity.doctor` command for sanitized provider troubleshooting.
- Coverage for model routing, tool-schema normalization, stable project IDs, and Claude tool-call conversion.

### Changed

- Split the provider into focused auth, client, diagnostics, models, streaming, types, usage, and utility modules.
- Made project-ID fallback stable per authenticated account instead of depending on the local working directory.
- Clarified OAuth client behavior and how to use a custom Google Cloud OAuth client.
- Bumped the package version to 0.2.0.

### Security

- Centralized API endpoint validation, callback loopback enforcement, and diagnostic secret redaction.
