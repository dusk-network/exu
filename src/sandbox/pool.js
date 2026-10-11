// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

/**
 * How long every busy worker must have run no call before a waiting task may
 * start an extra one, in ms.
 */
const STALL = 100;

/** Lets a timer not keep the process alive (Node, Bun, Deno). */
const unrefTimer = (timer) => {
  if (typeof timer?.unref === "function") timer.unref();
  else globalThis.Deno?.unrefTimer?.(timer);
};

/**
 * A bounded set of sandbox workers for one module and imports. Workers are
 * started on demand up to `size`; a task waits when all are busy. A worker
 * that comes back healthy goes to the next waiting task, or rests idle until
 * its own idle timeout reports it (see WorkerChannel#onexpire).
 *
 * The bound would deadlock a task that waits on another task of the same
 * module while every worker is taken. So while tasks wait, the pool checks
 * every `STALL` ms: if every busy worker ran no call for that long (its task
 * waits on something else), the next waiting task gets an extra worker, which
 * ends with its task. While workers compute, the bound holds.
 */
export class Pool {
  #create;
  #size;
  #reuse;
  #count = 0;
  #idle = [];
  #waiters = [];
  #busy = new Set();
  #retiring = new WeakSet();
  #timer = null;

  /**
   * @param {Object} config
   * @param {() => import("./channel.js").WorkerChannel} config.create - Starts a worker.
   * @param {number} config.size - The most workers alive at once.
   * @param {boolean} config.reuse - Whether idle workers wait for later tasks.
   */
  constructor({ create, size, reuse }) {
    this.#create = create;
    this.#size = size;
    this.#reuse = reuse;
  }

  /** Starts a worker in a free place; gives the place back if that throws. */
  #startCounted() {
    this.#count++;
    try {
      return this.#start();
    } catch (error) {
      this.#count--;
      throw error;
    }
  }

  #start() {
    const channel = this.#create();
    channel.onexpire = () => {
      const index = this.#idle.indexOf(channel);
      if (index === -1) return; // busy again
      this.#idle.splice(index, 1);
      channel.kill();
      this.#count--;
    };
    return channel;
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
      if (!channel.dead) {
        channel.ref();
        return Promise.resolve(this.#lend(channel));
      }
      this.#count--;
    }

    if (this.#count < this.#size) {
      return Promise.resolve(this.#lend(this.#startCounted()));
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        cancel: () => signal?.removeEventListener("abort", abort),
      };
      const abort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index !== -1) this.#waiters.splice(index, 1);
        if (this.#waiters.length === 0 && this.#timer !== null) {
          clearTimeout(this.#timer);
          this.#timer = null;
        }
        reject(signal.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.#waiters.push(waiter);
      this.#watch();
    });
  }

  /** Takes the next waiting task; stops the stall check once none waits. */
  #nextWaiter() {
    const waiter = this.#waiters.splice(0, 1)[0];
    if (this.#waiters.length === 0 && this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    return waiter;
  }

  /** Checks for stalled workers while tasks wait (see the class notes). */
  #watch() {
    if (this.#timer !== null || this.#waiters.length === 0) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#relieve();
    }, STALL);
    unrefTimer(this.#timer);
  }

  #relieve() {
    if (this.#waiters.length === 0) return;
    const now = performance.now();
    const stalled = [...this.#busy].every((channel) =>
      channel.idleSince !== undefined && now - channel.idleSince >= STALL
    );
    if (stalled) {
      const waiter = this.#nextWaiter();
      waiter.cancel();
      try {
        waiter.resolve(this.#lend(this.#startCounted()));
      } catch (error) {
        waiter.reject(error);
      }
    }
    this.#watch();
  }

  /**
   * Returns a worker after a task. A reusable one goes to the next waiting
   * task or rests idle; otherwise it is killed and its place freed.
   *
   * @param {import("./channel.js").WorkerChannel} channel
   * @param {boolean} reusable
   */
  release(channel, reusable) {
    this.#busy.delete(channel);
    if (!reusable || channel.dead || this.#retiring.has(channel)) {
      channel.kill();
      this.#count--;
      // Replace it for a waiting task, but only within the bound.
      if (this.#count < this.#size && this.#waiters.length) {
        const waiter = this.#nextWaiter();
        waiter.cancel();
        try {
          waiter.resolve(this.#lend(this.#startCounted()));
        } catch (error) {
          waiter.reject(error);
        }
      }
      return;
    }

    // An extra worker started for a stalled pool ends with its task, even
    // when tasks are waiting: they wait for a worker within the bound.
    if (this.#count > this.#size) {
      channel.kill();
      this.#count--;
      return;
    }

    const waiter = this.#nextWaiter();
    if (waiter) {
      waiter.cancel();
      waiter.resolve(this.#lend(channel));
      return;
    }

    if (!this.#reuse) {
      channel.kill();
      this.#count--;
      return;
    }

    channel.unref();
    this.#idle.push(channel);
  }

  /**
   * Ends every idle worker now. Busy ones finish their task first and end
   * then; later tasks start new workers.
   */
  close() {
    for (const channel of this.#idle.splice(0)) {
      channel.kill();
      this.#count--;
    }
    for (const channel of this.#busy) this.#retiring.add(channel);
  }

  /** Whether the pool has no workers and no waiting tasks. */
  get empty() {
    return this.#count === 0 && this.#waiters.length === 0;
  }

  #lend(channel) {
    this.#busy.add(channel);
    return channel;
  }
}
