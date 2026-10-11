// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

// bun e2e/bun.js [filter...]
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { Module } from "../src/mod.js";
import { runAll } from "./run.js";

const unhandled = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));

const asset = (name) => new URL(`./assets/${name}`, import.meta.url);
const only = process.argv.slice(2);
const { summary, results } = await runAll({
  Module,
  runtime: `bun ${Bun.version}`,
  hardwareConcurrency: navigator.hardwareConcurrency,
  bytes: async (name) => new Uint8Array(await readFile(asset(name))),
  url: asset,
  importsUrl: new URL("../tests/custom-imports.js", import.meta.url),
  workerEntry: new URL("../src/sandbox/worker-entry.js", import.meta.url),
  unhandled,
}, { only: only.length ? only : undefined });

if (process.env.E2E_JSON) {
  await writeFile(process.env.E2E_JSON, JSON.stringify({ summary, results }));
}
process.exit(summary.ok ? 0 : 1);
