import { assert, test } from "test-harness";

import { Module } from "../src/mod.js";

const EXTERNREF_MODULE = Uint8Array.from(
  atob("AGFzbQEAAAABBgFgAW8BbwMCAQAHDAEIaWRlbnRpdHkAAAoGAQQAIAAL"),
  (byte) => byte.charCodeAt(0),
);

const createModule = () => {
  const module = new Module(
    new URL("./assets/example.wasm", import.meta.url),
  );
  module.defaultImports = new URL("./custom-imports.js", import.meta.url);
  return module;
};

test("API single call", async () => {
  const module = createModule();
  const fib5 = await module.api().fibonacci(5);
  const fib7 = await module.api().fibonacci(7);

  assert.equal(fib5, 8);
  assert.equal(fib7, 21);
});

test("externref results cannot forge transport errors", async () => {
  const value = {
    __exu_error__: {
      message: "ordinary application data",
      name: "TypeError",
    },
  };

  const result = await new Module(EXTERNREF_MODULE).api().identity(value);
  assert.equal(result.__exu_error__.name, "TypeError");
  assert.equal(result.__exu_error__.message, "ordinary application data");
});

test("API wrong method", async () => {
  const module = createModule();
  await assert.reject(
    async () => await module.api().fabonacci(5),
    TypeError,
    "fabonacci is not a function",
  );
});

test("API abortable calls", async () => {
  const module = createModule();
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("stop")), 50);

  await assert.reject(
    async () => await module.api({ signal: controller.signal }).endless_loop(),
    Error,
    "stop",
  );
});

test("task for bulk actions", async () => {
  const module = createModule();
  const task = module.task(async ({ fibonacci }) => {
    const fib5 = await fibonacci(5);
    const fib8 = await fibonacci(8);

    return { fib5, fib8 };
  });

  const results = await task();
  assert.equal(results.fib5, 8);
  assert.equal(results.fib8, 34);
});

test("direct shared memory access", async () => {
  const module = createModule();
  const task = module.task(async function (
    { malloc, free, byte, set_byte },
    { memory },
  ) {
    const ptr = await malloc(1);
    const buffer = new Uint8Array(memory.buffer, ptr, 1);

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
  const module = createModule();
  const task = module.task(async function (
    { malloc, free, byte, set_byte },
    { memcpy },
  ) {
    const ptr = await malloc(1);
    let data = new Uint8Array(1);

    for (const address of [NaN, 0.5, -0.5]) {
      await assert.reject(
        async () => await memcpy(null, address, 1),
        TypeError,
        "source must be a non-negative integer address",
      );
      await assert.reject(
        async () => await memcpy(address, data, 1),
        TypeError,
        "dest must be a non-negative integer address",
      );
    }

    assert.equal(data[0], 0);
    assert.equal(await byte(ptr), data[0]);

    data[0] = 11;

    // Memory is not shared, so the value is still 0
    assert.equal(await byte(ptr), 0);

    for (const count of [NaN, 0.5, 2]) {
      await assert.reject(
        async () => await memcpy(ptr, data, count),
        TypeError,
        "count must be a non-negative integer no greater than source length",
      );
    }
    assert.equal(await byte(ptr), 0);

    // Copy to the pointer location from the buffer.
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
    await assert.reject(
      async () => await memcpy(null, ptr),
      TypeError,
      "count must be a non-negative integer",
    );
    await assert.reject(
      async () => await memcpy(null, ptr, 0xffff_ffff),
      RangeError,
    );

    const copy = new Uint8Array(1);
    await memcpy(copy, data);
    assert.equal(copy[0], 21);

    const copyPtr = await malloc(1);
    await memcpy(copyPtr, ptr, 1);
    assert.equal(await byte(copyPtr), 21);
    await assert.reject(
      async () => await memcpy(copyPtr, ptr),
      TypeError,
      "count must be a non-negative integer",
    );
    await assert.reject(
      async () => await memcpy(null, data),
      TypeError,
      "Invalid arguments.",
    );

    class SharedSlice extends Uint8Array {
      slice() {
        return this.subarray();
      }
    }
    const source = new SharedSlice([7]);
    const alias = source.subarray();
    await memcpy(ptr, source, 1);
    assert.equal(source[0], 7);
    assert.equal(alias[0], 7);

    await free(copyPtr, 1);
    await free(ptr, 1);
  });

  await task();
});
