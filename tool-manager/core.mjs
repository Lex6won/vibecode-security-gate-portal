// =============================================================================
// 도구 관리자 핵심 로직 (S8에서 독립 프로그램으로 완성 예정)
//
// 2026-08-13 S1에서 src/server.js 로부터 이관했다. 서버 포털은 사용자 PC를
// 조작할 수 없으므로(22번 문서 §7), 설치·업데이트·MCP 등록은 PC에서 실행되는
// 도구 관리자가 맡는다. 이 파일은 그 로직을 유실 없이 보존한 것이며,
// 원본은 git 이력(8b91ee0 이전의 src/server.js)에도 남아 있다.
//
// 역할 경계(하네스팀 협의): 이 층은 "언제 무엇을 할지 정하고 결과를 보여 주는"
// 층이다. 실제 도구 감지와 설정 파일 백업·수정·복구는 하네스 스크립트가 한다.
// 감지·설정 로직을 여기에 중복 구현하지 말 것.
//
// 상태: 아직 실행 진입점(CLI/창)이 없다. S8에서 붙인다.
// UI 원형: tool-manager/ui-prototype.html (구 /harness 화면)
// =============================================================================
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile, copyFile, rename, rm, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const POWERSHELL = join(process.env.SystemRoot || "C:\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const HARNESS_SOURCE_DIR = runtimePath("PORTAL_HARNESS_SOURCE_DIR", resolve(ROOT, "..", "vibe_harness_codex"));
const LOCAL_TOOLS_DIR = runtimePath("PORTAL_TOOLS_DIR", join(ROOT, "tools"));
const LOCAL_HARNESS_DIR = join(LOCAL_TOOLS_DIR, "vibe_harness_codex");
const LOCAL_CHECKER_DIR = join(LOCAL_TOOLS_DIR, "vibecode-checker");
const HARNESS_REPOSITORY = "https://github.com/Lex6won/vibe_harness_codex.git";
const CHECKER_REPOSITORY = "https://github.com/Lex6won/vibecode-checker.git";
const OPERATION_LOG_FILE = runtimePath("PORTAL_OPERATION_LOG_FILE", join(ROOT, ".local", "gate-operation-log.jsonl"));

function runtimePath(name, fallback) {
  const value = process.env[name];
  return value && isAbsolute(value) ? value : fallback;
}

function harnessSourceDir() {
  return existsSync(LOCAL_HARNESS_DIR) ? LOCAL_HARNESS_DIR : HARNESS_SOURCE_DIR;
}

function koreaTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}`;
}

function installBackupPath(path) {
  return `${path}.portal-backup-${koreaTimestamp(new Date()).replace(/[:]/g, "")}`;
}

function installStagingPath(path) {
  return `${path}.portal-staging-${randomUUID()}`;
}

export async function writeGateOperation(action, target, result) {
  const entry = {
    at: new Date().toISOString(),
    action,
    target,
    status: result?.status || "unknown",
    reason: result?.reason || null
  };
  try {
    mkdirSync(dirname(OPERATION_LOG_FILE), { recursive: true });
    await appendFile(OPERATION_LOG_FILE, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Audit logging must never turn a completed local operation into a failure.
  }
}

function redactLocalPath(value) {
  return String(value || "").replace(/[A-Za-z]:[\/][^\s"'<>|]+/g, (match) => `…${basename(match)}`);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      shell: false,
      windowsHide: options.windowsHide ?? true,
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", ...(options.env || {}) }
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      resolveCommand(result);
    };
    const timeoutId = options.timeout_ms
      ? setTimeout(() => {
        child.kill();
        finish({ ok: false, code: -1, stdout, stderr: `${stderr}\ncommand timed out` });
      }, options.timeout_ms)
      : null;
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { finish({ ok: false, code: -1, stdout, stderr: String(error.message || error) }); });
    child.on("close", (code) => { finish({ ok: code === 0, code, stdout, stderr }); });
  });
}

// ---- 이하 src/server.js 에서 그대로 이관한 본문 ----

async function gitSummary(repoPath) {
  if (!existsSync(repoPath)) {
    return { installed: false, status: "missing" };
  }

  const [commit, branch, remote, dirty] = await Promise.all([
    runCommand("git", ["-C", repoPath, "rev-parse", "--short", "HEAD"]),
    runCommand("git", ["-C", repoPath, "branch", "--show-current"]),
    runCommand("git", ["-C", repoPath, "remote", "get-url", "origin"]),
    runCommand("git", ["-C", repoPath, "status", "--short"])
  ]);

  return {
    installed: commit.ok,
    status: commit.ok ? "present" : "invalid",
    path: repoPath,
    commit: commit.stdout.trim(),
    branch: branch.stdout.trim(),
    remote: remote.stdout.trim(),
    dirty: dirty.stdout.trim().length > 0
  };
}

async function remoteMainSummary(repoPath, local = null) {
  if (!existsSync(repoPath)) return { available: false, status: "missing" };
  const remote = await runCommand("git", ["-C", repoPath, "ls-remote", "origin", "refs/heads/main"], { timeout_ms: 20000 });
  const remoteCommit = remote.stdout.trim().split(/\s+/)[0] || "";
  if (!remote.ok || !remoteCommit) {
    return { available: false, status: "unreachable", error: remote.stderr.trim() || remote.stdout.trim() };
  }
  const localCommit = local?.commit || "";
  return {
    available: true,
    status: localCommit && remoteCommit.startsWith(localCommit) ? "current" : "update_available",
    local_commit: localCommit || null,
    remote_commit: remoteCommit.slice(0, 7)
  };
}

function normalizedRepository(value = "") {
  return String(value).trim().toLowerCase().replace(/\.git$/, "").replace(/\/$/, "");
}

async function isOfficialCheckout(repoPath, repository) {
  if (!repoPath || !existsSync(repoPath)) return false;
  const origin = await runCommand("git", ["-C", repoPath, "remote", "get-url", "origin"], { timeout_ms: 8000 });
  return origin.ok && normalizedRepository(origin.stdout) === normalizedRepository(repository);
}

function fileUrlMatchesPath(url, path) {
  if (!url || !path) return false;
  const normalizedUrl = decodeURIComponent(String(url)).replaceAll("\\", "/").toLowerCase();
  const normalizedPath = resolve(path).replaceAll("\\", "/").toLowerCase();
  return normalizedUrl.endsWith(normalizedPath) || normalizedUrl.endsWith(`/${normalizedPath}`);
}

async function checkerInstallationStatus() {
  const fixturePath = process.env.PORTAL_TEST_CHECKER_STATUS_FILE;
  if (fixturePath && existsSync(fixturePath)) {
    try {
      const payload = JSON.parse(readFileSync(fixturePath, "utf8"));
      if (payload?.status === "invalid_contract") return { installed: false, status: "invalid_contract" };
      return payload?.installed ? { installed: true, ...payload } : { installed: false, status: "missing" };
    } catch {
      return { installed: false, status: "invalid_contract" };
    }
  }
  const result = await runCommand("gvskb", ["status", "--json"], { timeout_ms: 15000 });
  if (!result.ok) return { installed: false, status: result.code === -1 ? "missing" : "invalid_contract" };
  try {
    const payload = JSON.parse(result.stdout);
    return payload?.schema_version === 1 && payload?.installed
      ? { installed: true, ...payload }
      : { installed: false, status: "invalid_contract" };
  } catch {
    return { installed: false, status: "invalid_contract" };
  }
}

function reinstallRequired(component, message) {
  return {
    component,
    status: "reinstall_required",
    message,
    github_checked: true
  };
}

export async function checkerSummary() {
  const [version, doctor, pipShow] = await Promise.all([
    runCommand("gvskb", ["version"]),
    runCommand("gvskb", ["doctor"]),
    runCommand("pip.exe", ["show", "vibecode-checker"])
  ]);

  const doctorText = `${doctor.stdout}\n${doctor.stderr}`;
  const hasError = /ERROR\s+[1-9]/.test(doctorText);
  const hasWarn = /WARN\s+[1-9]/.test(doctorText) || doctor.code !== 0;

  const editableMatch = pipShow.stdout.match(/^Editable project location:\s*(.+)$/mi);
  const editablePath = editableMatch?.[1]?.trim() || "";
  const source = editablePath ? await gitSummary(editablePath) : { installed: false, status: "package_only" };
  const remote = editablePath ? await remoteMainSummary(editablePath, source) : { available: false, status: "package_only" };

  return {
    installed: version.ok,
    version: version.stdout.trim(),
    doctor_status: hasError ? "error" : hasWarn ? "warn" : "ok",
    doctor_exit_code: doctor.code,
    doctor_summary: doctorText.split(/\r?\n/).filter(Boolean).slice(-8),
    source,
    remote
  };
}

async function checkerCommandSummary() {
  const command = await runCommand("where.exe", ["gvskb-server"], { timeout_ms: 8000 });
  return {
    available: command.ok,
    path: command.ok ? command.stdout.split(/\r?\n/).find(Boolean)?.trim() || null : null
  };
}

function checkerMcpEntry() {
  return {
    command: "gvskb-server",
    args: [],
    env: {
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8"
    }
  };
}

function hasRegisteredChecker(config) {
  const server = config?.mcpServers?.["vibecode-checker"];
  return Boolean(server && server.command === "gvskb-server");
}

export async function mcpSummary() {
  const codexPath = mcpConfigPath("codex");
  const claudeCodePath = mcpConfigPath("claude-code");
  const claudeDesktopPaths = [mcpConfigPath("claude-desktop")].filter(Boolean);

  const [tomlSource, checkerCommand] = await Promise.all([
    existsSync(codexPath) ? readFile(codexPath, "utf8") : Promise.resolve(""),
    checkerCommandSummary()
  ]);
  let claudeCodeSource = "";
  let claudeDesktopSource = "";
  let claudeCodeValid = false;
  let claudeDesktopValid = false;
  let claudeCodeConfig = null;
  let claudeDesktopConfig = null;

  if (existsSync(claudeCodePath)) {
    try {
      claudeCodeSource = await readFile(claudeCodePath, "utf8");
      claudeCodeConfig = JSON.parse(claudeCodeSource);
      claudeCodeValid = true;
    } catch {
      claudeCodeValid = false;
    }
  }

  for (const path of claudeDesktopPaths) {
    if (!existsSync(path)) continue;
    try {
      claudeDesktopSource = await readFile(path, "utf8");
      claudeDesktopConfig = JSON.parse(claudeDesktopSource);
      claudeDesktopValid = true;
      break;
    } catch {
      claudeDesktopValid = false;
      break;
    }
  }

  const tools = {
    codex: {
      status: /\[mcp_servers\.vibecode-checker\][\s\S]*?command\s*=\s*["']gvskb-server["']/.test(tomlSource) ? "registered" : "missing",
      setting_location: "프로젝트/.codex/config.toml"
    },
    "claude-code": {
      status: claudeCodeValid && hasRegisteredChecker(claudeCodeConfig)
        ? "registered"
        : existsSync(claudeCodePath) && !claudeCodeValid ? "configuration_incomplete" : "missing",
      setting_location: "프로젝트/.mcp.json"
    },
    "claude-desktop": {
      status: claudeDesktopValid && hasRegisteredChecker(claudeDesktopConfig)
        ? "registered"
        : claudeDesktopSource && !claudeDesktopValid ? "configuration_incomplete" : "missing",
      setting_location: "Claude Desktop MCP 설정"
    },
    lovable: {
      status: "not_supported",
      setting_location: "자동 MCP 등록 미지원"
    }
  };

  return {
    tools,
    codex_project: tools.codex.status,
    common_mcp: tools["claude-code"].status,
    checker_command: checkerCommand
  };
}

export async function executionGateSummary() {
  let packageJson = {};
  try {
    packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  } catch {
    packageJson = {};
  }

  const hooksPath = await runCommand("git", ["config", "--get", "core.hooksPath"]);
  const normalizedHooksPath = hooksPath.stdout.trim().replaceAll("\\", "/");
  const preCommitPath = normalizedHooksPath
    ? join(ROOT, normalizedHooksPath, "pre-commit")
    : join(ROOT, ".githooks", "pre-commit");

  return {
    guard_script: packageJson.scripts?.guard ? "configured" : "missing",
    security_scan_script: packageJson.scripts?.["security:scan"] ? "configured" : "missing",
    hook_path: normalizedHooksPath || "not_configured",
    pre_commit_hook: hooksPath.ok && existsSync(preCommitPath) ? "active" : "missing_or_not_configured",
    npm_package_gate: existsSync(join(ROOT, "shared", "enforcement", "gvskb_gate.js")) ? "present" : "missing",
    pypi_package_gate: existsSync(join(ROOT, "shared", "enforcement", "gvskb_gate.py")) ? "present" : "missing"
  };
}

export async function localStatus() {
  const sourceDir = harnessSourceDir();
  const [projectHarness, sourceHarness, checker, mcp, executionGate] = await Promise.all([
    Promise.resolve({
      installed: existsSync(join(ROOT, "shared", "harness.yaml")),
      status: existsSync(join(ROOT, "shared", "harness.yaml")) ? "applied" : "missing",
      path: ROOT
    }),
    gitSummary(sourceDir),
    checkerSummary(),
    mcpSummary(),
    executionGateSummary()
  ]);

  const harnessRemote = sourceHarness.installed
    ? await remoteMainSummary(sourceDir, sourceHarness)
    : await officialRemoteSummary(HARNESS_REPOSITORY);
  return {
    checked_at: new Date().toISOString(),
    project_harness: projectHarness,
    source_harness: { ...sourceHarness, path: sourceDir, remote: harnessRemote },
    checker,
    mcp,
    execution_gate: executionGate,
    network: {
      mode: "online",
      github: harnessRemote.available || checker.remote?.available ? "reachable" : "unavailable",
      osv: checker.doctor_status === "error" ? "unknown" : "reachable_or_cached"
    }
  };
}

async function officialRemoteSummary(repository) {
  const remote = await runCommand("git", ["ls-remote", repository, "refs/heads/main"], { timeout_ms: 20000 });
  const commit = remote.stdout.trim().split(/\s+/)[0] || "";
  return remote.ok && commit
    ? { available: true, status: "available", remote_commit: commit.slice(0, 7) }
    : { available: false, status: "unreachable" };
}

function simpleVersionResult(component, local, remote) {
  if (!local?.installed) {
    if (!remote?.available) {
      return { component, status: "check_unavailable", message: "GitHub에서 최신 설치 기준을 확인하지 못했습니다. 다시 확인하세요.", github_checked: false };
    }
    return { component, status: "not_installed", message: "설치되어 있지 않습니다. 설치할 수 있습니다.", github_checked: true, available_version: remote.remote_commit || null };
  }
  if (remote?.available && (local?.dirty || (local?.branch && local.branch !== "main"))) {
    return reinstallRequired(
      component,
      local.dirty
        ? "설치 폴더에 변경이 있어 자동 업데이트를 하지 않습니다. 공식 재설치로 새 설치본을 만들 수 있습니다."
        : "공식 main 브랜치가 아닌 설치본입니다. 공식 재설치를 진행할 수 있습니다."
    );
  }
  if (remote?.status === "current") {
    return { component, status: "current", message: "최신 버전입니다.", github_checked: true };
  }
  if (remote?.status === "update_available") {
    return { component, status: "update_available", message: "업데이트가 필요합니다.", github_checked: true };
  }
  return { component, status: "check_unavailable", message: "GitHub에서 최신 버전을 확인할 수 없습니다. 잠시 후 다시 확인하세요.", github_checked: false };
}

export async function simpleVersionStatus(target) {
  if (target === "harness") {
    const managed = existsSync(LOCAL_HARNESS_DIR);
    const sourceDir = managed ? LOCAL_HARNESS_DIR : HARNESS_SOURCE_DIR;
    const local = await gitSummary(sourceDir);
    const remote = local.installed && managed
      ? await remoteMainSummary(sourceDir, local)
      : await officialRemoteSummary(HARNESS_REPOSITORY);
    if (!local.installed) return simpleVersionResult("하네스", local, remote);
    if (!remote.available) return simpleVersionResult("하네스", local, remote);
    if (!managed || !(await isOfficialCheckout(sourceDir, HARNESS_REPOSITORY))) {
      return reinstallRequired("하네스", "공식 설치본이 아닙니다. 기존 개발 폴더는 유지하고 공식 재설치를 진행할 수 있습니다.");
    }
    return simpleVersionResult("하네스", local, remote);
  }

  if (target === "checker") {
    const installed = await checkerInstallationStatus();
    const remote = await officialRemoteSummary(CHECKER_REPOSITORY);
    if (!installed.installed) {
      if (installed.status === "missing") return simpleVersionResult("체커", { installed: false }, remote);
      return { component: "체커", status: "check_unavailable", message: "설치 정보를 확인하지 못했습니다. 설치 버전 확인을 다시 실행하세요.", github_checked: false };
    }
    if (!remote.available) return simpleVersionResult("체커", { installed: true }, remote);
    const identity = installed.install_identity || {};
    const local = await gitSummary(LOCAL_CHECKER_DIR);
    const managed = local.installed
      && Boolean(identity.editable)
      && fileUrlMatchesPath(identity.install_url, LOCAL_CHECKER_DIR)
      && await isOfficialCheckout(LOCAL_CHECKER_DIR, CHECKER_REPOSITORY);
    if (!managed) {
      return reinstallRequired("체커", "공식 설치본이 아닙니다. 현재 설치는 그대로 두고 공식 재설치를 진행할 수 있습니다.");
    }
    const checkoutRemote = await remoteMainSummary(LOCAL_CHECKER_DIR, local);
    return simpleVersionResult("체커", local, checkoutRemote);
  }

  return { component: "", status: "invalid_target", message: "확인할 대상을 찾을 수 없습니다.", github_checked: false };
}

export async function installComponent(target) {
  const version = await simpleVersionStatus(target);
  if (version.status === "check_unavailable") {
    return { status: "blocked", reason: "github_check_required", message: "GitHub 기준을 확인하지 못해 설치를 시작하지 않았습니다. 다시 확인하세요." };
  }
  if (!["not_installed", "reinstall_required"].includes(version.status)) {
    return { status: "already_installed", message: "이미 설치되어 있습니다. 설치 버전을 확인하세요." };
  }

  if (target === "harness") {
    mkdirSync(LOCAL_TOOLS_DIR, { recursive: true });
    const staging = installStagingPath(LOCAL_HARNESS_DIR);
    const cloned = await runCommand("git", ["clone", "--depth", "1", HARNESS_REPOSITORY, staging], { timeout_ms: 120000 });
    if (!cloned.ok) {
      return { status: "failed", reason: "clone_failed", message: "하네스 공식 저장소를 가져오지 못했습니다.", detail: redactLocalPath((cloned.stderr || cloned.stdout).trim().slice(-500)) };
    }
    const validated = await runCommand(
      POWERSHELL,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(staging, "shared", "scripts", "gg-validate.ps1")],
      { cwd: staging, timeout_ms: 120000 }
    );
    if (!validated.ok) {
      await rm(staging, { recursive: true, force: true });
      return { status: "needs_review", reason: "validation_failed", message: "새 공식 설치본이 기본 검증을 통과하지 못했습니다. 기존 설치는 바꾸지 않았습니다.", detail: redactLocalPath((validated.stderr || validated.stdout).trim().slice(-500)) };
    }
    let backup = null;
    if (existsSync(LOCAL_HARNESS_DIR)) {
      backup = installBackupPath(LOCAL_HARNESS_DIR);
      await rename(LOCAL_HARNESS_DIR, backup);
    }
    await rename(staging, LOCAL_HARNESS_DIR);
    return { status: "installed", message: "공식 하네스 설치와 기본 검증이 완료되었습니다.", location: LOCAL_HARNESS_DIR, backup: backup ? basename(backup) : null };
  }

  const sourceDir = harnessSourceDir();
  const bootstrap = join(sourceDir, "shared", "scripts", "checker-bootstrap.mjs");
  if (!existsSync(bootstrap)) {
    return { status: "blocked", reason: "harness_bootstrap_missing", message: "체커 설치에 필요한 하네스 설치 파일을 찾지 못했습니다. 하네스를 먼저 설치하세요." };
  }
  mkdirSync(LOCAL_TOOLS_DIR, { recursive: true });
  let backup = null;
  if (existsSync(LOCAL_CHECKER_DIR)) {
    backup = installBackupPath(LOCAL_CHECKER_DIR);
    await rename(LOCAL_CHECKER_DIR, backup);
  }
  const installed = await runCommand("node", [bootstrap, "--target", LOCAL_CHECKER_DIR, "--yes", "--install-python"], { timeout_ms: 300000 });
  if (!installed.ok) {
    await rm(LOCAL_CHECKER_DIR, { recursive: true, force: true });
    if (backup) await rename(backup, LOCAL_CHECKER_DIR);
    const detail = `${installed.stderr}\n${installed.stdout}`.trim();
    if (/WinError 32|used by another process|다른 프로세스/i.test(detail)) {
      return {
        status: "failed",
        reason: "checker_server_running",
        message: "보안 체커가 다른 AI 도구에서 실행 중입니다. Codex·Claude Code·Claude Desktop을 종료한 뒤 다시 시도하세요.",
        detail: "gvskb-server 실행 파일이 사용 중이라 교체하지 않았습니다. 기존 설치는 유지됩니다."
      };
    }
    return { status: "failed", reason: "checker_install_failed", message: "체커 설치를 완료하지 못했습니다. Python 3.11 이상과 pip 설치 상태를 확인하세요.", detail: redactLocalPath(detail.slice(0, 600)) };
  }
  const verified = await simpleVersionStatus("checker");
  return verified.status === "current"
    ? { status: "installed", message: "공식 체커 설치와 상태 점검이 완료되었습니다.", location: LOCAL_CHECKER_DIR, backup: backup ? basename(backup) : null }
    : { status: "needs_review", reason: "post_install_verification_failed", message: "체커 설치 후 공식 설치 여부를 확인하지 못했습니다. 기존 개발 설치는 보존되어 있습니다.", detail: verified.message };
}

function mcpConfigPath(target) {
  if (target === "codex") return process.env.PORTAL_TEST_CODEX_CONFIG || join(ROOT, ".codex", "config.toml");
  if (target === "claude-code") return process.env.PORTAL_TEST_CLAUDE_CODE_CONFIG || join(ROOT, ".mcp.json");
  if (target === "claude-desktop") {
    if (process.env.PORTAL_TEST_CLAUDE_DESKTOP_CONFIG) return process.env.PORTAL_TEST_CLAUDE_DESKTOP_CONFIG;
    if (process.env.APPDATA) return join(process.env.APPDATA, "Claude", "claude_desktop_config.json");
    if (process.env.HOME) return join(process.env.HOME, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return "";
}

function configBackupPath(path) {
  return `${path}.portal-backup-${koreaReportTimestamp(new Date()).replace(/[:]/g, "")}`;
}

async function writeTextWithBackup(path, content) {
  let backup = null;
  if (existsSync(path)) {
    backup = configBackupPath(path);
    await copyFile(path, backup);
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.portal-writing`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
  return backup ? basename(backup) : null;
}

