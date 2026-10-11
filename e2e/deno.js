// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

// deno run --allow-read --allow-net e2e/deno.js [filter...]
import { Module } from "../src/mod.js";
import { runAll } from "./run.js";

const unhandled = [];
globalThis.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  unhandled.push(event.reason);
});

const asset = (name) => new URL(`./assets/${name}`, import.meta.url);
const { summary, results } = await runAll({
  Module,
  runtime: `deno ${Deno.version.deno}`,
  hardwareConcurrency: navigator.hardwareConcurrency,
  bytes: (name) => Deno.readFile(asset(name)),
  url: asset,
  importsUrl: new URL("../tests/custom-imports.js", import.meta.url),
  workerEntry: new URL("../src/sandbox/worker-entry.js", import.meta.url),
  unhandled,
}, { only: Deno.args.length ? Deno.args : undefined });

// Only with --allow-env=E2E_JSON: never prompt for permission.
const json = Deno.permissions.querySync({ name: "env", variable: "E2E_JSON" })
    .state === "granted"
  ? Deno.env.get("E2E_JSON")
  : undefined;
if (json) {
  if (
    Deno.permissions.querySync({ name: "write", path: json }).state !==
      "granted"
  ) {
    console.error(`E2E_JSON needs --allow-write=${json}`);
    Deno.exit(1);
  }
  await Deno.writeTextFile(json, JSON.stringify({ summary, results }));
}
Deno.exit(summary.ok ? 0 : 1);
