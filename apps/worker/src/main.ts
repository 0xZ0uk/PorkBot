import { createLogger } from "@porkbot/logging";
import { moduleInfo, workerModules } from "./index.ts";

const logger = createLogger({ service: moduleInfo.name });

logger.info("worker idle", { modules: [...workerModules] });

setInterval(() => undefined, 60_000);
