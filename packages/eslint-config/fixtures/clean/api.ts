import { moduleInfo } from "@porkbot/contracts";
import { Hono } from "hono";

export const app = new Hono();
export const contractsPackage = moduleInfo.name;
