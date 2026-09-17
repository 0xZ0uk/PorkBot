import { moduleInfo as core } from "@porkbot/core";
import { moduleInfo as db } from "@porkbot/db";
import { moduleInfo as effect } from "@porkbot/effect";
import { moduleInfo as logging } from "@porkbot/logging";

export const moduleInfo = {
  name: "@porkbot/worker",
  summary: "Always-on background worker. Graphile Worker owns durable jobs.",
} as const;

export const workerModules = [core.name, db.name, effect.name, logging.name] as const;
