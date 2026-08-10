#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

const port = Number(process.env.PORTAL_BUTTON_TEST_PORT || 8793);
const baseUrl = `http://127.0.0.1:${port}`;

const pages = [
  "/",
  "/scan",
  "/harness",
  "/help",
  "/admin/login",
  "/admin"
];

const allowedExternalHosts = new Set(["github.com"]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
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
  await fetchText("/api/local/status");
  await fetchText("/api/local/version-status?target=harness");
  await fetchText("/api/local/version-status?target=checker");
  await fetchText("/api/local/update/preview", { method: "POST" });
  await fetchText("/api/local/mcp/register", { method: "POST" });
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
  assert.ok(html.includes('class="flow-title"><span class="sequence">1</span>') && html.includes('class="flow-title"><span class="sequence">2</span>') && html.includes('class="flow-title" id="scan-mode-title"><span class="sequence">3</span>'), "scan flow must visibly order save location, source selection, and scan mode");
  assert.ok(html.includes('function showScanCompleted(job, progress, saveError = null)') && html.includes('점검과 파일 저장이 완료되었습니다.'), "completed scan must visibly confirm local report saving");
  assert.ok(html.includes('showScanCompleted(job, progress, saveError)') && html.includes('결과 파일 저장을 확인하세요.'), "scan completion must remain visible when local report saving fails");
  assert.ok(html.includes('progress.status === "failed" || job.status === "failed"'), "checker failures must not be treated as local save or connection retries");
  assert.ok(html.includes('.modal-actions {') && html.includes('.button.primary {'), "modal confirmation buttons must use the shared portal button design");
  assert.ok(html.includes('window.showDirectoryPicker'), "report save location must use the browser directory picker");
  assert.ok(html.includes('error.name === "AbortError"') && html.includes('저장 위치 선택을 취소했습니다.'), "save-location cancellation must be shown as guidance, not a browser error");
  assert.ok(html.includes('targetSelectionInFlight'), "native target picker must prevent duplicate picker windows");
}

async function assertInstallActionsPerComponent() {
  const html = await fetchText("/harness");
  for (const target of ["harness", "checker"]) {
    const actions = [...html.matchAll(new RegExp(`data-action="${target}-(install|update)"`, "g"))];
    assert.equal(actions.length, 2, `${target} must expose exactly install and update actions`);
  }
  assert.ok(html.includes('class="component-state"'), "version status must be shown as read-only guidance, not a function button");
  assert.ok(html.includes('title: "공식 설치"'), "unofficial or development installs must offer official installation with no extra action");
  assert.ok(html.includes('id="operationActions"') && html.includes('id="actionResultClose"'), "installation progress must have dedicated final-state controls");
  assert.ok(html.includes('operationActions.hidden = true;') && html.includes('actionResultClose.hidden = true;'), "installation progress must hide confirmation controls while work is running");
  assert.ok(html.includes('operationActions.hidden = false;') && html.includes('actionResultClose.hidden = false;'), "installation completion must reveal confirmation controls");
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
  const results = [];
  for (const page of pages) {
    results.push({ page, ...(await assertPageControls(page)) });
  }
  await fetchText("/first-screen-gg-v2-1.html");
  await assertApiBackedButtons();
  await assertLocalPickerContract();
  await assertInstallActionsPerComponent();
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
