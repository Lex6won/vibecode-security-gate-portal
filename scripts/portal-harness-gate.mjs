#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(process.argv[2] || ".");
const failures = [];
const warnings = [];

function rel(path) {
  return path.replaceAll("\\", "/");
}

function mustExist(path, label = path) {
  if (!existsSync(join(root, path))) failures.push(`missing ${label}: ${path}`);
}

function readText(path) {
  const full = join(root, path);
  if (!existsSync(full)) {
    failures.push(`missing readable file: ${path}`);
    return "";
  }
  return readFileSync(full, "utf8").replace(/^\uFEFF/, "");
}

function walk(dir) {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  const out = [];
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const path = join(full, entry.name);
    const relPath = rel(relative(root, path));
    if (entry.isDirectory()) out.push(...walk(relPath));
    else out.push(relPath);
  }
  return out;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
    ...options,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error,
  };
}

function checkHarnessFiles() {
  for (const path of [
    "AGENTS.md",
    "README.md",
    "shared/harness.yaml",
    "shared/references/harness-enforcement-contract.yaml",
    "shared/references/core-process-enforcement.yaml",
    "shared/references/checker-integration.md",
    "shared/enforcement/gvskb_gate.js",
    "shared/enforcement/gvskb_gate.py",
    ".mcp.json",
    ".codex/config.toml",
  ]) {
    mustExist(path);
  }

  const contract = readText("shared/references/harness-enforcement-contract.yaml");
  for (const marker of [
    "before package install/use, code generation, test, and release handoff",
    "For new npm packages, use shared/enforcement/gvskb_gate.js check/install before npm install",
    "For JavaScript and TypeScript dependency changes, direct npm/pnpm/yarn installs are harness bypasses",
    "Use scan_path for source security checks",
    "TypeScript is an approved implementation source",
  ]) {
    if (!contract.includes(marker)) failures.push(`harness contract missing marker: ${marker}`);
  }

  const coreProcess = readText("shared/references/core-process-enforcement.yaml");
  for (const marker of [
    "implementation_first:",
    "mandatory_processes:",
    "service_implementation:",
    "scenario_test:",
    "security_check:",
    "package_gate:",
    "release_submission:",
    "clickable_controls_are_user_flow",
    "primary_buttons_and_links_reachable",
    "no_placeholder_href_or_dead_click_target",
    "button_link_contract_test_for_user_facing_pages",
  ]) {
    if (!coreProcess.includes(marker)) failures.push(`core process enforcement missing marker: ${marker}`);
  }
}

function checkMcpConfig() {
  const text = readText(".mcp.json");
  try {
    const parsed = JSON.parse(text);
    const server = parsed?.mcpServers?.["vibecode-checker"];
    if (!server) failures.push(".mcp.json missing mcpServers.vibecode-checker");
    if (server?.command !== "gvskb-server") {
      failures.push(".mcp.json must use gvskb-server for vibecode-checker");
    }
    if (server?.env?.PYTHONUTF8 !== "1") failures.push(".mcp.json missing PYTHONUTF8=1");
    if (server?.env?.PYTHONIOENCODING !== "utf-8") failures.push(".mcp.json missing PYTHONIOENCODING=utf-8");
    if (server?.env && Object.hasOwn(server.env, "GVSKB_MODE")) {
      failures.push(".mcp.json must not hard-code GVSKB_MODE unless the environment is confirmed offline");
    }
  } catch (error) {
    failures.push(`.mcp.json invalid JSON: ${error.message}`);
  }

  const codexConfig = readText(".codex/config.toml");
  for (const marker of [
    "[mcp_servers.vibecode-checker]",
    'command = "gvskb-server"',
    "PYTHONUTF8",
    "PYTHONIOENCODING",
  ]) {
    if (!codexConfig.includes(marker)) failures.push(`.codex/config.toml missing marker: ${marker}`);
  }
}

function checkPackagePolicy() {
  const pkg = JSON.parse(readText("package.json"));
  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
    ...(pkg.optionalDependencies || {}),
  };
  const names = Object.keys(deps);
  if (names.length === 0) return;

  const logPath = "docs/13_package_gate_log.md";
  if (!existsSync(join(root, logPath))) {
    failures.push(`${logPath} required because package.json declares dependencies`);
    return;
  }
  const log = readText(logPath);
  for (const name of names) {
    if (!log.includes(name)) {
      failures.push(`${logPath} missing checker evidence entry for dependency: ${name}`);
    }
  }
}

