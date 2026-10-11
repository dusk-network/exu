// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.
//
// @ts-self-types="./mod.d.ts"

/**
 * Run WebAssembly modules as isolated, abortable tasks in worker sandboxes.
 *
 * @module
 */

/**
 * @typedef {Object} MemoryAccessor
 *
 * @property {WebAssembly.Memory} memory - The WebAssembly memory object
 * @property {function} memcpy - The memory copy function
 * @property {Object} globals - The WebAssembly's globals
 */

/**
 * This is a callback function description.
 *
 * @callback TaskCallback
 * @param {WebAssembly.Exports} exports - The WebAssembly exports object
 * @param {MemoryAccessor} accessor- The memory accessor object
 *
 * @returns {void} - Description of the return value.
 */

/**
 * @typedef {Object} ModuleOptions
 * @property {URL|string|ArrayBuffer|ArrayBufferView} source - The source of the WebAssembly
 */

/**
 * @typedef {Object} SandboxOptions
 * @property {AbortSignal} signal - An AbortSignal object instance
 * @property {URL|string} [importsUrl] - The URL of the imports
 */

/**
 * @typedef {Object.<string, *>} Options
 */

import { isExportName, MemoryProxy, NullTarget } from "./proxies.js";
import { Sandbox } from "./sandbox/mod.js";

/**
 * Ensures at runtime the imports value is valid.
 * @private
 *
 * @param {URL|string} [value] - the imports value
 *
 * @returns {string|undefined} - the validated imports value
 */
/**
 * Settles like `promise`, but rejects with the abort reason as soon as
 * `signal` aborts.
 * @private
 *
 * @param {Promise} promise - The work to wait for
 * @param {AbortSignal} [signal] - Stops the wait
 *
 * @returns {Promise}
 */
const untilAborted = (promise, signal) => {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    // Handled first, so the work's own late failure is never unhandled.
    promise.then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", abort)
    );
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
  });
};

const arrayBufferLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
).get;

/**
 * Whether `value` is an ArrayBuffer, from this realm or another (e.g. an
 * iframe), where `instanceof` would say no.
 * @private
 *
 * @param {*} value
 * @returns {boolean}
 */
const isArrayBuffer = (value) => {
  try {
    arrayBufferLength.call(value);
    return true;
  } catch {
    return false;
  }
};

const ensureImportsValue = (value) => {
  if (value instanceof URL) {
    return value.href;
  } else if (typeof value === "string") {
    return value;
  } else if (typeof value === "undefined" || null) {
    return undefined;
  } else {
    throw new TypeError("imports can be only a URL, a string or undefined");
  }
};

/**
 * Class representing a WebAssembly module running in isolation in a
 * {@link Sandbox}.
 *
 * All operations are asynchronous and return a Promise.
 */
export class Module {
  #module;
  #importsUrl;

  /**
   * Creates a Module instance.
   *
   * @param {ModuleOptions|ModuleOptions#source} options
   */
  constructor(options) {
    const source = options?.source ?? options;
    if (source instanceof URL) {
      this.#module = WebAssembly.compileStreaming(fetch(source.href));
    } else if (typeof source === "string") {
      this.#module = WebAssembly.compileStreaming(fetch(source));
    } else if (isArrayBuffer(source)) {
      this.#module = WebAssembly.compile(source);
    } else if (ArrayBuffer.isView(source)) {
      // Engines differ on which views they compile (V8 refuses DataView).
      this.#module = WebAssembly.compile(
        new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
      );
    } else {
      throw new TypeError(
        "`source` must be a URL, a string, an ArrayBuffer or an ArrayBuffer view",
      );
    }
    // Tasks surface compile failures; until one runs, they are not unhandled.
    this.#module.catch(() => {});
  }

  /**
   * The default imports URL (if any)
   *
   * @type {URL}
   */
  get defaultImports() {
    return this.#importsUrl;
  }

  set defaultImports(value) {
    this.#importsUrl = ensureImportsValue(value);
  }

  /**
   * Creates a new {Sandbox} instance for the module.
   *
   * @param {SandboxOptions} [options] - The options for the sandbox
   *
   * @returns {Promise<Sandbox>} - The sandbox instance
   */
  async #createSandbox(options = {}) {
    const { signal, imports } = options;

    const module = await untilAborted(this.#module, signal);
    // The abort may land between compilation settling and this line.
    signal?.throwIfAborted();

    const importsUrl = ensureImportsValue(imports) ?? this.#importsUrl;

    return new Sandbox({ module, importsUrl, signal });
  }

  /**
   * Creates a task to run asynchronously in a newly created {Sandbox}.
   *
   * @param {TaskCallback} fn - The function to run in the sandbox
   * @returns {Promise<function>} - An asynchronous function can be run with {SandboxOptions}
   */
  task(fn) {
    return async (options = {}) => {
      const { signal } = options;
      let sandbox;
      try {
        sandbox = await this.#createSandbox(options);
      } catch (error) {
        // Aborted meanwhile: the abort reason wins over, say, a compile error.
        signal?.throwIfAborted();
        throw error;
      }
      // Stop the worker on abort, even between requests to it.
      const abort = () => sandbox.terminate(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });

      try {
        // An abort rejects the task at once, even while the callback waits on
        // something else; whatever it still runs then meets the dead sandbox.
        const result = await untilAborted(
          (async () => {
            const memory = await sandbox.memory;
            const globals = await sandbox.globals;
            // A task aborted while it started never runs its callback.
            signal?.throwIfAborted();

            return await fn(sandbox.exports, {
              memory: memory ?? MemoryProxy,
              memcpy: sandbox.memcpy,
              globals,
            });
          })(),
          signal,
        );
        signal?.throwIfAborted();
        return result;
      } catch (error) {
        // An aborted task rejects with the abort reason, however the callback
        // handled the failed request.
        signal?.throwIfAborted();
        throw error;
      } finally {
        signal?.removeEventListener("abort", abort);
        sandbox.terminate();
      }
    };
  }

  /**
   * Executes a single method from the WebAssembly module.
   * Each call creates a new {Sandbox} instance, thus it is not suitable for
   * running multiple methods. See {Module#task} for that.
   *
   * @param {SandboxOptions} [options] - The options for the sandbox
   *
   * @returns {WebAssembly.Exports} -The WebAssembly exports object
   */
  api = (options = {}) =>
    new Proxy(NullTarget, {
      get: (_, prop) =>
        isExportName(prop)
          ? (...args) => this.task((exports) => exports[prop](...args))(options)
          : undefined,
    });
}
