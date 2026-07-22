import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = join(pluginRoot, "dist", "plugin.cjs");

mkdirSync(dirname(bundlePath), { recursive: true });
execFileSync(
  "ext",
  ["build", "--entry", join(pluginRoot, "src", "index.ts"), "--out", bundlePath],
  { cwd: pluginRoot, stdio: "inherit" }
);

// Generate the audit artifact from the same typed manifest module the plugin imports, so the
// documented audit command cannot drift from the executable bundle's declared security boundary.
const manifestJson = execFileSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    'import { manifest } from "./src/manifest.ts"; process.stdout.write(JSON.stringify(manifest));'
  ],
  { cwd: pluginRoot, encoding: "utf8" }
);
writeFileSync(
  join(pluginRoot, "manifest.json"),
  `${JSON.stringify(JSON.parse(manifestJson), null, 2)}\n`
);
