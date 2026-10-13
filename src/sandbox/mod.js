// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

import { isExportName, NullTarget } from "../proxies.js";
import { PROTOCOL, WorkerChannel } from "./channel.js";

export { PROTOCOL };

const isAddress = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * One task's view of a sandbox worker: a fresh WebAssembly instance, its
 * exports and its memory. The worker itself may be shared with earlier and
 * later tasks through a pool; once the task ends, its handles reject.
 */
export class Sandbox {
  #channel;
  #begun;
  #ended = false;
  #failure;

  /**
   * @param {Object} config - Configuration object for the sandbox.
   * @param {WorkerChannel} [config.channel] - A (pooled) worker to use.
   * @param {WebAssembly.Module} [config.module] - The compiled module, to start
   *   a worker of its own when no channel is given.
   * @param {string} [config.importsUrl] - The URL for the module's imports.
   * @param {AbortSignal} [config.signal] - An optional AbortSignal to cancel operations.
   * @param {URL|string} [config.workerUrl] - The worker module to start (see {@link spawnWorker}).
   * @param {number} [config.startTimeout] - How long the worker may take to
   *   start, in ms.
   */
  constructor({
    channel,
    module,
    importsUrl,
    signal,
    workerUrl,
    startTimeout,
  }) {
    this.#channel =
      channel ??
      new WorkerChannel({ module, importsUrl, workerUrl, startTimeout });
    this.#channel.signal = signal;
    this.#begun = this.#channel.ready.then(() =>
      this.#ended ? Promise.reject(this.#failure) : this.#channel.begin(),
    );
    // Surfaced through the task's requests; a sandbox ended before any must
    // not raise an unhandled rejection.
    this.#begun.catch(() => {});
  }

  /**
   * Gets asynchrously the exports object from the WebAssembly module.
   *
   * @type {Promise<WebAssembly.Exports>}
   */
  get exports() {
    return new Proxy(NullTarget, {
      get: (_, prop) =>
        isExportName(prop)
          ? (...args) =>
              this.#send("request", { type: "call", member: prop, args })
          : undefined,
    });
  }

  get globals() {
    return this.#begun.then(({ globals }) => globals);
  }

  /**
   * Gets asynchrously the memory object for the WebAssembly module.
   *
   * @type {Promise<WebAssembly.Memory>}
   */
  get memory() {
    return this.#begun.then(({ memory }) => memory);
  }

  /**
   * Copies memory between the WebAssembly and JavaScript contexts. Supported
   * pairs are `null, number`, `number, Uint8Array`, `number, number`, and
   * `Uint8Array, Uint8Array`.
   *
   * @param {number|Uint8Array|null} dest - The destination memory address or buffer.
   * @param {number|Uint8Array} source - The source memory address or buffer.
   * @param {number} [count] - The number of bytes to copy. Required for numeric sources and bounded by Uint8Array sources.
   *
   * @returns {Promise<void|Uint8Array>} A promise that resolves once the operation is complete.
   *
   * @throws {TypeError} Throws if the arguments are invalid.
   */
  memcpy = async (dest, source, count) => {
    if (typeof source === "number" && !isAddress(source)) {
      throw new TypeError("source must be a non-negative integer address");
    }
    if (typeof dest === "number" && !isAddress(dest)) {
      throw new TypeError("dest must be a non-negative integer address");
    }

    if (
      typeof source === "number" &&
      (dest === null || typeof dest === "number") &&
      (!Number.isSafeInteger(count) || count < 0)
    ) {
      throw new TypeError("count must be a non-negative integer");
    }

    if (
      typeof dest === "number" &&
      source instanceof Uint8Array &&
      count !== undefined &&
      (!Number.isSafeInteger(count) || count < 0 || count > source.byteLength)
    ) {
      throw new TypeError(
        "count must be a non-negative integer no greater than source length",
      );
    }

    if (dest === null && typeof source === "number") {
      // Copy from WASM memory to JS memory
      return await this.#send("memory", { get: { source, count } });
    } else if (typeof dest === "number" && source instanceof Uint8Array) {
      // Copy from JS memory to WASM memory

      const transferable = new Uint8Array(source);
      return await this.#send(
        "memory",
        { set: { dest, source: transferable, count } },
        [transferable.buffer],
      );
    } else if (typeof dest === "number" && typeof source === "number") {
      // Copy from WASM memory to WASM memory
      await this.#send("memory", { set: { source, dest, count } });
    } else if (dest instanceof Uint8Array && source instanceof Uint8Array) {
      // Copy from JS memory to JS memory
      dest.set(source);
    } else {
      throw new TypeError("Invalid arguments.");
    }
  };

  #send(kind, message, transfer) {
    if (this.#ended) return Promise.reject(this.#failure);
    // Requests follow the task's `begin`, even when sent right away.
    return this.#begun.then(() => {
      if (this.#ended) throw this.#failure;
      return this.#channel[kind](message, transfer);
    });
  }

  /**
   * Ends the task and its worker: the request in flight and every queued or
   * later one rejects with `reason`.
   */
  terminate = (reason = new Error("Sandbox terminated")) => {
    this.#end(reason);
    this.#channel.kill(reason);
  };

  /**
   * Ends the task. Its worker is handed back for reuse only when `reuse` is
   * set, it is still alive and nothing of the task is still running there;
   * otherwise it is killed.
   *
   * @param {boolean} reuse - Whether the worker may serve another task.
   * @returns {boolean} Whether the worker can be reused.
   */
  release(reuse) {
    if (this.#ended) return false;
    this.#end(new Error("Sandbox terminated"));
    const channel = this.#channel;
    channel.signal = undefined;
    if (!reuse || channel.dead || !channel.idle) {
      channel.kill(this.#failure);
      return false;
    }
    channel.end().catch((error) => channel.kill(error));
    return true;
  }

  #end(reason) {
    if (this.#ended) return;
    this.#ended = true;
    this.#failure = reason;
  }
}
