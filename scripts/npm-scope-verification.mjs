import { spawn } from "node:child_process";
import console from "node:console";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverPublicPackages } from "./publishable-packages.mjs";
import { validatePublicPackageSet } from "./release-preflight.mjs";

const registry = "https://registry.npmjs.org/";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function verifyNpmScope({
  rootDirectory = repositoryRoot,
  executeNpm = runNpm,
  discoverPackages = discoverPublicPackages
} = {}) {
  const actorResult = await executeNpm(["whoami", `--registry=${registry}`]);
  const actor = actorResult.stdout.trim();
  if (actorResult.code !== 0 || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(actor)) {
    throw new Error("npm authentication verification failed");
  }

  const membershipResult = await executeNpm([
    "org",
    "ls",
    "@tenantscript",
    "--json",
    `--registry=${registry}`
  ]);
  const memberships = parseJsonObject(membershipResult);
  const role = Object.hasOwn(memberships, actor) ? memberships[actor] : undefined;
  if (role !== "owner" && role !== "admin") {
    throw new Error("npm scope ownership verification failed");
  }

  let packageNames;
  try {
    packageNames = validatePublicPackageSet(await discoverPackages(rootDirectory));
  } catch {
    throw new Error("npm package inventory verification failed");
  }
  const packageStates = [];
  for (const name of packageNames) {
    const result = await executeNpm(["view", name, "name", "--json", `--registry=${registry}`]);
    if (result.code === 0) {
      if (parseJson(result.stdout) !== name) {
        throw new Error("npm package state verification failed");
      }
      packageStates.push({ name, status: "published" });
      continue;
    }
    if (!/\bE404\b|404 Not Found/u.test(`${result.stdout}\n${result.stderr}`)) {
      throw new Error("npm package state verification failed");
    }
    packageStates.push({ name, status: "available" });
  }

  return {
    version: 1,
    registry,
    scope: "@tenantscript",
    actor,
    role,
    packages: packageStates
  };
}

function parseJsonObject(result) {
  if (result.code !== 0) throw new Error("npm scope ownership verification failed");
  const value = parseJson(result.stdout);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("npm scope ownership verification failed");
  }
  return value;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("npm registry response verification failed");
  }
}

async function runNpm(args) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("npm", args, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false"
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length + chunk.length > 65_536) {
        overflow = true;
        child.kill("SIGKILL");
      } else {
        stdout += chunk;
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length + chunk.length > 65_536) {
        overflow = true;
        child.kill("SIGKILL");
      } else {
        stderr += chunk;
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("npm command verification failed"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise(
        overflow ? { code: 1, stdout: "", stderr: "" } : { code: code ?? 1, stdout, stderr }
      );
    });
  });
}

async function main() {
  console.log(JSON.stringify(await verifyNpmScope()));
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "npm scope verification failed");
    process.exitCode = 1;
  });
}
