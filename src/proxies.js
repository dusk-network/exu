// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

export const NullTarget = Object.create(null);

/**
 * Whether a property read on an exports proxy names a WebAssembly export.
 * `then` and symbols are not, so promise resolution and coercion never treat
 * the proxy as a thenable or call into the worker.
 *
 * @param {string|symbol} prop - The property being read.
 * @returns {boolean}
 */
export const isExportName = (prop) =>
  typeof prop === "string" && prop !== "then";

export const MemoryProxy = new Proxy(NullTarget, {
  get() {
    throw new ReferenceError(
      "Cannot directly access to WebAssembly Memory unless it's a Shared Memory",
    );
  },
});
