#!/usr/bin/env node
import { createBinaryAdminClient, runExtCli } from "./index.js";

const client = createBinaryAdminClient(process.env, fetch);

process.exitCode = await runExtCli(process.argv.slice(2), client);
