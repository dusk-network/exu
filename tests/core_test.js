import {
  test,
  assert,
} from "http://rawcdn.githack.com/mio-mini/test-harness/0.1.0/mod.js";

import { Module } from "../src/mod.js";

const module = new Module(
  new URL(
    "./example/target/wasm32-unknown-unknown/release/example.wasm",
    import.meta.url,
  ),
);

module.defaultImports = new URL("./custom-imports.js", import.meta.url);

test("API single call", async () => {
  const fib5 = await module.api().fibonacci(5);
  const fib7 = await module.api().fibonacci(7);

  assert.equal(fib5, 8);
  assert.equal(fib7, 21);
});

test("API wrong method", async () => {
  await assert.reject(
    async () => await module.api().fabonacci(5),
    TypeError,
    "fabonacci is not a function",
  );
});

test("API abortable calls", async () => {
  await assert.reject(
    async () =>
      await module.api({ signal: AbortSignal.timeout(500) }).endless_loop(),
    Error,
    "Signal timed out.",
  );
});

test("task for bulk actions", async () => {
  let task = module.task(async ({ fibonacci }) => {
    let fib5 = await fibonacci(5);
    let fib8 = await fibonacci(8);

    return { fib5, fib8 };
  });

  let results = await task();
  assert.equal(results.fib5, 8);
  assert.equal(results.fib8, 34);
});

test("direct shared memory access", async () => {
  const task = module.task(async function (
    { malloc, free, byte, set_byte },
    { memory },
  ) {
    let ptr = await malloc(1);
    let buffer = new Uint8Array(memory.buffer, ptr, 1);

    assert.equal(buffer[0], 0);
    assert.equal(await byte(ptr), buffer[0]);

    buffer[0] = 11;

    assert.equal(await byte(ptr), 11);

    await set_byte(ptr, 21);

    assert.equal(await byte(ptr), 21);
    assert.equal(buffer[0], 21);

    await free(ptr, 1);

    return "abcd";
  });

  const result = await task();

  assert.equal(result, "abcd");
});

test("memcpy", async () => {
  const task = module.task(async function (
    { malloc, free, byte, set_byte },
    { memcpy },
  ) {
    let ptr = await malloc(1);
    let data = new Uint8Array(1);

    assert.equal(data[0], 0);
    assert.equal(await byte(ptr), data[0]);

    data[0] = 11;

    // Memory is not shared, so the value is still 0
    assert.equal(await byte(ptr), 0);

    // Copy to the pointer location from the buffer.
    // The ownership is transferred to the worker,
    // so to keep the buffer data, we need to set it back.
    data = await memcpy(ptr, data, 1);

    // Now the memory is updated
    assert.equal(await byte(ptr), 11);

    await set_byte(ptr, 21);

    assert.equal(await byte(ptr), 21);

    // Memory is not shared, so the value is still 11
    assert.equal(data[0], 11);

    // Copy to the pointer location from the buffer
    // Since the buffer is returned, it can be omitted.
    data = await memcpy(null, ptr, 1);

    // Now the memory is updated
    assert.equal(data[0], 21);

    await free(ptr, 1);
  });

  await task();
});
