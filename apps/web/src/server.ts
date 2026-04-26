import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";

const root = new URL(".", import.meta.url).pathname;
const { ANDY_WEB_PORT } = process.env;
const port = Number(ANDY_WEB_PORT ?? 8790);
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = join(root, path);
    try {
      const content = await readFile(file);
      response.writeHead(200, { "content-type": contentType(file) });
      response.end(content);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found");
    }
  })();
});
server.listen(port, "127.0.0.1");

console.log(`Andy web console listening on http://127.0.0.1:${port}`);

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