export async function registerMcp(target) {
  if (!["codex", "claude-code", "claude-desktop"].includes(target)) {
    return { status: "blocked", reason: "unsupported_tool", message: "이 도구는 자동 MCP 등록을 지원하지 않습니다." };
  }
  const command = await checkerCommandSummary();
  if (!command.available) {
    return { status: "blocked", reason: "checker_not_installed", message: "체커가 설치되어 있지 않아 MCP를 등록하지 않았습니다. 체커를 먼저 설치하고 버전을 확인하세요." };
  }
  const path = mcpConfigPath(target);
  if (!path) return { status: "blocked", reason: "config_location_missing", message: "이 PC에서 MCP 설정 위치를 찾지 못했습니다." };

  if (target === "codex") {
    const current = existsSync(path) ? await readFile(path, "utf8") : "";
    const hasSection = /^\[mcp_servers\.vibecode-checker\]\s*$/m.test(current);
    if (hasSection) {
      if (/\[mcp_servers\.vibecode-checker\][\s\S]*?command\s*=\s*["']gvskb-server["']/m.test(current)) {
        return { status: "already_registered", message: "Codex 설정에 보안 체커 MCP가 이미 등록되어 있습니다.", location: path };
      }
      return { status: "blocked", reason: "existing_mcp_configuration", message: "기존 보안 체커 MCP 설정이 달라 자동으로 바꾸지 않았습니다. 설정을 확인하세요." };
    }
    const block = `\n[mcp_servers.vibecode-checker]\ncommand = "gvskb-server"\nargs = []\nenv = { PYTHONUTF8 = "1", PYTHONIOENCODING = "utf-8" }\n`;
    const backup = await writeTextWithBackup(path, `${current.trimEnd()}${block}`);
    return { status: "registered", message: "Codex용 보안 체커 MCP를 등록했습니다. Codex를 다시 시작하세요.", location: path, backup };
  }

  let config = {};
  if (existsSync(path)) {
    try {
      config = JSON.parse(await readFile(path, "utf8"));
    } catch {
      return { status: "blocked", reason: "invalid_configuration", message: "기존 MCP 설정 파일 형식이 올바르지 않아 자동으로 바꾸지 않았습니다." };
    }
  }
  if (!config || Array.isArray(config) || typeof config !== "object") {
    return { status: "blocked", reason: "invalid_configuration", message: "기존 MCP 설정 구조가 올바르지 않아 자동으로 바꾸지 않았습니다." };
  }
  config.mcpServers = config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers) ? config.mcpServers : {};
  const existing = config.mcpServers["vibecode-checker"];
  if (existing) {
    if (existing.command === "gvskb-server") {
      return { status: "already_registered", message: "보안 체커 MCP가 이미 등록되어 있습니다.", location: path };
    }
    return { status: "blocked", reason: "existing_mcp_configuration", message: "기존 보안 체커 MCP 설정이 달라 자동으로 바꾸지 않았습니다. 설정을 확인하세요." };
  }
  config.mcpServers["vibecode-checker"] = checkerMcpEntry();
  const backup = await writeTextWithBackup(path, `${JSON.stringify(config, null, 2)}\n`);
  const toolLabel = target === "claude-code" ? "Claude Code" : "Claude Desktop";
  return { status: "registered", message: `${toolLabel}용 보안 체커 MCP를 등록했습니다. ${toolLabel}을 다시 시작하세요.`, location: path, backup };
}

