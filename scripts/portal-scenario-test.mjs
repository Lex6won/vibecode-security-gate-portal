#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.PORTAL_TEST_PORT || 8791);
const baseUrl = `http://127.0.0.1:${port}`;
const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const adminId = "gg0018@gg.go.kr";
const adminPassword = "ScenarioAdmin!2026";
const localApiToken = "portal-scenario-local-token";
let adminCookie = "";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localHeaders(headers) {
  const merged = new Headers(headers || {});
  merged.set("X-VibeCode-Local-Token", localApiToken);
  return merged;
}

function rawRequest(path, headers = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, headers }, (response) => {
      response.resume();
      response.on("end", () => resolveRequest(response));
    });
    request.once("error", rejectRequest);
    request.end();
  });
}

async function fetchJson(path, options) {
  const headers = localHeaders(options?.headers);
  if (adminCookie) headers.set("cookie", adminCookie);
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  assert.ok(response.ok, `${path} expected ok, got ${response.status}: ${text.slice(0, 300)}`);
  return body;
}

async function fetchText(path) {
  const headers = new Headers();
  if (adminCookie) headers.set("cookie", adminCookie);
  const response = await fetch(`${baseUrl}${path}`, { headers });
  const text = await response.text();
  assert.ok(response.ok, `${path} expected ok, got ${response.status}`);
  return text;
}

async function waitForServer(child) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const health = await fetchJson("/health");
      if (health.status === "ok") return;
    } catch {
      await wait(250);
    }
  }
  throw new Error("test server did not become ready");
}

async function startScan(scanMode, targetType, targetRef, saveDir = "", targetLabel = "") {
  const started = await fetchJson("/api/scan/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scan_mode: scanMode, target_type: targetType, target_ref: targetRef, target_label: targetLabel, save_dir: saveDir })
  });
  assert.ok(started.scan_id, "scan_id must be returned");
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const progress = await fetchJson(started.progress_url);
    if (progress.status === "completed" || progress.status === "failed") {
      return fetchJson(started.result_url);
    }
    await wait(500);
  }
  throw new Error(`scan did not finish: ${started.scan_id}`);
}

function escapePowerShellLiteral(value) {
  return String(value).replaceAll("'", "''");
}

async function createZipFixture() {
  const fixtureDir = await mkdtemp(join(tmpdir(), "portal-local-scan-"));
  const sourceFile = join(fixtureDir, "safe-source.js");
  const archivePath = join(fixtureDir, "safe-source.zip");
  await writeFile(sourceFile, "export const projectName = 'local-scan-fixture';\n", "utf8");
  const script = `Compress-Archive -LiteralPath '${escapePowerShellLiteral(sourceFile)}' -DestinationPath '${escapePowerShellLiteral(archivePath)}' -Force`;
  const child = spawn(powershell, ["-NoProfile", "-Command", script], { windowsHide: true });
  const [code] = await once(child, "close");
  assert.equal(code, 0, "test ZIP fixture must be created");
  return { fixtureDir, sourceFile, archivePath };
}

async function assertPagesLoad() {
  const pages = [
    ["/", "오늘 할 일을 선택하세요"],
    ["/scan", "대상을 선택하고 점검하세요"],
    ["/harness", "코딩 보조 하네스"],
    ["/admin/login", "관리자 로그인"],
    ["/help", "도움말"]
  ];
  for (const [path, marker] of pages) {
    const html = await fetchText(path);
    assert.ok(html.includes(marker), `${path} missing marker: ${marker}`);
  }
}

