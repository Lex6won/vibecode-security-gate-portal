#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] || ".");
const failures = [];
const warnings = [];

function readText(path) {
  const fullPath = join(root, path);
  if (!existsSync(fullPath)) {
    failures.push(`MISSING ${path}`);
    return "";
  }
  return readFileSync(fullPath, "utf8").replace(/^\uFEFF/, "");
}

function requireText(path, markers) {
  const text = readText(path);
  for (const marker of markers) {
    if (!text.includes(marker)) {
      failures.push(`${path} missing marker: ${marker}`);
    }
  }
}

function walk(dir) {
  const fullDir = join(root, dir);
  if (!existsSync(fullDir)) return [];
  const results = [];
  for (const entry of readdirSync(fullDir, { withFileTypes: true })) {
    const fullPath = join(fullDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(relative(root, fullPath)));
    } else {
      results.push(relative(root, fullPath).replaceAll("\\", "/"));
    }
  }
  return results;
}

requireText("README.md", [
  "https://github.com/Lex6won/vibe_harness_codex",
  "https://github.com/Lex6won/vibecode-checker",
  "git clone https://github.com/Lex6won/vibe_harness_codex.git",
  "git clone https://github.com/Lex6won/vibecode-checker.git",
  "quick/standard/full",
  "표준 운영 하네스",
  "초보 공무원",
  "구상 → 표준 템플릿 구현",
  "dev-quick",
  "GVSKB_POLICIES_DIR",
  "gvskb-server",
  "profile_fallback",
  "network_profile",
  "최종 리포트 2종",
  "보안팀 또는 AX 전담팀에 제출",
  "shared/assets/coaching-messages.md",
  "shared/enforcement/gvskb_gate.py",
  "shared/enforcement/gvskb_gate.js",
  ".mcp.json",
  ".codex/config.toml",
  "망분리·반입 환경으로 확인된 경우에만 설정",
]);

requireText("AGENTS.md", [
  "quick during coding",
  "standard operating harness",
  "standard after implementation completion",
  "full before deployment/security/AX submission",
  "vibecode-checker",
  "dev-quick",
  "GVSKB_POLICIES_DIR",
  "profile_fallback",
  "https://github.com/Lex6won/vibe_harness_codex",
  "https://github.com/Lex6won/vibecode-checker",
  "Python, JavaScript, or TypeScript",
  "coaching-messages.md",
  "gvskb_gate.py",
  "gvskb_gate.js",
]);

requireText("shared/harness.yaml", [
  "canonical_repositories:",
  "standard operating harness",
  "agency_onboarding:",
  "coaching-messages.md",
  "https://github.com/Lex6won/vibe_harness_codex",
  "https://github.com/Lex6won/vibecode-checker",
  "checker-mediated-only",
  "checker_profile_policy:",
  "package_gate:",
  "common_mcp_config",
  "codex_project_config",
  "gvskb_gate.py",
  "gvskb_gate.js",
  "final_submission_impact",
  "quick_profile: \"dev-quick\"",
  "custom_policies_dir: \"absolute-path-only\"",
  "vibecode-checker_saved_html_report",
  "vibecode-checker_saved_json_evidence",
]);

requireText("shared/institution-profile.yaml", [
  "allowed_function_implementation_languages:",
  "- python",
  "- javascript",
  "canonical_repositories:",
  "registry_access: \"checker-mediated-only\"",
]);

requireText("shared/assets/coaching-messages.md", [
  "패키지 차단",
  "보안 점검",
  "체커 미설치",
  "배포 전 제출",
  "안 됩니다",
]);

requireText("shared/references/user-experience-policy.md", [
  "구상 → 만들기 → 확인",
  "shared/assets/coaching-messages.md",
  "차단은 실패가 아니라 안전한 우회로 안내",
]);

requireText("shared/references/institution-profile-guide.md", [
  "처음 바꿀 파일",
  "처음에는 건드리지 말 파일",
  "shared/institution-profile.yaml",
]);

