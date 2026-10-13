// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

// What Deno's test sanitizers checked, for every test in a file that imports
// this: a timer still pending when the test ends (unref'd or not, however
// soon it would fire), a message channel this side never closed (with or
// without listeners), or anything else left keeping the process alive.
import assert from "node:assert/strict";
import process from "node:process";
import { afterEach, beforeEach } from "node:test";

const real = {
  MessageChannel: globalThis.MessageChannel,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
};
const pause = (ms) => new Promise((resolve) => real.setTimeout(resolve, ms));
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const resources = () => {
  const counts = {};
  for (const type of process.getActiveResourcesInfo()) {
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return JSON.stringify(counts);
};

let before;
let channels;
let timers;

beforeEach(() => {
  before = resources();
  channels = new Set();
  timers = new Set();
  const open = channels;
  const pending = timers;
  // As with Deno's sanitizer, this side must close its own port: one closed
  // by the other side, or by its thread ending, still counts as left open.
  globalThis.MessageChannel = class extends real.MessageChannel {
    constructor() {
      super();
      open.add(this);
      for (const port of [this.port1, this.port2]) {
        const close = port.close;
        port.close = () => {
          open.delete(this);
          close.call(port);
        };
      }
    }
  };
  globalThis.setTimeout = (callback, ...rest) => {
    const timer = real.setTimeout(
      (...args) => {
        pending.delete(timer);
        callback(...args);
      },
      ...rest,
    );
    pending.add(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    pending.delete(timer);
    real.clearTimeout(timer);
  };
  globalThis.setInterval = (...args) => {
    const timer = real.setInterval(...args);
    pending.add(timer);
    return timer;
  };
  globalThis.clearInterval = (timer) => {
    pending.delete(timer);
    real.clearInterval(timer);
  };
});

afterEach(async () => {
  try {
    // Clean-up already under way lands within a few turns.
    for (let i = 0; i < 5; i++) await nextTurn();
    assert.equal(timers.size, 0, `the test left ${timers.size} timer(s)`);
    // A terminated thread lets go of its own port once it has exited; a leak
    // is still there a second later.
    for (let waited = 0; waited < 1000; waited += 10) {
      if (channels.size === 0 && resources() === before) break;
      await pause(10);
    }
    assert.equal(
      channels.size,
      0,
      `the test left ${channels.size} message channel(s) open`,
    );
    assert.equal(resources(), before, "the test left resources behind");
  } finally {
    Object.assign(globalThis, real);
  }
});
