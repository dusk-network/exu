import { Module } from "../src/mod.js";

Deno.test("aborted module compilation does not create a sandbox", async () => {
  const compile = WebAssembly.compile;
  const Worker = globalThis.Worker;
  const emptyModule = await compile(
    new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
  );
  let finishCompilation;

  WebAssembly.compile = () =>
    new Promise((resolve) => (finishCompilation = resolve));
  globalThis.Worker = class {
    constructor() {
      throw new Error("sandbox created after abort");
    }
  };

  try {
    const controller = new AbortController();
    const reason = new Error("stop");
    const task = new Module(new Uint8Array()).task(() => {})({
      signal: controller.signal,
    });

    controller.abort(reason);
    finishCompilation(emptyModule);

    let error;
    try {
      await task;
    } catch (cause) {
      error = cause;
    }
    if (error !== reason) throw error;
  } finally {
    WebAssembly.compile = compile;
    globalThis.Worker = Worker;
  }
});

Deno.test("invalid modules reject tasks", async () => {
  const invalid = new Module(new Uint8Array());
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("task remained pending")), 1_000);
  });

  let error;
  try {
    await Promise.race([invalid.task(() => {})(), timeout]);
  } catch (cause) {
    error = cause;
  } finally {
    clearTimeout(timer);
  }

  if (!(error instanceof WebAssembly.CompileError)) {
    throw error ?? new Error("invalid module task unexpectedly succeeded");
  }
});
