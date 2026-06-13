#!/usr/bin/env node
/* global process */

const { runExtCli } = await import("../src/index.ts");
const args = process.argv.slice(2);
const commandArgs = args[0] === "--" ? args.slice(1) : args;

const exitCode = await runExtCli(["rollback-drill", ...commandArgs], {
  rollbackInstallation: () => {
    throw new Error("rollback client is not used by rollback-drill");
  }
});

process.exitCode = exitCode;
