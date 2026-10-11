// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

// Runtime-neutral E2E cases. Each states one invariant Exu's consumers
// (W3sper's protocol driver) rely on. `known` names a reproduced violation in
// the current release (an issue reference, or a function of ctx for
// runtime-specific ones); runners report those as known failures and flag
// them when they start passing.
//
// ctx: {
//   Module, runtime, hardwareConcurrency,
//   bytes(name): Promise<Uint8Array>, url(name): URL, importsUrl: URL,
//   workerEntry: URL (Exu's own worker module),
//   unhandled: unknown[]  (unhandled rejections recorded by the runner)
// }

import * as assert from "./assert.js";

const INVALID = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 0xff]);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Counts workers created/terminated while `fn` runs. */
async function trackWorkers(fn) {
  const Original = globalThis.Worker;
  const stats = { created: 0, terminated: 0, alive: 0, maxAlive: 0, urls: [] };
  const workers = new Set();
  class Tracked extends Original {
    #ended = false;
    constructor(...args) {
      super(...args);
      workers.add(this);
      stats.urls.push(String(args[0]));
      stats.created++;
      stats.alive++;
      stats.maxAlive = Math.max(stats.maxAlive, stats.alive);
    }
    terminate() {
      if (!this.#ended) {
        this.#ended = true;
        workers.delete(this);
        stats.terminated++;
        stats.alive--;
      }
      return super.terminate();
    }
  }
  globalThis.Worker = Tracked;
  try {
    await fn(stats);
  } finally {
    // Only undo our own patch: after a timeout the runner has moved on.
    if (globalThis.Worker === Tracked) globalThis.Worker = Original;
  }
  return stats;
}

/**
 * Runs `fn(signal)`, then aborts `signal` and ends any worker it left running
 * (e.g. one stuck behind a known hang), so it cannot leak into later cases.
 * Pass `signal` to the tasks, so one still starting cannot start a worker
 * afterwards.
 */
async function withoutLeftovers(fn) {
  const { Worker, MessageChannel } = globalThis;
  const started = [];
  const channels = [];
  const TrackedWorker = class extends Worker {
    constructor(...args) {
      super(...args);
      started.push(this);
    }
  };
  const TrackedChannel = class extends MessageChannel {
    constructor() {
      super();
      channels.push(this);
    }
  };
  Object.assign(globalThis, {
    Worker: TrackedWorker,
    MessageChannel: TrackedChannel,
  });
  const cleanup = new AbortController();
  try {
    return await fn(cleanup.signal);
  } finally {
    cleanup.abort(new Error("case cleanup"));
    // Only undo our own patches: after a timeout the runner has moved on.
    if (globalThis.Worker === TrackedWorker) globalThis.Worker = Worker;
    if (globalThis.MessageChannel === TrackedChannel) {
      globalThis.MessageChannel = MessageChannel;
    }
    started.forEach((worker) => worker.terminate());
    channels.forEach(({ port1, port2 }) => {
      port1.close();
      port2.close();
    });
  }
}

/**
 * Longest gap between turns of the caller's event loop while `fn` runs,
 * sampled with a setTimeout chain (a MessageChannel ping-pong starves timers
 * in Bun 1.3).
 */
async function longestStall(fn) {
  let last = performance.now();
  let max = 0;
  let running = true;
  let timer;
  const beat = () => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
    if (running) timer = setTimeout(beat, 0);
  };
  timer = setTimeout(beat, 0);
  try {
    await fn();
  } finally {
    running = false;
    clearTimeout(timer);
    max = Math.max(max, performance.now() - last);
  }
  return max;
}

