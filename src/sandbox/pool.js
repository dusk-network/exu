// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

/** Lets a timer not keep the process alive (Node, Bun, Deno). */
const unrefTimer = (timer) => {
  if (typeof timer?.unref === "function") timer.unref();
  else globalThis.Deno?.unrefTimer?.(timer);
};

/**
 * A bounded set of sandbox workers for one module and imports. Workers are
 * started on demand up to `size`; a task waits when all are busy. A worker
 * that comes back healthy goes to the next waiting task, or rests idle and
 * ends after `idleTimeout` ms without work (at once when it is 0).
 */
export class Pool {
  #create;
  #size;
  #idleTimeout;
  #count = 0;
  #idle = [];
  #timers = new Map();
  #waiters = [];

  /**
   * @param {Object} config
   * @param {() => import("./channel.js").WorkerChannel} config.create - Starts a worker.
   * @param {number} config.size - The most workers alive at once.
   * @param {number} config.idleTimeout - How long an idle worker lives, in ms.
   */
  constructor({ create, size, idleTimeout }) {
    this.#create = create;
    this.#size = size;
    this.#idleTimeout = idleTimeout;
  }

  /**
   * Takes an idle worker, starts one, or waits for one to come back.
   *
   * @param {AbortSignal} [signal] - Gives up waiting on abort.
   * @returns {Promise<import("./channel.js").WorkerChannel>}
   */
  acquire(signal) {
    signal?.throwIfAborted();

    let channel;
    while ((channel = this.#idle.pop())) {
      clearTimeout(this.#timers.get(channel));
      this.#timers.delete(channel);
      if (!channel.dead) {
        channel.ref();
        return Promise.resolve(channel);
      }
      this.#count--;
    }

    if (this.#count < this.#size) {
      this.#count++;
      return Promise.resolve(this.#create());
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        cancel: () => signal?.removeEventListener("abort", abort),
      };
      const abort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index !== -1) this.#waiters.splice(index, 1);
        reject(signal.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  /**
   * Returns a worker after a task. A reusable one goes to the next waiting
   * task or rests idle; otherwise it is killed and its place freed.
   *
   * @param {import("./channel.js").WorkerChannel} channel
   * @param {boolean} reusable
   */
  release(channel, reusable) {
    if (!reusable || channel.dead) {
      channel.kill();
      this.#count--;
      const waiter = this.#waiters.shift();
      if (waiter) {
        waiter.cancel();
        this.#count++;
        waiter.resolve(this.#create());
      }
      return;
    }

    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.cancel();
      waiter.resolve(channel);
      return;
    }

    if (this.#idleTimeout === 0) {
      channel.kill();
      this.#count--;
      return;
    }

    channel.unref();
    this.#idle.push(channel);
    const timer = setTimeout(() => {
      const index = this.#idle.indexOf(channel);
      if (index === -1) return;
      this.#idle.splice(index, 1);
      this.#timers.delete(channel);
      channel.kill();
      this.#count--;
    }, this.#idleTimeout);
    unrefTimer(timer);
    this.#timers.set(channel, timer);
  }

  /** Ends every idle worker now. Busy ones finish their task first. */
  close() {
    for (const channel of this.#idle.splice(0)) {
      clearTimeout(this.#timers.get(channel));
      this.#timers.delete(channel);
      channel.kill();
      this.#count--;
    }
  }
}
