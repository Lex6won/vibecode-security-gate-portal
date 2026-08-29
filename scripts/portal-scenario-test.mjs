#!/usr/bin/env node
// 서버 기반 포털(S1 이후)의 사용자 시나리오 검증.
// 입력은 업로드(browser_folder/browser_archive)와 GitHub URL뿐이다.
// 로컬 픽커·로컬 절대경로·save_dir·설치/MCP 라우트는 제거됐음을 함께 검증한다.
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readZipEntries } from "../src/hwpx-template.mjs";

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

function koreaDateKey(value = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
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
    ["/scan", "저장 위치와 검사 대상을 준비하세요."],
    ["/my", "내 점검 이력"],
    ["/harness", "하네스 내려받기"],
    ["/tools", "하네스 내려받기"],
    ["/admin/login", "관리자 로그인"]
  ];
  for (const [path, marker] of pages) {
    const html = await fetchText(path);
    assert.ok(html.includes(marker), `${path} missing marker: ${marker}`);
  }
}

async function scenarioQuickScan(fixture) {
  const uploaded = await uploadFixtureFolder(fixture, "quick-fixture");
  // 라벨에 공백을 섞는다 — 보고서 파일명·다운로드가 실사용 라벨(공백 포함)에서 깨졌던 회귀(2026-08-28).
  const result = await startScan("quick", uploaded.target_type, uploaded.path, "민원 조회 도구");
  assert.equal(result.status, "completed");
  assert.equal(result.decision, "quick_complete");
  assert.equal(result.summary.scanned_file_count, 1);
  assert.equal(result.summary.finding_count, 0);
  assert.equal(result.summary.profile_fallback, null, "quick scan must not silently fall back from dev-quick");
  assert.equal(result.summary.coverage_truncated, false, "quick scan fixture must stay within the intended file limit");
  assert.equal(result.summary.dependency_incomplete, false, "quick scan fixture must complete the dependency check");
  assert.equal(result.report_render_error, null, "completed scans must make the user-facing HTML report available");
  const reportNamePattern = /^민원 조회 도구_\d{4}-\d{2}-\d{2}_\d{4}_간편점검(?:_\d+)?\.(?:html|md|json)$/;
  assert.ok(result.artifacts.some((report) => reportNamePattern.test(report.file_name) && report.file_name.endsWith(".html")),
    "quick scan HTML report names must include the target name and Korean scan date");
  assert.ok(result.artifacts.some((report) => reportNamePattern.test(report.file_name) && report.file_name.endsWith(".md")),
    "quick scan Markdown report names must include the target name and Korean scan date");
  assert.ok(result.artifacts.some((report) => reportNamePattern.test(report.file_name) && report.file_name.endsWith(".json")),
    "quick scan JSON evidence names must include the target name and Korean scan date");
  // P5: 원본 미보관·보존기한 사실이 응답에 실린다.
  assert.equal(result.source_retained, false, "results must state that uploaded source is not retained");
  assert.ok(Number.isFinite(result.report_retention_days) && result.report_retention_days > 0, "results must state the report retention period");
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

  const koreanReport = result.artifacts.find((report) => /\p{L}/u.test(report.file_name));
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
  assert.equal(result.report_render_error, null, "standard scans must make the user-facing HTML report available");
  assert.ok(result.artifacts.every((report) => /^standard-fixture_\d{4}-\d{2}-\d{2}_\d{4}_표준점검(?:_\d+)?\./.test(report.file_name)),
    "standard scan report names must include the selected folder name and Korean scan date");
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

// 제출 전에는 산출물을 임시 보관하고, 관측 적재와 90일 보관은 검토 제출 시점에만 한다.
async function scenarioAutoObservations(fixture) {
  const packageJsonPath = join(fixture.fixtureDir, "package.json");
  await writeFile(packageJsonPath, `${JSON.stringify({ name: "obs-fixture", version: "1.0.0", dependencies: { busboy: "1.6.0" } }, null, 2)}\n`, "utf8");
  const uploaded = await uploadBrowserTarget("folder", [
    { source: fixture.sourceFile, path: "obs-fixture/safe-source.js", name: "safe-source.js" },
    { source: packageJsonPath, path: "obs-fixture/package.json", name: "package.json" }
  ]);
  const result = await startScan("quick", uploaded.target_type, uploaded.path, uploaded.label);
  assert.equal(result.status, "completed");
  assert.equal(result.observations_submitted_at, null, "completed scans must not record package observations before review submission");
  assert.equal(result.artifact_storage, "temporary", "completed scans must expose temporary artifacts before submission");
  assert.equal(result.reports.length, 0, "reports must not enter retained storage before submission");
  assert.ok(result.artifacts.some((artifact) => artifact.url?.startsWith("/artifacts/") && artifact.file_name.endsWith(".html")),
    "completed scans must expose a viewable temporary HTML report");
  assert.ok(result.artifacts.some((artifact) => artifact.kind === "sbom" && artifact.file_name.endsWith(".sbom.cdx.json")),
    "completed scans must create a CycloneDX SBOM artifact");
  assert.ok(result.artifacts.some((artifact) => /^obs-fixture_\d{4}-\d{2}-\d{2}_\d{4}_간편점검(?:_\d+)?\.sbom\.cdx\.json$/.test(artifact.file_name)),
    "SBOM names must include the selected target name and Korean scan date");

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

  // 소속 없이도 가입은 된다(진입장벽 최소화) — 대신 점검 시작이 소속을 요구한다.
  const bareSignup = await fetch(`${baseUrl}/api/auth/request-link`, {
    method: "POST",
    headers: withUser("", { "Content-Type": "application/json" }),
    body: JSON.stringify({ email: "newuser@gg.go.kr" })
  });
  assert.equal(bareSignup.status, 200, "signup must not demand organization up front");
  const bareLink = (await bareSignup.json()).dev_login_url;
  const bareComplete = await fetch(`${baseUrl}${bareLink}`, { redirect: "manual" });
  const bareCookie = String(bareComplete.headers.get("set-cookie") || "").split(";")[0];
  const profileGated = await fetch(`${baseUrl}/api/scan/start`, {
    method: "POST",
    headers: withUser(bareCookie, { "Content-Type": "application/json" }),
    body: JSON.stringify({ scan_mode: "quick", target_type: "github_url", target_ref: "https://github.com/x/y" })
  });
  assert.equal(profileGated.status, 400, "scans must be blocked until the profile is complete");
  assert.equal((await profileGated.json()).error, "profile_required", "the block must name the missing profile — observations must never lack the department snapshot");

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
  const reportUrl = existingResult.artifacts?.[0]?.url;
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
  assert.equal(requested.status, "submitted");
  assert.ok(requested.submission_package?.url?.startsWith("/reports/"),
    "submission must return one downloadable package for the user");
  assert.ok(requested.request_document?.url?.startsWith("/reports/"),
    "submission must generate a review request document");
  const packageResponse = await fetch(`${baseUrl}${requested.submission_package.url}`, { headers: localHeaders() });
  assert.equal(packageResponse.status, 200, "the owner must receive the submission package");
  const packageEntries = readZipEntries(Buffer.from(await packageResponse.arrayBuffer()));
  assert.ok(packageEntries.some((entry) => entry.name === "01_보안성검토요청서.html"),
    "the package must contain the generated review request document");
  assert.ok(packageEntries.some((entry) => entry.name.startsWith("02_점검리포트/") && entry.name.endsWith(".html")),
    "the package must contain the HTML security report");
  assert.ok(packageEntries.some((entry) => entry.name.startsWith("02_점검리포트/") && entry.name.endsWith(".sbom.cdx.json")),
    "the package must contain the SBOM");
  const duplicate = await fetch(`${baseUrl}/api/scan/${result.id}/request-review`, { method: "POST", headers: localHeaders() });
  assert.equal(duplicate.status, 409, "duplicate review requests must be rejected");
  const history = await fetchJson("/api/my/scans");
  const entry = history.scans.find((scan) => scan.id === result.id);
  assert.equal(entry?.review_request?.status, "submitted", "my history must show the submission status");
  assert.equal(entry?.artifact_storage, "submitted", "review submission must promote artifacts to retained storage");
  assert.ok(entry?.reports?.length >= 3 && entry.reports.every((report) => report.url?.startsWith("/reports/")),
    "review submission must retain HTML, JSON, and SBOM reports on the server");
  assert.ok(entry?.observations_submitted_at, "review submission must record package metadata for the whitelist evidence");
  const sbom = entry.reports.find((report) => report.kind === "sbom");
  assert.ok(sbom?.url, "submitted scan must retain a downloadable SBOM");
  const sbomResponse = await fetch(`${baseUrl}${sbom.url}`, { headers: localHeaders() });
  assert.equal(sbomResponse.status, 200, "submitted SBOM must be downloadable by its owner");
  const sbomDocument = JSON.parse(await sbomResponse.text());
  assert.equal(sbomDocument.bomFormat, "CycloneDX", "SBOM must use CycloneDX");
  assert.equal(sbomDocument.specVersion, "1.6", "SBOM must use the required CycloneDX 1.6 schema");
  const busboy = (sbomDocument.components || []).find((component) => component.name === "busboy");
  assert.equal(busboy?.version, "1.6.0", "SBOM must record each resolved package version");
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
      PORTAL_WHITELIST_DIR: join(fixture.fixtureDir, "queue-whitelist"),
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
      PORTAL_WHITELIST_DIR: join(fixture.fixtureDir, "host-whitelist"),
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

// 적대적: 하네스 릴리스 피드가 오염돼도 위험한 링크가 화면에 뜨지 않는다.
// 피드 값은 외부 입력이므로 https 가 아닌 주소(javascript: 등)는 서버가 버려야 한다.
async function scenarioHarnessReleaseGuard(fixture) {
  const feedPort = Number(process.env.PORTAL_FEED_TEST_PORT || 8797);
  const portalPort = Number(process.env.PORTAL_RELEASE_TEST_PORT || 8798);
  const poisoned = JSON.stringify({
    status: "demo_installer_published",
    installer: {
      version: "9.9.9",
      download_url: "javascript:alert(document.cookie)",
      sha256: "deadbeef"
    },
    capabilities: { supported_tools: ["codex", "lovable-github"] }
  });
  const feed = createHttpServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(poisoned);
  });
  await new Promise((resolveListen) => feed.listen(feedPort, "127.0.0.1", resolveListen));

  const server = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(portalPort),
      ADMIN_INITIAL_PASSWORD: adminPassword,
      ADMIN_AUTH_FILE: join(fixture.fixtureDir, "release-admin.json"),
      PORTAL_SCAN_HISTORY_FILE: join(fixture.fixtureDir, "release-history.jsonl"),
      PORTAL_OBSERVATION_DIR: join(fixture.fixtureDir, "release-observations"),
      PORTAL_ACCOUNT_DIR: join(fixture.fixtureDir, "release-accounts"),
      PORTAL_WHITELIST_DIR: join(fixture.fixtureDir, "release-whitelist"),
      PORTAL_HARNESS_RELEASE_URL: `http://127.0.0.1:${feedPort}/release-index.json`,
      PORTAL_LOCAL_API_TOKEN: localApiToken,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8"
    },
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
      if (server.exitCode !== null) throw new Error("release guard test server died");
      try {
        const health = await fetch(`http://127.0.0.1:${portalPort}/health`);
        ready = health.ok;
      } catch {
        await wait(250);
      }
    }
    assert.ok(ready, "release guard test server did not become ready");
    const headers = new Headers({ "X-VibeCode-Local-Token": localApiToken });
    const release = await (await fetch(`http://127.0.0.1:${portalPort}/api/harness/release`, { headers })).json();
    assert.equal(release.download_url, null, "a non-https installer URL from the feed must be dropped, never rendered as a link");
    assert.ok(!release.supported_tools.some((tool) => tool.id.includes("lovable")), "Lovable must stay filtered even when the feed advertises it");
  } finally {
    server.kill();
    await Promise.race([once(server, "exit"), wait(2000)]);
    await new Promise((resolveClose) => feed.close(resolveClose));
  }
}

