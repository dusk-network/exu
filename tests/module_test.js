import assert from "node:assert/strict";

import { Module } from "../src/mod.js";

const EMPTY_MODULE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

Deno.test("module validates sources and default imports", () => {
  const module = new Module({ source: EMPTY_MODULE });
  const imports = new URL("./custom-imports.js", import.meta.url);

  assert.equal(module.defaultImports, undefined);
  module.defaultImports = imports;
  assert.equal(module.defaultImports, imports.href);
  module.defaultImports = imports.href;
  assert.equal(module.defaultImports, imports.href);
  module.defaultImports = undefined;
  assert.equal(module.defaultImports, undefined);

  assert.throws(() => {
    module.defaultImports = 1;
  }, TypeError);
  assert.throws(() => new Module({}), TypeError);
  assert.throws(() => new Module(null), TypeError);
});

Deno.test("string sources run without imports or shared memory", async () => {
  const module = new Module("data:application/wasm;base64,AGFzbQEAAAA=");

  const result = await module.task((_exports, { memory, globals }) => {
    assert.deepEqual(globals, {});
    assert.throws(() => memory.buffer, ReferenceError);
    return 42;
  })();

  assert.equal(result, 42);
});

Deno.test("pre-aborted tasks preserve their abort reason", async () => {
  const reason = new Error("stop");
  const task = new Module(EMPTY_MODULE).task(() => {
    throw new Error("task unexpectedly ran");
  });

  await assert.rejects(
    task({ signal: AbortSignal.abort(reason) }),
    (error) => error === reason,
  );
});

Deno.test("ArrayBuffers from another realm are accepted", async () => {
  const { runInNewContext } = await import("node:vm");
  const buffer = runInNewContext(
    "new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]).buffer",
  );
  assert.ok(!(buffer instanceof ArrayBuffer));
  const result = await new Module(buffer).task(() => 42)();
  assert.equal(result, 42);
});

Deno.test("a missing file: source rejects with fetch's TypeError", async () => {
  // Deno and Bun fetch file: URLs; only Node reads them from disk.
  const module = new Module(new URL("./assets/missing.wasm", import.meta.url));
  await assert.rejects(module.task(() => 42)(), TypeError);
});
