# Web fetch test fixtures

Saved page copies used by `scripts/test-web-fetch.ts`, so extraction tests do not
depend on live network responses. Each file is gzip-compressed and read with
`node:zlib`; decompress one with `gzip -dc file.html.gz` to inspect it.

| File | Source page | Copy |
| --- | --- | --- |
| `iana-http-status-codes.xhtml.gz` | <https://www.iana.org/assignments/http-status-codes/http-status-codes.xhtml> | ~39 KB, from the Antigravity live fetch, 2026-10-19 |
| `wikipedia-artemis-ii.html.gz` | <https://en.wikipedia.org/wiki/Artemis_II> | ~171 KB, from the Antigravity live fetch, 2026-10-19; the crawler's own limit cuts it mid-sentence near the end |
| `nasa-artemis-heat-shield.html.gz` | <https://www.nasa.gov/missions/artemis/artemis-2/rigorous-analysis-confirms-nasas-artemis-ii-heat-shield-performance/> | ~292 KB, from the Antigravity live fetch, 2026-10-19 |
| `mdn-status-shell.html.gz` | <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status> | ~26 KB, the crawler's copy: a pre-hydration shell, cut off inside its navigation menu |
| `mdn-status-page.html.gz` | same MDN URL | ~234 KB, fetched with curl and a browser user agent, because the crawler's copy of MDN pages never contains the article |

The first four files are the bytes `read_url_content` actually receives from the
Antigravity fetch RPCs (cache or live), tokens excluded. `mdn-status-shell` is kept to
pin the honest result for a JavaScript-rendered page, and `mdn-status-page` is the
article HTML MDN serves a browser, kept so the converter is still tested against
MDN-authored markup.

Replace a fixture only together with the expectations in `scripts/test-web-fetch.ts`,
and update this table when you do.
