// Adds a `once` listener, a listener that removes a later one, one that adds
// another, one that checks the target, and one that stops the rest, around
// Exu's worker: message listeners must follow the DOM's rules, as in a Web
// Worker.
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
// Dispatched at the worker global.
addEventListener("message", (event) => {
  if (event.target !== self || event.currentTarget !== self) {
    throw new TypeError("a message's target is not self");
  }
});

worker();

// After Exu's worker, on a task's `begin` (which it answers asynchronously, so
// a throw here would fail the task): stopping must keep the next listener out,
// and the one added mid-dispatch, appended later still.
addEventListener("message", (event) => {
  if (event.data?.type === "begin") event.stopImmediatePropagation();
});
addEventListener("message", (event) => {
  if (event.data?.type === "begin") {
    throw new TypeError("stopImmediatePropagation did not stop a listener");
  }
});
