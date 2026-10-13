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
 * A bounded set of sandbox workers for one module, whatever imports each
 * loaded. Workers are started on demand up to `size`; a task waits when all
 * are busy. A worker that comes back healthy goes to the next waiting task
 * with the same imports, or rests idle until its own idle timeout reports it
 * (see WorkerChannel#onexpire). A task with other imports takes the place of
 * an idle worker, or of the next one to come back.
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
  #imports = new WeakMap();
  #timer = null;

  /**
   * @param {Object} config
   * @param {(importsUrl?: string) => import("./channel.js").WorkerChannel} config.create -
   *   Starts a worker with the given imports.
   * @param {number} config.size - The most workers alive at once.
   * @param {boolean} config.reuse - Whether idle workers wait for later tasks.
   */
  constructor({ create, size, reuse }) {
    this.#create = create;
    this.#size = size;
    this.#reuse = reuse;
  }

  /** Starts a worker in a free place; gives the place back if that throws. */
  #start(importsUrl) {
    this.#count++;
    let channel;
    try {
      channel = this.#create(importsUrl);
    } catch (error) {
      this.#count--;
      throw error;
    }
    this.#imports.set(channel, importsUrl);
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
   * Takes an idle worker with the task's imports, starts one, or waits for one
   * to come back.
   *
   * @param {AbortSignal} [signal] - Gives up waiting on abort.
   * @param {string} [importsUrl] - The imports the task needs.
   * @returns {Promise<import("./channel.js").WorkerChannel>}
   */
  acquire(signal, importsUrl) {
    signal?.throwIfAborted();

    for (let i = this.#idle.length - 1; i >= 0; i--) {
      const channel = this.#idle[i];
      if (channel.dead) {
        this.#idle.splice(i, 1);
        this.#count--;
      } else if (this.#imports.get(channel) === importsUrl) {
        this.#idle.splice(i, 1);
        channel.ref();
        return Promise.resolve(this.#lend(channel));
      }
    }

    // Full, but with idle workers of other imports: end the oldest.
    if (this.#count >= this.#size && this.#idle.length) {
      this.#idle.shift().kill();
      this.#count--;
    }

    if (this.#count < this.#size) {
      return Promise.resolve(this.#lend(this.#start(importsUrl)));
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        importsUrl,
        resolve,
        reject,
        cancel: () => signal?.removeEventListener("abort", abort),
      };
      const abort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index !== -1) this.#waiters.splice(index, 1);
        this.#unwatch();
        reject(signal.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.#waiters.push(waiter);
      this.#watch();
    });
  }

  /** Takes the next waiting task; stops the stall check once none waits. */
  #nextWaiter() {
    const waiter = this.#waiters.shift();
    this.#unwatch();
    return waiter;
  }

  /** Gives the next waiting task a new worker with its imports. */
  #startForNext() {
    const waiter = this.#nextWaiter();
    waiter.cancel();
    try {
      waiter.resolve(this.#lend(this.#start(waiter.importsUrl)));
    } catch (error) {
      waiter.reject(error);
    }
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

  #unwatch() {
    if (this.#waiters.length === 0 && this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #relieve() {
    if (this.#waiters.length === 0) return;
    const now = performance.now();
    const stalled = [...this.#busy].every(
      (channel) =>
        channel.idleSince !== undefined && now - channel.idleSince >= STALL,
    );
    if (stalled) this.#startForNext();
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
    const waiter = this.#waiters[0];
    if (
      !reusable ||
      channel.dead ||
      this.#retiring.has(channel) ||
      (waiter && waiter.importsUrl !== this.#imports.get(channel))
    ) {
      channel.kill();
      this.#count--;
      // Replace it for a waiting task, but only within the bound.
      if (this.#count < this.#size && this.#waiters.length) {
        this.#startForNext();
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

    if (waiter) {
      this.#nextWaiter().cancel();
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

  #lend(channel) {
    this.#busy.add(channel);
    return channel;
  }
}