async function scenarioQuickScan() {
  const result = await startScan("quick", "folder", "src");
  assert.equal(result.status, "completed");
  assert.equal(result.decision, "quick_complete");
  assert.equal(result.summary.scanned_file_count, 1);
  assert.equal(result.summary.finding_count, 0);
  assert.equal(result.summary.profile_fallback, null, "quick scan must not silently fall back from dev-quick");
  assert.equal(result.summary.coverage_truncated, false, "quick scan fixture must stay within the intended file limit");
  assert.equal(result.summary.dependency_incomplete, false, "quick scan fixture must complete the dependency check");
  assert.ok(result.reports.some((report) => /_보안점검(?:_\d+)?\.html$/.test(report.file_name)), "quick scan must use the checker HTML report naming rule");
  assert.ok(result.reports.some((report) => /_보안점검(?:_\d+)?\.md$/.test(report.file_name)), "quick scan must use the checker Markdown report naming rule");
  assert.ok(result.reports.some((report) => /_보안점검(?:_\d+)?\.json$/.test(report.file_name)), "quick scan must save JSON evidence with the checker naming rule");
  return result;
}

async function scenarioLocalRequestBoundary(result) {
  const hostileHost = await rawRequest("/api/local/status", { Host: "evil.example.com" });
  assert.equal(hostileHost.statusCode, 421, "local APIs must reject an untrusted Host header");

  const missingToken = await fetch(`${baseUrl}/api/local/update/preview`, { method: "POST" });
  assert.equal(missingToken.status, 403, "state-changing local APIs must require the portal request token");

  const hostileOrigin = await fetch(`${baseUrl}/api/local/update/preview`, {
    method: "POST",
    headers: localHeaders({ Origin: "https://evil.example.com" })
  });
  assert.equal(hostileOrigin.status, 403, "state-changing local APIs must reject cross-origin requests");

  const trustedOrigin = await fetch(`${baseUrl}/api/local/update/preview`, {
    method: "POST",
    headers: localHeaders({ Origin: baseUrl })
  });
  assert.equal(trustedOrigin.status, 200, "same-origin portal requests with the token must remain available");

  const directAdmin = await fetch(`${baseUrl}/admin.html`, { redirect: "manual" });
  assert.equal(directAdmin.status, 302, "direct administrator HTML must redirect to login without a session");
  assert.equal(directAdmin.headers.get("location"), "/admin/login");

  const koreanReport = result.reports.find((report) => /\p{L}/u.test(report.file_name));
  assert.ok(koreanReport, "checker report output must retain the Korean naming rule");
  const download = await fetch(`${baseUrl}${koreanReport.url}`);
  assert.equal(download.status, 200, "Korean-named reports must be downloadable");
  assert.match(String(download.headers.get("content-disposition")), /filename\*=UTF-8''/, "report download must expose a UTF-8 filename");
}

async function scenarioStandardScan() {
  const result = await startScan("standard", "folder", "src");
  assert.equal(result.status, "completed");
  assert.equal(result.decision, "allow");
  assert.equal(result.summary.profile_fallback, null, "standard scan must not silently fall back from public-default-strict");
  assert.equal(result.summary.coverage_truncated, false, "standard scan fixture must not silently truncate files");
  assert.equal(result.summary.dependency_incomplete, false, "standard scan fixture must complete the dependency check");
  assert.ok(result.reports.some((report) => /_보안점검(?:_\d+)?\.html$/.test(report.file_name)), "standard scan must create an HTML report");
  assert.ok(result.reports.some((report) => /_보안점검(?:_\d+)?\.md$/.test(report.file_name)), "standard scan must create a Markdown report");
  assert.ok(result.reports.some((report) => /_보안점검(?:_\d+)?\.json$/.test(report.file_name)), "standard scan must create JSON evidence");
  return result;
}

