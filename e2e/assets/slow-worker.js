// A worker module that takes a while to load before it runs Exu's worker.
// Messages sent meanwhile must wait for it, as they do in a Web Worker.
import worker from "../../src/sandbox/worker.js";

await new Promise((resolve) => setTimeout(resolve, 150));
worker();