export async function updatePreview() {
  const status = await localStatus();
  const harness = status.source_harness || {};
  const checker = status.checker || {};
  const blockedTargets = [];
  const blockedReasons = {};
  if (harness.dirty || (harness.branch && harness.branch !== "main")) {
    blockedTargets.push("harness");
    blockedReasons.harness = harness.dirty ? "dirty_worktree" : "non_main_branch";
  }
  if (checker.source?.dirty || (checker.source?.branch && checker.source.branch !== "main")) {
    blockedTargets.push("checker");
    blockedReasons.checker = checker.source?.dirty ? "dirty_worktree" : "non_main_branch";
  }
  return {
    status: blockedTargets.length ? "blocked_dirty_worktree" : "preview_ready",
    applies_without_approval: false,
    flow: ["상태 확인", "변경 내용 보기", "사용자 승인", "업데이트 적용", "재검증"],
    blocked_targets: blockedTargets,
    blocked_reasons: blockedReasons,
    items: [
      {
        target: "harness",
        current_version: harness.commit || "미설치",
        available_version: harness.remote?.remote_commit || "확인 불가",
        status: harness.remote?.status || harness.status || "확인 불가",
        dirty: Boolean(harness.dirty),
        channel: "stable",
        source: "official_release_or_approved_commit",
        validation: "gg-validate.ps1 required"
      },
      {
        target: "checker",
        current_version: checker.version || "미설치",
        available_version: checker.remote?.remote_commit || "확인 불가",
        status: checker.remote?.status || (checker.installed ? "package_only" : "missing"),
        dirty: Boolean(checker.source?.dirty),
        channel: "stable",
        source: "official_editable_checkout_or_validated_package",
        validation: "gvskb doctor required"
      },
      {
        target: "mcp",
        source: "project settings",
        validation: "config backup and connection test required"
      }
    ]
  };
}

