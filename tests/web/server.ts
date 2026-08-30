const baseUrl = new URL("../", import.meta.url);

Deno.serve({ port: 8000 }, async (request) => {
  const pathname = new URL(request.url).pathname;
  const fileUrl = pathname === "/" || pathname === "/index.html"
    ? new URL("web/index.html", baseUrl)
    : pathname.startsWith("/src/")
    ? new URL(`..${pathname}`, baseUrl)
    : new URL(`.${pathname}`, baseUrl);

  let file;
  try {
    file = await Deno.open(fileUrl, { read: true });
  } catch {
    return new Response("404 Not Found", { status: 404 });
  }

  const headers = new Headers({
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  });

  if (pathname.endsWith(".wasm")) {
    headers.set("Content-Type", "application/wasm");
  } else if (pathname.endsWith(".js")) {
    headers.set("Content-Type", "application/javascript");
  }

  return new Response(file.readable, { headers });
});
