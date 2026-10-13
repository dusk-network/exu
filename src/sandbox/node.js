// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

// Node has no Web Workers. This runs the sandbox worker on a
// `node:worker_threads` thread, behind the part of the Web Worker interface
// the channel uses. Node's modules come from `process.getBuiltinModule`, so
// bundlers for the browser never meet a `node:` import.
import worker from "./worker.js";

/**
 * Runs first in the thread: the Web Worker globals a sandbox worker uses
 * (`self`, `onmessage`, `addEventListener`, `postMessage`) over `parentPort`.
 * The host sends `{ data, ports }`, see {@link NodeWorker#postMessage}. As in
 * a Web Worker, messages wait until the worker's code has run: the returned
 * function delivers them.
 *
 * @returns {() => void}
 */
function webWorkerGlobals() {
  const { parentPort } = globalThis.process.getBuiltinModule(
    "node:worker_threads",
  );
  // Message listeners under the DOM's rules, as a Web Worker's: registration
  // order, one entry per listener and capture flag, `once`, `signal`, `this`
  // as the worker global, and a snapshot per event (listeners added meanwhile
  // wait for the next one; removed ones do not run). A listener that throws
  // is reported as uncaught and the others still run. As a Web Worker's event
  // handler, `onmessage` takes its place when first set until cleared.
  const listeners = [];
  const remove = (callback, capture) => {
    const index = listeners.findIndex((entry) =>
      entry.callback === callback && entry.capture === capture
    );
    if (index !== -1) listeners.splice(index, 1)[0].removed = true;
  };
  const captureOf = (options) =>
    typeof options === "boolean" ? options : Boolean(options?.capture);

  globalThis.addEventListener = (type, callback, options) => {
    if (type !== "message" || !callback) return;
    const capture = captureOf(options);
    const signal = typeof options === "object" ? options?.signal : undefined;
    if (signal?.aborted) return;
    if (
      listeners.some((e) => e.callback === callback && e.capture === capture)
    ) {
      return;
    }
    listeners.push({ callback, capture, once: Boolean(options?.once) });
    signal?.addEventListener("abort", () => remove(callback, capture), {
      once: true,
    });
  };
  globalThis.removeEventListener = (type, callback, options) => {
    if (type === "message") remove(callback, captureOf(options));
  };

  let onmessage = null;
  const onmessageListener = (event) => onmessage?.call(globalThis, event);
  globalThis.self = globalThis;
  Object.defineProperty(globalThis, "onmessage", {
    get: () => onmessage,
    set: (handler) => {
      const next = typeof handler === "function" ? handler : null;
      if (next && !onmessage) {
        globalThis.addEventListener("message", onmessageListener);
      }
      if (!next) globalThis.removeEventListener("message", onmessageListener);
      onmessage = next;
    },
    configurable: true,
  });
  globalThis.postMessage = (data, transfer) =>
    parentPort.postMessage(data, transfer);

  // The event as dispatched at the worker global: trusted, at its target,
  // and honouring stopImmediatePropagation.
  const deliver = ({ data, ports }) => {
    const event = new MessageEvent("message", { data, ports });
    let stopped = false;
    const set = (values) =>
      Object.defineProperties(
        event,
        Object.fromEntries(
          Object.entries(values).map(([key, value]) => [
            key,
            { value, configurable: true },
          ]),
        ),
      );
    set({
      isTrusted: true,
      target: globalThis,
      srcElement: globalThis,
      currentTarget: globalThis,
      eventPhase: Event.AT_TARGET,
      composedPath: () => stopped === null ? [] : [globalThis],
      stopImmediatePropagation: () => stopped = true,
    });
    for (const entry of [...listeners]) {
      if (stopped) break;
      if (entry.removed) continue;
      if (entry.once) remove(entry.callback, entry.capture);
      try {
        if (typeof entry.callback === "function") {
          entry.callback.call(globalThis, event);
        } else {
          entry.callback.handleEvent(event);
        }
      } catch (error) {
        globalThis.process.nextTick(() => {
          throw error;
        });
      }
    }
    stopped = null;
    set({ currentTarget: null, eventPhase: Event.NONE });
  };
  let queued = [];
  parentPort.on("message", ({ data, ports }) => {
    if (queued) queued.push({ data, ports });
    else deliver({ data, ports });
  });
  return () => {
    const events = queued;
    queued = null;
    events.forEach(deliver);
  };
}

/**
 * Whether this is Node: no Web Workers, so sandbox workers run on
 * `node:worker_threads`, but Node's built-in modules.
 *
 * @returns {boolean}
 */
