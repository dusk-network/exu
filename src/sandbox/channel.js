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
 * One sandbox worker thread and its memory port. Requests are serialized: one
 * is in flight at a time, the rest queue behind it. The channel outlives
 * tasks when pooled; `kill()` ends it for good.
 */
export class WorkerChannel {
  #worker;
  #port;
  #pending = Promise.resolve();
  #queued = 0;
  #reject = null;
  #signal;
  #dead = false;
  #failure;

  /** Settles once the worker accepted the module and protocol. */
  ready;

  /**
   * @param {Object} config
   * @param {WebAssembly.Module} config.module - The compiled module.
   * @param {string} [config.importsUrl] - The module's imports, if any.
   * @param {URL|string} [config.workerUrl] - The worker to start.
   */
  constructor({ module, importsUrl, workerUrl }) {
    const mc = new MessageChannel();
    this.#port = mc.port1;

    const fail = (event) => {
      if (this.#dead) return;
      event.preventDefault();
      this.kill(
        event.error instanceof Error
          ? event.error
          : new Error(event.message || "Sandbox worker failed"),
      );
    };
    this.#port.addEventListener("messageerror", fail);

    // Requests queue behind the worker's start; a failed start kills the
    // channel with that error.
    this.#pending = spawnWorker(workerUrl).then((worker) => {
      if (this.#dead) {
        worker.terminate();
        return;
      }
      this.#worker = worker;
      worker.addEventListener("error", fail);
      worker.addEventListener("messageerror", fail);
    }).catch((error) => this.kill(error));

    this.ready = this.request(
      { type: "init", protocol: PROTOCOL, module, importsUrl },
      [mc.port2],
    ).then((initialized) => {
      if (initialized?.protocol !== PROTOCOL) {
        throw incompatibleWorker(initialized?.protocol);
      }
    });
    // Surfaced through the first task's `begin`.
    this.ready.catch(() => {});
  }

  /** Whether the channel was killed. */
  get dead() {
    return this.#dead;
  }

  /** Whether no request is queued or in flight. */
  get idle() {
    return this.#queued === 0;
  }

  /** The abort signal of the task using the channel, if any. */
  set signal(signal) {
    this.#signal = signal;
  }

  /** Sends a message to the worker, once it started. */
  request(message, transfer = []) {
    return this.#enqueue(() => this.#worker, message, transfer);
  }

  /** Sends a message to the worker's memory port. */
  memory(message, transfer = []) {
    return this.#enqueue(this.#port, message, transfer);
  }

  #enqueue(receiver, message, transfer) {
    this.#queued++;
    const request = this.#pending.then(() => {
      if (this.#dead) throw this.#failure;
      return this.#send(
        typeof receiver === "function" ? receiver() : receiver,
        message,
        transfer,
      );
    });
    const done = () => this.#queued--;
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
    this.#port.close();
    this.#worker?.terminate();
  }
}
