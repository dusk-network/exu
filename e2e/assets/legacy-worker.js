// Stands in for a sandbox worker from Exu 0.1: it replies to the init message
// without the `{ ok, value }` envelope or a protocol version.
self.onmessage = () => postMessage({ memory: null, globals: {} });
