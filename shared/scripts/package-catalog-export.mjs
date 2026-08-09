#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function stripQuotes(value) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function parseApprovedPackages(text) {
  const entries = [];
  const conditions = parseRestrictedConditions(text);
  let section = null;
  let bucket = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    const top = line.match(/^([A-Za-z0-9_]+):\s*$/);
    if (top) {
      section = top[1];
      bucket = null;
      continue;
    }

    const nested = line.match(/^\s{2}([A-Za-z0-9_]+):\s*$/);
    if (nested) {
      bucket = nested[1];
      continue;
    }

    const item = line.match(/^\s{4}-\s+(.+?)\s*$/);
    if (!item || !section || !bucket) continue;

    const name = stripQuotes(item[1]);
    if (!name) continue;

    let ecosystem = null;
    if (section === "python") ecosystem = "pypi";
    if (section === "npm_frontend" || section === "npm_backend") ecosystem = "npm";
    if (!ecosystem) continue;

    entries.push({
      ecosystem,
      package: name,
      scope: bucket === "core" ? "allowed_name" : "restricted_name",
      registry_import_status: "DO_NOT_IMPORT_AS_APPROVED_WITHOUT_VERSION",
      source_file: "shared/references/approved-packages.yaml",
      source_section: `${section}.${bucket}`,
      basis: bucket === "core" ? "HARNESS_ALLOWED_NAME_SCOPE" : "HARNESS_RESTRICTED_NAME_SCOPE",
      conditions: conditions.get(`${ecosystem}:${name}`) || [],
      note: "Name-only catalog entry. Registry APPROVED requires an exact package version and checker evidence.",
    });
  }

  return entries;
}

function parseRestrictedConditions(text) {
  const conditions = new Map();
  let section = null;
  let inConditions = false;
  let currentPackage = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    const top = line.match(/^([A-Za-z0-9_]+):\s*$/);
    if (top) {
      section = top[1];
      inConditions = false;
      currentPackage = null;
      continue;
    }

    if (/^\s{2}restricted_conditions:\s*$/.test(line)) {
      inConditions = true;
      currentPackage = null;
      continue;
    }

    const pkg = line.match(/^\s{4}(.+?):\s*$/);
    if (pkg && inConditions && section) {
      currentPackage = stripQuotes(pkg[1]);
      let ecosystem = null;
      if (section === "python") ecosystem = "pypi";
      if (section === "npm_frontend" || section === "npm_backend") ecosystem = "npm";
      if (ecosystem && currentPackage) {
        conditions.set(`${ecosystem}:${currentPackage}`, []);
      }
      continue;
    }

    const item = line.match(/^\s{6}-\s+(.+?)\s*$/);
    if (item && inConditions && section && currentPackage) {
      let ecosystem = null;
      if (section === "python") ecosystem = "pypi";
      if (section === "npm_frontend" || section === "npm_backend") ecosystem = "npm";
      if (ecosystem) {
        const key = `${ecosystem}:${currentPackage}`;
        const list = conditions.get(key) || [];
        list.push(stripQuotes(item[1]));
        conditions.set(key, list);
      }
    }
  }

  return conditions;
}

function parseDenylist(text) {
  const entries = [];
  let section = null;
  let ecosystem = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "");
    if (/^denied_packages:\s*$/.test(line)) {
      section = "denied_packages";
      ecosystem = null;
      continue;
    }
    if (/^[A-Za-z0-9_]+:\s*$/.test(line) && !/^denied_packages:\s*$/.test(line)) {
      if (!/^\s/.test(line)) {
        section = null;
        ecosystem = null;
      }
    }

    const nested = line.match(/^\s{2}(npm|python):\s*$/);
    if (nested && section === "denied_packages") {
      ecosystem = nested[1] === "python" ? "pypi" : "npm";
      continue;
    }

    const item = line.match(/^\s{4}-\s+(.+?)\s*$/);
    if (!item || section !== "denied_packages" || !ecosystem) continue;

    const name = stripQuotes(item[1]);
    if (!name) continue;

    entries.push({
      ecosystem,
      package: name,
      status: "REJECTED",
      source_file: "shared/references/package-denylist.yaml",
      source_section: `denied_packages.${ecosystem}`,
      approval_basis: "BASELINE_DENYLIST",
    });
  }

  return entries;
}

const root = resolve(argValue("--root", "."));
const out = resolve(argValue("--out", "generated/package-catalog.export.json"));
const approvedPath = resolve(root, "shared/references/approved-packages.yaml");
const deniedPath = resolve(root, "shared/references/package-denylist.yaml");

const approved = parseApprovedPackages(readFileSync(approvedPath, "utf8"));
const denied = parseDenylist(readFileSync(deniedPath, "utf8"));

const denyKeys = new Set(denied.map((entry) => `${entry.ecosystem}:${entry.package}`));
const scopeCatalog = approved.filter((entry) => !denyKeys.has(`${entry.ecosystem}:${entry.package}`));
const registryImportEntries = denied;

const payload = {
  package_catalog_export_version: 2,
  generated_by: "shared/scripts/package-catalog-export.mjs",
  registry_import_contract: "Name-only approved/restricted entries are scope hints, not registry APPROVED decisions. Denylist package entries become REJECTED. Absence remains UNKNOWN.",
  registry_import_entries: registryImportEntries,
  scope_catalog: scopeCatalog,
  denied_patterns_note: "restricted_patterns are harness gate patterns and are not registry package decisions.",
};

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`WROTE ${out}`);
console.log(`REGISTRY_IMPORT_ENTRIES ${registryImportEntries.length}`);
console.log(`SCOPE_CATALOG_ENTRIES ${scopeCatalog.length}`);
