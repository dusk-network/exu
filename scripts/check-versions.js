// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

// node scripts/check-versions.js [tag] — npm (package.json) and JSR
// (jsr.json) publish the same version, and a release tag names it.
import { readFileSync } from "node:fs";
import process from "node:process";

const version = (file) =>
  JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url))).version;
const npm = version("package.json");
const jsr = version("jsr.json");
const tag = process.argv[2];

if (npm !== jsr) {
  console.error(`package.json has ${npm}, jsr.json has ${jsr}`);
  process.exit(1);
}
if (tag !== undefined && tag !== `v${npm}`) {
  console.error(`the tag is ${tag}, the version ${npm}`);
  process.exit(1);
}
console.log(`version ${npm}${tag ? `, tag ${tag}` : ""}`);
