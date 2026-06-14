# clubhouse-stats

Player-facing stats canvas for Clubhouse Hudson Square. Loaded inside the
Clubhouse Optix mobile app via a canvas configured in the Optix admin
dashboard. Reads the Optix-issued `{token}` and `{user_id}` URL macros, calls
a Supabase Edge Function that validates the token and returns the player's
career stats + recent sessions, and renders.

- **Page:** [stats.html](stats.html) — single static file, GitHub Pages-hosted
- **Edge Function:** in the `clubhouse` repo under `canvas/edge-functions/stats/index.ts`
- **Bay relay:** [relay/](relay/) — single-file Python relay that runs on each
  bay PC, proxies Uneekor → GSPro on the GSPro OpenAPI Connect protocol, and
  writes every shot to Supabase. See [relay/README.md](relay/README.md).
- **Data:** Supabase project `ufzmrvnunjmlqqwjqprq`, `players` / `sessions` /
  `shots` tables populated by the relay above.

Brand: dark green `#0d2618`, cream `#ede4cf`, Tusker Grotesk headlines.

Live URL once GitHub Pages is enabled:
`https://liam580.github.io/clubhouse-stats/stats.html`
