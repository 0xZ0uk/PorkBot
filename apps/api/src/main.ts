import { createApiServer, moduleInfo } from "./index.ts";

const requestedPort = Number(process.env.PORT ?? 3001);
const server = createApiServer();

server.listen(requestedPort, () => {
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : requestedPort;
  process.stdout.write(
    JSON.stringify({ level: "info", msg: "api listening", service: moduleInfo.name, port }) + "\n",
  );
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
