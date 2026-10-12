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
 * The host sends `{ data, ports }`, see {@link NodeWorker#postMessage}.
 */
function webWorkerGlobals() {
  const { parentPort } = globalThis.process.getBuiltinModule(
    "node:worker_threads",
  );
  const listeners = new Set();
  let onmessage = null;

  globalThis.self = globalThis;
  Object.defineProperty(globalThis, "onmessage", {
    get: () => onmessage,
    set: (listener) => onmessage = listener,
    configurable: true,
  });
  globalThis.addEventListener = (type, listener) => {
    if (type === "message") listeners.add(listener);
  };
  globalThis.removeEventListener = (type, listener) => {
    if (type === "message") listeners.delete(listener);
  };
  globalThis.postMessage = (data, transfer) =>
    parentPort.postMessage(data, transfer);

  parentPort.on("message", ({ data, ports }) => {
    const event = { data, ports };
    onmessage?.(event);
    for (const listener of listeners) listener(event);
  });
}

/**
 * Whether sandbox workers must run on `node:worker_threads`: there are no Web
 * Workers here (Node), but Node's built-in modules are.
 *
 * @returns {boolean}
 */
export const needsNodeWorker = () =>
  typeof globalThis.Worker === "undefined" &&
  typeof globalThis.process?.getBuiltinModule === "function";

/**
 * The code a thread runs: Exu's worker, or the worker module at `href`.
 *
 * @param {string} [href]
 * @returns {string}
 */
const threadSource = (href) =>
  href === undefined
    ? `(${webWorkerGlobals})();\n(${worker})();`
    : `(${webWorkerGlobals})();\nimport(${JSON.stringify(href)});`;

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

  /** @type {((event: MessageEvent) => void) | null} */
  onmessage = null;

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

    this.#thread.on("message", (data) => {
      const event = new MessageEvent("message", { data });
      this.onmessage?.(event);
      this.dispatchEvent(event);
    });
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
