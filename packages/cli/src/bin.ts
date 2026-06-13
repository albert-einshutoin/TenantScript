#!/usr/bin/env node
import { createHttpRollbackClient, runExtCli, type RollbackClient } from "./index.js";

const endpoint = process.env.TENANTSCRIPT_CONTROL_PLANE_URL;
const client: RollbackClient =
  endpoint === undefined
    ? {
        rollbackInstallation: () => {
          throw new Error("set TENANTSCRIPT_CONTROL_PLANE_URL before using ext rollback");
        }
      }
    : createHttpRollbackClient(endpoint, fetch);

process.exitCode = await runExtCli(process.argv.slice(2), client);
