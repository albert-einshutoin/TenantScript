import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const source = resolve(root, "packages/control-plane/src/success-response-schemas.ts");
const target = resolve(root, "docs/reference/control-plane-success-responses.schema.json");
const { CONTROL_PLANE_SUCCESS_RESPONSE_SCHEMAS } = await import(pathToFileURL(source).href);
const artifact = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $defs: CONTROL_PLANE_SUCCESS_RESPONSE_SCHEMAS
};

await writeFile(target, `${JSON.stringify(artifact, null, 2)}\n`);
console.log("Updated docs/reference/control-plane-success-responses.schema.json.");
