// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

import { spawnWorker } from "./spawn.js";

/**
 * Version of the messages between host and worker. Keep in step with
 * `PROTOCOL` in ./worker.js.
 */
export const PROTOCOL = 2;

/** How long a worker may take to start and accept the module, in ms. */
const START_TIMEOUT = 30_000;

const errorTypes = {
  CompileError: WebAssembly.CompileError,
  LinkError: WebAssembly.LinkError,
  RangeError,
  ReferenceError,
  RuntimeError: WebAssembly.RuntimeError,
  SyntaxError,
  TypeError,
};

const incompatibleWorker = (protocol) =>
  new Error(
    `Incompatible Exu sandbox worker: protocol ${
      protocol ?? "unknown"
    }, expected ${PROTOCOL}`,
  );

const responseError = (details) => {
  const ErrorType = Object.hasOwn(errorTypes, details?.name)
    ? errorTypes[details.name]
    : Error;
  const error = new ErrorType(details?.message);
  error.name = details?.name ?? "Error";
  error.stack = details?.stack;
  return error;
};

/**
 * One sandbox worker thread. Requests are serialized: one is in flight at a
 * time, the rest queue behind it. Each task gets its own memory port, closed
 * when the task ends, so an idle channel holds no port. The channel outlives
 * tasks when pooled; `kill()` ends it for good.
 */
export class WorkerChannel {
  #worker;
  #port = null;
  #fail;
  #pending = Promise.resolve();
  #queued = 0;
  #idleSince;
  #startTimeout;
  #reject = null;
  #signal;
  #dead = false;
  #failure;

  /** Settles once the worker accepted the module and protocol. */
  ready;

  /** Called when the idle worker's `idleTimeout` ran out. */
  onexpire = null;

  /**
   * @param {Object} config
   * @param {WebAssembly.Module} config.module - The compiled module.
   * @param {string} [config.importsUrl] - The module's imports, if any.
   * @param {URL|string} [config.workerUrl] - The worker to start.
   * @param {number} [config.idleTimeout] - How long the worker waits for
   *   another task before it reports `onexpire`, in ms; 0 never.
   * @param {number} [config.startTimeout] - How long the worker may take to
   *   start, in ms.
   */
  constructor({
    module,
    importsUrl,
    workerUrl,
    idleTimeout = 0,
    startTimeout = START_TIMEOUT,
  }) {
    this.#startTimeout = startTimeout;
    const fail = (event) => {
      if (this.#dead) return;
      event.preventDefault();
      this.kill(
        event.error instanceof Error
          ? event.error
          : new Error(event.message || "Sandbox worker failed"),
      );
    };
    this.#fail = fail;

    // Requests queue behind the worker's start; a failed start kills the
    // channel with that error.
    this.#pending = spawnWorker(workerUrl, () => !this.#dead).then((worker) => {
      if (this.#dead) {
        worker?.terminate();
        return;
      }
      this.#worker = worker;
      worker.addEventListener("error", fail);
      worker.addEventListener("messageerror", fail);
      worker.addEventListener("message", ({ data }) => {
        if (data?.type === "expire" && !this.#dead) this.onexpire?.();
      });
    }).catch((error) => this.kill(error));

    this.ready = this.request({
      type: "init",
      protocol: PROTOCOL,
      module,
      importsUrl,
      idleTimeout,
    }).then((initialized) => {
      if (initialized?.protocol !== PROTOCOL) {
        throw incompatibleWorker(initialized?.protocol);
      }
    });
    // A worker that failed its start is never pooled; the error surfaces
    // through the first task's `begin`.
    this.ready.catch((error) => this.kill(error));

    // A worker whose download stalls would leave its task pending for good.
    const timer = setTimeout(
      () =>
        this.kill(
          new Error(`Sandbox worker did not start within ${startTimeout} ms`),
        ),
      startTimeout,
    );
    const stop = () => clearTimeout(timer);
    this.ready.then(stop, stop);
  }

  /** Whether the channel was killed. */
  get dead() {
    return this.#dead;
  }

  /** Whether no request is queued or in flight. */
  get idle() {
    return this.#queued === 0;
  }

  /** When the last request settled, while none is queued or in flight. */
  get idleSince() {
    return this.#idleSince;
  }

  /** The abort signal of the task using the channel, if any. */
  set signal(signal) {
    this.#signal = signal;
  }

  /** Sends a message to the worker, once it started. */
  request(message, transfer = []) {
    return this.#enqueue(() => this.#worker, message, transfer);
  }

  /** Starts a task: a fresh instance and its own memory port. */
  begin() {
    const mc = new MessageChannel();
    this.#port = mc.port1;
    this.#port.addEventListener("messageerror", this.#fail);
    const begun = this.request({ type: "begin" }, [mc.port2]);
    // Aborted before it was sent, `port2` was never transferred: close it.
    begun.catch(() => mc.port2.close());
    // Instantiation, custom imports and their `oninit` must not hang either.
    const timer = setTimeout(
      () =>
        this.kill(
          new Error(
            `Sandbox instance did not start within ${this.#startTimeout} ms`,
          ),
        ),
      this.#startTimeout,
    );
    const stop = () => clearTimeout(timer);
    begun.then(stop, stop);
    return begun;
  }

  /** Ends the task: drops its instance and closes its memory port. */
  end() {
    const ended = this.request({ type: "end" });
    this.#closePort();
    return ended;
  }

  /** Sends a message to the current task's memory port. */
  memory(message, transfer = []) {
    if (!this.#port) {
      return Promise.reject(new Error("No task is running in this worker"));
    }
    return this.#enqueue(this.#port, message, transfer);
  }

  #closePort() {
    this.#port?.close();
    this.#port = null;
  }

  #enqueue(receiver, message, transfer) {
    if (this.#queued++ === 0) this.#idleSince = undefined;
    const request = this.#pending.then(() => {
      if (this.#dead) throw this.#failure;
      return this.#send(
        typeof receiver === "function" ? receiver() : receiver,
        message,
        transfer,
      );
    });
    const done = () => {
      if (--this.#queued === 0) this.#idleSince = performance.now();
    };
    this.#pending = request.then(done, done);
    return request;
  }

  #send(receiver, message, transfer) {
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
      const abort = () => this.kill(signal.reason);
      const rejectRequest = (error) => finish(reject, error);

      this.#reject = rejectRequest;

      if (signal?.aborted) {
        this.kill(signal.reason);
        return;
      }

      signal?.addEventListener("abort", abort, { once: true });
      receiver.onmessage = ({ data }) => {
        // Idle-expiry notices are not replies.
        if (data?.type === "expire") return;
        if (data?.ok === true) {
          finish(resolve, data.value);
        } else if (data?.ok === false) {
          finish(reject, responseError(data.error));
        } else {
          // Workers from Exu 0.1 reply without an envelope.
          finish(reject, incompatibleWorker());
        }
      };

      try {
        receiver.postMessage(message, transfer);
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  /** Lets an idle channel's thread not keep the process alive, if possible. */
  unref() {
    this.#worker?.unref?.();
  }

  ref() {
    this.#worker?.ref?.();
  }

  /**
   * Ends the worker: the request in flight and every queued or later one
   * rejects with `reason`.
   */
  kill(reason = new Error("Sandbox terminated")) {
    if (this.#dead) return;
    this.#dead = true;
    this.#failure = reason;
    this.#reject?.(reason);
    this.#closePort();
    this.#worker?.terminate();
  }
}
