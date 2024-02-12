/**
 * Parse a fat pointer, returning an array of two elements, in order the pointer
 * to the memory and the size allocated.
 *
 * @param value {bigint}
 * @returns {number[]}
 */
const parseFatPtr = (value) => {
  let ptr = Number(value >> 32n);
  let size = Number(value & 0xffff_ffffn);

  return [ptr, size];
};

const memory = new WebAssembly.Memory({
  initial: 18,
  maximum: 100,
  shared: true,
});

export default {
  env: {
    memory,

    /**
     * This method is required by `example.wasm` to signal to the host any
     * string messages, for example if the WebAssembly module panics.
     *
     * @param fatptr {bigint}
     */
    sig(fatptr) {
      let [ptr, size] = parseFatPtr(fatptr);

      let messageBuffer = new Uint8Array(memory.buffer, ptr, size);

      if (memory.buffer instanceof SharedArrayBuffer) {
        const copyBuffer = new Uint8Array(size);
        copyBuffer.set(messageBuffer, 0);
        messageBuffer = copyBuffer;
      }

      const message = new TextDecoder().decode(messageBuffer);
      console.log("WASM:", message);
    },
  },
};
