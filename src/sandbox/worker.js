// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

// The sandbox worker. A host may reuse one worker for several tasks: `init`
// hands over the compiled module once, then each task `begin`s with a fresh
// instance and its own memory port, `call`s its exports and `end`s, which
// drops both. An idle worker counts down `idleTimeout` itself and then asks
// the host to end it, so an idle host holds neither ports nor timers.
export default function () {
  // Version of the messages with the host; keep in step with `PROTOCOL` in
  // ./channel.js.
  const PROTOCOL = 2;

  const state = {
    module: null,
    importsUrl: undefined,
    idleTimeout: 0,
    idleTimer: undefined,
    instance: null,
    imports: null,
    memoryPort: null,
  };

  const success = (value) => ({ ok: true, value });
  const failure = (error) => ({
    ok: false,
    error: {
      message: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : "Error",
      stack: error instanceof Error ? error.stack : undefined,
    },
  });

  const incompatibleHost = (protocol) =>
    new Error(
      `Incompatible Exu host: protocol ${
        protocol ?? "unknown"
      }, expected ${PROTOCOL}`,
    );

  const getGlobals = () =>
    Object.fromEntries(
      WebAssembly.Module.exports(state.module)
        .filter(({ kind, name }) => kind === "global" && !name.startsWith("__"))
        .map(({ name }) => [name, state.instance.exports[name].value]),
    );

  async function begin() {
    if (typeof state.importsUrl === "string") {
      const importsModule = await import(state.importsUrl);
      state.imports = importsModule.default;
      state.instance = new WebAssembly.Instance(state.module, state.imports);

      if (typeof importsModule.oninit === "function") {
        await importsModule.oninit(state.instance);
      }
    } else {
      state.instance = new WebAssembly.Instance(state.module);
    }

    const begun = { memory: null, globals: getGlobals() };

    // `crossOriginIsolated` might be `undefined`; in that case, the behavior is
    // the same as having the value `true`.
    if (self.crossOriginIsolated !== false) {
      begun.memory = state.imports?.env?.memory ?? null;
    }

    return begun;
  }

  function call({ member, args }) {
    const method = state.instance?.exports[member];

    if (typeof method !== "function") {
      throw new TypeError(`${member} is not a function`);
    }

    return method(...args);
  }

  function handleMemoryRequest({ data: { get, set } }) {
    try {
      const memory =
        state.imports?.env?.memory ?? state.instance?.exports?.memory;

      if (!(memory instanceof WebAssembly.Memory)) {
        throw new ReferenceError("WebAssembly.Memory is not defined");
      } else if (set) {
        const { dest, source, count } = set;
        const length = count ?? source.byteLength;
        const bytes =
          typeof source === "number"
            ? new Uint8Array(memory.buffer, source, length)
            : source.subarray(0, length);

        new Uint8Array(memory.buffer, dest, length).set(bytes);
        if (source instanceof Uint8Array) {
          state.memoryPort.postMessage(success(source), [source.buffer]);
        } else {
          state.memoryPort.postMessage(success(undefined));
        }
      } else if (get) {
        const { source, count } = get;
        state.memoryPort.postMessage(
          success(new Uint8Array(new Uint8Array(memory.buffer, source, count))),
        );
      } else {
        throw new TypeError("Invalid memory request");
      }
    } catch (error) {
      state.memoryPort.postMessage(failure(error));
    }
  }

  function rest() {
    state.instance = null;
    state.imports = null;
    state.memoryPort?.close();
    state.memoryPort = null;
    if (state.idleTimeout > 0) {
      state.idleTimer = setTimeout(
        () => postMessage({ type: "expire" }),
        state.idleTimeout,
      );
    }
  }

  addEventListener("message", async ({ data, ports }) => {
    clearTimeout(state.idleTimer);
    try {
      switch (data?.type) {
        case "init":
          // A host of another protocol reports the mismatch from this reply.
          if (data.protocol !== PROTOCOL) {
            postMessage(success({ protocol: PROTOCOL }));
            break;
          }
          state.module = data.module;
          state.importsUrl = data.importsUrl;
          state.idleTimeout = data.idleTimeout ?? 0;
          postMessage(success({ protocol: PROTOCOL }));
          break;
        case "begin":
          state.memoryPort = ports[0];
          state.memoryPort.onmessage = handleMemoryRequest;
          postMessage(success(await begin()));
          break;
        case "call":
          postMessage(success(call(data)));
          break;
        case "end":
          rest();
          postMessage(success(undefined));
          break;
        default:
          throw incompatibleHost(data?.protocol);
      }
    } catch (error) {
      postMessage(failure(error));
    }
  });
}
