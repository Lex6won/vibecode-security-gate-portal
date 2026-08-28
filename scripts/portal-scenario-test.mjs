#!/usr/bin/env node
// 서버 기반 포털(S1 이후)의 사용자 시나리오 검증.
// 입력은 업로드(browser_folder/browser_archive)와 GitHub URL뿐이다.
// 로컬 픽커·로컬 절대경로·save_dir·설치/MCP 라우트는 제거됐음을 함께 검증한다.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
let userCookie = "";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cookieHeader(extra = "") {
  return [userCookie, adminCookie, extra].filter(Boolean).join("; ");
}

function localHeaders(headers, extraCookie = "") {
  const merged = new Headers(headers || {});
  merged.set("X-VibeCode-Local-Token", localApiToken);
  const cookies = cookieHeader(extraCookie);
  if (cookies) merged.set("cookie", cookies);
  return merged;
}

// P3: 매직링크 가입 — 개발 모드가 돌려준 링크를 그대로 열어 세션 쿠키를 받는다.
async function signupOn(base, email, organization, department) {
  const tokenHeaders = new Headers({ "Content-Type": "application/json" });
  tokenHeaders.set("X-VibeCode-Local-Token", localApiToken);
  const requested = await fetch(`${base}/api/auth/request-link`, {
    method: "POST",
    headers: tokenHeaders,
    body: JSON.stringify({ email, organization, department })
  });
  assert.equal(requested.status, 200, `signup link request failed for ${email}`);
  const result = await requested.json();
  assert.ok(result.dev_login_url, "dev mode must return the login link in the response");
  const complete = await fetch(`${base}${result.dev_login_url}`, { redirect: "manual" });
  assert.equal(complete.status, 302, "login completion must redirect back to the scan page");
  const cookie = String(complete.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(cookie.startsWith("portal_session="), "login completion must issue a session cookie");
  return cookie;
}

function withUser(cookie, headers) {
  const merged = new Headers(headers || {});
  merged.set("X-VibeCode-Local-Token", localApiToken);
  merged.set("cookie", cookie);
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
  const cookies = cookieHeader();
  if (cookies) headers.set("cookie", cookies);
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

async function startScan(scanMode, targetType, targetRef, targetLabel = "") {
  const started = await fetchJson("/api/scan/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scan_mode: scanMode, target_type: targetType, target_ref: targetRef, target_label: targetLabel })
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

async function uploadBrowserTarget(kind, files) {
  const form = new FormData();
  form.append("kind", kind);
  form.append("manifest", JSON.stringify(files.map((file) => file.path)));
  for (const [index, file] of files.entries()) {
    form.append(`file_${index}`, new Blob([await readFile(file.source)]), file.name);
  }
  return fetchJson("/api/local/upload-target", { method: "POST", body: form });
}

async function uploadFixtureFolder(fixture, rootName) {
  const uploaded = await uploadBrowserTarget("folder", [{
    source: fixture.sourceFile,
    path: `${rootName}/safe-source.js`,
    name: "safe-source.js"
  }]);
  assert.equal(uploaded.status, "selected");
  assert.equal(uploaded.target_type, "browser_folder");
  return uploaded;
}

async function assertPagesLoad() {
  const pages = [
    ["/", "AI로 만든 코드, 제출 전에 보안 점검부터"],
    ["/scan", "3단계로 소스를 점검하세요."],
    ["/my", "내 점검 이력"],
    ["/harness", "하네스 내려받기"],
    ["/tools", "하네스 내려받기"],
    ["/admin/login", "관리자 로그인"],
    ["/help", "도움말"]
  ];
  for (const [path, marker] of pages) {
    const html = await fetchText(path);
    assert.ok(html.includes(marker), `${path} missing marker: ${marker}`);
  }
}

async function scenarioQuickScan(fixture) {
  const uploaded = await uploadFixtureFolder(fixture, "quick-fixture");
  const result = await startScan("quick", uploaded.target_type, uploaded.path, uploaded.label);
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
  const hostileHost = await rawRequest("/api/tools/versions", { Host: "evil.example.com" });
  assert.equal(hostileHost.statusCode, 421, "APIs must reject an untrusted Host header");

  const missingToken = await fetch(`${baseUrl}/api/local/upload-target`, { method: "POST" });
  assert.equal(missingToken.status, 403, "state-changing APIs must require the portal request token");

  const hostileOrigin = await fetch(`${baseUrl}/api/local/upload-target`, {
    method: "POST",
    headers: localHeaders({ Origin: "https://evil.example.com" })
  });
  assert.equal(hostileOrigin.status, 403, "state-changing APIs must reject cross-origin requests");

  // 경계를 통과한 요청은 본문 검증까지 도달한다(빈 본문이므로 400).
  const trustedOrigin = await fetch(`${baseUrl}/api/local/upload-target`, {
    method: "POST",
    headers: localHeaders({ Origin: baseUrl })
  });
  assert.equal(trustedOrigin.status, 400, "same-origin portal requests with the token must reach body validation");

  const directAdmin = await fetch(`${baseUrl}/admin.html`, { redirect: "manual" });
  assert.equal(directAdmin.status, 302, "direct administrator HTML must redirect to login without a session");
  assert.equal(directAdmin.headers.get("location"), "/admin/login");

  const koreanReport = result.reports.find((report) => /\p{L}/u.test(report.file_name));
  assert.ok(koreanReport, "checker report output must retain the Korean naming rule");
  const download = await fetch(`${baseUrl}${koreanReport.url}`, { headers: localHeaders() });
  assert.equal(download.status, 200, "Korean-named reports must be downloadable");
  assert.match(String(download.headers.get("content-disposition")), /filename\*=UTF-8''/, "report download must expose a UTF-8 filename");
}

async function scenarioStandardScan(fixture) {
  const uploaded = await uploadFixtureFolder(fixture, "standard-fixture");
  const result = await startScan("standard", uploaded.target_type, uploaded.path, uploaded.label);
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

// S1: 로컬 픽커·로컬 절대경로 검사가 실제로 제거됐는지 못박는다.
async function scenarioRemovedLocalSurfaces() {
  const picker = await fetch(`${baseUrl}/api/local/pick-target`, {
    method: "POST",
    headers: localHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ kind: "folder" })
  });
  assert.equal(picker.status, 404, "native picker route must be gone on the server");

  for (const removedType of ["folder", "archive"]) {
    const rejected = await fetch(`${baseUrl}/api/scan/start`, {
      method: "POST",
      headers: localHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ scan_mode: "quick", target_type: removedType, target_ref: "src" })
    });
    assert.equal(rejected.status, 400, `local path target_type '${removedType}' must be rejected`);
  }

  // 업로드 영역 밖의 서버 경로를 업로드 대상인 척 넘기면 검사가 시작되지 않아야 한다.
  const escaped = await startScan("quick", "browser_folder", "src");
  assert.equal(escaped.status, "failed", "server paths outside the upload area must never be scanned");
  assert.ok(!("target_ref" in escaped), "result must not echo the requested path");

  for (const removedRoute of [
    "/api/local/status",
    "/api/local/version-status?target=checker",
    "/api/local/mcp/status"
  ]) {
    const response = await fetch(`${baseUrl}${removedRoute}`, { headers: localHeaders() });
    assert.equal(response.status, 404, `${removedRoute} must be migrated to the tool manager`);
  }
}

// P3 전환: 관측 축적은 완료 시 자동이다. 수동 제출 라우트는 제거됐다.
async function scenarioAutoObservations(fixture) {
  const packageJsonPath = join(fixture.fixtureDir, "package.json");
  await writeFile(packageJsonPath, `${JSON.stringify({ name: "obs-fixture", version: "1.0.0", dependencies: { busboy: "1.6.0" } }, null, 2)}\n`, "utf8");
  const uploaded = await uploadBrowserTarget("folder", [
    { source: fixture.sourceFile, path: "obs-fixture/safe-source.js", name: "safe-source.js" },
    { source: packageJsonPath, path: "obs-fixture/package.json", name: "package.json" }
  ]);
  const result = await startScan("quick", uploaded.target_type, uploaded.path, uploaded.label);
  assert.equal(result.status, "completed");
  assert.ok(result.observations_submitted_at, "completed scans must record observations automatically");

  const removedRoute = await fetch(`${baseUrl}/api/scan/${result.id}/submit-observations`, { method: "POST", headers: localHeaders() });
  assert.equal(removedRoute.status, 404, "the manual submission route must be gone after the auto-recording switch");
  return result;
}

// P3: 계정 경계 — 도메인 제한, 가입 필수 정보, 로그인 없는 접근 차단, 남의 결과 404.
async function scenarioAuthAndOwnership(existingResult) {
  const foreignDomain = await fetch(`${baseUrl}/api/auth/request-link`, {
    method: "POST",
    headers: withUser("", { "Content-Type": "application/json" }),
    body: JSON.stringify({ email: "attacker@gmail.com", organization: "x", department: "y" })
  });
  assert.equal(foreignDomain.status, 400, "non-institution email domains must be rejected");
  assert.equal((await foreignDomain.json()).error, "email_domain_not_allowed");

  const missingProfile = await fetch(`${baseUrl}/api/auth/request-link`, {
    method: "POST",
    headers: withUser("", { "Content-Type": "application/json" }),
    body: JSON.stringify({ email: "newuser@gg.go.kr" })
  });
  assert.equal(missingProfile.status, 400, "first registration must require organization and department");
  assert.equal((await missingProfile.json()).error, "registration_required");

  const anonymousScan = await fetch(`${baseUrl}/api/scan/start`, {
    method: "POST",
    headers: withUser("", { "Content-Type": "application/json" }),
    body: JSON.stringify({ scan_mode: "quick", target_type: "github_url", target_ref: "https://github.com/x/y" })
  });
  assert.equal(anonymousScan.status, 401, "scans must require a logged-in user");

  const anonymousResult = await fetch(`${baseUrl}/api/scan/${existingResult.id}/result`, { headers: withUser("") });
  assert.equal(anonymousResult.status, 404, "results must not exist for anonymous callers");

  // 다른 계정: 남의 결과·보고서·이력이 모두 보이지 않아야 한다.
  const otherCookie = await signupOn(baseUrl, "other@korea.kr", "타기관", "타부서");
  const foreignResult = await fetch(`${baseUrl}/api/scan/${existingResult.id}/result`, { headers: withUser(otherCookie) });
  assert.equal(foreignResult.status, 404, "another user's scan result must return 404");
  const reportUrl = existingResult.reports?.[0]?.url;
  assert.ok(reportUrl, "fixture scan must have a report to test");
  const foreignReport = await fetch(`${baseUrl}${reportUrl}`, { headers: withUser(otherCookie) });
  assert.equal(foreignReport.status, 404, "another user's report file must return 404");
  const otherHistory = await (await fetch(`${baseUrl}/api/my/scans`, { headers: withUser(otherCookie) })).json();
  assert.equal(otherHistory.scans.length, 0, "my history must contain only the caller's scans");

  // 본인: 이력 조회와 보고서 다운로드가 된다.
  const myHistory = await fetchJson("/api/my/scans");
  assert.ok(myHistory.scans.some((scan) => scan.id === existingResult.id), "owner must see the scan in my history");
  const ownReport = await fetch(`${baseUrl}${reportUrl}`, { headers: localHeaders() });
  assert.equal(ownReport.status, 200, "owner must download own reports");

  // 프로필 수정 — 기관·부서는 언제든 바꿀 수 있고, 기존 점검의 스냅샷은 불변이다.
  const profileUpdated = await fetchJson("/api/auth/profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organization: "경기도청", department: "변경된부서" })
  });
  assert.equal(profileUpdated.status, "updated");
  const afterProfile = await fetchJson(`/api/scan/${existingResult.id}/result`);
  assert.notEqual(afterProfile.owner_department, "변경된부서", "scan-time department snapshot must not change with the profile");
}