requireText("shared/references/lifecycle-quality-gates.yaml", [
  "checker_profiles:",
  "quick:",
  "standard:",
  "full:",
  "two_report_release_default",
  "mandatory_user_notice",
  "conditional_documents_only",
]);

requireText("shared/references/package-alternatives.yaml", [
  "Prefer no-new-package and approved-package replacements before exception requests.",
  "preferred_replacement",
  "output_template",
]);

requireText("shared/references/checker-bootstrap-policy.md", [
  "사용자가 명시적으로 동의하기 전에는",
  "https://github.com/Lex6won/vibecode-checker",
  "https://github.com/Lex6won/vibe_harness_codex",
  "루트 `.mcp.json`",
  ".codex/config.toml",
  "dev-quick",
  "GVSKB_POLICIES_DIR",
  "gvskb-server",
  "절대경로",
  "--yes",
  "--install-python",
]);

requireText("shared/references/checker-integration.md", [
  "dev-quick",
  "GVSKB_POLICIES_DIR",
  "requested_checker_profile",
  "applied_checker_profile",
  "profile_fallback",
  "network_profile",
  "검증을 완료 처리하지 않는다",
  "gvskb_gate.py",
  "gvskb_gate.js",
  "--ignore-scripts",
]);

requireText("shared/enforcement/gvskb_gate.py", [
  "audit_manifest",
  "verify-manifest",
  "GVSKB_GATE_MODE",
  "package_manifest_text",
  "max_cve",
  "heuristics",
  "typosquat_warning",
  "local_denied",
  "registry_rejected",
  "not_found",
  "in_kev",
]);

if (readText("shared/enforcement/gvskb_gate.py").includes("check_package_impl")) {
  failures.push("shared/enforcement/gvskb_gate.py must use audit_manifest instead of check_package_impl");
}

requireText("shared/enforcement/gvskb_gate.js", [
  "GVSKB_GATE_PYTHON",
  "gvskb_gate.py",
  "--ignore-scripts",
  "verify-manifest",
  "npm",
]);

const disallowedImplementationExtensions = new Set([
  ".java",
  ".go",
  ".php",
  ".rb",
  ".cs",
  ".rs",
]);

for (const file of walk("shared/golden-templates")) {
  const lower = file.toLowerCase();
  for (const extension of disallowedImplementationExtensions) {
    if (lower.endsWith(extension)) {
      failures.push(`golden template uses non-approved implementation language: ${file}`);
    }
  }
}

for (const file of walk("shared/golden-templates")) {
  if (!file.endsWith("requirements.txt")) continue;
  const lines = readText(file)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  for (const line of lines) {
    if (!line.includes("==") || line.includes("*") || line.includes("[")) {
      failures.push(`${file} dependency must be exact and checker-parseable: ${line}`);
    }
  }
}

for (const file of walk("shared/golden-templates")) {
  if (!file.endsWith("package.json")) continue;
  const parsed = JSON.parse(readText(file));
  for (const section of ["dependencies", "devDependencies"]) {
    const deps = parsed[section] || {};
    for (const [name, version] of Object.entries(deps)) {
      if (typeof version !== "string" || version.startsWith("^") || version.startsWith("~") || version.includes("*")) {
        failures.push(`${file} ${section}.${name} must use an exact version, got ${version}`);
      }
    }
  }
  if ((file.includes("gg-node-api") || file.includes("gg-spa")) && parsed.engines?.node !== ">=20.19.0 <21") {
    failures.push(`${file} must declare engines.node >=20.19.0 <21`);
  }
  if ((file.includes("gg-node-api") || file.includes("gg-spa")) && !existsSync(join(root, file.replace("package.json", "package-lock.json")))) {
    failures.push(`${file} requires package-lock.json for release evidence`);
  }
}

for (const file of walk("evals")) {
  if (!file.endsWith(".json")) continue;
  try {
    const parsed = JSON.parse(readText(file));
    if (!parsed.name) failures.push(`${file} missing name`);
    if (!Array.isArray(parsed.expect) || parsed.expect.length === 0) {
      failures.push(`${file} missing non-empty expect[]`);
    }
  } catch (error) {
    failures.push(`${file} invalid JSON: ${error.message}`);
  }
}

