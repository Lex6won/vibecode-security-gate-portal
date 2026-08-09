#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = Number(process.env.PORTAL_TEST_PORT || 8791);
const baseUrl = `http://127.0.0.1:${port}`;
const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
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
  const response = await fetch(`${baseUrl}${path}`);
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

async function startScan(scanMode, targetType, targetRef, saveDir = "") {
  const started = await fetchJson("/api/scan/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scan_mode: scanMode, target_type: targetType, target_ref: targetRef, save_dir: saveDir })
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
  return { fixtureDir, archivePath };
}

async function assertPagesLoad() {
  const pages = [
    ["/", "오늘 할 일을 선택하세요"],
    ["/scan", "대상을 선택하고 점검하세요"],
    ["/harness", "하네스 설치"],
    ["/admin/login", "관리자 로그인"],
    ["/admin", "사용 현황과 점검 결과"],
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
  assert.equal(result.decision, "allow");
  assert.equal(result.summary.scanned_file_count, 1);
  assert.equal(result.summary.finding_count, 0);
  assert.ok(result.reports.some((report) => report.file_name.endsWith("-report.html")), "quick scan must create HTML report");
  return result;
}

async function scenarioStandardSubmission() {
  const result = await startScan("submission", "folder", "src");
  assert.equal(result.status, "completed");
  assert.equal(result.decision, "allow");
  assert.ok(result.reports.some((report) => report.file_name.endsWith("-submission.zip")), "submission scan must create ZIP");
  assert.ok(result.reports.some((report) => report.file_name.endsWith("-report.md")), "submission scan must create Markdown report");
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
  assert.equal(localFolder.saved_location_label, "saved-reports", "result must expose only the selected folder label");
  assert.equal("target_ref" in localFolder, false, "local path must not be exposed by the result API");

  const archive = await startScan("quick", "archive", archivePick.path, savedFolder);
  assert.equal(archive.status, "completed");
  assert.equal(archive.summary.scanned_file_count, 1, "ZIP scan must reach the local checker");
  return { localFolder, archive };
}

async function scenarioHarnessAndMcp() {
  const status = await fetchJson("/api/local/status");
  assert.equal(status.project_harness.status, "applied");
  assert.equal(status.execution_gate.guard_script, "configured");
  assert.equal(status.execution_gate.pre_commit_hook, "active");

  const preview = await fetchJson("/api/local/update/preview", { method: "POST" });
  assert.equal(preview.applies_without_approval, false);
  assert.ok(preview.items.some((item) => item.target === "harness" && item.current_version), "harness update preview must include the local version");
  assert.ok(preview.items.some((item) => item.target === "checker" && item.current_version), "checker update preview must include the local version");

  const apply = await fetchJson("/api/local/update/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approval_token: "user-confirmed" })
  });
  assert.equal(apply.status, "blocked", "dirty or non-main checker worktree must block automatic update");
  assert.ok(apply.blocked_targets.includes("checker"), "checker worktree eligibility must be checked before update");

  const mcp = await fetchJson("/api/local/mcp/register", { method: "POST" });
  assert.ok(["already_registered", "needs_user_approval"].includes(mcp.status));
  assert.equal(mcp.applies_without_approval, false);
  return { status, preview, apply, mcp };
}

async function scenarioAdmin() {
  const summary = await fetchJson("/api/admin/summary");
  assert.ok(summary.total >= 2, "admin total should include scenario scans");
  assert.ok(summary.allow >= 2, "admin allow count should include successful scans");

  const list = await fetchJson("/api/admin/scans");
  assert.ok(Array.isArray(list.scans));
  assert.ok(list.scans.length >= 2);
  assert.ok(list.scans[0].reports.some((report) => report.url?.startsWith("/reports/")), "admin scan must expose report URL");
  return { summary, list };
}

const fixture = await createZipFixture();
const child = spawn(process.execPath, ["src/server.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    PORTAL_TEST_PICK_PATH: join(process.cwd(), "src"),
    PORTAL_TEST_ARCHIVE_PATH: fixture.archivePath,
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
  const submission = await scenarioStandardSubmission();
  const localTargets = await scenarioLocalFolderAndZip(fixture);
  await scenarioHarnessAndMcp();
  await scenarioAdmin();
  console.log(JSON.stringify({
    status: "passed",
    base_url: baseUrl,
    scenarios: {
      pages_loaded: true,
      quick_scan: quick.id,
      submission_scan: submission.id,
      local_folder_scan: localTargets.localFolder.id,
      zip_scan: localTargets.archive.id,
      harness_mcp: true,
      admin: true
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
