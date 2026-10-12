# Exu

Exu is a high-performance library for browsers, Deno, Bun and Node, facilitating seamless integration of WebAssembly modules. It adopts a unique sandbox/worker approach to ensure safe and efficient execution of tasks.

## Key Features

- **Sandbox/Worker Model:** Exu leverages a sandboxed environment for executing tasks, ensuring isolation and security while maintaining high performance.
- **Shared Memory Access:** Offers two modes of memory access - direct shared memory access for efficient data manipulation and a `memcpy` function for copying data between contexts.
- **Task-Based Execution:** Simplifies the execution of bulk actions and complex tasks by encapsulating them in easily manageable units.

## Getting Started

### Installation

To include Exu in your project, import the module directly from the provided URL:

```javascript
import { Module } from "jsr:@dusk/exu";
```

On Node, add it with `npx jsr add @dusk/exu` and import it from
`@dusk/exu`.

### Basic Usage

#### Creating a Module Instance

First, create a new `Module` instance by specifying the path to your WebAssembly module:

```javascript
const module = new Module(
  new URL("path/to/your/wasm/module.wasm", import.meta.url),
);
```

Optionally, set default imports if your WebAssembly module requires them:

```javascript
module.defaultImports = new URL("./path/to/custom-imports.js", import.meta.url);
```

#### Executing API Calls

Perform single API calls straightforwardly:

```javascript
const result = await module.api().yourFunction(args);
```

Handle errors gracefully using try-catch blocks for API calls that might fail:

```javascript
try {
  const result = await module.api().nonExistentFunction();
} catch (error) {
  console.error("Function does not exist", error);
}
```

#### Task-Based Bulk Actions

To efficiently handle bulk actions, such as when multiple functions need to access the same memory, or to manage more complex tasks, it's recommended to encapsulate these operations within a defined task:

```javascript
let task = module.task(async ({ yourFunctionA, yourFunctionB }) => {
  let result1 = await yourFunctionA(arg1);
  let result2 = await yourFunctionB(arg2);

  return { result1, result2 };
});

let results = await task();
```

### Memory Management

#### Direct Shared Memory Access

Directly manipulate shared memory for high-performance scenarios:

```javascript
const task = module.task(async ({ malloc, free, byte, set_byte }, { memory }) => {
  let ptr = await malloc(size);
  let buffer = new Uint8Array(memory.buffer, ptr, size);

  // Perform operations on the buffer

  await free(ptr, size);
});
```

#### Memory Copy (`memcpy`)

Use the `memcpy` function to copy data between JavaScript and the WebAssembly environment, useful for scenarios where direct memory sharing is not feasible:

```javascript
const task = module.task(async ({ malloc, free }, { memcpy }) => {
  let ptr = await malloc(size);
  let data = new Uint8Array(size);

  // Set data values...

  // Copy data to WebAssembly memory
  data = await memcpy(ptr, data, size);

  // Retrieve updated data from WebAssembly memory
  data = await memcpy(null, ptr, size);

  await free(ptr, size);
});
```

### Worker pool

Tasks run in a pool of workers: at most `workers` at once per module, whatever
their imports (by default one less than the logical cores), with other tasks
waiting their turn. Each task gets a
fresh instance of the module. A worker that finished its task cleanly serves
the next one, and ends after `idleTimeout` ms without work (10 seconds by
default; `0` ends it as soon as its task does, unless a task is waiting).
Workers whose task was aborted, that still had calls running, or that loaded
custom imports are never reused.

```javascript
const module = new Module({ source, workers: 4, idleTimeout: 30_000 });
// ...
module.close(); // ends idle workers now
```

Idle workers hold no ports or timers on the caller's side; each one counts
down its own idle time. In Deno, though, an idle worker keeps the process
alive until it times out: call `close()` when a script is done with a module.

A task may wait on another task of the same module. When every worker is
taken and has run no call for 100 ms (each task is waiting on something else),
the next waiting task gets an extra worker, which ends with its task. So
nested tasks cannot deadlock the pool; they may wait up to about 100 ms. While
workers are busy with calls, the `workers` bound holds.

### Workers and Content Security Policy

In browsers, Exu starts each sandbox worker from `src/sandbox/worker-entry.js`,
next to its own module. Bundlers such as Vite and webpack recognise this and
emit the worker as a file of their own, which pages limited to
`worker-src 'self'` (browser extensions, for example) can start. If that file
does not start (Exu was loaded from another origin, or bundled without it), Exu
falls back to a worker built from a Blob URL, which `worker-src 'self'` refuses.
Deno and Bun always use the Blob worker, which needs no file access.

To start a different copy of the worker, pass its URL:

```javascript
const module = new Module({ source, workerUrl });
```

The worker must come from the same Exu version. A mismatched worker rejects
tasks with an "Incompatible Exu sandbox worker" error. It must also listen for
messages as soon as it loads, before any top-level `await`: browsers and Deno
drop messages that arrive earlier.

### Node

Node (22.3 or later) has no Web Workers, so Exu runs each sandbox worker on a
`node:worker_threads` thread, with the same pool, isolation and aborts. A
`file:` URL source is read from disk. A `workerUrl` is imported into the
thread (a relative one is resolved against the working directory), and so are
imports, so they must be modules Node can import, such as `file:` URLs.

## License

Exu is made available under the [Mozilla Public License 2.0 (MPL 2.0)](https://www.mozilla.org/en-US/MPL/2.0/). You are encouraged to use, modify, and distribute the library in compliance with the terms set forth in the MPL 2.0.