const mcpConfigText = readText(".mcp.json");
const mcpConfigBytes = readFileSync(join(root, ".mcp.json"));
if (mcpConfigBytes.length >= 3 && mcpConfigBytes[0] === 0xef && mcpConfigBytes[1] === 0xbb && mcpConfigBytes[2] === 0xbf) {
  failures.push(".mcp.json must be UTF-8 without BOM");
}
const parsedMcpConfig = JSON.parse(mcpConfigText);
const checkerServer = parsedMcpConfig?.mcpServers?.["vibecode-checker"];
const checkerCommand = checkerServer?.command;
const checkerArgs = Array.isArray(checkerServer?.args) ? checkerServer.args : [];
const usesGvskbServer = checkerCommand === "gvskb-server" && checkerArgs.length === 0;
const usesPythonModule = checkerCommand === "python" && checkerArgs.length === 2 && checkerArgs[0] === "-m" && checkerArgs[1] === "gvskb.server";
if (!usesGvskbServer && !usesPythonModule) {
  failures.push(".mcp.json checker command must be gvskb-server or python -m gvskb.server");
}
if (checkerCommand === "gvskb" && checkerArgs.includes("mcp")) {
  failures.push(".mcp.json must not use invalid command gvskb mcp");
}
for (const envName of ["PYTHONUTF8", "PYTHONIOENCODING"]) {
  if (!Object.prototype.hasOwnProperty.call(checkerServer?.env || {}, envName)) {
    failures.push(`.mcp.json missing required checker env: ${envName}`);
  }
}
if (Object.prototype.hasOwnProperty.call(checkerServer?.env || {}, "GVSKB_MODE")) {
  failures.push(".mcp.json must not hard-code GVSKB_MODE; set offline only in confirmed air-gapped environments");
}
if (mcpConfigText.includes("GVSKB_POLICIES_DIR")) {
  const policyDir = parsedMcpConfig?.mcpServers?.["vibecode-checker"]?.env?.GVSKB_POLICIES_DIR;
  if (typeof policyDir === "string" && !/^([A-Za-z]:[\\/]|\/)/.test(policyDir)) {
    failures.push(".mcp.json GVSKB_POLICIES_DIR must be absolute or omitted");
  }
}

const codexConfig = readText(".codex/config.toml");
for (const marker of [
  "[mcp_servers.vibecode-checker]",
  "command = \"gvskb-server\"",
  "PYTHONUTF8",
  "PYTHONIOENCODING",
]) {
  if (!codexConfig.includes(marker)) failures.push(`.codex/config.toml missing marker: ${marker}`);
}
if (codexConfig.includes("GVSKB_MODE")) {
  failures.push(".codex/config.toml must not hard-code GVSKB_MODE");
}

const claudeMcpText = readText(".claude/.mcp.json");
if (claudeMcpText.includes("GVSKB_MODE")) {
  failures.push(".claude/.mcp.json must not hard-code GVSKB_MODE");
}

const finalEval = readText("evals/04_final_release_harness.json");
for (const marker of [
  "coding quick check",
  "implementation complete standard check",
  "release full checker reports",
  "submit two final reports",
  "GitHub canonical source",
]) {
  if (!finalEval.includes(marker)) failures.push(`evals/04_final_release_harness.json missing final acceptance marker: ${marker}`);
}

if (walk("shared/golden-templates").length === 0) {
  failures.push("golden templates are empty");
}

if (warnings.length > 0) {
  console.log("WARNINGS:");
  for (const warning of warnings) console.log(`- ${warning}`);
}

if (failures.length > 0) {
  console.log("HARNESS FINAL SMOKE FAILED");
  for (const failure of failures) console.log(`- ${failure}`);
  process.exit(1);
}

console.log("HARNESS FINAL SMOKE PASSED");