export async function applyUpdates(targets = ["harness", "checker"]) {
  const requestedTargets = targets.filter((target) => target === "harness" || target === "checker");
  const eligibleTargets = requestedTargets.length ? requestedTargets : ["harness", "checker"];
  const states = Object.fromEntries(await Promise.all(eligibleTargets.map(async (target) => [target, await simpleVersionStatus(target)])));
  const blockedTargets = eligibleTargets.filter((target) => states[target].status !== "update_available");
  if (blockedTargets.length) {
    return {
      status: "blocked",
      reason: "update_not_eligible",
      blocked_targets: blockedTargets,
      blocked_reasons: Object.fromEntries(blockedTargets.map((target) => [target, states[target].status]))
    };
  }

  const results = [];
  for (const target of eligibleTargets) {
    const repoPath = target === "harness" ? LOCAL_HARNESS_DIR : LOCAL_CHECKER_DIR;
    if (!repoPath || !existsSync(repoPath)) {
      results.push({ target, status: "manual_update_required", reason: "official_install_missing" });
      continue;
    }
    const pulled = await runCommand("git", ["-C", repoPath, "pull", "--ff-only", "origin", "main"], { timeout_ms: 120000 });
    results.push({ target, status: pulled.ok ? "updated_or_current" : "failed", detail: redactLocalPath((pulled.stderr || pulled.stdout).trim().slice(-500)) });
  }

  const harnessValidation = eligibleTargets.includes("harness")
    ? await runCommand(
      POWERSHELL,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(LOCAL_HARNESS_DIR, "shared", "scripts", "gg-validate.ps1")],
      { cwd: LOCAL_HARNESS_DIR, timeout_ms: 120000 }
    )
    : { ok: true };
  const checkerValidation = eligibleTargets.includes("checker")
    ? await runCommand("gvskb", ["doctor"], { timeout_ms: 120000 })
    : { ok: true };
  const hasFailure = results.some((result) => result.status === "failed") || !harnessValidation.ok || !checkerValidation.ok;
  return {
    status: hasFailure ? "needs_review" : "applied",
    results,
    post_checks: {
      harness_validate: harnessValidation.ok ? "ok" : "failed",
      checker_doctor: checkerValidation.ok ? "ok" : "failed"
    }
  };
}

