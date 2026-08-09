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
  await fetchText("/api/local/update/preview", { method: "POST" });
  await fetchText("/api/local/mcp/register", { method: "POST" });
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
