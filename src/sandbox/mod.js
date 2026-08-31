// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

import { NullTarget } from "../proxies.js";
import worker from "./worker.js";

const isAddress = (value) => Number.isSafeInteger(value) && value >= 0;

const errorTypes = {
  CompileError: WebAssembly.CompileError,
  LinkError: WebAssembly.LinkError,
  RangeError,
  ReferenceError,
  RuntimeError: WebAssembly.RuntimeError,
  SyntaxError,
  TypeError,
};

const responseError = (details) => {
  if (!details) return new Error("Invalid sandbox response");
  const ErrorType = Object.hasOwn(errorTypes, details.name)
    ? errorTypes[details.name]
    : Error;
  const error = new ErrorType(details.message);
  error.name = details.name;
  error.stack = details.stack;
  return error;
};

// Create a Blob URL for the worker code.
const workerUrl = URL.createObjectURL(
  new Blob([`(${worker})()`], { type: "application/javascript" }),
);

/**
 * Creates a sandbox environment for executing code in a separate context
 * using Web Workers.
 */
export class Sandbox {
  #worker;
  #failure;
  #initialized;
  #memoryPort;
  #pending = Promise.resolve();
  #reject;
  #signal;
  #terminated = false;

  /**
   * Constructs the sandbox and initializes its worker and memory channel.
   *
   * @param {Object} config - Configuration object for the sandbox.
   * @param {string} config.module - The module URL to load in the worker.
   * @param {string} config.importsUrl - The URL for the module's imports.
   * @param {AbortSignal} config.signal - An optional AbortSignal to cancel operations.
   */
  constructor({ module, importsUrl, signal }) {
    this.#worker = new Worker(workerUrl, { type: "module" });
    this.#signal = signal;

    const mc = new MessageChannel();
    this.#memoryPort = mc.port1;

    const fail = (event) => {
      if (this.#terminated) return;
      event.preventDefault();
      this.terminate(
        event.error instanceof Error
          ? event.error
          : new Error(event.message || "Sandbox worker failed"),
      );
    };
    this.#worker.addEventListener("error", fail);
    this.#worker.addEventListener("messageerror", fail);
    this.#memoryPort.addEventListener("messageerror", fail);

    this.#initialized = this.send(this.#worker, { module, importsUrl }, [
      mc.port2,
    ]);
  }

  /**
   * Gets asynchrously the exports object from the WebAssembly module.
   *
   * @type {Promise<WebAssembly.Exports>}
   */
  get exports() {
    return new Proxy(NullTarget, {
      get: (_, prop) => (...args) =>
        this.send(this.#worker, { member: prop, args }),
    });
  }

  get globals() {
    return this.#initialized.then(({ globals }) => globals);
  }

  /**
   * Gets asynchrously the memory object for the WebAssembly module.
   *
   * @type {Promise<WebAssembly.Memory>}
   */
  get memory() {
    return this.#initialized.then(({ memory }) => memory);
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
      return await this.send(this.#memoryPort, {
        get: { source, count },
      });
    } else if (typeof dest === "number" && source instanceof Uint8Array) {
      // Copy from JS memory to WASM memory

      const transferable = new Uint8Array(source);
      return await this.send(
        this.#memoryPort,
        { set: { dest, source: transferable, count } },
        [transferable.buffer],
      );
    } else if (typeof dest === "number" && typeof source === "number") {
      // Copy from WASM memory to WASM memory
      await this.send(this.#memoryPort, { set: { source, dest, count } });
    } else if (dest instanceof Uint8Array && source instanceof Uint8Array) {
      // Copy from JS memory to JS memory
      dest.set(source);
    } else {
      throw new TypeError("Invalid arguments.");
    }
  };

  /**
   * Sends a message to the specified receiver (worker or message port).
   *
   * @param {Worker|MessagePort} receiver - The message receiver.
   * @param {...*} args - See `postMessage` arguments.
   *
   * @returns {Promise<any>} A promise that resolves with the response from the receiver.
   */
  send = (receiver, ...args) => {
    const request = this.#pending.then(() => {
      if (this.#terminated) throw this.#failure;
      return this.#send(receiver, ...args);
    });
    this.#pending = request.catch(() => {});
    return request;
  };

  #send(receiver, ...args) {
    return new Promise((resolve, reject) => {
      const signal = this.#signal;
      let settled = false;

      const finish = (settle, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        receiver.onmessage = null;
        if (this.#reject === rejectRequest) this.#reject = null;
        settle(value);
      };
      const abort = () => this.terminate(signal.reason);
      const rejectRequest = (error) => finish(reject, error);

      this.#reject = rejectRequest;

      if (signal?.aborted) {
        this.terminate(signal.reason);
        return;
      }

      signal?.addEventListener("abort", abort, { once: true });
      receiver.onmessage = ({ data }) => {
        if (data?.ok === true) {
          finish(resolve, data.value);
        } else {
          finish(reject, responseError(data?.error));
        }
      };

      try {
        receiver.postMessage(...args);
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  terminate = (reason = new Error("Sandbox terminated")) => {
    if (this.#terminated) return;
    this.#terminated = true;
    this.#failure = reason;
    this.#reject?.(reason);
    this.#memoryPort.close();
    this.#worker.terminate();
  };
}