async function scenarioLocalFolderAndZip(fixture) {
  const folderPick = await fetchJson("/api/local/pick-target", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "folder" })
  });
  assert.equal(folderPick.status, "selected");
  assert.ok(folderPick.path.endsWith("src"), "folder picker must return the local source folder in test mode");

  const saveDirectoryPick = await fetchJson("/api/local/pick-target", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "save_dir" })
  });
  assert.equal(saveDirectoryPick.status, "selected");
  assert.equal(saveDirectoryPick.path, folderPick.path);

  const archivePick = await fetchJson("/api/local/pick-target", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "archive" })
  });
  assert.equal(archivePick.status, "selected");
  assert.equal(archivePick.path, fixture.archivePath);

  const savedFolder = join(fixture.fixtureDir, "saved-reports");
  await mkdir(savedFolder);
  const localFolder = await startScan("quick", "folder", folderPick.path, savedFolder);
  assert.equal(localFolder.status, "completed");
  assert.ok(localFolder.saved_reports.length >= 2, "local folder scan must copy reports to selected PC folder");
  assert.ok(localFolder.saved_reports.some((report) => /_보안점검(?:_\d+)?\.html$/.test(report.file_name)), "saved report must retain the checker file naming rule");
  assert.equal(localFolder.saved_location_label, "saved-reports", "result must expose only the selected folder label");
  assert.equal("target_ref" in localFolder, false, "local path must not be exposed by the result API");

  const archive = await startScan("quick", "archive", archivePick.path, savedFolder);
  assert.equal(archive.status, "completed");
  assert.equal(archive.summary.scanned_file_count, 1, "ZIP scan must reach the local checker");
  return { localFolder, archive };
}

async function uploadBrowserTarget(kind, files) {
  const form = new FormData();
  form.append("kind", kind);
  form.append("manifest", JSON.stringify(files.map((file) => file.path)));
  for (const [index, file] of files.entries()) {
    form.append(`file_${index}`, new Blob([await readFile(file.source)]), file.name);
  }
  return fetchJson("/api/local/upload-target", { method: "POST", body: form });
}

async function scenarioBrowserSelectedTargets(fixture) {
  const browserFolder = await uploadBrowserTarget("folder", [{
    source: fixture.sourceFile,
    path: "selected-source/safe-source.js",
    name: "safe-source.js"
  }]);
  assert.equal(browserFolder.status, "selected");
  assert.equal(browserFolder.target_type, "browser_folder");
  assert.equal(browserFolder.label, "selected-source", "browser folder selection must preserve the chosen folder name for the user and report name");
  const folderResult = await startScan("quick", browserFolder.target_type, browserFolder.path, "", browserFolder.label);
  assert.equal(folderResult.status, "completed");
  assert.equal(folderResult.summary.scanned_file_count, 1, "browser-selected folder must reach the local checker");
  assert.ok(folderResult.reports.some((report) => report.file_name.includes("_selected-source_보안점검")), "browser-selected folder reports must use the selected folder name, never the temporary upload ID");

  const browserArchive = await uploadBrowserTarget("archive", [{
    source: fixture.archivePath,
    path: "safe-source.zip",
    name: "safe-source.zip"
  }]);
  assert.equal(browserArchive.status, "selected");
  assert.equal(browserArchive.target_type, "browser_archive");
  const archiveResult = await startScan("quick", browserArchive.target_type, browserArchive.path, "", browserArchive.label);
  assert.equal(archiveResult.status, "completed");
  assert.equal(archiveResult.summary.scanned_file_count, 1, "browser-selected ZIP must reach the local checker");
  return { folderResult, archiveResult };
}

async function approvalToken() {
  const issued = await fetchJson("/api/local/approval-token", { method: "POST" });
  assert.ok(issued.approval_token, "the portal must issue a one-time approval token");
  return issued.approval_token;
}

