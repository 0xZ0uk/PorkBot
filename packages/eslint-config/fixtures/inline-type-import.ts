import { createServer, type Server } from "node:http";

export const makeServer = createServer;
export type HttpServer = Server;
