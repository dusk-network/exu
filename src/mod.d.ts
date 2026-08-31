/**
 * Run WebAssembly modules as isolated, abortable tasks in worker sandboxes.
 *
 * @module
 */

/**
 * Values exposed to task callbacks for direct memory access.
 */
export interface MemoryAccessor {
  /** The WebAssembly memory exported by the running module. */
  memory: WebAssembly.Memory;
  /** Copies bytes between JavaScript and WebAssembly memory. */
  memcpy(dest: null, source: number, count: number): Promise<Uint8Array>;
  memcpy(
    dest: number,
    source: Uint8Array,
    count?: number,
  ): Promise<Uint8Array>;
  memcpy(dest: number, source: number, count: number): Promise<void>;
  memcpy(dest: Uint8Array, source: Uint8Array): Promise<void>;
  /** The WebAssembly globals exported by the running module. */
  globals: WebAssembly.Exports;
}

/**
 * Function executed against a freshly created WebAssembly sandbox.
 */
export type TaskCallback<T = unknown> = (
  exports: WebAssembly.Exports,
  accessor: MemoryAccessor,
) => T | Promise<T>;

/**
 * Options used to construct a {@link Module}.
 */
export interface ModuleOptions {
  /** WebAssembly module URL, fetch URL, or byte buffer. */
  source: URL | string | Uint8Array;
}

/**
 * Options used when creating a sandbox for a task or API call.
 */
export interface SandboxOptions {
  /** Cancels the sandbox operation when aborted. */
  signal?: AbortSignal;
  /** Import module URL used while instantiating the WebAssembly module. */
  imports?: URL | string;
}

/**
 * Callable proxy over the WebAssembly module exports.
 */
export interface ModuleApi {
  [name: string]: (...args: unknown[]) => Promise<unknown>;
}

/**
 * WebAssembly module wrapper that runs each task in an isolated worker sandbox.
 */
export class Module {
  /**
   * Creates a module from a WebAssembly URL, fetch URL, byte buffer, or options object.
   */
  constructor(options: ModuleOptions | ModuleOptions["source"]);

  /**
   * Default import module URL used when a task does not provide one.
   */
  get defaultImports(): string | undefined;
  set defaultImports(value: URL | string | undefined);

  /**
   * Creates an asynchronous task that runs in a fresh sandbox on every call.
   */
  task<T>(fn: TaskCallback<T>): (options?: SandboxOptions) => Promise<T>;

  /**
   * Returns a callable proxy for one-off WebAssembly export calls.
   */
  api(options?: SandboxOptions): ModuleApi;
}