async function scenarioHarnessAndMcp(mcpConfigPath, operationLogPath) {
  const harnessVersion = await fetchJson("/api/local/version-status?target=harness");
  assert.ok(["current", "update_available", "reinstall_required", "check_unavailable", "not_installed"].includes(harnessVersion.status));
  assert.ok(["최신 버전입니다.", "업데이트가 필요합니다.", "설치되어 있지 않습니다."].some((known) => String(harnessVersion.message || "").startsWith(known)) || ["check_unavailable", "reinstall_required"].includes(harnessVersion.status));

  const checkerVersion = await fetchJson("/api/local/version-status?target=checker");
  assert.ok(["current", "update_available", "reinstall_required", "check_unavailable", "not_installed"].includes(checkerVersion.status));

  const status = await fetchJson("/api/local/status");
  assert.equal(status.project_harness.status, "applied");
  assert.equal(status.execution_gate.guard_script, "configured");
  assert.equal(status.execution_gate.pre_commit_hook, "active");

  const installWithoutApproval = await fetch(`${baseUrl}/api/local/component/install`, {
    method: "POST",
    headers: localHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ target: "checker" })
  });
  assert.equal(installWithoutApproval.status, 409, "component install must require explicit user approval");

  const preview = await fetchJson("/api/local/update/preview", { method: "POST" });
  assert.equal(preview.applies_without_approval, false);
  assert.ok(preview.items.some((item) => item.target === "harness" && item.current_version), "harness update preview must include the local version");
  assert.ok(preview.items.some((item) => item.target === "checker" && item.current_version), "checker update preview must include the local version");

  const staleApproval = await fetch(`${baseUrl}/api/local/update/apply`, {
    method: "POST",
    headers: localHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ approval_token: "user-confirmed" })
  });
  assert.equal(staleApproval.status, 409, "fixed or reused approval strings must never authorize an update");

  const apply = await fetchJson("/api/local/update/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approval_token: await approvalToken() })
  });
  assert.equal(apply.status, "blocked", "dirty or non-main checker worktree must block automatic update");
  assert.ok(apply.blocked_targets.includes("checker"), "checker worktree eligibility must be checked before update");

  const mcp = await fetchJson("/api/local/mcp/register", { method: "POST" });
  assert.ok(["already_registered", "needs_user_approval"].includes(mcp.status));
  assert.equal(mcp.applies_without_approval, false);

  const mcpStatuses = await fetchJson("/api/local/mcp/status");
  for (const target of ["codex", "claude-code", "claude-desktop", "lovable"]) {
    assert.ok(mcpStatuses.tools[target], `MCP status must include ${target}`);
    const targetStatus = await fetchJson(`/api/local/mcp/status?target=${target}`);
    assert.equal(targetStatus.target, target, `MCP status must check ${target} independently`);
    assert.equal(targetStatus.connection.status, mcpStatuses.tools[target].status);
  }
  assert.equal(mcpStatuses.tools.lovable.status, "not_supported", "Lovable must be shown as separately unsupported, not registered");

  const mcpRegistration = await fetchJson("/api/local/mcp/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target: "claude-desktop", approval_token: await approvalToken() })
  });
  assert.equal(mcpRegistration.status, "registered", "MCP registration must update only the selected test configuration");
  assert.equal(mcpRegistration.connection.status, "registered");
  assert.ok(mcpRegistration.backup, "MCP registration must back up an existing configuration");
  const registeredConfig = JSON.parse(await readFile(mcpConfigPath, "utf8"));
  assert.equal(registeredConfig.mcpServers?.["vibecode-checker"]?.command, "gvskb-server");
  const operations = (await readFile(operationLogPath, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  assert.ok(operations.some((entry) => entry.action === "mcp_register" && entry.target === "claude-desktop" && entry.status === "registered"), "MCP registration must leave a minimal gate operation log");
  return { status, preview, apply, mcp, mcpStatuses };
}

async function scenarioAdmin(exportDirectory) {
  const withoutToken = await fetch(`${baseUrl}/api/admin/summary`);
  assert.equal(withoutToken.status, 403, "admin APIs must reject requests without the portal request token");

  const unauthorized = await fetch(`${baseUrl}/api/admin/summary`, { headers: localHeaders() });
  assert.equal(unauthorized.status, 401, "admin summary must reject unauthenticated requests");

  const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: localHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ id: adminId, password: adminPassword })
  });
  assert.equal(loginResponse.status, 200, "admin login must accept the configured test account");
  adminCookie = String(loginResponse.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(adminCookie.startsWith("admin_session="), "admin login must issue an HttpOnly session cookie");

  const summary = await fetchJson("/api/admin/summary");
  assert.ok(summary.total >= 2, "admin total should include scenario scans");
  assert.ok(summary.allow >= 1, "admin allow count should include successful standard scans");
  assert.ok(summary.quick_complete >= 1, "admin summary must count completed quick scans separately from standard scans");

  const list = await fetchJson("/api/admin/scans");
  assert.ok(Array.isArray(list.scans));
  assert.ok(list.scans.length >= 2);
  assert.ok(list.scans[0].reports.some((report) => report.url?.startsWith("/reports/")), "admin scan must expose report URL");

  const exported = await fetchJson("/api/admin/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ save_dir: exportDirectory })
  });
  assert.equal(exported.status, "saved", "admin export must save a report");
  assert.equal(exported.saved_location_label, "admin-export", "admin export must expose only the folder label");
  const savedPayload = JSON.parse(await readFile(join(exportDirectory, exported.file_name), "utf8"));
  assert.equal(savedPayload.report_type, "관리자 점검 현황");
  assert.ok(savedPayload.scans.length >= 2, "admin export must include scan metadata");
  return { summary, list, exported };
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