function checkProjectGuardContract() {
  const pkg = JSON.parse(readText("package.json"));
  const scripts = pkg.scripts || {};
  for (const scriptName of ["check", "harness:gate", "button:test", "scenario:test", "security:scan", "guard"]) {
    if (!scripts[scriptName]) failures.push(`package.json missing required script: ${scriptName}`);
  }
  if (!String(scripts["button:test"] || "").includes("portal-button-contract-test.mjs")) {
    failures.push("button:test must run scripts/portal-button-contract-test.mjs");
  }
  for (const required of ["harness:gate", "button:test", "scenario:test", "security:scan"]) {
    if (!String(scripts.guard || "").includes(required)) {
      failures.push(`guard script must include ${required}`);
    }
  }
}

function checkImplementationLanguages() {
  const disallowed = [".java", ".go", ".php", ".rb", ".cs", ".rs", ".kt", ".swift", ".dart"];
  for (const file of walk("src")) {
    const lower = file.toLowerCase();
    if (disallowed.some((ext) => lower.endsWith(ext))) {
      failures.push(`implementation language outside harness policy: ${file}`);
    }
  }
}

function checkJavaScriptSyntax() {
  for (const file of walk("src").filter((path) => path.endsWith(".js") || path.endsWith(".mjs"))) {
    const result = run("node", ["--check", file]);
    if (result.status !== 0) failures.push(`node --check failed for ${file}: ${result.stderr || result.stdout}`);
  }
  for (const file of ["scripts/portal-harness-gate.mjs"]) {
    const result = run("node", ["--check", file]);
    if (result.status !== 0) failures.push(`node --check failed for ${file}: ${result.stderr || result.stdout}`);
  }
}

function checkCheckerDoctor() {
  const version = run("gvskb", ["version"]);
  if (version.status !== 0) {
    failures.push(`gvskb version failed: ${version.stderr || version.error?.message || version.stdout}`);
    return;
  }

  const doctor = run("gvskb", ["doctor"]);
  const combined = `${doctor.stdout}\n${doctor.stderr}`;
  const summaryMatch = combined.match(/요약:\s*OK\s+\d+\s*·\s*WARN\s+(\d+)\s*·\s*ERROR\s+(\d+)/i);
  const fallbackErrorMatch = summaryMatch ? null : combined.match(/ERROR\s+(\d+)/i);
  const fallbackWarnMatch = summaryMatch ? null : combined.match(/WARN\s+(\d+)/i);
  const errorCount = summaryMatch ? Number(summaryMatch[2]) : fallbackErrorMatch ? Number(fallbackErrorMatch[1]) : 0;
  const warnCount = summaryMatch ? Number(summaryMatch[1]) : fallbackWarnMatch ? Number(fallbackWarnMatch[1]) : 0;
  if (errorCount > 0) {
    failures.push(`gvskb doctor reports ERROR ${errorCount}`);
  } else if (doctor.status !== 0) {
    warnings.push("gvskb doctor returned a non-zero status without ERROR; treating it as WARN for development gate");
  }
  if (warnCount > 0) {
    warnings.push(`gvskb doctor reports WARN ${warnCount}; keep this visible in release notes`);
  }
}

function checkWritableReportArea() {
  const reports = join(root, "reports");
  if (!existsSync(reports)) mkdirSync(reports);
  try {
    const stat = statSync(reports);
    if (!stat.isDirectory()) failures.push("reports path exists but is not a directory");
  } catch (error) {
    failures.push(`cannot access reports directory: ${error.message}`);
  }
}

checkHarnessFiles();
checkMcpConfig();
checkPackagePolicy();
checkProjectGuardContract();
checkImplementationLanguages();
checkJavaScriptSyntax();
checkCheckerDoctor();
checkWritableReportArea();

if (warnings.length) {
  console.log("HARNESS GATE WARNINGS");
  for (const item of warnings) console.log(`- ${item}`);
}

if (failures.length) {
  console.log("HARNESS GATE FAILED");
  for (const item of failures) console.log(`- ${item}`);
  process.exit(1);
}

console.log("HARNESS GATE PASSED");
