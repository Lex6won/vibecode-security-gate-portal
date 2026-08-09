#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

const port = Number(process.env.PORTAL_TEST_PORT || 8791);
const baseUrl = `http://127.0.0.1:${port}`;

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

async function startScan(scanMode, targetType, targetRef) {
  const started = await fetchJson("/api/scan/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scan_mode: scanMode, target_type: targetType, target_ref: targetRef })
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

async function assertPagesLoad() {
  const pages = [
    ["/", "오늘 할 일을 선택하세요"],
    ["/scan", "대상을 선택하고 점검하세요"],
    ["/harness", "설치할 하네스를 선택하세요"],
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

async function scenarioHarnessAndMcp() {
  const status = await fetchJson("/api/local/status");
  assert.equal(status.project_harness.status, "applied");
  assert.equal(status.execution_gate.guard_script, "configured");
  assert.equal(status.execution_gate.pre_commit_hook, "active");

  const preview = await fetchJson("/api/local/update/preview", { method: "POST" });
  assert.equal(preview.applies_without_approval, false);

  const mcp = await fetchJson("/api/local/mcp/register", { method: "POST" });
  assert.ok(["already_registered", "needs_user_approval"].includes(mcp.status));
  assert.equal(mcp.applies_without_approval, false);
  return { status, preview, mcp };
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

const child = spawn(process.execPath, ["src/server.js"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
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
  await scenarioHarnessAndMcp();
  await scenarioAdmin();
  console.log(JSON.stringify({
    status: "passed",
    base_url: baseUrl,
    scenarios: {
      pages_loaded: true,
      quick_scan: quick.id,
      submission_scan: submission.id,
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
}
