// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

// Each test must end with the resources it started with: no ports, timers or
// threads left keeping the process alive. Importing this adds the check to
// every test in the file.
import assert from "node:assert/strict";
import process from "node:process";
import { afterEach, beforeEach } from "node:test";

const resources = () => {
  const counts = {};
  for (const type of process.getActiveResourcesInfo()) {
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let before;
beforeEach(() => {
  before = resources();
});
afterEach(async () => {
  // A terminated thread holds its port until it has exited, which takes a
  // few milliseconds; a leak is still there a second later.
  for (let waited = 0; waited < 1000; waited += 10) {
    if (JSON.stringify(resources()) === JSON.stringify(before)) return;
    await pause(10);
  }
  assert.deepEqual(resources(), before, "the test left resources behind");
});
