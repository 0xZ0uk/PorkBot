import { moduleInfo, workerModules } from "./index.ts";

process.stdout.write(
  JSON.stringify({
    level: "info",
    msg: "worker idle",
    service: moduleInfo.name,
    modules: workerModules,
  }) + "\n",
);

setInterval(() => undefined, 60_000);