async function startStateFixtureServer(fixtureDir) {
  const port = Number(process.env.PORTAL_STATE_TEST_PORT || 8792);
  const toolsDir = join(fixtureDir, "managed-tools");
  const checkerDir = join(toolsDir, "vibecode-checker");
  const harnessDir = join(toolsDir, "vibe_harness_codex");
  const checkerStatusPath = join(fixtureDir, "checker-status.json");
  await mkdir(checkerDir, { recursive: true });
  await mkdir(harnessDir, { recursive: true });
  for (const directory of [checkerDir, harnessDir]) {
    runGit(["init"], directory);
    runGit(["config", "user.email", "portal-test@example.invalid"], directory);
    runGit(["config", "user.name", "Portal scenario"], directory);
    await writeFile(join(directory, "README.txt"), "fixture\n", "utf8");
    runGit(["add", "."], directory);
    runGit(["commit", "-m", "fixture"], directory);
    runGit(["branch", "-M", "main"], directory);
  }
  runGit(["remote", "add", "origin", "https://github.com/Lex6won/vibecode-checker.git"], checkerDir);
  runGit(["remote", "add", "origin", "https://github.com/Lex6won/vibe_harness_codex.git"], harnessDir);

  const writeCheckerStatus = async (payload) => writeFile(checkerStatusPath, `${JSON.stringify(payload)}\n`, "utf8");
  await writeCheckerStatus({ installed: false });
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      PORTAL_TOOLS_DIR: toolsDir,
      PORTAL_HARNESS_SOURCE_DIR: join(fixtureDir, "no-development-harness"),
      PORTAL_TEST_CHECKER_STATUS_FILE: checkerStatusPath,
      ADMIN_INITIAL_PASSWORD: adminPassword,
      ADMIN_AUTH_FILE: join(fixtureDir, "state-admin.json"),
      PORTAL_SCAN_HISTORY_FILE: join(fixtureDir, "state-scan-history.jsonl"),
      PORTAL_LOCAL_API_TOKEN: localApiToken,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8"
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const fixtureBaseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${fixtureBaseUrl}/health`);
      if (response.ok) break;
    } catch {
      // The local test server is still starting.
    }
    await wait(250);
  }
  const status = async (target) => {
    const response = await fetch(`${fixtureBaseUrl}/api/local/version-status?target=${target}`, { headers: localHeaders() });
    assert.ok(response.ok, `state fixture ${target} version status must respond`);
    return response.json();
  };
  try {
    assert.equal((await status("harness")).status, "update_available", "official harness install must expose only update");
    assert.equal((await status("checker")).status, "not_installed", "no checker install must expose only install");

    const fileUrl = `file:///${checkerDir.replaceAll("\\", "/")}`;
    await writeCheckerStatus({
      schema_version: 1,
      installed: true,
      version: "0.3.0",
      install_identity: { editable: true, install_url: fileUrl },
      runtime_freshness: { process_stale: false }
    });
    assert.equal((await status("checker")).status, "update_available", "official managed checker must expose update when older than GitHub main");

    await writeCheckerStatus({
      schema_version: 1,
      installed: true,
      version: "0.3.0",
      install_identity: { editable: true, install_url: "file:///C:/developer/vibecode-checker" },
      runtime_freshness: { process_stale: false }
    });
    assert.equal((await status("checker")).status, "reinstall_required", "development checker install must expose official reinstallation, never update");

    await writeCheckerStatus({ status: "invalid_contract" });
    assert.equal((await status("checker")).status, "check_unavailable", "an unknown checker status contract must not unlock install or update");
  } finally {
    child.kill();
    await Promise.race([once(child, "exit"), wait(2000)]);
  }
}