// Cloudflare Access 연동: 서명이 유효한 JWT 만 로그인으로 인정한다.
// 위조 토큰(다른 키 서명)·무토큰은 거부, 미설정 서버는 라우트 자체가 없어야 한다.
async function scenarioAccessLogin(fixture) {
  const certsPort = Number(process.env.PORTAL_ACCESS_CERTS_PORT || 8799);
  const portalPort = Number(process.env.PORTAL_ACCESS_TEST_PORT || 8800);
  const teamBase = `http://127.0.0.1:${certsPort}`;
  const aud = "portal-test-aud";

  const good = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const evil = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...good.publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
  const certs = createHttpServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((resolveListen) => certs.listen(certsPort, "127.0.0.1", resolveListen));

  const b64url = (value) => Buffer.from(value).toString("base64url");
  const makeJwt = (privateKey, payloadOverride = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }));
    const payload = b64url(JSON.stringify({
      iss: teamBase, aud: [aud], email: "access-user@gg.go.kr",
      iat: now, nbf: now - 10, exp: now + 300, ...payloadOverride
    }));
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
  };

  const server = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(portalPort),
      ADMIN_INITIAL_PASSWORD: adminPassword,
      ADMIN_AUTH_FILE: join(fixture.fixtureDir, "access-admin.json"),
      PORTAL_SCAN_HISTORY_FILE: join(fixture.fixtureDir, "access-history.jsonl"),
      PORTAL_OBSERVATION_DIR: join(fixture.fixtureDir, "access-observations"),
      PORTAL_ACCOUNT_DIR: join(fixture.fixtureDir, "access-accounts"),
      PORTAL_WHITELIST_DIR: join(fixture.fixtureDir, "access-whitelist"),
      PORTAL_ACCESS_TEAM_DOMAIN: teamBase,
      PORTAL_ACCESS_AUD: aud,
      PORTAL_LOCAL_API_TOKEN: localApiToken,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8"
    },
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
      if (server.exitCode !== null) throw new Error("access test server died");
      try { ready = (await fetch(`http://127.0.0.1:${portalPort}/health`)).ok; } catch { await wait(250); }
    }
    assert.ok(ready, "access test server did not become ready");
    const base = `http://127.0.0.1:${portalPort}`;
    const post = (jwt, body = {}) => fetch(`${base}/api/auth/access-login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-VibeCode-Local-Token": localApiToken,
        ...(jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {})
      },
      body: JSON.stringify(body)
    });

    const noToken = await post(null);
    assert.equal(noToken.status, 401, "missing Access JWT must be rejected");
    const forged = await post(makeJwt(evil.privateKey));
    assert.equal(forged.status, 401, "a JWT signed by an unknown key must be rejected");
    const wrongAud = await post(makeJwt(good.privateKey, { aud: ["other-app"] }));
    assert.equal(wrongAud.status, 401, "a JWT for another application must be rejected");
    const expired = await post(makeJwt(good.privateKey, { exp: Math.floor(Date.now() / 1000) - 600 }));
    assert.equal(expired.status, 401, "an expired JWT must be rejected");

    const ok = await post(makeJwt(good.privateKey));
    assert.equal(ok.status, 200, "a valid Access JWT must sign the user in without a profile");
    const cookie = String(ok.headers.get("set-cookie") || "").split(";")[0];
    assert.ok(cookie.startsWith("portal_session="), "access login must issue a portal session");
    // 소속이 비면 점검은 막힌다 — 관측의 부서 스냅샷 온전성.
    const gated = await fetch(`${base}/api/scan/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VibeCode-Local-Token": localApiToken, cookie },
      body: JSON.stringify({ scan_mode: "quick", target_type: "github_url", target_ref: "https://github.com/x/y" })
    });
    assert.equal(gated.status, 400);
    assert.equal((await gated.json()).error, "profile_required");
    const profiled = await fetch(`${base}/api/auth/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VibeCode-Local-Token": localApiToken, cookie },
      body: JSON.stringify({ organization: "경기도청", department: "AI산업육성과" })
    });
    assert.equal(profiled.status, 200, "the profile prompt must be able to complete the account");
    const who = await (await fetch(`${base}/api/auth/session`, {
      headers: { "X-VibeCode-Local-Token": localApiToken, cookie }
    })).json();
    assert.equal(who.email, "access-user@gg.go.kr", "session must belong to the JWT email");

    // 세션 조회는 관문 인증 사실을 화면에 알려준다 (빠른 시작 경로의 근거).
    const hinted = await (await fetch(`${base}/api/auth/session`, {
      headers: { "X-VibeCode-Local-Token": localApiToken, "Cf-Access-Jwt-Assertion": makeJwt(good.privateKey) }
    })).json();
    assert.equal(hinted.access_email, "access-user@gg.go.kr");
    assert.equal(hinted.access_registered, true);

    // 터널 사칭 차단: 관문을 통과한 요청은 그 신원과 같은 이메일로만 로그인 링크를 받을 수 있다.
    const linkHeaders = (jwt) => ({ "Content-Type": "application/json", "X-VibeCode-Local-Token": localApiToken, "Cf-Access-Jwt-Assertion": jwt });
    const mismatch = await fetch(`${base}/api/auth/request-link`, {
      method: "POST", headers: linkHeaders(makeJwt(good.privateKey)),
      body: JSON.stringify({ email: "someone.else@gg.go.kr" })
    });
    assert.equal(mismatch.status, 403, "request-link through the gateway must reject a different email");
    assert.equal((await mismatch.json()).error, "email_mismatch", "gateway impersonation must be reported as an identity mismatch");
    const selfLink = await fetch(`${base}/api/auth/request-link`, {
      method: "POST", headers: linkHeaders(makeJwt(good.privateKey)),
      body: JSON.stringify({ email: "access-user@gg.go.kr" })
    });
    assert.equal(selfLink.status, 200, "request-link through the gateway must accept the matching identity");
  } finally {
    server.kill();
    await Promise.race([once(server, "exit"), wait(2000)]);
    await new Promise((resolveClose) => certs.close(resolveClose));
  }
}

// P5: 보존기한이 지난 보고서는 기동 시 삭제되고, 기한 내 보고서는 남는다.
async function scenarioReportRetention(fixture) {
  const retentionPort = Number(process.env.PORTAL_RETENTION_TEST_PORT || 8796);
  const reportDir = join(fixture.fixtureDir, "retention-reports");
  const historyFile = join(fixture.fixtureDir, "retention-history.jsonl");
  const observationDir = join(fixture.fixtureDir, "retention-observations");
  const observationFile = join(observationDir, "package-observations.jsonl");
  const usageStatsFile = join(observationDir, "package-usage-stats.json");
  await mkdir(reportDir, { recursive: true });
  await mkdir(observationDir, { recursive: true });
  const oldFile = join(reportDir, "old_보안점검.html");
  const freshFile = join(reportDir, "fresh_보안점검.html");
  await writeFile(oldFile, "expired", "utf8");
  await writeFile(freshFile, "fresh", "utf8");
  const retainedScanId = "retention-history-scan";
  const observedAt = new Date().toISOString();
  await writeFile(historyFile, `${JSON.stringify({
    id: retainedScanId,
    status: "completed",
    mode: "quick",
    target_type: "browser_folder",
    target_label: "retention-fixture",
    decision: "allow",
    summary: { scanned_file_count: 1, finding_count: 0, language_counts: { JavaScript: 1 } },
    owner_email: "retention-user@gg.go.kr",
    owner_organization: "경기도청",
    owner_department: "정보화부서",
    created_at: observedAt
  })}\n`, "utf8");
  await writeFile(observationFile, `${JSON.stringify({
    scan_id: retainedScanId,
    ecosystem: "npm",
    package_name: "busboy",
    package_version: "1.6.0",
    version_exact: true,
    source_scope: "manifest",
    observed_at: observedAt
  })}\n`, "utf8");
  await writeFile(usageStatsFile, `${JSON.stringify({
    "npm:busboy": {
      ecosystem: "npm",
      package_name: "busboy",
      observation_count: 1,
      manifest_count: 1,
      project_labels: [],
      department_codes: [],
      versions: ["1.6.0"],
      latest_version: "1.6.0",
      has_vulnerable_observation: false,
      has_malicious_observation: false,
      first_observed_at: observedAt,
      last_observed_at: observedAt
    }
  }, null, 2)}\n`, "utf8");
  const oldDate = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
  await utimes(oldFile, oldDate, oldDate);

  const server = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(retentionPort),
      ADMIN_INITIAL_PASSWORD: adminPassword,
      ADMIN_AUTH_FILE: join(fixture.fixtureDir, "retention-admin.json"),
      PORTAL_SCAN_HISTORY_FILE: historyFile,
      PORTAL_OBSERVATION_DIR: observationDir,
      PORTAL_ACCOUNT_DIR: join(fixture.fixtureDir, "retention-accounts"),
      PORTAL_WHITELIST_DIR: join(fixture.fixtureDir, "retention-whitelist"),
      PORTAL_REPORT_DIR: reportDir,
      PORTAL_REPORT_RETENTION_DAYS: "90",
      PORTAL_LOCAL_API_TOKEN: localApiToken,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8"
    },
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
      if (server.exitCode !== null) throw new Error("retention test server died");
      try {
        const health = await fetch(`http://127.0.0.1:${retentionPort}/health`);
        ready = health.ok;
      } catch {
        await wait(250);
      }
    }
    assert.ok(ready, "retention test server did not become ready");
    assert.ok(!existsSync(oldFile), "reports past the retention period must be deleted at startup");
    assert.ok(existsSync(freshFile), "reports within the retention period must be kept");
    assert.ok(existsSync(historyFile), "report cleanup must not delete scan history used for time-series statistics");
    assert.ok(existsSync(observationFile), "report cleanup must not delete submitted package observations");
    const retainedHistory = JSON.parse((await readFile(historyFile, "utf8")).trim());
    assert.equal(retainedHistory.owner_email, "retention-user@gg.go.kr",
      "report cleanup must retain email-level scan history metadata");
    assert.equal(retainedHistory.owner_organization, "경기도청",
      "report cleanup must retain organization-level scan history metadata");
    assert.equal(retainedHistory.owner_department, "정보화부서",
      "report cleanup must retain department-level scan history metadata");
    const retainedUsageStats = JSON.parse(await readFile(usageStatsFile, "utf8"));
    assert.equal(retainedUsageStats["npm:busboy"]?.observation_count, 1,
      "report cleanup must not delete package and exact-version statistics");
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

  // 하네스의 release-index.json 을 그대로 소비한다 — Lovable 은 정책 확인 전까지 걸러진다.
  const release = await fetchJson("/api/harness/release");
  assert.equal(typeof release.available, "boolean", "release endpoint must always report availability honestly");
  if (release.available) {
    assert.ok(!release.supported_tools.some((tool) => tool.id.includes("lovable")), "Lovable must stay filtered out pending security policy review");
    assert.ok(release.download_url?.startsWith("https://"), "installer download URL must be present when available");
  }
}

