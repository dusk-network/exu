// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

import { Module } from "../../src/mod.js";
import { runAll } from "../run.js";

const unhandled = [];
globalThis.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  unhandled.push(event.reason);
});

const asset = (name) => new URL(`../assets/${name}`, import.meta.url);
const params = new URLSearchParams(location.search);
const only = params.getAll("only");

globalThis.__e2e = runAll({
  Module,
  runtime: params.get("runtime") ?? navigator.userAgent,
  csp: params.has("csp"),
  hardwareConcurrency: navigator.hardwareConcurrency,
  bytes: async (name) => {
    const response = await fetch(asset(name));
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  },
  url: asset,
  importsUrl: new URL("../../tests/custom-imports.js", import.meta.url),
  unhandled,
}, {
  only: only.length ? only : undefined,
  log: (line) => console.log(`E2E ${line}`),
});
