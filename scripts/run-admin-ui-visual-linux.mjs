import { access, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const baselineRelativePath = "apps/admin-ui/test/e2e/visual.spec.ts-snapshots";
const update = process.argv.includes("--update");

const temporaryRoot = await mkdtemp(join(tmpdir(), "tenantscript-visual-"));
const temporaryRepository = join(temporaryRoot, "repository");
const excludedNames = new Set([
  ".devloop",
  ".git",
  ".tmp",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results"
]);
const excludedCredentialFiles = new Set([".env", ".npmrc", ".yarnrc", ".yarnrc.yml"]);

try {
  await cp(repositoryRoot, temporaryRepository, {
    recursive: true,
    filter: (source) => {
      const parts = relative(repositoryRoot, source).split(sep);
      const name = parts.at(-1) ?? "";
      if (
        name !== ".env.example" &&
        (excludedCredentialFiles.has(name) || name.startsWith(".env."))
      ) {
        return false;
      }
      return !parts.some((part) => excludedNames.has(part));
    }
  });
  if (update) {
    await rm(join(temporaryRepository, baselineRelativePath), { recursive: true, force: true });
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  const visualCommand = [
    "mkdir -p /tmp/bin",
    "corepack enable --install-directory /tmp/bin",
    "export PATH=/tmp/bin:$PATH",
    "pnpm install --frozen-lockfile",
    `pnpm --filter @tenantscript/admin-ui exec playwright test test/e2e/visual.spec.ts${update ? " --update-snapshots" : ""}`
  ].join(" && ");
  const command = [
    "run",
    "--rm",
    "--init",
    "--ipc=host",
    "--user",
    `${String(uid)}:${String(gid)}`,
    "--env",
    "HOME=/tmp",
    "--volume",
    `${temporaryRepository}:/work`,
    "--workdir",
    "/work",
    "mcr.microsoft.com/playwright:v1.61.1-noble",
    "bash",
    "-lc",
    visualCommand
  ];
  const result = spawnSync("docker", command, { stdio: "inherit" });

  if (update && result.status === 0) {
    await replaceDirectory(
      join(temporaryRepository, baselineRelativePath),
      join(repositoryRoot, baselineRelativePath)
    );
    console.log(`Updated Linux visual baselines in ${baselineRelativePath}`);
  } else if (!update && result.status !== 0) {
    await copyIfPresent(
      join(temporaryRepository, "apps/admin-ui/test-results"),
      join(repositoryRoot, "apps/admin-ui/test-results")
    );
    await copyIfPresent(
      join(temporaryRepository, "apps/admin-ui/playwright-report"),
      join(repositoryRoot, "apps/admin-ui/playwright-report")
    );
  }

  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Linux visual regression failed with exit ${String(result.status)}`);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function copyIfPresent(source, destination) {
  try {
    await access(source);
  } catch {
    return;
  }
  await replaceDirectory(source, destination);
}

async function replaceDirectory(source, destination) {
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true });
}
