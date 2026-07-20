#!/usr/bin/env node
import { createBinaryAdminClient, createBinaryDoctorRuntime, runExtCli } from "./index.js";

const client = createBinaryAdminClient(process.env, fetch);
const runtime = createBinaryDoctorRuntime(process.env, fetch);

process.exitCode = await runExtCli(process.argv.slice(2), client, undefined, runtime);
