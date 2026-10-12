// Registers a message listener that throws, then takes a while to load: Node's
// threads hold the first message and hand it over once the module has loaded.
addEventListener("message", () => {
  throw new TypeError("listener failed");
});
await new Promise((resolve) => setTimeout(resolve, 150));