// P3: 보안성검토 요청 — 완료된 본인 점검만, 중복 불가, 이력에 상태 표시.
async function scenarioReviewRequest(result) {
  const requested = await fetchJson(`/api/scan/${result.id}/request-review`, { method: "POST" });
  assert.equal(requested.status, "requested");
  const duplicate = await fetch(`${baseUrl}/api/scan/${result.id}/request-review`, { method: "POST", headers: localHeaders() });
  assert.equal(duplicate.status, 409, "duplicate review requests must be rejected");
  const history = await fetchJson("/api/my/scans");
  const entry = history.scans.find((scan) => scan.id === result.id);
  assert.equal(entry?.review_request?.status, "requested", "my history must show the review request status");
}

// S2: 동시 상한 1인 별도 서버에서 큐 순번과 워터마크 접수 중단을 검증한다.
async function scenarioQueueAndCapacity(fixture) {
  const queuePort = Number(process.env.PORTAL_QUEUE_TEST_PORT || 8794);
  const queueBase = `http://127.0.0.1:${queuePort}`;
  const spawnServer = (extraEnv) => spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(queuePort),
      ADMIN_INITIAL_PASSWORD: adminPassword,
      ADMIN_AUTH_FILE: join(fixture.fixtureDir, "queue-admin.json"),
      PORTAL_SCAN_HISTORY_FILE: join(fixture.fixtureDir, "queue-history.jsonl"),
      PORTAL_OBSERVATION_DIR: join(fixture.fixtureDir, "queue-observations"),
      PORTAL_ACCOUNT_DIR: join(fixture.fixtureDir, "queue-accounts"),
      PORTAL_LOCAL_API_TOKEN: localApiToken,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      ...extraEnv
    },
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true
  });
  const request = async (path, options, cookie = "") => {
    const headers = localHeaders(options?.headers, cookie);
    if (cookie) headers.set("cookie", cookie);
    return fetch(`${queueBase}${path}`, { ...options, headers });
  };
  const waitReady = async (server) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (server.exitCode !== null) throw new Error("queue test server died");
      try {
        const health = await fetch(`${queueBase}/health`);
        if (health.ok) return;
      } catch {
        await wait(250);
      }
    }
    throw new Error("queue test server not ready");
  };
  const startBody = (label) => JSON.stringify({
    scan_mode: "quick", target_type: "github_url",
    target_ref: `https://github.com/Lex6won/${label}`, target_label: label
  });

  // 1) 동시 상한 1 + 사용자당 1건: 같은 사용자는 409, 다른 사용자는 대기열에 선다.
  const limited = spawnServer({ PORTAL_MAX_CONCURRENT_SCANS: "1" });
  try {
    await waitReady(limited);
    const cookieA = await signupOn(queueBase, "queue-a@gg.go.kr", "경기도청", "테스트과");
    const cookieB = await signupOn(queueBase, "queue-b@korea.kr", "타기관", "테스트과");
    const first = await (await request("/api/scan/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: startBody("queue-a") }, cookieA)).json();
    assert.ok(first.scan_id, "first scan must be accepted");
    const sameUser = await request("/api/scan/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: startBody("queue-a2") }, cookieA);
    assert.equal(sameUser.status, 409, "a user must not run two scans at once");
    assert.equal((await sameUser.json()).error, "user_scan_limit");
    const second = await (await request("/api/scan/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: startBody("queue-b") }, cookieB)).json();
    assert.equal(second.status, "queued", "another user's scan must wait when the concurrency limit is 1");
    assert.equal(second.queue_position, 1, "queued scan must expose its position");
    const progress = await (await request(`/api/scan/${second.scan_id}/progress`, {}, cookieB)).json();
    assert.ok(String(progress.message || "").includes("창을 닫으셔도"), "queued progress must tell users they can close the window");
  } finally {
    limited.kill();
    await Promise.race([once(limited, "exit"), wait(2000)]);
  }

  // 2) 디스크 워터마크: 로그인해도 여유가 부족하면 접수 자체가 503으로 막힌다.
  const exhausted = spawnServer({ PORTAL_MIN_FREE_DISK_BYTES: "999999999999999" });
  try {
    await waitReady(exhausted);
    const cookieFull = await signupOn(queueBase, "full-disk@gg.go.kr", "경기도청", "테스트과");
    const rejectedScan = await request("/api/scan/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: startBody("full-disk") }, cookieFull);
    assert.equal(rejectedScan.status, 503, "scan intake must stop when disk capacity is low");
    const rejectedUpload = await request("/api/local/upload-target", { method: "POST" }, cookieFull);
    assert.equal(rejectedUpload.status, 503, "upload intake must stop when disk capacity is low");
    const body = await rejectedScan.json();
    assert.equal(body.error, "capacity_exhausted");
  } finally {
    exhausted.kill();
    await Promise.race([once(exhausted, "exit"), wait(2000)]);
  }
}

// 서버 프로파일: 허용 호스트는 설정(PORTAL_ALLOWED_HOSTS)으로만 열리고,
// 설정이 없으면 기본값(로컬 전용)이 그대로 유지되어야 한다.
async function scenarioHostAllowlist(fixture) {
  // 1) 기본 서버(허용목록 미설정): 외부 호스트명은 거부된다.
  const defaultDenied = await rawRequest("/", { host: "portal.test.gg" });
  assert.equal(defaultDenied.statusCode, 421, "unknown Host must stay rejected when no allowlist is configured");

  const hostPort = Number(process.env.PORTAL_HOST_TEST_PORT || 8795);
  const server = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(hostPort),
      ADMIN_INITIAL_PASSWORD: adminPassword,
      ADMIN_AUTH_FILE: join(fixture.fixtureDir, "host-admin.json"),
      PORTAL_SCAN_HISTORY_FILE: join(fixture.fixtureDir, "host-history.jsonl"),
      PORTAL_OBSERVATION_DIR: join(fixture.fixtureDir, "host-observations"),
      PORTAL_ACCOUNT_DIR: join(fixture.fixtureDir, "host-accounts"),
      PORTAL_LOCAL_API_TOKEN: localApiToken,
      PORTAL_ALLOWED_HOSTS: "portal.test.gg",
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8"
    },
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true
  });
  const requestWithHost = (headers) => new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest({ host: "127.0.0.1", port: hostPort, path: "/", headers }, (response) => {
      response.resume();
      response.on("end", () => resolveRequest(response));
    });
    request.once("error", rejectRequest);
    request.end();
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
      if (server.exitCode !== null) throw new Error("host allowlist test server died");
      try {
        const health = await fetch(`http://127.0.0.1:${hostPort}/health`);
        ready = health.ok;
      } catch {
        await wait(250);
      }
    }
    assert.ok(ready, "host allowlist test server did not become ready");

    const allowed = await requestWithHost({ host: "portal.test.gg" });
    assert.equal(allowed.statusCode, 200, "a configured host must be accepted");
    const denied = await requestWithHost({ host: "evil.example.com" });
    assert.equal(denied.statusCode, 421, "hosts outside the allowlist must stay rejected");
    const httpsOrigin = await requestWithHost({ host: "portal.test.gg", origin: "https://portal.test.gg" });
    assert.equal(httpsOrigin.statusCode, 200, "an https origin for an allowed host must pass (tunnel/reverse-proxy)");
    const foreignOrigin = await requestWithHost({ host: "portal.test.gg", origin: "https://evil.example.com" });
    assert.equal(foreignOrigin.statusCode, 403, "foreign origins must stay rejected");
  } finally {
    server.kill();
    await Promise.race([once(server, "exit"), wait(2000)]);
  }
}

