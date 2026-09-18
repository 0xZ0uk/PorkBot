import { createServer } from "node:http";
import type { Server } from "node:http";
import { createHealthListener } from "@porkbot/health";

export const serviceName = "@porkbot/web";

const placeholderDocument = [
  "<!doctype html>",
  '<html lang="en">',
  "<head>",
  '<meta charset="utf-8" />',
  "<title>PorkBot</title>",
  "</head>",
  "<body>",
  "<main>",
  "<h1>PorkBot</h1>",
  "<p>The web console is a placeholder until slice 11.1.</p>",
  "</main>",
  "</body>",
  "</html>",
  "",
].join("\n");

/**
 * The placeholder web surface: one document and the health probe. The static
 * SPA shell (slice 11.1) replaces the document, and this server with it; the
 * health route stays on every surface.
 */
export function createWebServer(): Server {
  const health = createHealthListener({ service: serviceName });

  return createServer((request, response) => {
    if (health(request, response)) {
      return;
    }

    if (request.method === "GET" && (request.url === "/" || request.url === "/index.html")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(placeholderDocument);
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
}
