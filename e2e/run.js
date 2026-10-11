// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

import { Skip } from "./assert.js";
import { cases } from "./cases.js";

const CASE_TIMEOUT = 30_000;

// Globals cases may patch, restored after every case.
const PATCHABLE = ["Worker", "MessageChannel", "fetch"];
const pick = (object, keys) =>
  Object.fromEntries(keys.map((key) => [key, object[key]]));

/**
 * Runs every case sequentially. Outcomes: pass, fail, known (a listed
 * violation that still fails), fixed (a listed violation that now passes) and
 * skip. Only `fail` and `fixed` make the run unsuccessful.
 */
export async function runAll(ctx, { log = console.log, only } = {}) {
  const results = [];
  // Close every module a case opened, so idle workers do not outlive it.
  const opened = new Set();
  const Module = class extends ctx.Module {
    constructor(...args) {
      super(...args);
      opened.add(this);
    }
  };
  // One task first, so one-time set-up (browsers probe Exu's worker file)
  // does not show up in the first case's worker counts.
  try {
    const warmup = new ctx.Module(await ctx.bytes("probe.wasm"));
    await warmup.api().add(1, 2);
    warmup.close?.();
  } catch {
    // the cases will report it
  }
  for (const c of cases({ ...ctx, Module })) {
    if (only && !only.some((o) => c.name.includes(o))) continue;
    const skip = typeof c.skip === "function" ? c.skip() : c.skip;
    const known = typeof c.known === "function" ? c.known(ctx) : c.known;
    if (skip) {
      results.push({ name: c.name, outcome: "skip", detail: skip });
      log(`SKIP   ${c.name} (${skip})`);
      continue;
    }
    const started = performance.now();
    const unhandledBefore = ctx.unhandled.length;
    // Note the workers a case starts, so any it leaves running (a hang, or a
    // case that timed out and keeps running) can be ended, and restore any
    // globals it patched.
    const saved = { ...pick(globalThis, PATCHABLE) };
    const workers = [];
    globalThis.Worker = class extends saved.Worker {
      constructor(...args) {
        super(...args);
        workers.push(this);
      }
    };
    // Tracked apart from `error`: a case may reject with a falsy reason.
    let failed = false;
    let error;
    let timer;
    let timedOut = false;
    try {
      await Promise.race([
        c.run(),
        new Promise((_, reject) =>
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`timed out after ${CASE_TIMEOUT} ms`));
          }, CASE_TIMEOUT)
        ),
      ]);
    } catch (e) {
      failed = true;
      error = e;
    } finally {
      clearTimeout(timer);
      Object.assign(globalThis, saved);
      if (timedOut) workers.forEach((worker) => worker.terminate());
    }
    // A rejection nobody handled is a failure in its own right. Runtimes
    // report one on a later turn of the event loop, so give them two.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const unhandled = ctx.unhandled.slice(unhandledBefore);
    if (!failed && unhandled.length) {
      failed = true;
      error = new Error(`unhandled rejection: ${unhandled[0]}`);
    }
    for (const module of opened) module.close?.();
    opened.clear();
    // Whatever the case left running would skew the cases after it.
    workers.forEach((worker) => worker.terminate());
    const ms = performance.now() - started;
    if (failed && error instanceof Skip) {
      results.push({ name: c.name, outcome: "skip", detail: error.message });
      log(`SKIP   ${c.name} (${error.message})`);
      continue;
    }
    const outcome = failed
      ? (known ? "known" : "fail")
      : (known ? "fixed" : "pass");
    const detail = !failed
      ? ""
      : error instanceof Error
      ? `${error.name}: ${error.message}`
      : `rejected with ${String(error)}`;
    results.push({ name: c.name, outcome, known, detail, ms });
    const tag = {
      pass: "PASS  ",
      fail: "FAIL  ",
      known: "KNOWN ",
      fixed: "FIXED ",
    }[outcome];
    log(
      `${tag} ${c.name}${known ? ` [${known}]` : ""}${
        detail ? ` — ${detail}` : ""
      } (${ms.toFixed(0)} ms)`,
    );
  }
  const count = (o) => results.filter((r) => r.outcome === o).length;
  const summary = {
    runtime: ctx.runtime,
    pass: count("pass"),
    fail: count("fail"),
    known: count("known"),
    fixed: count("fixed"),
    skip: count("skip"),
    unhandled: ctx.unhandled.map(String),
    ok: count("fail") === 0 && count("fixed") === 0,
  };
  log(
    `${ctx.runtime}: ${summary.pass} pass, ${summary.fail} fail, ${summary.known} known, ` +
      `${summary.fixed} fixed, ${summary.skip} skipped, ${summary.unhandled.length} unhandled rejection(s)`,
  );
  return { summary, results };
}
