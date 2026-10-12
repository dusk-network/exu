// Adds a `once` listener, a listener that removes a later one, and one that
// adds another, then runs Exu's worker: message listeners must follow the
// DOM's rules, as in a Web Worker.
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

let added = false;
addEventListener("message", function () {
  if (this !== self) throw new TypeError("a listener's this is not self");
  if (added) return;
  added = true;
  // Added during dispatch: it must not get the message being dispatched.
  let first = true;
  addEventListener("message", () => {
    if (first) throw new TypeError("a listener added mid-dispatch got it");
  });
  queueMicrotask(() => first = false);
});
worker();
