// Adds a `once` listener, and a listener that removes a later one, then runs
// Exu's worker: listeners must follow EventTarget's rules.
import worker from "../../src/sandbox/worker.js";

let ran = false;
addEventListener("message", () => {
  if (ran) throw new TypeError("a once listener ran twice");
  ran = true;
}, { once: true });
const removed = () => {
  throw new TypeError("a removed listener ran");
};
addEventListener("message", () => removeEventListener("message", removed));
addEventListener("message", removed);
worker();