export function cases(ctx) {
  const { Module } = ctx;
  const probe = async () => new Module(await ctx.bytes("probe.wasm"));

  return [
    // ── Every task settles ──────────────────────────────────────────────
    {
      name: "a trap rejects the task with a RuntimeError",
      async run() {
        const module = await probe();
        await assert.rejects(module.api().trap(), {
          type: WebAssembly.RuntimeError,
        });
      },
    },
    {
      name: "an invalid module rejects its tasks with a CompileError",
      async run() {
        await assert.rejects(new Module(INVALID).task(() => 1)(), {
          type: WebAssembly.CompileError,
        });
      },
    },
    {
      name: "missing imports reject the task instead of hanging",
      async run() {
        const module = new Module(await ctx.bytes("needs-import.wasm"));
        const error = await assert.rejects(module.api().ok());
        assert.ok(
          error instanceof WebAssembly.LinkError || error instanceof TypeError,
          `unexpected ${error.name}: ${error.message}`,
        );
      },
    },
    {
      name: "an unknown export rejects with a TypeError",
      async run() {
        await assert.rejects((await probe()).api().nope(), {
          type: TypeError,
          message: "nope is not a function",
        });
      },
    },
    {
      name: "a task callback's own error rejects the task",
      async run() {
        const module = await probe();
        const boom = new Error("callback failed");
        await assert.rejects(
          module.task(() => {
            throw boom;
          })(),
          { is: boom },
        );
        await assert.rejects(
          module.task(async ({ inc }) => {
            await inc();
            throw boom;
          })(),
          { is: boom },
        );
      },
    },
    {
      name:
        "a module used after its construction tick causes no unhandled rejection",
      async run() {
        const before = ctx.unhandled.length;
        const module = new Module(INVALID);
        await tick(50);
        await assert.rejects(module.task(() => 1)(), { name: "CompileError" });
        await tick(20);
        assert.equal(
          ctx.unhandled.length,
          before,
          `unhandled rejection: ${ctx.unhandled.at(-1)}`,
        );
      },
    },
    {
      name: "api() proxies are not thenable",
      async run() {
        const module = await probe();
        assert.equal(
          typeof module.api().then,
          "undefined",
          "api().then is a function",
        );
        await withoutLeftovers((signal) =>
          assert.within(
            Promise.resolve(module.api({ signal })),
            1000,
            "await module.api()",
          )
        );
      },
    },
    {
      name: "a task can return its exports proxy",
      async run() {
        const module = await probe();
        await withoutLeftovers((signal) =>
          assert.within(
            module.task((exports) => Promise.resolve(exports))({ signal }),
            1000,
            "task returning exports",
          )
        );
      },
    },

    // ── Abort ────────────────────────────────────────────────────────────
    {
      name: "a pre-aborted signal rejects with its reason and starts no worker",
      async run() {
        const module = await probe();
        const reason = new Error("stop before start");
        const stats = await trackWorkers(() =>
          assert.rejects(
            module.task(() => 1)({ signal: AbortSignal.abort(reason) }),
            { is: reason },
          )
        );
        assert.equal(stats.created, 0, `${stats.created} worker(s) started`);
      },
    },
    {
      name: "abort stops a never-ending call promptly with the abort reason",
      skip: () =>
        globalThis.crossOriginIsolated === false
          ? "page is not cross-origin isolated"
          : false,
      async run() {
        // The call sets byte 0 of the shared memory, then spins: once the
        // host sees the flag, the call is running in the worker.
        const module = new Module(await ctx.bytes("flag-spin.wasm"));
        module.defaultImports = ctx.importsUrl;
        const controller = new AbortController();
        const reason = new Error("user cancelled");
        const stats = await trackWorkers(async () => {
          let flag;
          const call = module.task(({ flag_then_spin }, { memory }) => {
            flag = new Uint8Array(memory.buffer);
            return flag_then_spin();
          })({ signal: controller.signal });
          const deadline = performance.now() + 5000;
          while (!(flag && Atomics.load(flag, 0) === 1)) {
            assert.ok(performance.now() < deadline, "the call never started");
            await tick(5);
          }
          const t = performance.now();
          controller.abort(reason);
          await assert.rejects(call, { is: reason }, 2000);
          const elapsed = performance.now() - t;
          assert.ok(elapsed < 500, `rejection took ${elapsed.toFixed(0)} ms`);
        });
        assert.equal(stats.alive, 0, "the spinning worker was not terminated");
      },
    },
    {
      name: "an abort after the task's last call still rejects the task",
      async run() {
        const module = await probe();
        const controller = new AbortController();
        const reason = new Error("too late?");
        await assert.rejects(
          module.task(async ({ inc }) => {
            const value = await inc();
            controller.abort(reason);
            await tick(10);
            return value;
          })({ signal: controller.signal }),
          { is: reason },
        );
      },
    },
    {
      name:
        "an abort while the callback waits on something else rejects at once",
      async run() {
        const module = await probe();
        const controller = new AbortController();
        const reason = new Error("stop waiting");
        const stats = await trackWorkers(async () => {
          const waiting = Promise.withResolvers();
          const task = module.task(async ({ inc }) => {
            await inc();
            waiting.resolve();
            await new Promise(() => {}); // never settles
          })({ signal: controller.signal });
          await waiting.promise; // no request is in flight from here on
          controller.abort(reason);
          await assert.rejects(task, { is: reason }, 1000);
        });
        assert.equal(stats.alive, 0, "the task's worker was not terminated");
      },
    },
    {
      name: "an abort racing a task's start leaves nothing unhandled",
      async run() {
        const module = await probe();
        await module.api().add(1, 2);
        for (let hops = 0; hops < 6; hops++) {
          const controller = new AbortController();
          const reason = new Error("raced");
          const task = module.task(({ add }) => add(1, 2))({
            signal: controller.signal,
          });
          for (let i = 0; i < hops; i++) await Promise.resolve();
          controller.abort(reason);
          await task.catch(() => {});
        }
      },
    },
    {
      name: "an aborted task never runs its callback",
      async run() {
        const module = await probe();
        await module.api().add(1, 2);
        let ran = 0;
        for (let batch = 0; batch < 10; batch++) {
          const controllers = Array.from(
            { length: 8 },
            () => new AbortController(),
          );
          const tasks = controllers.map((controller, i) =>
            module.task(() => {
              if (i === 0) controllers.slice(1).forEach((c) => c.abort());
              else if (controller.signal.aborted) ran++;
            })({ signal: controller.signal }).catch(() => {})
          );
          await Promise.all(tasks);
        }
        assert.equal(ran, 0, `${ran} callback(s) ran after their abort`);
      },
    },
    {
      name: "an abort beats a compile error that settles after it",
      async run() {
        const module = new Module(INVALID);
        await module.task(() => 1)().catch(() => {}); // compilation has failed
        const controller = new AbortController();
        const reason = new Error("aborted first");
        const task = module.task(() => 1)({ signal: controller.signal });
        await Promise.resolve();
        controller.abort(reason);
        await assert.rejects(task, { is: reason });
      },
    },
    {
      name: "an abort while the module is still loading rejects at once",
      async run() {
        const fetch = globalThis.fetch;
        globalThis.fetch = () => new Promise(() => {}); // a stalled download
        try {
          const module = new Module("https://example.invalid/stalled.wasm");
          const controller = new AbortController();
          const reason = new Error("stop loading");
          const task = module.task(() => 1)({ signal: controller.signal });
          await tick(20);
          controller.abort(reason);
          await assert.rejects(task, { is: reason }, 1000);
        } finally {
          globalThis.fetch = fetch;
        }
      },
    },
    {
      name: "settled tasks leave no listeners on their abort signal",
      async run() {
        const module = await probe();
        const { signal } = new AbortController();
        let live = 0;
        const add = signal.addEventListener.bind(signal);
        const remove = signal.removeEventListener.bind(signal);
        signal.addEventListener = (type, ...rest) => {
          if (type === "abort") live++;
          return add(type, ...rest);
        };
        signal.removeEventListener = (type, ...rest) => {
          if (type === "abort") live--;
          return remove(type, ...rest);
        };
        await module.task(async ({ inc, add }) => {
          await inc();
          await add(1, 2);
        })({ signal });
        await assert.rejects(module.task(({ trap }) => trap())({ signal }), {
          name: "RuntimeError",
        });
        assert.equal(live, 0, `${live} abort listener(s) left on the signal`);
      },
    },
    {
      name: "aborting one task leaves concurrent tasks alone",
      async run() {
        const module = await probe();
        const controller = new AbortController();
        const doomed = module.api({ signal: controller.signal }).spin();
        const fine = module.api().burn(2_000_000, 7);
        await tick(20);
        controller.abort(new Error("only this one"));
        await assert.rejects(doomed, { message: "only this one" });
        assert.equal(await assert.within(fine, 5000), 7);
      },
    },

    // ── Isolation and lifecycle ─────────────────────────────────────────
    {
      name: "every task gets a fresh instance",
      async run() {
        const module = await probe();
        for (let i = 0; i < 3; i++) {
          const seen = await module.task(async ({ inc }) => [
            await inc(),
            await inc(),
            await inc(),
          ])();
          assert.bytes(new Uint8Array(seen), [1, 2, 3]);
        }
        assert.equal(await module.api().inc(), 1);
        assert.equal(await module.api().inc(), 1);
      },
    },
    {
      name: "by default a worker ends with its task",
      async run() {
        const module = await probe();
        await module.api().add(1, 2); // browsers probe the worker file first
        const stats = await trackWorkers(async () => {
          assert.equal(await module.api().add(1, 2), 3);
          assert.equal(await module.api().add(1, 2), 3);
        });
        assert.equal(stats.created, 2, `${stats.created} worker(s) started`);
        assert.equal(stats.alive, 0, `${stats.alive} worker(s) left running`);
      },
    },
    {
      name: "a healthy worker serves the next task",
      async run() {
        const module = new Module({
          source: await ctx.bytes("probe.wasm"),
          idleTimeout: 10_000,
        });
        const stats = await trackWorkers(async () => {
          await module.api().add(1, 2);
          await module.api().trap().catch(() => {});
          await module.task(() => {
            throw new Error("callback");
          })().catch(() => {});
          assert.equal(await module.api().inc(), 1);
          module.close();
        });
        assert.equal(stats.created, 1, `${stats.created} worker(s) started`);
        assert.equal(stats.alive, 0, `${stats.alive} worker(s) left running`);
      },
    },
    {
      name: "aborted and still-busy workers are not reused",
      async run() {
        const module = new Module({
          source: await ctx.bytes("probe.wasm"),
          idleTimeout: 10_000,
        });
        const stats = await trackWorkers(async () => {
          const controller = new AbortController();
          const spinning = module.api({ signal: controller.signal }).spin();
          await tick(20);
          controller.abort(new Error("stop"));
          await spinning.catch(() => {});
          // Returns while a call is still running in its worker.
          await module.task(({ spin }) => {
            spin().catch(() => {});
          })();
          assert.equal(await module.api().add(1, 2), 3);
          module.close();
        });
        assert.equal(stats.created, 3, `${stats.created} worker(s) started`);
        assert.equal(stats.alive, 0, `${stats.alive} worker(s) left running`);
      },
    },
    {
      name: "a finished task's exports cannot reach the next task",
      async run() {
        const module = new Module({
          source: await ctx.bytes("probe.wasm"),
          idleTimeout: 10_000,
        });
        let stale;
        await module.task((exports) => {
          stale = exports;
          return exports.inc();
        })();
        await assert.rejects(stale.inc(), { message: "Sandbox terminated" });
        assert.equal(await module.api().inc(), 1);
        module.close();
      },
    },
    {
      name: "workers that loaded custom imports are not reused",
      async run() {
        const module = new Module({
          source: await ctx.bytes("example.wasm"),
          idleTimeout: 10_000,
        });
        module.defaultImports = ctx.importsUrl;
        const stats = await trackWorkers(async () => {
          assert.equal(await module.api().fibonacci(5), 8);
          assert.equal(await module.api().fibonacci(5), 8);
        });
        assert.equal(stats.created, 2, `${stats.created} worker(s) started`);
        assert.equal(stats.alive, 0, `${stats.alive} worker(s) left running`);
      },
    },
    {
      name: "idle workers end after idleTimeout",
      async run() {
        const source = await ctx.bytes("probe.wasm");
        const module = new Module({ source, idleTimeout: 50 });
        const stats = await trackWorkers(async () => {
          await module.api().add(1, 2);
          await tick(300);
        });
        assert.equal(stats.alive, 0, `${stats.alive} worker(s) still idle`);
      },
    },

    // ── The sandbox worker ──────────────────────────────────────────────
    {
      name: "starts Exu's worker file in browsers, a Blob worker elsewhere",
      async run() {
        const module = await probe();
        const stats = await trackWorkers(() => module.api().add(1, 2));
        const url = stats.urls.at(-1);
        if (/^(deno|bun) /.test(ctx.runtime)) {
          assert.ok(url.startsWith("blob:"), `started ${url}`);
        } else {
          assert.ok(
            url.endsWith("/src/sandbox/worker-entry.js"),
            `started ${url}`,
          );
        }
      },
    },
    {
      name: "starts the worker given as workerUrl",
      async run() {
        const source = await ctx.bytes("probe.wasm");
        const module = new Module({ source, workerUrl: ctx.workerEntry });
        const stats = await trackWorkers(async () => {
          assert.equal(await module.api().add(1, 2), 3);
        });
        assert.equal(stats.urls[0], ctx.workerEntry.href);
      },
    },
    {
      name: "a worker from another Exu version fails clearly",
      async run() {
        const source = await ctx.bytes("probe.wasm");
        const module = new Module({
          source,
          workerUrl: ctx.url("legacy-worker.js"),
        });
        await assert.rejects(module.api().add(1, 2), {
          message: /Incompatible Exu sandbox worker/,
        });
      },
    },
    {
      name: "rejects a workerUrl that is not a URL or a string",
      async run() {
        const source = await ctx.bytes("probe.wasm");
        let error;
        try {
          new Module({ source, workerUrl: 42 });
        } catch (e) {
          error = e;
        }
        assert.equal(error?.name, "TypeError");
      },
    },

    // ── memcpy ───────────────────────────────────────────────────────────
    {
      name: "memcpy into WASM keeps the caller's buffer and returns a copy",
      async run() {
        const module = await probe();
        const source = new Uint8Array([1, 2, 3, 4]);
        await module.task(async ({ load8 }, { memcpy }) => {
          const returned = await memcpy(64, source);
          assert.equal(source.byteLength, 4, "caller's buffer was detached");
          assert.bytes(source, [1, 2, 3, 4]);
          assert.bytes(returned, [1, 2, 3, 4]);
          assert.ok(
            returned.buffer !== source.buffer,
            "the returned bytes share the caller's buffer",
          );
          assert.equal(await load8(66), 3);
        })();
      },
    },
    {
      name: "memcpy out of WASM returns an independent copy",
      async run() {
        const module = await probe();
        await module.task(async ({ store8 }, { memcpy }) => {
          await store8(10, 9);
          const first = await memcpy(null, 10, 1);
          await store8(10, 5);
          assert.bytes(first, [9]);
          assert.bytes(await memcpy(null, 10, 1), [5]);
        })();
      },
    },
    {
      name: "memcpy copies within WASM memory",
      async run() {
        const module = await probe();
        await module.task(async ({ load8 }, { memcpy }) => {
          await memcpy(100, new Uint8Array([7, 8, 9]));
          await memcpy(200, 100, 3);
          assert.equal(await load8(201), 8);
        })();
      },
    },
    {
      name: "memcpy rejects out-of-bounds reads and writes",
      async run() {
        const module = await probe();
        await module.task(async (_, { memcpy }) => {
          const end = 2 * 65536;
          await assert.rejects(memcpy(null, end - 1, 2), {
            type: RangeError,
          });
          await assert.rejects(memcpy(end - 1, new Uint8Array(2)), {
            type: RangeError,
          });
        })();
      },
    },
    {
      name: "memcpy validates its arguments",
      async run() {
        const module = await probe();
        await module.task(async (_, { memcpy }) => {
          await assert.rejects(memcpy(null, -1, 1), { type: TypeError });
          await assert.rejects(memcpy(null, 0), { type: TypeError });
          await assert.rejects(memcpy(0, new Uint8Array(1), 2), {
            type: TypeError,
          });
          await assert.rejects(memcpy(null, new Uint8Array(1)), {
            type: TypeError,
          });
        })();
      },
    },
    {
      name: "megabyte copies round-trip intact",
      async run() {
        const module = await probe();
        const data = new Uint8Array(100_000).map((_, i) => (i * 31) & 255);
        await module.task(async (_, { memcpy }) => {
          await memcpy(1024, data);
          assert.bytes(await memcpy(null, 1024, data.length), data);
        })();
      },
    },
    {
      name: "shared memory is visible on both sides when cross-origin isolated",
      skip: () =>
        globalThis.crossOriginIsolated === false
          ? "page is not cross-origin isolated"
          : false,
      async run() {
        const module = new Module(await ctx.bytes("example.wasm"));
        module.defaultImports = ctx.importsUrl;
        await module.task(
          async ({ malloc, byte, set_byte, free }, { memory }) => {
            const ptr = await malloc(1);
            new Uint8Array(memory.buffer, ptr, 1)[0] = 11;
            assert.equal(await byte(ptr), 11);
            await set_byte(ptr, 21);
            assert.equal(new Uint8Array(memory.buffer, ptr, 1)[0], 21);
            await free(ptr, 1);
          },
        )();
      },
    },

    // ── Ordering and concurrency ────────────────────────────────────────
    {
      name: "overlapping calls in one task keep their own results",
      async run() {
        const module = await probe();
        const results = await module.task(({ burn }) =>
          Promise.all([
            burn(3_000_000, 1),
            burn(10, 2),
            burn(1_000_000, 3),
            burn(0, 4),
          ])
        )();
        assert.bytes(new Uint8Array(results), [1, 2, 3, 4]);
      },
    },
    {
      name: "64 concurrent tasks all return the right answers",
      async run() {
        const module = await probe();
        const results = await Promise.all(
          Array.from({ length: 64 }, (_, i) => module.api().add(i, 1000)),
        );
        results.forEach((value, i) => assert.equal(value, i + 1000));
      },
    },
    {
      name: "concurrent tasks start a bounded number of workers",
      async run() {
        const module = await probe();
        // #3: one less than the logical cores, so the caller keeps one.
        const limit = Math.max(1, ctx.hardwareConcurrency - 1);
        const stats = await trackWorkers(() =>
          Promise.all(
            Array.from({ length: 4 * limit }, () =>
              module.api().burn(200_000, 1)),
          )
        );
        assert.ok(
          stats.maxAlive <= limit,
          `${stats.maxAlive} workers alive at once (limit ${limit})`,
        );
      },
    },
    {
      name: "a long call does not stall the caller's event loop",
      async run() {
        const module = await probe();
        await tick(1000); // let earlier cases' workers wind down
        const stall = await longestStall(() =>
          module.api().burn(300_000_000, 1)
        );
        // RAIL: keep main-thread work under 50 ms.
        assert.ok(stall < 50, `event loop stalled ${stall.toFixed(1)} ms`);
      },
    },
    {
      name: "a burst of tasks does not stall the caller's event loop",
      // Deno blocks the caller for ~17 ms while it starts each worker, so a
      // burst that has to start the pool stalls there whatever Exu does.
      skip: () =>
        ctx.runtime.startsWith("deno")
          ? "Deno blocks the caller while starting workers"
          : false,
      async run() {
        const module = await probe();
        await tick(1000);
        const stall = await longestStall(async () => {
          await Promise.all(
            Array.from({ length: 64 }, () => module.api().burn(200_000, 1)),
          );
          await tick(500); // include worker teardown
        });
        // RAIL: respond within 100 ms, even to a burst of 64 tasks.
        assert.ok(stall < 100, `event loop stalled ${stall.toFixed(1)} ms`);
      },
    },
    {
      name: "a burst of tasks on started workers does not stall the caller",
      async run() {
        const module = new Module({
          source: await ctx.bytes("probe.wasm"),
          idleTimeout: 10_000,
        });
        const burst = () =>
          Promise.all(
            Array.from({ length: 64 }, () => module.api().burn(200_000, 1)),
          );
        await burst();
        await tick(200);
        const stall = await longestStall(burst);
        // RAIL: respond within 100 ms.
        assert.ok(stall < 100, `event loop stalled ${stall.toFixed(1)} ms`);
      },
    },

    // ── Sources ──────────────────────────────────────────────────────────
    {
      name: "accepts a Uint8Array source",
      async run() {
        assert.equal(await (await probe()).api().add(2, 3), 5);
      },
    },
    {
      name: "accepts an ArrayBuffer source",
      async run() {
        const { buffer } = await ctx.bytes("probe.wasm");
        assert.equal(await new Module(buffer).api().add(2, 3), 5);
      },
    },
    {
      name: "accepts other ArrayBuffer views",
      async run() {
        const bytes = await ctx.bytes("probe.wasm");
        // At an offset into a larger buffer, as views often are.
        const padded = new Uint8Array(bytes.byteLength + 8);
        padded.set(bytes, 3);
        const views = [
          new DataView(padded.buffer, 3, bytes.byteLength),
          new Uint8ClampedArray(padded.buffer, 3, bytes.byteLength),
          new Int8Array(padded.buffer, 3, bytes.byteLength),
        ];
        for (const view of views) {
          assert.equal(
            await new Module(view).api().add(2, 3),
            5,
            view.constructor.name,
          );
        }
      },
    },
    {
      name: "accepts a URL source",
      async run() {
        assert.equal(
          await new Module(ctx.url("probe.wasm")).api().add(2, 3),
          5,
        );
      },
    },
    {
      name: "accepts a data: URL source",
      async run() {
        const bytes = await ctx.bytes("probe.wasm");
        let binary = "";
        bytes.forEach((b) => (binary += String.fromCharCode(b)));
        const url = `data:application/wasm;base64,${btoa(binary)}`;
        assert.equal(await new Module(url).api().add(2, 3), 5);
      },
    },
    {
      name: "rejects other sources with a TypeError",
      run() {
        for (const source of [null, 42, {}]) {
          let error;
          try {
            new Module(source);
          } catch (e) {
            error = e;
          }
          assert.ok(error, `no error for ${JSON.stringify(source)}`);
          assert.ok(
            error instanceof TypeError,
            `${error.name}, not a TypeError`,
          );
          assert.ok(
            /URL|buffer/i.test(error.message),
            `not Exu's own validation: ${error.message}`,
          );
        }
      },
    },

    // ── The real workload ───────────────────────────────────────────────
    {
      name: "wallet-core 1.7.1 exposes its entry sizes through globals",
      async run() {
        // Not committed: drop a wallet-core build into e2e/assets to run this.
        const wasm = await ctx.bytes("wallet-core-1.7.1.wasm").catch(() =>
          null
        );
        if (!wasm) {
          throw new assert.Skip("e2e/assets/wallet-core-1.7.1.wasm absent");
        }
        const module = new Module(wasm);
        const [key, item] = await module.task(
          async (_, { globals, memcpy }) => {
            const u32 = async (address) =>
              new DataView((await memcpy(null, address, 4)).buffer).getUint32(
                0,
                true,
              );
            return [await u32(globals.KEY_SIZE), await u32(globals.ITEM_SIZE)];
          },
        )();
        assert.equal(key, 32);
        assert.equal(item, 736);
      },
    },
  ];
}
