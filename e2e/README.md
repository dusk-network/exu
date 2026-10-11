# E2E invariants

Each case in `cases.js` states one invariant Exu's consumers (W3sper's protocol
driver) rely on: tasks settle, aborts stop work, every task gets a fresh
instance, workers end, `memcpy` keeps buffers and bounds, and a long call does
not stall the caller. The same cases run in every runtime.

```sh
deno run --allow-read --allow-net e2e/deno.js
bun e2e/bun.js
cd e2e && npm install && node browsers.mjs   # Chromium, Firefox, WebKit
```

Pass case names (or parts of them) to run a subset.

`browsers.mjs` serves the repository cross-origin isolated, and once more under
a browser-extension CSP (`worker-src 'self'`).

Cases marked `known` reproduce an open issue. They are reported as `KNOWN` while
they fail and as `FIXED` once they pass, which fails the run until the mark is
removed. Unexpected failures fail the run too.

The wallet-core case runs only when `e2e/assets/wallet-core-1.7.1.wasm` is
present; it is not committed.
