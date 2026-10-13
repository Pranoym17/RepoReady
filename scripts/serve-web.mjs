import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

const root = resolve("apps/web/dist");
const port = Number(process.env.PORT ?? 4322);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};
createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let path = decodeURIComponent(url.pathname);
    if (path.includes("\\") || path.includes("\0"))
      throw new Error("Invalid path");
    if (path.endsWith("/")) path += "index.html";
    else if (!extname(path)) path += "/index.html";
    const file = resolve(root, "." + path);
    if (!file.startsWith(root + sep)) throw new Error("Invalid path");
    let bytes;
    let status = 200;
    try {
      bytes = await readFile(file);
    } catch {
      bytes = await readFile(resolve(root, "404.html"));
      status = 404;
    }
    response.writeHead(status, {
      "Content-Type":
        status === 404
          ? types[".html"]
          : (types[extname(file)] ?? "application/octet-stream"),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch {
    response.writeHead(400);
    response.end("Invalid request");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Built website: http://127.0.0.1:${port}`);
});
