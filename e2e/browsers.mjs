// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

// node e2e/browsers.mjs — runs the suite in Chromium, Firefox and WebKit
// (headless, via Playwright), once cross-origin isolated and once as in a
// browser extension: its CSP, which allows no Blob workers, and no cross-origin
// isolation. ENGINES=chromium,firefox limits the engines.
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
};
// The Dusk wallet extension's (Manifest V3 `extension_pages`); `worker-src`
// falls back to `script-src`.
const EXTENSION_CSP =
  "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';";

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  const path = normalize(join(root, pathname));
  if (!path.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(path);
    const headers = {
      "Content-Type": types[extname(path)] ?? "application/octet-stream",
    };
    if (pathname.endsWith("/csp.html")) {
      headers["Content-Security-Policy"] = EXTENSION_CSP;
    } else {
      headers["Cross-Origin-Opener-Policy"] = "same-origin";
      headers["Cross-Origin-Embedder-Policy"] = "require-corp";
    }
    res.writeHead(200, headers).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/e2e/browser`;

const engines = (process.env.ENGINES ?? "chromium,firefox,webkit").split(",");
// [label, page, cross-origin isolated, only these cases]
const pages = [
  ["isolated", "index.html", true, []],
  ["extension-csp", "csp.html", false, []],
];
const report = [];
let ok = true;

for (const engine of engines) {
  let browser;
  try {
    browser = await { chromium, firefox, webkit }[engine].launch();
  } catch (error) {
    console.log(`${engine}: cannot launch (${error.message.split("\n")[0]})`);
    ok = false;
    continue;
  }
  for (const [label, file, isolated, only] of pages) {
    const runtime = `${engine} ${browser.version()} (${label})`;
    const page = await browser.newPage();
    page.on("console", (msg) => {
      if (msg.text().startsWith("E2E ")) {
        console.log(`${engine.padEnd(8)} ${msg.text().slice(4)}`);
      }
    });
    page.on("pageerror", (e) =>
      console.log(`${engine} pageerror: ${e.message}`),
    );
    const query = new URLSearchParams([
      ["runtime", runtime],
      ...only.map((o) => ["only", o]),
    ]);
    try {
      await page.goto(`${base}/${file}?${query}`);
      const result = await page.evaluate(() => globalThis.__e2e);
      report.push(result);
      ok &&= result.summary.ok;
      if (
        (await page.evaluate(() => globalThis.crossOriginIsolated)) !== isolated
      ) {
        console.log(`${runtime}: crossOriginIsolated is not ${isolated}`);
        ok = false;
      }
    } catch (error) {
      console.log(`${runtime}: ${error.message.split("\n")[0]}`);
      ok = false;
    }
    await page.close();
  }
  await browser.close();
}
server.close();

if (process.env.E2E_JSON) {
  await writeFile(process.env.E2E_JSON, JSON.stringify(report));
}
process.exit(ok ? 0 : 1);
