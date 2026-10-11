import assert from "node:assert/strict";

import { Module } from "../src/mod.js";
import { probeWorker } from "../src/sandbox/spawn.js";

const EMPTY_MODULE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

Deno.test("a worker that fails to start leaves no port behind", async () => {
  // The URL is invalid, so `new Worker` throws; the sanitizer checks the port.
  const module = new Module({ source: EMPTY_MODULE, workerUrl: "https://" });
  await assert.rejects(module.task(() => 42)());
});

Deno.test("the worker probe gives up on a worker that never replies", async () => {
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

Deno.test("the worker probe reports a worker that cannot be created", async () => {
  assert.equal(
    await probeWorker(() => {
      throw new DOMException("cross-origin", "SecurityError");
    }),
    false,
  );
});

Deno.test("a worker that never starts rejects instead of hanging", async () => {
  const { Worker } = globalThis;
  const terminated = [];
  globalThis.Worker = class extends EventTarget {
    postMessage(_message, transfer = []) {
      transfer.forEach((port) => port.close?.()); // never answers
    }
    terminate() {
      terminated.push(this);
    }
  };
  try {
    const { Sandbox } = await import("../src/sandbox/mod.js");
    const sandbox = new Sandbox({ module: null, startTimeout: 50 });
    await assert.rejects(sandbox.globals, /did not start within 50 ms/);
    assert.equal(terminated.length, 1);
  } finally {
    globalThis.Worker = Worker;
  }
});

Deno.test("a worker answers a host of another protocol with its own", async () => {
  const { PROTOCOL } = await import("../src/sandbox/mod.js");
  const worker = new Worker(
    new URL("../src/sandbox/worker-entry.js", import.meta.url),
    { type: "module" },
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
