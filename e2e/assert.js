// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

// Minimal assertions that run unchanged in every runtime the E2E suite
// targets, browsers included.

export class AssertionError extends Error {
  name = "AssertionError";
}

/** Thrown by a case that cannot run here (e.g. an optional asset is absent). */
export class Skip extends Error {
  name = "Skip";
}

const show = (value) => {
  if (ArrayBuffer.isView(value)) {
    return `${value.constructor.name}[${Array.from(value).slice(0, 16)}${
      value.length > 16 ? ",…" : ""
    }]`;
  }
  if (typeof value === "bigint") return `${value}n`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

export function ok(value, message = "expected a truthy value") {
  if (!value) throw new AssertionError(message);
}

export function equal(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    throw new AssertionError(
      message ?? `expected ${show(expected)}, got ${show(actual)}`,
    );
  }
}

export function bytes(actual, expected, message) {
  ok(
    ArrayBuffer.isView(actual),
    message ?? `expected bytes, got ${show(actual)}`,
  );
  const a = new Uint8Array(actual.buffer, actual.byteOffset, actual.byteLength);
  const b = new Uint8Array(expected);
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) {
    throw new AssertionError(message ?? `expected ${show(b)}, got ${show(a)}`);
  }
}

/** Settles `promise`, or fails if it is still pending after `ms`. */
export async function within(promise, ms, what = "operation") {
  let timer;
  const pending = Symbol("pending");
  const result = await Promise.race([
    promise.then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
    new Promise((r) => (timer = setTimeout(() => r(pending), ms))),
  ]);
  clearTimeout(timer);
  if (result === pending) {
    throw new AssertionError(`${what} still pending after ${ms} ms`);
  }
  if ("error" in result) throw result.error;
  return result.value;
}

/**
 * Asserts `promise` rejects within `ms`. `expected` may give `type` (checked
 * with instanceof), `name`, `message` (string or RegExp) or `is` (identity).
 */
export async function rejects(promise, expected = {}, ms = 5000) {
  let rejected = false;
  let error;
  try {
    await within(promise, ms, "rejection");
  } catch (e) {
    if (e instanceof AssertionError && /still pending/.test(e.message)) throw e;
    rejected = true;
    error = e;
  }
  if (!rejected) {
    throw new AssertionError("expected a rejection, but it resolved");
  }
  if ("is" in expected && error !== expected.is) {
    throw new AssertionError(
      `expected rejection with ${show(
        expected.is?.message ?? expected.is,
      )}, got ${error?.name}: ${error?.message}`,
    );
  }
  if (expected.type && !(error instanceof expected.type)) {
    throw new AssertionError(
      `expected a ${expected.type.name}, got ${error?.constructor?.name} ${error?.name}: ${error?.message}`,
    );
  }
  if (expected.name && error?.name !== expected.name) {
    throw new AssertionError(
      `expected ${expected.name}, got ${error?.name}: ${error?.message}`,
    );
  }
  if (expected.message) {
    const matches =
      expected.message instanceof RegExp
        ? expected.message.test(error?.message)
        : error?.message === expected.message;
    if (!matches) {
      throw new AssertionError(
        `expected message ${expected.message}, got ${show(error?.message)}`,
      );
    }
  }
  return error;
}
