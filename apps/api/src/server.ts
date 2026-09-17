import { createServer, type Server } from "node:http";
import { moduleInfo as contracts } from "@porkbot/contracts";
import { moduleInfo as core } from "@porkbot/core";
import { moduleInfo as logging } from "@porkbot/logging";

export const serviceName = "@porkbot/api";

export function createApiServer(): Server {
  return createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          status: "ok",
          service: serviceName,
          modules: [core.name, contracts.name, logging.name],
        }),
      );
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
}
