// Registers a message listener, then an `onmessage` handler that relies on it,
// then runs Exu's worker: handlers must run in the order they were registered.
import worker from "../../src/sandbox/worker.js";

let seen = 0;
addEventListener("message", () => seen++);
self.onmessage = () => {
  if (seen === 0) throw new Error("onmessage ran before an earlier listener");
};
worker();
