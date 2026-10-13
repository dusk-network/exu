// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

import { isNode, startNodeWorker } from "./node.js";
import worker from "./worker.js";

let blobUrl;
let fileWorkerProbe;

// Bundlers recognise this exact form and emit the worker as a file of its own.
const fileWorker = () =>
  new Worker(new URL("./worker-entry.js", import.meta.url), { type: "module" });

const blobWorker = () => {
  blobUrl ??= URL.createObjectURL(
    new Blob([`(${worker})()`], { type: "application/javascript" }),
  );
  return new Worker(blobUrl, { type: "module" });
};

// Server runtimes have no CSP to satisfy, and Deno would need read permission
// for the worker file. A `process` global proves nothing: Electron pages and
// some bundles have one, and Node has no Web Workers at all.
const isServerRuntime = () =>
  typeof globalThis.Deno !== "undefined" ||
  typeof globalThis.Bun !== "undefined";

/** How long the probe waits for the worker file to start, in ms. */
const PROBE_TIMEOUT = 5000;

/**
 * Whether a worker from `create` starts and replies within `timeout` ms. It
 * does not when `create` throws (Exu loaded from another origin), the file
 * fails to load (bundled without it), or the download stalls.
 *
 * @param {() => Worker} create - Starts the worker to probe.
 * @param {number} [timeout] - How long to wait for its reply, in ms.
 * @returns {Promise<boolean>}
 */
export function probeWorker(create, timeout = PROBE_TIMEOUT) {
  return new Promise((resolve) => {
    let probe;
    try {
      probe = create();
    } catch {
      resolve(false);
      return;
    }
    const done = (usable) => {
      clearTimeout(timer);
      probe.terminate();
      resolve(usable);
    };
    const timer = setTimeout(() => done(false), timeout);
    probe.addEventListener("error", (event) => {
      event.preventDefault();
      done(false);
    }, { once: true });
    // Any reply, even the error for this unknown message, proves it started.
    probe.addEventListener("message", () => done(true), { once: true });
    probe.postMessage({ type: "probe" });
  });
}

/** How long a failed probe stands before the file is tried again, in ms. */
const PROBE_RETRY = 60_000;

/**
 * Whether Exu's worker file starts here. A success holds for the page; a
 * failure (perhaps a transient one) is rechecked after `PROBE_RETRY`.
 */
function probeFileWorker() {
  const stale = fileWorkerProbe?.failedAt !== undefined &&
    performance.now() - fileWorkerProbe.failedAt > PROBE_RETRY;
  if (!fileWorkerProbe || stale) {
    const probe = { usable: probeWorker(fileWorker) };
    probe.usable.then((usable) => {
      if (!usable) probe.failedAt = performance.now();
    });
    fileWorkerProbe = probe;
  }
  return fileWorkerProbe.usable;
}

/**
 * Starts a sandbox worker.
 *
 * - On Node, which has no Web Workers, the worker runs on a
 *   `node:worker_threads` thread (see ./node.js).
 * - `workerUrl`, when given, is used as is.
 * - In browsers, Exu's worker module file is used when it starts, which
 *   satisfies `worker-src 'self'`.
 * - Otherwise (server runtimes, a cross-origin copy of Exu, a bundle without
 *   the file) the worker is built from a Blob URL.
 *
 * @param {URL|string} [workerUrl] - The worker module to start.
 * @param {() => boolean} [wanted] - Whether the worker is still wanted; on
 *   Node, a start that waited and is no longer wanted gives `null`.
 * @returns {Promise<Worker|null>}
 */
export async function spawnWorker(workerUrl, wanted) {
  if (isNode()) {
    return startNodeWorker(workerUrl, wanted);
  }
  if (workerUrl !== undefined) {
    return new Worker(workerUrl, { type: "module" });
  }
  if (!isServerRuntime() && await probeFileWorker()) {
    return fileWorker();
  }
  return blobWorker();
}
