import assert from "node:assert/strict";

import { Module } from "../src/mod.js";

const ADD_MODULE = Uint8Array.from(
  atob("AGFzbQEAAAABBwFgAn9/AX8DAgEABwcBA2FkZAAACgkBBwAgACABags="),
  (byte) => byte.charCodeAt(0),
);

// Deno's sanitizers fail a test that leaves ports or timers behind; idle
// pooled workers must hold neither on this side.
Deno.test("idle pooled workers leave no ports or timers behind", async () => {
  const module = new Module(ADD_MODULE);
  assert.equal(await module.api().add(1, 2), 3);
  assert.equal(await module.api().add(2, 3), 5);
  await module.task(async ({ add }, { memcpy }) => {
    await assert.rejects(memcpy(null, 0, 1), ReferenceError);
    return add(3, 4);
  })();
});

Deno.test("close() ends idle workers, and later tasks start new ones", async () => {
  const module = new Module(ADD_MODULE);
  assert.equal(await module.api().add(1, 2), 3);
  module.close();
  assert.equal(await module.api().add(2, 3), 5);
  module.close();
});

// A task aborted after it took a warm worker but before its `begin` went out
// (it queues behind the previous task's `end`) must not leave its port open.
Deno.test("an abort before a task begins leaves no port behind", async () => {
  const module = new Module(ADD_MODULE);
  assert.equal(await module.api().add(1, 2), 3);
  const controller = new AbortController();
  const task = module.api({ signal: controller.signal }).add(2, 3);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  controller.abort(new Error("stop"));
  await assert.rejects(task, /stop/);
  module.close();
});

Deno.test("close() also retires workers that were busy at the time", async () => {
  const { Worker } = globalThis;
  let started = 0;
  globalThis.Worker = class extends Worker {
    constructor(...args) {
      super(...args);
      started++;
    }
  };
  try {
    const module = new Module(ADD_MODULE);
    const finish = Promise.withResolvers();
    const busy = module.task(async ({ add }) => {
      await finish.promise;
      return add(1, 2);
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    module.close();
    finish.resolve();
    assert.equal(await busy, 3);
    assert.equal(await module.api().add(2, 3), 5);
    assert.equal(started, 2, "the busy worker was reused after close()");
    module.close();
  } finally {
    globalThis.Worker = Worker;
  }
});

Deno.test("a task can wait on another task with every worker taken", async () => {
  const module = new Module({ source: ADD_MODULE, workers: 1 });
  const result = await module.task(async ({ add }) =>
    await add(1, 2) + await module.api().add(3, 4)
  )();
  assert.equal(result, 10);
  module.close();
});

Deno.test("close() also covers tasks waiting for a worker", async () => {
  const { Worker } = globalThis;
  let started = 0;
  let ended = 0;
  globalThis.Worker = class extends Worker {
    constructor(...args) {
      super(...args);
      started++;
    }
    terminate() {
      ended++;
      return super.terminate();
    }
  };
  try {
    const module = new Module({
      source: ADD_MODULE,
      workers: 1,
      idleTimeout: 60_000,
    });
    const finish = Promise.withResolvers();
    const a = module.task(async ({ add }) => {
      await finish.promise;
      return add(1, 2);
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const b = module.api().add(3, 4); // waits for the only worker
    module.close();
    finish.resolve();
    assert.deepEqual(await Promise.all([a, b]), [3, 7]);
    assert.equal(ended, started, "a worker outlived close()");
  } finally {
    globalThis.Worker = Worker;
  }
});

/** Runs `fn` while counting the workers alive at once. */
async function countingWorkers(fn) {
  const { Worker } = globalThis;
  const stats = { alive: 0, maxAlive: 0 };
  globalThis.Worker = class extends Worker {
    #ended = false;
    constructor(...args) {
      super(...args);
      stats.maxAlive = Math.max(stats.maxAlive, ++stats.alive);
    }
    terminate() {
      if (!this.#ended) stats.alive--;
      this.#ended = true;
      return super.terminate();
    }
  };
  try {
    await fn();
  } finally {
    globalThis.Worker = Worker;
  }
  return stats;
}

const importsUrl = (name) => `data:text/javascript,export default {};//${name}`;

Deno.test("the workers bound covers tasks with different imports", async () => {
  const module = new Module({ source: ADD_MODULE, workers: 2 });
  const stats = await countingWorkers(async () => {
    const results = await Promise.all(
      [undefined, "a", "b"].flatMap((name) =>
        [1, 2, 3].map((i) =>
          module.api({ imports: name && importsUrl(name) }).add(i, 10)
        )
      ),
    );
    assert.deepEqual(results, [11, 12, 13, 11, 12, 13, 11, 12, 13]);
    module.close();
  });
  assert.ok(stats.maxAlive <= 2, `${stats.maxAlive} workers alive at once`);
});

Deno.test("an idle worker makes room for a task with other imports", async () => {
  const module = new Module({ source: ADD_MODULE, workers: 1 });
  const stats = await countingWorkers(async () => {
    assert.equal(await module.api().add(1, 2), 3); // leaves an idle worker
    assert.equal(await module.api({ imports: importsUrl("a") }).add(2, 3), 5);
    module.close();
  });
  assert.equal(stats.maxAlive, 1);
});

Deno.test("idleTimeout must be a number", () => {
  for (const idleTimeout of ["100", 1n, true]) {
    assert.throws(
      () => new Module({ source: ADD_MODULE, idleTimeout }),
      TypeError,
      String(idleTimeout),
    );
  }
});
