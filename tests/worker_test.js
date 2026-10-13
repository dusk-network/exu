import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import "./leaks.js";

import { Module } from "../src/mod.js";
import { NodeWorker } from "../src/sandbox/node.js";
import { probeWorker } from "../src/sandbox/spawn.js";
import { threads } from "./workers.js";

const EMPTY_MODULE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

test("a worker that fails to start leaves no port behind", async () => {
  // The URL is invalid, so `new Worker` throws; the sanitizer checks the port.
  const module = new Module({ source: EMPTY_MODULE, workerUrl: "https://" });
  await assert.rejects(module.task(() => 42)());
});

test("the worker probe gives up on a worker that never replies", async () => {
  let terminated = false;
  const silent = new class extends EventTarget {
    postMessage() {}
    terminate() {
      terminated = true;
    }
  }();
  assert.equal(await probeWorker(() => silent, 50), false);
  assert.ok(terminated);
});

test("the worker probe reports a worker that cannot be created", async () => {
  assert.equal(
    await probeWorker(() => {
      throw new DOMException("cross-origin", "SecurityError");
    }),
    false,
  );
});

test("a worker that never starts rejects instead of hanging", async () => {
  const { Worker } = threads;
  const terminated = [];
  threads.Worker = class extends EventEmitter {
    postMessage(_message, transfer = []) {
      transfer.forEach((port) => port.close?.()); // never answers
    }
    terminate() {
      terminated.push(this);
    }
    ref() {}
    unref() {}
  };
  try {
    const { Sandbox } = await import("../src/sandbox/mod.js");
    const sandbox = new Sandbox({ module: null, startTimeout: 50 });
    await assert.rejects(sandbox.globals, /did not start within 50 ms/);
    assert.equal(terminated.length, 1);
  } finally {
    threads.Worker = Worker;
  }
});

test("a worker answers a host of another protocol with its own", async () => {
  const { PROTOCOL } = await import("../src/sandbox/mod.js");
  const worker = new NodeWorker(
    new URL("../src/sandbox/worker-entry.js", import.meta.url),
  );
  try {
    const reply = new Promise((resolve) =>
      worker.addEventListener("message", ({ data }) => resolve(data), {
        once: true,
      })
    );
    worker.postMessage({ type: "init", protocol: PROTOCOL + 1 });
    assert.deepEqual(await reply, { ok: true, value: { protocol: PROTOCOL } });
  } finally {
    worker.terminate();
  }
});