async function scenarioToolsSurface() {
  const versions = await fetchJson("/api/tools/versions");
  assert.equal(versions.checker.installed, true, "the server checker must be installed for the portal to be useful");
  assert.ok(String(versions.checker.version || "").includes("gvskb"), "server checker version must be reported");
  assert.ok(["ok", "warn", "error"].includes(versions.checker.doctor_status));
  assert.ok(versions.note.includes("도구 관리자"), "the response must say PC tool state belongs to the tool manager");
}

async function scenarioAdmin() {
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
  assert.ok(summary.observations?.observed_packages >= 1, "admin summary must expose accumulated package observations");
  assert.ok(summary.observations?.submitted_scan_count >= 1, "admin summary must count observation submissions");
  assert.ok(summary.accounts?.total_accounts >= 2, "admin summary must count registered accounts");
  assert.ok(summary.pending_review_requests >= 1, "admin summary must count pending review requests");

  const reviewQueue = await fetchJson("/api/admin/review-requests");
  assert.ok(reviewQueue.requests.some((item) => item.owner_email === "tester@gg.go.kr" && item.status === "requested"),
    "admin review queue must list the requester and status");
  assert.ok(summary.allow >= 1, "admin allow count should include successful standard scans");
  assert.ok(summary.quick_complete >= 1, "admin summary must count completed quick scans separately from standard scans");

  const list = await fetchJson("/api/admin/scans");
  assert.ok(Array.isArray(list.scans));
  assert.ok(list.scans.length >= 2);
  assert.ok(list.scans.some((scan) => scan.reports?.some((report) => report.url?.startsWith("/reports/"))), "admin scan must expose report URL");

  // S1: 내보내기는 서버 폴더 저장이 아니라 다운로드다.
  const exportResponse = await fetch(`${baseUrl}/api/admin/export`, { headers: localHeaders({ cookie: adminCookie }) });
  assert.equal(exportResponse.status, 200, "admin export must be downloadable");
  assert.match(String(exportResponse.headers.get("content-disposition")), /attachment/, "admin export must be an attachment");
  const exported = JSON.parse(await exportResponse.text());
  assert.equal(exported.report_type, "관리자 점검 현황");
  assert.ok(exported.scans.length >= 2, "admin export must include scan metadata");
  return { summary, list, exported };
}