const fixture = await createZipFixture();
const adminExportDirectory = join(fixture.fixtureDir, "admin-export");
const mcpConfigPath = join(fixture.fixtureDir, "claude_desktop_config.json");
const operationLogPath = join(fixture.fixtureDir, "gate-operation-log.jsonl");
await mkdir(adminExportDirectory);
await writeFile(mcpConfigPath, `${JSON.stringify({ mcpServers: { fixture: { command: "fixture-command" } } }, null, 2)}\n`, "utf8");
const child = spawn(process.execPath, ["src/server.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    ADMIN_ID: adminId,
    ADMIN_INITIAL_PASSWORD: adminPassword,
    ADMIN_AUTH_FILE: join(process.env.TEMP || process.env.TMP || ".", "vibecode-portal-scenario-admin-auth.json"),
    PORTAL_TEST_PICK_PATH: join(process.cwd(), "src"),
    PORTAL_TEST_ARCHIVE_PATH: fixture.archivePath,
    PORTAL_TEST_CLAUDE_DESKTOP_CONFIG: mcpConfigPath,
    PORTAL_OPERATION_LOG_FILE: operationLogPath,
    PORTAL_SCAN_HISTORY_FILE: join(fixture.fixtureDir, "scan-history.jsonl"),
    PORTAL_LOCAL_API_TOKEN: localApiToken,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8"
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

try {
  await waitForServer(child);
  await assertPagesLoad();
  const quick = await scenarioQuickScan();
  await scenarioLocalRequestBoundary(quick);
  const standard = await scenarioStandardScan();
  const localTargets = await scenarioLocalFolderAndZip(fixture);
  const browserTargets = await scenarioBrowserSelectedTargets(fixture);
  await scenarioHarnessAndMcp(mcpConfigPath, operationLogPath);
  await scenarioAdmin(adminExportDirectory);
  await startStateFixtureServer(fixture.fixtureDir);
  console.log(JSON.stringify({
    status: "passed",
    base_url: baseUrl,
    scenarios: {
      pages_loaded: true,
      quick_scan: quick.id,
      standard_scan: standard.id,
    local_folder_scan: localTargets.localFolder.id,
    zip_scan: localTargets.archive.id,
    browser_folder_scan: browserTargets.folderResult.id,
    browser_zip_scan: browserTargets.archiveResult.id,
      harness_mcp: true,
      admin: true,
      installation_state_matrix: true
    }
  }, null, 2));
} catch (error) {
  console.error(stdout);
  console.error(stderr);
  console.error(error);
  process.exitCode = 1;
} finally {
  child.kill();
  await Promise.race([once(child, "exit"), wait(2000)]);
  await rm(fixture.fixtureDir, { recursive: true, force: true });
}
