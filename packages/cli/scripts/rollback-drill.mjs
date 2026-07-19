#!/usr/bin/env node
/* global console, process */

const { runRollbackDrill } = await import("../src/rollback-drill.ts");
const args = process.argv.slice(2);
const commandArgs = args[0] === "--" ? args.slice(1) : args;

const exitCode = runRollbackDrill(commandArgs, {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line)
});

process.exitCode = exitCode;
