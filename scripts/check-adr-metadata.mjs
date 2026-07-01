#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const defaultAdrDir = join(root, "docs/adr");
// Template path stays under the repo so temp dirs used by tests still share one status enum.
const templatePath = join(defaultAdrDir, "000-template.md");

const REQUIRED_SECTIONS = ["Context", "Decision", "Consequences"];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseMetadataBlock(content) {
  const lines = content.split("\n");
  const h1Index = lines.findIndex((line) => line.startsWith("# "));
  if (h1Index === -1) {
    return { metadata: {}, bodyStart: 0 };
  }

  const metadata = {};
  let index = h1Index + 1;

  while (index < lines.length && lines[index].trim() === "") {
    index += 1;
  }

  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith("## ")) {
      break;
    }

    const match = line.match(/^([A-Za-z ]+):\s*(.+)$/);
    if (!match) {
      break;
    }

    metadata[match[1]] = match[2].trim();
    index += 1;
  }

  return { metadata, bodyStart: index };
}

function readAllowedStatuses() {
  const template = readFileSync(templatePath, "utf8");
  const { metadata } = parseMetadataBlock(template);
  const allowed = metadata["Allowed statuses"];

  if (!allowed) {
    throw new Error(`${templatePath}: missing Allowed statuses metadata`);
  }

  return allowed.split(",").map((status) => status.trim());
}

function hasSection(content, sectionName) {
  const pattern = new RegExp(`^## ${sectionName}$`, "m");
  return pattern.test(content);
}

function validateAdrFile(filePath, allowedStatuses, { isTemplate = false } = {}) {
  const content = readFileSync(filePath, "utf8");
  const { metadata } = parseMetadataBlock(content);
  const errors = [];
  const relativePath = filePath.replace(`${root}/`, "");

  const requiredFields = isTemplate
    ? ["Date", "Deciders", "Status", "Allowed statuses"]
    : ["Date", "Deciders", "Status"];

  for (const field of requiredFields) {
    if (!metadata[field]) {
      errors.push(`${relativePath}: missing ${field} metadata`);
    }
  }

  if (metadata.Date && !isTemplate && !DATE_PATTERN.test(metadata.Date)) {
    errors.push(`${relativePath}: Date must use YYYY-MM-DD format`);
  }

  if (metadata.Deciders && metadata.Deciders.trim() === "") {
    errors.push(`${relativePath}: Deciders must not be empty`);
  }

  if (metadata.Status && !allowedStatuses.includes(metadata.Status)) {
    errors.push(
      `${relativePath}: Status "${metadata.Status}" is not allowed (expected one of: ${allowedStatuses.join(", ")})`
    );
  }

  if (metadata["Allowed statuses"]) {
    const declared = metadata["Allowed statuses"].split(",").map((status) => status.trim());
    const mismatched = declared.filter((status) => !allowedStatuses.includes(status));
    if (mismatched.length > 0 || declared.length !== allowedStatuses.length) {
      errors.push(
        `${relativePath}: Allowed statuses must match template enum (${allowedStatuses.join(", ")})`
      );
    }
  }

  if (content.includes("## Status")) {
    errors.push(`${relativePath}: legacy "## Status" section must be replaced with metadata block`);
  }

  // Blocked ADRs may document blockers instead of a final decision record.
  if (!isTemplate && metadata.Status && metadata.Status !== "Blocked") {
    for (const section of REQUIRED_SECTIONS) {
      if (!hasSection(content, section)) {
        errors.push(`${relativePath}: missing ## ${section} section`);
      }
    }
  }

  return errors;
}

function main() {
  const customDir = process.argv[2];
  const adrDir = customDir ? resolve(customDir) : defaultAdrDir;
  const allowedStatuses = readAllowedStatuses();

  const adrFiles = readdirSync(adrDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(adrDir, name))
    .sort();

  const errors = [];
  for (const filePath of adrFiles) {
    const isTemplate = basename(filePath) === "000-template.md";
    errors.push(...validateAdrFile(filePath, allowedStatuses, { isTemplate }));
  }

  if (errors.length > 0) {
    console.error("ADR metadata check failed:\n");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  const label = customDir ? adrDir : "docs/adr";
  console.log(`ADR metadata check passed (${adrFiles.length} files in ${label}).`);
}

main();
