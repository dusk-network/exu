# Exu

Exu is a high-performance library designed for both browser and Deno environments, facilitating seamless integration of WebAssembly modules. It adopts a unique sandbox/worker approach to ensure safe and efficient execution of tasks.

## Key Features

- **Sandbox/Worker Model:** Exu leverages a sandboxed environment for executing tasks, ensuring isolation and security while maintaining high performance.
- **Shared Memory Access:** Offers two modes of memory access - direct shared memory access for efficient data manipulation and a copy mechanism via the `memcpy` function for transferring ownership between contexts.
- **Task-Based Execution:** Simplifies the execution of bulk actions and complex tasks by encapsulating them in easily manageable units.

## Getting Started

### Installation

To include Exu in your project, import the module directly from the provided URL:

```javascript
import { Module } from "path/to/exu/src/mod.js";
```

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
const task = module.task(async ({ malloc, free, memcpy }) => {
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

## License

Exu is made available under the [Mozilla Public License 2.0 (MPL 2.0)](https://www.mozilla.org/en-US/MPL/2.0/). You are encouraged to use, modify, and distribute the library in compliance with the terms set forth in the MPL 2.0.