const fixture = await createZipFixture();
const child = spawn(process.execPath, ["src/server.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port),
    ADMIN_ID: adminId,
    ADMIN_INITIAL_PASSWORD: adminPassword,
    ADMIN_AUTH_FILE: join(process.env.TEMP || process.env.TMP || ".", "vibecode-portal-scenario-admin-auth.json"),
    PORTAL_SCAN_HISTORY_FILE: join(fixture.fixtureDir, "scan-history.jsonl"),
    PORTAL_OBSERVATION_DIR: join(fixture.fixtureDir, "observations"),
    PORTAL_ACCOUNT_DIR: join(fixture.fixtureDir, "accounts"),
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
  // P3: 모든 점검 흐름은 로그인 뒤에만 가능하다 — 매직링크 가입으로 시작한다.
  userCookie = await signupOn(baseUrl, "tester@gg.go.kr", "경기도청", "AI산업육성과");
  await assertPagesLoad();
  const quick = await scenarioQuickScan(fixture);
  await scenarioLocalRequestBoundary(quick);
  const standard = await scenarioStandardScan(fixture);
  await scenarioRemovedLocalSurfaces();

  const browserArchive = await uploadBrowserTarget("archive", [{
    source: fixture.archivePath,
    path: "safe-source.zip",
    name: "safe-source.zip"
  }]);
  assert.equal(browserArchive.target_type, "browser_archive");
  const archiveResult = await startScan("quick", browserArchive.target_type, browserArchive.path, browserArchive.label);
  assert.equal(archiveResult.status, "completed");
  assert.equal(archiveResult.summary.scanned_file_count, 1, "uploaded ZIP must reach the checker");

  const observation = await scenarioAutoObservations(fixture);
  await scenarioAuthAndOwnership(quick);
  await scenarioReviewRequest(observation);
  await scenarioToolsSurface();
  await scenarioAdmin();
  await scenarioQueueAndCapacity(fixture);
  await scenarioHostAllowlist(fixture);
  console.log(JSON.stringify({
    status: "passed",
    base_url: baseUrl,
    scenarios: {
      pages_loaded: true,
      quick_scan: quick.id,
      standard_scan: standard.id,
      uploaded_zip_scan: archiveResult.id,
      auto_observations: observation.id,
      auth_and_ownership: true,
      review_request: true,
      removed_local_surfaces: true,
      tools_surface: true,
      admin: true,
      queue_and_capacity: true,
      host_allowlist: true
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
