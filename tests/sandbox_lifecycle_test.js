import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import "./leaks.js";

import { Module } from "../src/mod.js";
import { Sandbox } from "../src/sandbox/mod.js";
import { threads } from "./workers.js";

const wasmUrl = new URL("./assets/example.wasm", import.meta.url);
const importsUrl = new URL("./custom-imports.js", import.meta.url);
const TRAP_MODULE = Uint8Array.from(
  atob("AGFzbQEAAAABCAJgAABgAAF/AwMCAAEHDQIEdHJhcAAAAm9rAAEKCgIDAAALBABBKgs="),
  (byte) => byte.charCodeAt(0),
);

const createModule = () => {
  const module = new Module(wasmUrl);
  module.defaultImports = importsUrl;
  return module;
};

test("same-sandbox export calls are serialized", async () => {
  const result = await createModule().task(({ fibonacci }) =>
    Promise.all([fibonacci(5), fibonacci(7)])
  )({ signal: AbortSignal.timeout(10_000) });

  assert.deepEqual(result, [8, 21]);
});

test("sandbox initialization errors reject tasks", async () => {
  await assert.rejects(
    new Module(wasmUrl).task(() => {
      throw new Error("task unexpectedly ran");
    })({ signal: AbortSignal.timeout(10_000) }),
    TypeError,
  );
});

test("termination rejects active, queued, and future requests", async () => {
  let active;
  let future;
  let queued;

  const result = await createModule().task(({ endless_loop, fibonacci }) => {
    active = endless_loop();
    queued = fibonacci(5);
    active.catch(() => {});
    queued.catch(() => {});
    future = fibonacci;
    return "done";
  })();

  assert.equal(result, "done");
  await assert.rejects(active, /Sandbox terminated/);
  await assert.rejects(queued, /Sandbox terminated/);
  await assert.rejects(() => future(5), /Sandbox terminated/);
});

test("worker failures reject active and future requests", async () => {
  const { Worker } = threads;
  // A thread that fails as soon as it gets a message.
  threads.Worker = class extends EventEmitter {
    postMessage(_message, transfer = []) {
      transfer.forEach((value) => value.close?.());
      queueMicrotask(() => this.emit("error", new Error("worker failed")));
    }
    terminate() {}
    ref() {}
    unref() {}
  };
  try {
    const sandbox = new Sandbox({ module: null, importsUrl: null });
    await assert.rejects(sandbox.globals, /worker failed/);
    await assert.rejects(() => sandbox.exports.ok(), /worker failed/);
  } finally {
    threads.Worker = Worker;
  }
});

test("sandbox remains usable after handled export errors", async () => {
  const result = await new Module(TRAP_MODULE).task(
    async ({ missing, ok, trap }) => {
      await assert.rejects(
        () => trap(),
        (error) =>
          error instanceof WebAssembly.RuntimeError &&
          /unreachable/.test(error.message) &&
          typeof error.stack === "string",
      );
      await assert.rejects(() => missing(), TypeError);
      return await ok();
    },
  )({ signal: AbortSignal.timeout(10_000) });

  assert.equal(result, 42);
});

test("sandbox remains usable after handled memory errors", async () => {
  const source = new Uint8Array([1]);
  const result = await createModule().task(
    async ({ fibonacci }, { memcpy }) => {
      await assert.rejects(
        () => memcpy(0xffff_ffff, source, 1),
        Error,
      );
      return await fibonacci(5);
    },
  )({ signal: AbortSignal.timeout(10_000) });

  assert.deepEqual(source, new Uint8Array([1]));
  assert.equal(result, 8);
});

test("a standalone sandbox accepts calls right away", async () => {
  const module = await WebAssembly.compile(TRAP_MODULE);
  const sandbox = new Sandbox({ module });
  try {
    assert.equal(await sandbox.exports.ok(), 42);
  } finally {
    sandbox.terminate();
  }
});

test("a standalone sandbox ended at once raises nothing unhandled", async () => {
  const module = await WebAssembly.compile(TRAP_MODULE);
  new Sandbox({ module }).terminate();
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("an instance whose imports never finish starting rejects", async () => {
  const module = await WebAssembly.compile(TRAP_MODULE);
  const importsUrl = new URL("./hanging-imports.js", import.meta.url).href;
  const sandbox = new Sandbox({ module, importsUrl, startTimeout: 100 });
  await assert.rejects(sandbox.globals, /did not start within 100 ms/);
});
