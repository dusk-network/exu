import assert from "node:assert/strict";

import { Module } from "../src/mod.js";
import { Sandbox } from "../src/sandbox/mod.js";

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

Deno.test("same-sandbox export calls are serialized", async () => {
  const result = await createModule().task(({ fibonacci }) =>
    Promise.all([fibonacci(5), fibonacci(7)])
  )({ signal: AbortSignal.timeout(10_000) });

  assert.deepEqual(result, [8, 21]);
});

Deno.test("sandbox initialization errors reject tasks", async () => {
  await assert.rejects(
    new Module(wasmUrl).task(() => {
      throw new Error("task unexpectedly ran");
    })({ signal: AbortSignal.timeout(10_000) }),
    TypeError,
  );
});

Deno.test("termination rejects active, queued, and future requests", async () => {
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

Deno.test("worker failures reject active and future requests", async () => {
  const OriginalWorker = globalThis.Worker;
  class FailingWorker extends EventTarget {
    postMessage(_message, transfer = []) {
      transfer.forEach((value) => value.close?.());
      queueMicrotask(() =>
        this.dispatchEvent(
          new ErrorEvent("error", {
            error: new Error("worker failed"),
            message: "worker failed",
          }),
        )
      );
    }

    terminate() {}
  }

  Object.defineProperty(globalThis, "Worker", { value: FailingWorker });
  try {
    const sandbox = new Sandbox({ module: null, importsUrl: null });
    await assert.rejects(sandbox.globals, /worker failed/);
    await assert.rejects(() => sandbox.exports.ok(), /worker failed/);
  } finally {
    Object.defineProperty(globalThis, "Worker", { value: OriginalWorker });
  }
});

Deno.test("sandbox remains usable after handled export errors", async () => {
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

Deno.test("sandbox remains usable after handled memory errors", async () => {
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