async function scenarioDevelopmentProfile() {
  const login = await fetch(`${baseUrl}/api/auth/development-login`, {
    method: "POST",
    headers: localHeaders()
  });
  assert.equal(login.status, 200, "the loopback development session must be available to the development clone");
  const developmentCookie = String(login.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(developmentCookie.startsWith("portal_session="), "development login must issue a user session");
  const sessionResponse = await fetch(`${baseUrl}/api/auth/session`, { headers: withUser(developmentCookie) });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  assert.equal(session.organization, "", "development login must not prefill a fictitious organization");
  assert.equal(session.department, "", "development login must not prefill a fictitious department");
}

async function scenarioAdmin(fixture) {
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

  const today = koreaDateKey();
  const todayDashboard = await fetchJson(`/api/admin/dashboard?from=${today}&to=${today}`);
  assert.equal(todayDashboard.scan_count, summary.today,
    "admin summary and the today dashboard must use the same Asia/Seoul day boundary");

  const attentionDashboard = await fetchJson(`/api/admin/dashboard?from=2026-01-01&to=2026-12-31&status=attention`);
  assert.equal(attentionDashboard.scan_count, summary.attention,
    "the attention filter must include both incomplete and human-review scans");

  const reviewQueue = await fetchJson("/api/admin/review-requests");
  const queuedReview = reviewQueue.requests.find((item) => item.owner_email === "tester@gg.go.kr" && item.status === "submitted");
  assert.ok(queuedReview,
    "admin review queue must list the requester and status");
  assert.ok(queuedReview.reports?.length >= 1
    && queuedReview.reports.every((report) => report.file_name && report.url?.startsWith("/reports/")),
  "review requests must carry the generated reports into the admin queue");

  // P4(현황 보강): 큐·디스크·화이트리스트 요약이 함께 온다.
  assert.ok(summary.queue && Number.isFinite(summary.queue.limit), "admin summary must expose queue state");
  assert.ok(summary.whitelist, "admin summary must expose whitelist counts");

  const dashboard = await fetchJson("/api/admin/dashboard?from=2026-01-01&to=2026-12-31&query=busboy&ecosystem=npm");
  assert.ok(Array.isArray(dashboard.monthly_scans) && dashboard.monthly_scans.length === 6,
    "admin dashboard must provide six monthly scan buckets for the line chart");
  assert.ok(Array.isArray(dashboard.languages), "admin dashboard must provide language distribution data");
  assert.ok(dashboard.packages.some((entry) => entry.package_name === "busboy" && entry.versions.includes("1.6.0")),
    "admin dashboard must expose submitted package names and recorded versions");
  assert.ok(dashboard.users.some((entry) => entry.email === "tester@gg.go.kr" && entry.scan_count >= 1),
    "admin dashboard must retain and aggregate scan history by email");
  assert.ok(dashboard.organizations.some((entry) => entry.organization === "경기도청" && entry.scan_count >= 1),
    "admin dashboard must retain and aggregate scan history by organization");
  assert.ok(dashboard.departments.some((entry) => entry.department === "AI산업육성과" && entry.scan_count >= 1),
    "admin dashboard must retain and aggregate scan history by department");

  // P4: 관측 → 근거 목록 → 담기/제외/저장 → 감사 기록.
  const packagesData = await fetchJson("/api/admin/packages");
  const busboyEntry = packagesData.packages.find((entry) => entry.package_name === "busboy");
  assert.ok(busboyEntry, "observed packages must appear in the admin evidence list");
  assert.ok(busboyEntry.observation_count >= 1, "evidence list must carry observation counts");
  assert.ok(busboyEntry.department_count >= 1, "department snapshots must feed the evidence list");
  assert.ok(String(packagesData.note).includes("승인·차단이 아닙니다"), "evidence list must state it is not a verdict");

  const included = await fetchJson("/api/admin/whitelist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ecosystem: busboyEntry.ecosystem, package_name: "busboy", action: "include", reason: "표준 업로드 파서" })
  });
  assert.equal(included.entry.status, "included");
  const afterInclude = await fetchJson("/api/admin/packages");
  assert.equal(afterInclude.packages.find((entry) => entry.package_name === "busboy")?.whitelist_status, "included");

  const unobserved = await fetch(`${baseUrl}/api/admin/whitelist`, {
    method: "POST",
    headers: localHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ ecosystem: "npm", package_name: "never-observed-pkg", action: "include" })
  });
  assert.equal(unobserved.status, 404, "packages without observations must not be listable");

  // 내보내기 — 패키지 식별 정보만, 부서·이메일·프로젝트명은 실리지 않는다(적대 검증).
  const evidenceExport = await fetch(`${baseUrl}/api/admin/whitelist/export`, { headers: localHeaders() });
  assert.equal(evidenceExport.status, 200, "whitelist evidence export must be downloadable");
  assert.match(String(evidenceExport.headers.get("content-disposition")), /attachment/);
  const exportText = await evidenceExport.text();
  const evidencePayload = JSON.parse(exportText);
  assert.ok(evidencePayload.included.some((entry) => entry.package_name === "busboy"), "export must contain included packages");
  assert.ok(!exportText.includes("AI산업육성과"), "export must not leak department names");
  assert.ok(!exportText.includes("gg.go.kr"), "export must not leak user emails");
  assert.ok(!exportText.includes("obs-fixture"), "export must not leak project labels");

  const excluded = await fetchJson("/api/admin/whitelist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ecosystem: busboyEntry.ecosystem, package_name: "busboy", action: "exclude", reason: "테스트 제외" })
  });
  assert.equal(excluded.entry.status, "excluded");

  // 감사 기록이 실제 파일로 남았는지 직접 확인한다 (담기·내보내기·제외 = 3건 이상).
  const auditText = await readFile(join(fixture.fixtureDir, "whitelist", "whitelist-audit.jsonl"), "utf8");
  const auditLines = auditText.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(auditLines.length >= 3, "every whitelist change and export must leave an audit record");
  assert.ok(auditLines.some((line) => line.action === "include" && line.package_name === "busboy"));
  assert.ok(auditLines.some((line) => line.action === "export"));
  assert.ok(auditLines.some((line) => line.action === "exclude" && line.before === "included"),
    "audit must record the previous state of each change");

  // 일반 사용자·무로그인으로는 관리자 패키지·화이트리스트 API에 접근할 수 없다.
  const userAttempt = await fetch(`${baseUrl}/api/admin/whitelist`, {
    method: "POST",
    headers: withUser(userCookie, { "Content-Type": "application/json" }),
    body: JSON.stringify({ ecosystem: "npm", package_name: "busboy", action: "include" })
  });
  assert.equal(userAttempt.status, 401, "user sessions must not manage the whitelist");
  const anonymousPackages = await fetch(`${baseUrl}/api/admin/packages`, { headers: withUser("") });
  assert.equal(anonymousPackages.status, 401, "anonymous callers must not read the evidence list");
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
    PORTAL_WHITELIST_DIR: join(fixture.fixtureDir, "whitelist"),
    PORTAL_REPORT_DIR: join(fixture.fixtureDir, "reports"),
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
  await scenarioDevelopmentProfile();
  await scenarioAdmin(fixture);
  await scenarioQueueAndCapacity(fixture);
  await scenarioHostAllowlist(fixture);
  await scenarioHarnessReleaseGuard(fixture);
  await scenarioAccessLogin(fixture);
  // 미설정 서버(메인 테스트 서버)에서는 라우트 자체가 닫혀 있어야 한다.
  const accessDisabled = await fetch(`${baseUrl}/api/auth/access-login`, { method: "POST", headers: localHeaders({ "Content-Type": "application/json" }), body: "{}" });
  assert.equal(accessDisabled.status, 404, "access-login must be absent when the integration is not configured");
  await scenarioReportRetention(fixture);
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
      host_allowlist: true,
      harness_release_guard: true,
      access_login: true,
      report_retention: true
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