export const isNode = () =>
  typeof globalThis.Worker === "undefined" &&
  typeof globalThis.process?.getBuiltinModule === "function";

// Starting a thread blocks the caller for a millisecond or two (the first one
// in a process for tens), so a burst on a cold pool starts its threads one per
// turn of the event loop rather than all in one.
let starting = Promise.resolve();
const nextTurn = () =>
  new Promise((resolve) => globalThis.setImmediate(resolve));

/**
 * Starts a {@link NodeWorker} on a later turn of the event loop, after any
 * started before it. A start no longer `wanted` by then (its task aborted, its
 * module closed) gives `null` and costs no turn.
 *
 * @param {URL|string} [workerUrl]
 * @param {() => boolean} [wanted]
 * @returns {Promise<NodeWorker|null>}
 */
export function startNodeWorker(workerUrl, wanted = () => true) {
  const started = starting.then(async () => {
    if (!wanted()) return null;
    await nextTurn();
    return wanted() ? new NodeWorker(workerUrl) : null;
  });
  starting = started.catch(() => {});
  return started;
}

/**
 * The code a thread runs: Exu's worker, or the worker module at `href`. A
 * module that fails to load, or a listener that throws on a held message, is
 * rethrown as an uncaught exception, so the thread fails whatever Node's
 * unhandled-rejection policy.
 *
 * @param {string} [href]
 * @returns {string}
 */
const threadSource = (href) =>
  href === undefined
    ? `const start = (${webWorkerGlobals})();\n(${worker})();\nstart();`
    : `const start = (${webWorkerGlobals})();\nimport(${
      JSON.stringify(href)
    }).then(start).catch((error) => process.nextTick(() => { throw error; }));`;

/**
 * A sandbox worker on a `node:worker_threads` thread that behaves like a Web
 * Worker to the channel: `message`, `error` and `messageerror` events,
 * `onmessage`, `postMessage` with transferred ports, `terminate`, `ref` and
 * `unref`. A thread that exits unasked (`process.exit`, out of memory)
 * reports an error.
 */
export class NodeWorker extends EventTarget {
  #thread;
  #ended = false;
  #onmessage = null;
  #onmessageListener = (event) => this.#onmessage?.call(this, event);

  /**
   * As a Web Worker's event handler: it takes its place among the `message`
   * listeners when first set, and keeps it until cleared.
   *
   * @type {((event: MessageEvent) => void) | null}
   */
  get onmessage() {
    return this.#onmessage;
  }

  set onmessage(handler) {
    const next = typeof handler === "function" ? handler : null;
    if (next && !this.#onmessage) {
      this.addEventListener("message", this.#onmessageListener);
    }
    if (!next) this.removeEventListener("message", this.#onmessageListener);
    this.#onmessage = next;
  }

  /**
   * @param {URL|string} [workerUrl] - A worker module to start instead of
   *   Exu's own; a relative one is resolved against the working directory.
   */
  constructor(workerUrl) {
    super();
    const { pathToFileURL } = globalThis.process.getBuiltinModule("node:url");
    const href = workerUrl === undefined
      ? undefined
      : new URL(workerUrl, pathToFileURL(`${globalThis.process.cwd()}/`)).href;
    // Looked up on each start, so tests can count threads.
    const { Worker } = globalThis.process.getBuiltinModule(
      "node:worker_threads",
    );
    this.#thread = new Worker(threadSource(href), { eval: true });

    this.#thread.on(
      "message",
      (data) => this.dispatchEvent(new MessageEvent("message", { data })),
    );
    this.#thread.on("error", (error) => this.#fail("error", error));
    this.#thread.on(
      "messageerror",
      (error) => this.#fail("messageerror", error),
    );
    this.#thread.on("exit", (code) => {
      if (!this.#ended) {
        this.#fail(
          "error",
          new Error(`Sandbox worker exited with code ${code}`),
        );
      }
    });
  }

  #fail(type, error) {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, {
      error: { value: error },
      message: { value: error?.message ?? "" },
    });
    this.dispatchEvent(event);
  }

  /**
   * Sends `data`; transferred ports reach the thread as the event's `ports`.
   *
   * @param {*} data
   * @param {Transferable[]} [transfer]
   */
  postMessage(data, transfer = []) {
    const ports = transfer.filter((item) => item instanceof MessagePort);
    this.#thread.postMessage({ data, ports }, transfer);
  }

  terminate() {
    this.#ended = true;
    this.#thread.terminate();
  }

  ref() {
    this.#thread.ref();
  }

  unref() {
    this.#thread.unref();
  }
}
