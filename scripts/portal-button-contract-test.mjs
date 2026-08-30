#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";

const port = Number(process.env.PORTAL_BUTTON_TEST_PORT || 8793);
const baseUrl = `http://127.0.0.1:${port}`;
const localApiToken = "portal-button-contract-token";

const pages = [
  "/",
  "/scan",
  "/my",
  "/harness",
  "/admin/login",
  "/admin"
];

const allowedExternalHosts = new Set(["github.com"]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(path, options) {
  const headers = new Headers(options?.headers || {});
  if (path.startsWith("/api/")) headers.set("X-VibeCode-Local-Token", localApiToken);
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const text = await response.text();
  assert.ok(response.ok, `${path} expected ok, got ${response.status}: ${text.slice(0, 200)}`);
  return text;
}

async function waitForServer(child) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      await wait(250);
    }
  }
  throw new Error("button test server did not become ready");
}

function lineOf(html, offset) {
  return html.slice(0, offset).split(/\r?\n/).length;
}

function attrsOf(rawAttrs) {
  const attrs = {};
  const pattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (const match of rawAttrs.matchAll(pattern)) {
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? true;
  }
  return attrs;
}

function textOfTag(source, endOffset, tagName) {
  const close = source.indexOf(`</${tagName}>`, endOffset);
  if (close < 0) return "";
  return source
    .slice(endOffset, close)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeInternalHref(currentPath, href) {
  const url = new URL(href, `${baseUrl}${currentPath === "/" ? "/" : currentPath}`);
  return `${url.pathname}${url.search}${url.hash}`;
}

function hasAnchor(html, hash) {
  if (!hash) return true;
  const id = decodeURIComponent(hash.slice(1));
  return html.includes(`id="${id}"`) || html.includes(`name="${id}"`);
}

function isDynamicTemplate(value) {
  return value.includes("${") || value.includes("{{");
}

function isButtonWired(html, attrs) {
  const id = typeof attrs.id === "string" ? attrs.id : "";
  const classes = typeof attrs.class === "string" ? attrs.class.split(/\s+/) : [];
  const hasData = Object.keys(attrs).some((name) => name.startsWith("data-"));
  if (hasData) return true;
  if (id && (html.includes(`#${id}`) || html.includes(`getElementById("${id}")`) || html.includes(`getElementById('${id}')`))) return true;
  if (classes.includes("modal-close") && html.includes("modal-close")) return true;
  if (classes.includes("search") && html.includes('querySelector(".search")')) return true;
  if (classes.includes("help-search") && html.includes("helpSearchButton")) return true;
  if (classes.includes("tab") && html.includes(".tabs .tab")) return true;
  if (classes.includes("metric") && html.includes(".metric")) return true;
  if (classes.includes("export") && html.includes("#adminExportButton")) return true;
  return false;
}

async function assertAnchor(pagePath, html, attrs, line) {
  const href = String(attrs.href || "");
  assert.ok(href, `${pagePath}:${line} anchor must have href`);
  assert.notEqual(href, "#", `${pagePath}:${line} anchor must not use href="#"`);
  if (isDynamicTemplate(href)) return;

  if (/^https?:\/\//.test(href)) {
    const url = new URL(href);
    assert.ok(allowedExternalHosts.has(url.hostname), `${pagePath}:${line} unexpected external host ${url.hostname}`);
    assert.equal(attrs.target, "_blank", `${pagePath}:${line} external link must open in a new tab`);
    assert.ok(String(attrs.rel || "").includes("noreferrer"), `${pagePath}:${line} external link must include rel=noreferrer`);
    return;
  }

  const normalized = normalizeInternalHref(pagePath, href);
  const targetPath = normalized.split("#")[0] || "/";
  const targetHtml = await fetchText(targetPath);
  assert.ok(hasAnchor(targetHtml, new URL(`${baseUrl}${normalized}`).hash), `${pagePath}:${line} missing anchor target ${href}`);
}

async function assertPageControls(pagePath) {
  const html = await fetchText(pagePath);
  const tags = [...html.matchAll(/<(a|button|input)\b([^>]*)>/gi)];
  assert.ok(tags.length > 0, `${pagePath} must contain interactive controls`);

  let anchorCount = 0;
  let buttonCount = 0;
  for (const match of tags) {
    const [full, tagName, rawAttrs] = match;
    if (isDynamicTemplate(full)) continue;
    const attrs = attrsOf(rawAttrs);
    const line = lineOf(html, match.index || 0);

    if (tagName.toLowerCase() === "a") {
      anchorCount += 1;
      await assertAnchor(pagePath, html, attrs, line);
    }

    if (tagName.toLowerCase() === "button") {
      buttonCount += 1;
      const text = textOfTag(html, (match.index || 0) + full.length, "button");
      assert.ok(text || attrs["aria-label"], `${pagePath}:${line} button must have visible text or aria-label`);
      assert.ok(isButtonWired(html, attrs), `${pagePath}:${line} button must be wired by id, data-* attribute, or page script`);
    }

    if (tagName.toLowerCase() === "input") {
      const type = String(attrs.type || "text");
      if (type === "file" || attrs.hidden === true) {
        assert.ok(attrs.id && html.includes(`#${attrs.id}`), `${pagePath}:${line} hidden/file input must be referenced by script`);
      } else {
        assert.ok(attrs.id || attrs["aria-label"], `${pagePath}:${line} visible input must have id or aria-label`);
      }
    }
  }

  assert.ok(anchorCount + buttonCount > 0, `${pagePath} must expose clickable actions`);
  return { anchors: anchorCount, buttons: buttonCount };
}

async function assertApiBackedButtons() {
  // S1(서버 전환): 화면이 의존하는 서버 API는 도구 버전 안내뿐이다.
  // 설치·업데이트·MCP 라우트는 도구 관리자로 이관되어 서버에 없어야 한다.
  await fetchText("/api/tools/versions");
  const html = await fetchText("/");
  assert.ok(html.includes("X-VibeCode-Local-Token"), "HTML pages must attach the local request token to same-origin API calls");
}

async function assertLocalPickerContract() {
  const html = await fetchText("/scan");
  assert.ok(html.includes('id="saveLocationPrompt"'), "scan page must explain why a save location is required before opening the browser picker");
  assert.ok(html.includes('점검결과를 저장할 위치를 선택해 주세요.'), "save-location prompt must use the approved user wording");
  assert.ok(html.includes('saveButton.addEventListener("click", () => requestSaveLocation())'), "save-location button must show the save-location explanation first");
  assert.ok(html.includes('requestSaveLocation(mode);'), "scan start must request a save location before opening the browser picker");
  assert.ok(html.includes('selectSaveLocation.addEventListener("click", async () =>') && html.includes('await chooseSaveLocation();'), "save-location prompt confirmation must open the browser directory picker");
  assert.ok(html.includes('id="folderPickerInput" type="file" webkitdirectory multiple'), "folder selection must use the browser Explorer picker");
  assert.ok(html.includes('id="archivePickerInput" type="file" accept=".zip,application/zip"'), "ZIP selection must use the browser Explorer picker");
  assert.ok(html.includes('const picker = activeTarget === "folder" ? folderPickerInput : archivePickerInput') && html.includes('picker.click()'), "folder selection button must open the browser file picker");
  assert.ok(html.includes('fetch("/api/local/upload-target"'), "browser-selected source files must be sent to the local scanner");
  assert.ok(html.includes('id="targetProgress"'), "source selection must show immediate progress feedback");
  assert.equal((html.match(/data-mode=/g) || []).length, 2, "scan page must expose only quick and standard modes");
  assert.ok(!html.includes('data-mode="submission"') && !html.includes('id="resultZip"'), "submission mode and ZIP result must be removed from the user flow");
  assert.ok(html.includes('state: "선택 창 여는 중"') && html.includes('state: "파일 읽는 중"'), "source selection must explain picker and file-reading progress");
  assert.ok(html.includes('id="confirmTargetProgress"') && html.includes('확인하고 점검 시작'), "prepared source must require a clear confirmation before the queued scan starts");
  assert.ok(html.includes('confirmTargetProgress.addEventListener("click", async () =>'), "source preparation confirmation must be wired");
  assert.ok(!html.includes('id="resultNote"'), "scan results must not show the obsolete yellow result-ID section");
  assert.ok(html.includes('id="scanCompleteActions"') && html.includes('id="closeCompletedScan"'), "completed scans must offer a clear result-confirmation action");
  assert.ok(html.includes('id="closeScanProgress"') && html.includes('function setScanRunning(mode)') && html.includes('function finishScanProgress'), "scan progress must hide close controls until a final state is reached");
  assert.ok(html.includes('id="retryScan"') && html.includes('retryScan.addEventListener("click"'), "failed scans must offer a clear retry action");
  assert.ok(html.includes('id="saveLocationCompleteActions"') && html.includes('id="confirmSaveLocation"'), "save-location selection must show a completion confirmation before advancing");
  assert.ok(html.includes('confirmSaveLocation.addEventListener("click", async () =>'), "save-location completion confirmation must advance the queued scan deliberately");
  assert.ok(html.includes('class="flow-title" id="save-step-title"><span class="sequence">1</span>') && html.includes('class="flow-title" id="target-step-title"><span class="sequence">2</span>') && html.includes('class="flow-title" id="scan-mode-title"><span class="sequence">3</span>'), "scan flow must visibly order save location, source selection, and scan mode");
  assert.ok(html.includes('function showScanCompleted(job, progress, saveError = null)') && html.includes('점검과 파일 저장이 완료되었습니다.'), "completed scan must visibly confirm local report saving");
  assert.ok(html.includes('showScanCompleted(job, progress, saveError)') && html.includes('결과 파일 저장을 확인하세요.'), "scan completion must remain visible when local report saving fails");
  assert.ok(html.includes('progress.status === "failed" || job.status === "failed"'), "checker failures must not be treated as local save or connection retries");
  assert.ok(html.includes('href="/shared.css"'), "scan page must load the shared portal stylesheet");
  const sharedCss = await fetchText("/shared.css");
  assert.ok(sharedCss.includes('.modal-actions {') && sharedCss.includes('.button.primary {'), "modal confirmation buttons must use the shared portal button design");
  assert.ok(html.includes('window.showDirectoryPicker'), "report save location must use the browser directory picker");
  assert.ok(html.includes('error.name === "AbortError"') && html.includes('저장 위치 선택을 취소했습니다.'), "save-location cancellation must be shown as guidance, not a browser error");
  assert.ok(html.includes('targetSelectionInFlight'), "native target picker must prevent duplicate picker windows");

  // 외부 포털은 Cloudflare Access가 인증하므로 별도 로그인·상단 보관 안내를 노출하지 않는다.
  assert.ok(!html.includes('id="loginGate"') && !html.includes('id="requestLoginLink"'),
    "scan page must not duplicate Cloudflare Access with a portal email-login card");
  assert.ok(html.includes('async function establishAccessSession()') && html.includes('"/api/auth/access-login"'),
    "scan page must automatically establish a portal session from Cloudflare Access");
  assert.ok(!html.includes('id="dataNotice"'), "scan page must not repeat the top-level retention notice");
  assert.ok(!html.includes("submit-observations"), "the manual observation submission must be gone from the user flow");
  assert.ok(html.includes('id="requestReview"'), "completed scans must offer a security-review request action");
  assert.ok(html.includes('aria-label="보안점검 4단계"')
    && [1, 2, 3, 4].every((step) => html.includes(`data-flow-item="${step}"`)),
  "scan page must expose preparation, scan, report, and review-submission as four top-level steps");
  assert.ok(html.includes("GitHub · GitLab URL") && html.includes("gitlab.aigov.go.kr"),
    "scan page must expose the approved government GitLab option");
  assert.ok(html.includes('id="requestReview"') && html.includes('function saveSubmissionPackage(submissionPackage)')
    && html.includes('보안성검토 자료 제출') && html.includes('하나의 제출자료 ZIP'),
  "review submission must create one downloadable package containing the request form and reports");
  assert.ok(!html.includes('openSubmissionFolder') && !html.includes('저장 폴더 열기')
    && html.includes('viewSubmission.id = "viewSubmission"') && html.includes('window.location.assign(`/my?scan=${encodeURIComponent(lastCompletedScanId)}`)')
    && html.includes('finish.id = "finishSubmission"') && html.includes('window.location.assign("/")'),
  "completed submission must offer the retained submission record, not mislabel a directory picker as opening the saved folder");
  assert.ok(!html.includes('.filter((item) => item.kind !== "sbom")'),
    "saving scan artifacts to the selected directory must include the SBOM when it was generated");
  assert.ok(html.includes('id="resultSbom"') && html.includes('function artifactDisplayName(report)')
    && html.includes('소프트웨어 명세서') && html.includes('?view=1')
    && html.includes('생성된 보고서입니다.') && html.includes('클릭하면 바로 보실 수 있으며')
    && html.includes('점검 결과') && html.includes('조건부 승인'),
  "scan results must make report viewing and submission ZIP downloads explicit");

  // P5: 원본 삭제·보존기한이 화면에 사실대로 표시되어야 한다.
  assert.ok(html.includes('id="resultSource"') && html.includes('id="resultRetention"'), "result card must show source deletion and retention facts");
  assert.ok(html.includes("일 후 자동 삭제"), "retention wording must state automatic deletion");
  assert.ok(html.includes("점검 직후 삭제됨"), "completed scans must state the uploaded source was deleted");
}

async function assertToolsGuidePage() {
  // S1(서버 전환): /harness 는 안내형 화면이다. 웹에서 설치·업데이트 버튼을 제공하지 않는다.
  const html = await fetchText("/harness");
  assert.ok(html.includes("하네스 내려받기") && html.includes('id="heroDownloadArea"'), "tools page must present one focused installer download action");
  assert.ok(html.includes("무엇을 설치하나요?") && html.includes("Harness Manager")
    && html.includes("AI로 만드는 프로젝트에 공통 개발 기준과 보안 점검 절차"),
  "tools page must explain what the harness installs and why users need it");
  assert.ok(html.includes("Codex") && html.includes("Claude Code"), "tools page must state which AI tools the harness supports");
  assert.ok(html.includes("Python, JavaScript, TypeScript 외"), "tools page must state the allowed-language boundary honestly");
  assert.ok(html.includes('fetch("/api/tools/versions"'), "tools page must load the server checker version");
  assert.ok(html.includes("확인할 수 없습니다"), "version load failure must be shown honestly, never as up-to-date");
  assert.ok(!/data-action="(harness|checker)-(install|update)"/.test(html), "web page must not expose PC install/update actions after the tool-manager split");

  // 하네스 release-index.json을 소비해 설치 파일을 내려받고, 클릭 후 설치 단계로 자동 전환한다.
  assert.ok(html.includes('id="harnessInstallerDownload"') && html.includes('fetch("/api/harness/release"')
    && html.includes('window.setTimeout(() => showHarnessStep(2), 250)'), "installer download must advance directly to the installation step");
  assert.ok(html.includes("시작 메뉴</b>에서 <b>VibeCode Harness Manager"), "install guidance must say where the Manager actually is (Start Menu) — the demo installer does not auto-launch it");
  assert.ok(html.includes('id="unsignedInstallNotice"') && html.includes("알 수 없는 게시자") && html.includes("추가 정보 → 실행"), "unsigned installer guidance must tell users the exact Windows action");
  assert.ok(html.includes("설치 완료 · 설정하기") && html.includes("3단계 · 설정"), "installation completion must lead users into project setup");
  assert.ok(html.includes('class="harness-step-label">내려받기</span>')
    && html.includes('class="harness-step-label">설치하기</span>')
    && html.includes('class="harness-step-label">설정하기</span>'),
  "harness progress labels must match the download, install, and setup stages");
  assert.ok(!html.includes("lovable"), "unapproved tool (Lovable) must not be named in the harness install guidance");
}

async function assertMyHistoryPage() {
  const html = await fetchText("/my");
  assert.ok(html.includes('async function establishAccessSession()') && html.includes('"/api/auth/access-login"')
    && html.includes('"/api/auth/development-login"'),
  "my history must establish the same Access or local development session as the scan page");
  assert.ok(html.includes('id="historyCard"') && html.indexOf('id="historyCard"') < html.indexOf('id="profileCard"'),
  "scan history must appear before the optional profile editor");
  assert.ok(html.includes('function artifactDisplayName(report)') && html.includes('보안성검토 제출자료 ZIP')
    && html.includes('scan.artifacts || scan.reports || []') && html.includes('결과 리포트와 목록은 새 창에서 보고')
    && html.includes('new URLSearchParams(window.location.search).get("scan")') && html.includes('data-label="산출물"')
    && html.includes('@media (max-width: 640px)'),
  "scan history must show readable artifacts, explain view/download behavior, focus the submitted scan, and remain readable on mobile");
  assert.ok(html.includes('id="toggleProfile"') && html.includes('소속 정보 수정')
    && html.includes('접속 인증을 확인하지 못했습니다'),
  "history page must keep profile editing optional and never redirect users to a duplicate email-login flow");
}

async function assertRemovedHelpSurface() {
  const home = await fetchText("/");
  const adminLogin = await fetchText("/admin/login");
  assert.ok(!home.includes('href="/help"') && !home.includes("도움말 · FAQ")
    && !home.includes("도구 설치") && !home.includes('vibecode-security-gate-portal\" target="_blank"'),
  "home must not retain the removed help or duplicate quick-link row");
  assert.ok(!home.includes('href="/admin/login"') && !home.includes('id="adminSection"'),
    "the public home page must not expose the administrator route or an administrator card");
  assert.ok(!adminLogin.includes('href="/help"'), "admin login must not link to the removed help page");
  for (const path of ["/help", "/help.html"]) {
    const response = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
    assert.equal(response.status, 302, `${path} must redirect away from the retired help surface`);
    assert.equal(response.headers.get("location"), "/", `${path} must redirect to the home page`);
  }
}

async function assertAdminDashboardSurface() {
  const html = readFileSync(new URL("../design/html-prototype/admin.html", import.meta.url), "utf8");
  assert.ok(html.includes('id="monthlyChart"') && html.includes('id="languageChart"') && html.includes('id="packageChart"'),
    "admin page must expose monthly, language, and package visualizations");
  assert.ok(html.includes('id="ecosystem"') && html.includes('id="language"') && html.includes('id="whitelistStatus"'),
    "admin dashboard must expose ecosystem, language, and whitelist filters");
  assert.ok(html.includes('fetchAdminJson(`/api/admin/dashboard?${dashboardQuery().toString()}') && html.includes('renderLineChart') && html.includes('renderPieChart'),
    "admin dashboard charts must be rendered from the filtered API response");
  assert.ok(html.includes('id="filterResetButton"') && html.includes("function resetFilters()")
    && html.includes('metric.classList.add("active")') && html.includes("loadAdminData();"),
  "metric filters must reload immediately and give administrators a visible reset path");
  assert.ok(html.includes('data-filter-status="검토·재점검 필요"') && html.includes('"attention"')
    && html.includes('["needs_review", "incomplete"]'),
  "the attention metric must include incomplete scans as well as human-review scans");
  assert.ok(html.includes("grid-column: 1 / -1") && html.includes("조건에 맞는 점검 이력이 없습니다.")
    && html.includes("chart-frame-pie") && html.includes("chart-detail") && html.includes("aria-pressed"),
  "charts must reserve their own legend/detail space and expose keyboard-accessible real-data details");
  assert.ok(!html.includes("익명 점검 #A1042") && !html.includes("예약 현황 대시보드") && !html.includes(">12건<"),
    "admin page must not display fabricated history or metric values before the API responds");
  assert.ok(["currentPassword", "newPassword", "confirmPassword"].every((id) => html.includes(`data-password-toggle="${id}"`))
    && html.includes('function updatePasswordMatchHint()') && html.includes("새 비밀번호가 일치합니다.")
    && html.includes("새 비밀번호가 일치하지 않습니다."),
  "password change must support visibility controls and immediate confirmation matching feedback");
}

const child = spawn(process.execPath, ["src/server.js"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), PORTAL_LOCAL_API_TOKEN: localApiToken, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
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
  const results = [];
  for (const page of pages) {
    results.push({ page, ...(await assertPageControls(page)) });
  }
  await fetchText("/first-screen-gg-v2-1.html");
  await assertApiBackedButtons();
  await assertLocalPickerContract();
  await assertToolsGuidePage();
  await assertMyHistoryPage();
  await assertRemovedHelpSurface();
  await assertAdminDashboardSurface();
  console.log(JSON.stringify({ status: "passed", base_url: baseUrl, pages: results }, null, 2));
} catch (error) {
  console.error(stdout);
  console.error(stderr);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, "exit"), wait(2000)]);
}

process.exit(process.exitCode || 0);
