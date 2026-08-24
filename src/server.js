import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { appendFile, rm, readdir, readFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import Busboy from "busboy";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const DESIGN_DIR = join(ROOT, "design", "html-prototype");
const REPORT_DIR = join(ROOT, "reports");
const TMP_DIR = join(ROOT, "tmp", "scan-targets");
const PORT = Number(process.env.PORT || 8787);
const POWERSHELL = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const MAX_BROWSER_UPLOAD_BYTES = 500 * 1024 * 1024;
const MAX_BROWSER_UPLOAD_FILES = 10000;

function runtimePath(name, fallback) {
  const value = process.env[name];
  return value && isAbsolute(value) ? value : fallback;
}

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return {};
  return Object.fromEntries(readFileSync(filePath, "utf8").split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) return [];
    return [[match[1], match[2].replace(/^['"]|['"]$/g, "")]];
  }));
}

const runtimeEnv = { ...loadDotEnv(join(ROOT, ".env")), ...process.env };
const ADMIN_ID = runtimeEnv.ADMIN_ID || "gg0018@gg.go.kr";
const ADMIN_AUTH_FILE = isAbsolute(runtimeEnv.ADMIN_AUTH_FILE || "")
  ? runtimeEnv.ADMIN_AUTH_FILE
  : join(ROOT, runtimeEnv.ADMIN_AUTH_FILE || ".local/admin-auth.json");
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const adminSessions = new Map();
const LOCAL_API_TOKEN = runtimeEnv.PORTAL_LOCAL_API_TOKEN || randomBytes(32).toString("hex");
const LOCAL_HOSTS = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`
]);
const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 50000;
const MAX_COMPRESSION_RATIO = 200;
const SCAN_HISTORY_FILE = runtimePath("PORTAL_SCAN_HISTORY_FILE", join(ROOT, ".local", "scan-history.jsonl"));
const LOGIN_LOCK_THRESHOLD = 5;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
const loginFailures = { count: 0, locked_until: 0 };

// S1(서버 전환): 일회용 승인 토큰(issue/consumeApprovalToken)은 설치·업데이트·MCP
// 등록에만 쓰였으므로 그 로직과 함께 tool-manager/core.mjs 쪽 흐름으로 넘어갔다.

function redactLocalPath(value) {
  return String(value || "").replace(/[A-Za-z]:[\\/][^\s"'<>|]+/g, (match) => `…${basename(match)}`);
}

function passwordRecord(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function saveAdminCredentials(record) {
  mkdirSync(dirname(ADMIN_AUTH_FILE), { recursive: true });
  writeFileSync(ADMIN_AUTH_FILE, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8" });
}

function loadAdminCredentials() {
  if (existsSync(ADMIN_AUTH_FILE)) {
    const stored = JSON.parse(readFileSync(ADMIN_AUTH_FILE, "utf8"));
    if (stored.id !== ADMIN_ID || !stored.salt || !stored.hash) {
      throw new Error("관리자 인증 설정이 올바르지 않습니다.");
    }
    return stored;
  }

  const initialPassword = runtimeEnv.ADMIN_INITIAL_PASSWORD;
  if (!initialPassword || initialPassword.length < 12) {
    throw new Error("첫 실행에는 ADMIN_INITIAL_PASSWORD 환경변수가 필요합니다. 12자 이상으로 설정하세요.");
  }
  const { salt, hash } = passwordRecord(initialPassword);
  const stored = { id: ADMIN_ID, salt, hash, created_at: new Date().toISOString(), password_changed_at: null };
  saveAdminCredentials(stored);
  return stored;
}

let adminCredentials = loadAdminCredentials();

const jobs = new Map();

function persistedJobRecord(job) {
  return {
    id: job.id,
    mode: job.mode,
    target_type: job.target_type,
    target_label: job.target_label || "",
    status: job.status,
    decision: job.decision,
    summary: job.summary || null,
    steps: job.steps || [],
    reports: (job.reports || []).map(({ file_name, path, url }) => ({ file_name, path, url })),
    report_stem: job.report_stem || null,
    created_at: job.created_at,
    updated_at: job.updated_at || null,
    error: job.error || null
  };
}

async function persistJob(job) {
  try {
    mkdirSync(dirname(SCAN_HISTORY_FILE), { recursive: true });
    await appendFile(SCAN_HISTORY_FILE, `${JSON.stringify(persistedJobRecord(job))}\n`, "utf8");
  } catch {
    // History persistence must never break a completed scan response.
  }
}

function loadScanHistory() {
  if (!existsSync(SCAN_HISTORY_FILE)) return;
  try {
    const lines = readFileSync(SCAN_HISTORY_FILE, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record?.id) jobs.set(record.id, { temporary_paths: [], ...record });
      } catch {
        // Skip corrupted lines instead of losing the whole history.
      }
    }
  } catch {
    // A broken history file must not prevent the portal from starting.
  }
}

loadScanHistory();

// Scan targets are copies of someone else's project and may hold credentials or keys.
// A crashed or interrupted job leaves its copy behind, so every startup clears the
// whole staging area: no job can be running yet, therefore every entry is an orphan.
// (2026-08-12 incident: leftovers here held another agency's TLS private key.)
async function purgeOrphanScanTargets() {
  if (!existsSync(TMP_DIR)) return;
  let removed = 0;
  for (const entry of await readdir(TMP_DIR)) {
    try {
      await rm(join(TMP_DIR, entry), { recursive: true, force: true });
      removed += 1;
    } catch {
      // A locked leftover must not stop the portal from starting.
    }
  }
  if (removed) console.log(`이전 검사에서 남은 임시 폴더 ${removed}개를 정리했습니다.`);
}

purgeOrphanScanTargets().catch(() => {
  // Startup hygiene is best effort; a failure here must not block the portal.
});

const staticRoutes = new Map([
  ["/", "main page.html"],
  ["/first-screen-gg-v2-1.html", "main page.html"],
  ["/scan", "security-scan.html"],
  ["/harness", "tools.html"],
  ["/tools", "tools.html"],
  ["/help", "help.html"],
  ["/admin", "admin.html"],
  ["/admin/login", "admin-login.html"]
]);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".zip": "application/zip"
};

function json(response, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body, null, 2);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...extraHeaders
  });
  response.end(payload);
}

function redirect(response, location) {
  response.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  response.end();
}

function cookieValue(request, name) {
  const cookies = String(request.headers.cookie || "").split(";");
  const item = cookies.find((cookie) => cookie.trim().startsWith(`${name}=`));
  return item ? decodeURIComponent(item.trim().slice(name.length + 1)) : "";
}

function isAdminAuthenticated(request) {
  const token = cookieValue(request, "admin_session");
  const session = adminSessions.get(token);
  if (!session) return false;
  if (session.expires_at <= Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function requireAdmin(request, response) {
  if (isAdminAuthenticated(request)) return true;
  json(response, 401, { error: "admin_auth_required", message: "총괄 관리자 로그인이 필요합니다." });
  return false;
}

function verifyPassword(password, record = adminCredentials) {
  if (typeof password !== "string" || !record?.salt || !record?.hash) return false;
  const actual = scryptSync(password, record.salt, 64);
  const expected = Buffer.from(record.hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createAdminSession() {
  const token = randomBytes(32).toString("hex");
  adminSessions.set(token, { expires_at: Date.now() + ADMIN_SESSION_TTL_MS });
  return [`admin_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ADMIN_SESSION_TTL_MS / 1000}`, token];
}

function text(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function isAllowedLocalHost(request) {
  return LOCAL_HOSTS.has(String(request.headers.host || "").toLowerCase());
}

function hasAllowedOrigin(request) {
  const origin = String(request.headers.origin || "");
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && LOCAL_HOSTS.has(url.host.toLowerCase());
  } catch {
    return false;
  }
}

function hasLocalApiToken(request) {
  const received = String(request.headers["x-vibecode-local-token"] || "");
  const expected = Buffer.from(LOCAL_API_TOKEN, "utf8");
  const actual = Buffer.from(received, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isStateChangingRequest(request) {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(request.method || "");
}

function requireTrustedLocalRequest(request, response, pathname = "") {
  if (!isAllowedLocalHost(request)) {
    json(response, 421, { error: "local_host_required", message: "로컬 포털 주소에서만 요청할 수 있습니다." });
    return false;
  }
  if (!hasAllowedOrigin(request)) {
    json(response, 403, { error: "untrusted_origin", message: "현재 포털 화면에서만 요청할 수 있습니다." });
    return false;
  }
  if ((isStateChangingRequest(request) || pathname.startsWith("/api/")) && !hasLocalApiToken(request)) {
    json(response, 403, { error: "local_request_token_required", message: "포털 화면을 새로고침한 뒤 다시 시도하세요." });
    return false;
  }
  return true;
}

function localApiBootstrap() {
  const token = JSON.stringify(LOCAL_API_TOKEN).replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `<script>(function(){const token=${token};const nativeFetch=window.fetch.bind(window);window.fetch=function(input,init){const url=new URL(input instanceof Request?input.url:input,window.location.href);if(url.origin===window.location.origin&&url.pathname.startsWith("/api/")){const next=Object.assign({},init||{});const headers=new Headers(next.headers||(input instanceof Request?input.headers:void 0));headers.set("X-VibeCode-Local-Token",token);next.headers=headers;return nativeFetch(input,next)}return nativeFetch(input,init)}})();</script>`;
}

function notFound(response) {
  json(response, 404, { error: "not_found" });
}

function safeStaticPath(pathname) {
  const routeFile = staticRoutes.get(pathname);
  const target = routeFile ? join(DESIGN_DIR, routeFile) : join(DESIGN_DIR, pathname);
  const resolved = resolve(normalize(target));
  if (!resolved.startsWith(resolve(DESIGN_DIR))) return null;
  return resolved;
}

function serveStatic(request, response, pathname) {
  const target = safeStaticPath(pathname);
  if (!target || !existsSync(target) || !statSync(target).isFile()) {
    notFound(response);
    return;
  }

  const type = contentTypes[extname(target).toLowerCase()] || "application/octet-stream";
  response.writeHead(200, {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Cache-Control": "no-store"
  });
  if (extname(target).toLowerCase() === ".html") {
    const document = readFileSync(target, "utf8");
    response.end(document.replace("</head>", `${localApiBootstrap()}</head>`));
    return;
  }
  createReadStream(target).pipe(response);
}

function serveReport(response, filename) {
  let decoded = "";
  try {
    decoded = decodeURIComponent(filename || "");
  } catch {
    notFound(response);
    return;
  }
  if (!/^[\p{L}\p{N}._-]+$/u.test(decoded) || decoded.includes("..")) {
    notFound(response);
    return;
  }
  const target = resolve(join(REPORT_DIR, decoded));
  if (!target.startsWith(resolve(REPORT_DIR)) || !existsSync(target) || !statSync(target).isFile()) {
    notFound(response);
    return;
  }
  const type = contentTypes[extname(target).toLowerCase()] || "application/octet-stream";
  const asciiFilename = decoded.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  response.writeHead(200, {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(decoded)}`
  });
  createReadStream(target).pipe(response);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      shell: false,
      windowsHide: options.windowsHide ?? true,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        ...(options.env || {})
      }
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
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish({ ok: false, code: -1, stdout, stderr: String(error.message || error) });
    });
    child.on("close", (code) => {
      finish({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function escapePowerShellLiteral(value) {
  return String(value).replaceAll("'", "''");
}

// S1(서버 전환): 네이티브 파일 선택창은 도구 관리자(tool-manager/)로 이관했다.
// 다중 사용자 서버에서 GUI 대화상자는 서버 콘솔에 떠서 아무도 누를 수 없다.
// 파일 선택은 브라우저가 사용자 PC에서 수행하고, 서버는 업로드만 받는다.

async function inspectZip(archivePath) {
  const archive = escapePowerShellLiteral(archivePath);
  const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [System.IO.Compression.ZipFile]::OpenRead('${archive}'); $count = 0; $total = 0; $bad = ''; foreach ($e in $zip.Entries) { $count++; $total += $e.Length; $n = $e.FullName.Replace('\\', '/'); if ($n -match '^[A-Za-z]:' -or $n.StartsWith('/') -or $n -match '(^|/)\\.\\.(/|$)') { if (-not $bad) { $bad = $n } } }; $zip.Dispose(); [Console]::Out.Write("$count\`n$total\`n$bad")`;
  const inspected = await runCommand(POWERSHELL, ["-NoProfile", "-Command", script], { timeout_ms: 120000 });
  if (!inspected.ok) {
    throw new Error("압축파일 구조를 확인하지 못해 검사를 시작하지 않았습니다. 파일이 손상되지 않았는지 확인하세요.");
  }
  const [entries, totalBytes, badEntry] = inspected.stdout.split(/\r?\n/);
  return {
    entries: Number(entries || 0),
    total_bytes: Number(totalBytes || 0),
    bad_entry: (badEntry || "").trim() || null
  };
}

async function assertSafeArchive(archivePath) {
  const archiveBytes = statSync(archivePath).size;
  if (archiveBytes > MAX_ARCHIVE_BYTES) {
    throw new Error("ZIP 파일이 500MB를 초과해 검사할 수 없습니다. 불필요한 파일을 빼고 다시 압축하세요.");
  }
  const inspection = await inspectZip(archivePath);
  if (inspection.bad_entry) {
    throw new Error("압축파일 안에 허용되지 않는 경로(상위 폴더 탈출·절대 경로)가 있어 검사를 중단했습니다.");
  }
  if (inspection.entries > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`압축파일 항목이 ${MAX_ARCHIVE_ENTRIES.toLocaleString()}개를 초과해 검사할 수 없습니다.`);
  }
  if (inspection.total_bytes > MAX_EXTRACTED_BYTES) {
    throw new Error("압축을 풀었을 때 용량이 2GB를 초과해 검사할 수 없습니다.");
  }
  if (archiveBytes > 0 && inspection.total_bytes / archiveBytes > MAX_COMPRESSION_RATIO) {
    throw new Error("압축 비율이 비정상적으로 높아(압축폭탄 의심) 검사를 중단했습니다.");
  }
}

async function extractZip(archivePath, destination) {
  await assertSafeArchive(archivePath);
  const archive = escapePowerShellLiteral(archivePath);
  const output = escapePowerShellLiteral(destination);
  const extracted = await runCommand(
    POWERSHELL,
    ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${output}' -Force`],
    { timeout_ms: 300000 }
  );
  if (!extracted.ok) {
    throw new Error(`ZIP 압축을 풀지 못했습니다. ${redactLocalPath(extracted.stderr || extracted.stdout)}`.trim());
  }
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

function safeBrowserUploadPath(value) {
  const raw = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  const normalized = normalize(raw).replaceAll("\\", "/");
  if (!raw || isAbsolute(raw) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("업로드 파일 경로가 올바르지 않습니다.");
  }
  return normalized;
}

async function receiveBrowserTarget(request) {
  const contentType = String(request.headers["content-type"] || "");
  if (!contentType.startsWith("multipart/form-data")) throw new Error("브라우저 파일 전송 형식이 올바르지 않습니다.");

  const uploadId = randomUUID();
  const uploadRoot = join(TMP_DIR, `browser-${uploadId}`);
  mkdirSync(uploadRoot, { recursive: true });
  let kind = "";
  let manifest = [];
  let totalBytes = 0;
  let failure = null;
  const writes = [];
  const busboy = Busboy({ headers: request.headers, limits: { files: MAX_BROWSER_UPLOAD_FILES, fields: 3, fileSize: MAX_BROWSER_UPLOAD_BYTES } });

  const fail = (message) => {
    if (!failure) failure = new Error(message);
  };

  busboy.on("field", (name, value) => {
    try {
      if (name === "kind") kind = value;
      if (name === "manifest") {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_BROWSER_UPLOAD_FILES) throw new Error("업로드 파일 목록이 올바르지 않습니다.");
        manifest = parsed.map((item) => safeBrowserUploadPath(item));
      }
    } catch (error) {
      fail(String(error.message || error));
    }
  });

  busboy.on("file", (fieldName, file) => {
    const index = Number(fieldName.replace(/^file_/, ""));
    if (!Number.isInteger(index) || !manifest[index]) {
      fail("업로드 파일 목록과 파일 데이터가 일치하지 않습니다.");
      file.resume();
      return;
    }
    let target;
    try {
      target = resolve(uploadRoot, manifest[index]);
      if (!target.startsWith(resolve(uploadRoot))) throw new Error("업로드 파일 경로가 허용 범위를 벗어났습니다.");
      mkdirSync(dirname(target), { recursive: true });
    } catch (error) {
      fail(String(error.message || error));
      file.resume();
      return;
    }
    file.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BROWSER_UPLOAD_BYTES) fail("선택한 파일 용량이 500MB를 초과합니다.");
    });
    file.on("limit", () => fail("파일 하나의 용량이 500MB를 초과합니다."));
    writes.push(pipeline(file, createWriteStream(target)));
  });

  await new Promise((resolvePromise, rejectPromise) => {
    busboy.on("error", rejectPromise);
    busboy.on("finish", resolvePromise);
    request.pipe(busboy);
  });
  await Promise.all(writes);

  if (failure || !["folder", "archive"].includes(kind) || manifest.length === 0 || writes.length !== manifest.length) {
    await rm(uploadRoot, { recursive: true, force: true });
    throw failure || new Error("선택한 파일을 모두 전송하지 못했습니다.");
  }

  if (kind === "archive") {
    const archivePath = resolve(uploadRoot, manifest[0]);
    if (manifest.length !== 1 || extname(archivePath).toLowerCase() !== ".zip") {
      await rm(uploadRoot, { recursive: true, force: true });
      throw new Error("ZIP 파일 하나만 선택할 수 있습니다.");
    }
    return { target_type: "browser_archive", path: archivePath, label: basename(archivePath), file_count: 1, cleanup_root: uploadRoot };
  }

  const rootNames = [...new Set(manifest.map((entry) => entry.split("/")[0]).filter(Boolean))];
  const label = rootNames.length === 1 ? rootNames[0] : `${manifest.length}개 파일`;
  return { target_type: "browser_folder", path: uploadRoot, label, file_count: manifest.length, cleanup_root: uploadRoot };
}

// S1(서버 전환): 설치·업데이트·MCP 등록·버전 비교 로직(gitSummary ~ applyUpdates)은
// tool-manager/core.mjs 로 이관했다. 서버는 사용자 PC를 조작할 수 없고, 그 일은
// PC에서 실행되는 도구 관리자가 맡는다(docs/22 §7). 서버에 남는 것은
// "서버 자체의 체커 버전"을 알려 주는 /api/tools/versions 뿐이다.

async function serverCheckerVersion() {
  const [version, doctor] = await Promise.all([
    runCommand("gvskb", ["version"], { timeout_ms: 15000 }),
    runCommand("gvskb", ["doctor"], { timeout_ms: 60000 })
  ]);
  const doctorText = `${doctor.stdout}
${doctor.stderr}`;
  const hasError = /ERRORs+[1-9]/.test(doctorText);
  const hasWarn = /WARNs+[1-9]/.test(doctorText) || doctor.code !== 0;
  return {
    installed: version.ok,
    version: version.ok ? version.stdout.trim() : null,
    doctor_status: hasError ? "error" : hasWarn ? "warn" : "ok"
  };
}

function safeReportNamePart(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
}

function koreaReportTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}`;
}

function reportStemForJob(job, targetPath) {
  let targetName = "";
  if (job.target_type === "github_url") {
    try {
      targetName = safeReportNamePart(new URL(String(job.target_ref)).pathname.split("/").filter(Boolean).join("_"));
    } catch {
      targetName = "";
    }
  }
  if (!targetName) targetName = safeReportNamePart(job.target_label);
  if (!targetName) targetName = safeReportNamePart(basename(targetPath));
  const base = [koreaReportTimestamp(new Date()), targetName, "보안점검"].filter(Boolean).join("_");
  let candidate = base;
  let suffix = 2;
  while ([".json", ".html", ".md"].some((extension) => existsSync(join(REPORT_DIR, `${candidate}${extension}`)))) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function createJob(mode, targetType, targetRef, targetLabel = "") {
  const id = randomUUID();
  const job = {
    id,
    mode,
    target_type: targetType,
    target_ref: targetRef,
    target_label: safeReportNamePart(targetLabel),
    status: "queued",
    decision: "incomplete",
    steps: [],
    reports: [],
    created_at: new Date().toISOString(),
    temporary_paths: []
  };
  jobs.set(id, job);
  return job;
}

async function cleanupJobTargets(job) {
  const cleanupFailures = [];
  await Promise.all((job.temporary_paths || []).map(async (target) => {
    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(`${basename(target)}: ${String(error.message || error)}`);
    }
  }));
  job.temporary_paths = [];
  if (cleanupFailures.length) job.cleanup_warning = cleanupFailures.join(" | ");
}

// S1(서버 전환): 결과를 서버 폴더에 복사해 주는 기능(saveReportsToDirectory)은 제거했다.
// 다중 사용자 서버의 파일시스템을 사용자가 고를 수 없다. 결과는 다운로드로 받는다.

function updateJob(job, patch) {
  Object.assign(job, patch);
  job.updated_at = new Date().toISOString();
}

const scanStepProgress = {
  prepare_target: { percent: 16, message: "검사 대상을 준비하고 있습니다." },
  code_scan: { percent: 62, message: "체커가 코드와 의존성을 점검하고 있습니다." },
  render_report: { percent: 90, message: "검사 보고서를 만들고 있습니다." }
};

function elapsedSeconds(since) {
  const timestamp = Date.parse(since || "");
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
}

function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}분 ${remainder}초` : `${minutes}분`;
}

function progressForJob(job) {
  if (job.status === "completed") return { percent: 100, message: "검사가 완료되었습니다." };
  const active = [...(job.steps || [])].reverse().find((step) => step.status === "running");
  if (active) {
    const base = scanStepProgress[active.name] || { percent: 8, message: "검사를 준비하고 있습니다." };
    const elapsed = elapsedSeconds(job.updated_at || job.created_at);
    if (active.name === "code_scan") {
      // Long scans advance smoothly but never imply completion before the report is built.
      const percent = Math.min(84, Math.round(28 + 56 * (1 - Math.exp(-elapsed / 240))));
      return { percent, message: `${base.message} (${formatElapsed(elapsed)} 경과)`, elapsed_seconds: elapsed };
    }
    return { ...base, elapsed_seconds: elapsed };
  }
  const failed = [...(job.steps || [])].reverse().find((step) => step.status === "failed");
  if (failed) return { ...(scanStepProgress[failed.name] || { percent: 0 }), message: job.error || "검사 중 문제가 발생했습니다." };
  return { percent: 0, message: "검사를 기다리고 있습니다." };
}

function isAllowedGithubUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com" && url.pathname.split("/").filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

// 업로드 검사 대상은 반드시 서버 업로드 영역(TMP_DIR) 안에 있어야 한다.
// API로 임의 서버 경로를 업로드 대상인 척 넘겨 서버 파일시스템을 스캔시키는 것을 막는다.
function assertUploadedPath(value) {
  const targetPath = resolve(String(value || ""));
  const uploadRoot = resolve(TMP_DIR);
  if (!targetPath.startsWith(uploadRoot + "\\") && !targetPath.startsWith(uploadRoot + "/")) {
    throw new Error("검사 대상을 찾지 못했습니다. 파일을 다시 올려 주세요.");
  }
  return targetPath;
}

// S1(서버 전환): 로컬 절대경로 검사(folder/archive)는 제거했다.
// 서버에는 사용자의 로컬 경로가 존재하지 않는다. 입력은 업로드와 GitHub URL뿐이다.
async function prepareScanTarget(job) {
  if (job.target_type === "browser_folder") {
    const targetPath = assertUploadedPath(job.target_ref);
    if (!existsSync(targetPath)) {
      throw new Error("검사 대상을 찾지 못했습니다. 파일을 다시 올려 주세요.");
    }
    job.temporary_paths.push(targetPath);
    return targetPath;
  }

  if (job.target_type === "browser_archive") {
    const archivePath = assertUploadedPath(job.target_ref);
    if (!existsSync(archivePath) || !statSync(archivePath).isFile()) {
      throw new Error("올린 압축파일을 찾지 못했습니다. 다시 올려 주세요.");
    }
    if (extname(archivePath).toLowerCase() !== ".zip") {
      throw new Error("ZIP 압축파일만 검사할 수 있습니다.");
    }
    mkdirSync(TMP_DIR, { recursive: true });
    const extractedDir = join(TMP_DIR, `${job.id}-archive`);
    await rm(extractedDir, { recursive: true, force: true });
    mkdirSync(extractedDir, { recursive: true });
    job.temporary_paths.push(extractedDir);
    job.temporary_paths.push(dirname(archivePath));
    await extractZip(archivePath, extractedDir);
    return extractedDir;
  }

  if (job.target_type === "github_url") {
    const targetUrl = String(job.target_ref || "").trim();
    if (!isAllowedGithubUrl(targetUrl)) {
      throw new Error("GitHub URL은 https://github.com/소유자/저장소 형식만 지원합니다.");
    }
    mkdirSync(TMP_DIR, { recursive: true });
    const cloneDir = join(TMP_DIR, job.id);
    await rm(cloneDir, { recursive: true, force: true });
    const clone = await runCommand("git", ["clone", "--depth", "1", targetUrl, cloneDir]);
    if (!clone.ok) {
      throw new Error(`GitHub 저장소를 가져오지 못했습니다: ${redactLocalPath(clone.stderr || clone.stdout)}`);
    }
    job.temporary_paths.push(cloneDir);
    return cloneDir;
  }

  throw new Error("지원하지 않는 검사 대상입니다. 폴더나 ZIP을 올리거나 GitHub 주소를 입력해 주세요.");
}

async function runScanJob(job) {
  updateJob(job, {
    status: "running",
    steps: [{ name: "prepare_target", status: "running" }]
  });

  let targetPath = "";
  try {
    targetPath = await prepareScanTarget(job);
  } catch (error) {
    updateJob(job, {
      status: "failed",
      decision: "incomplete",
      error: String(error.message || error),
      steps: [{ name: "prepare_target", status: "failed" }]
    });
    await cleanupJobTargets(job);
    await persistJob(job);
    return;
  }

  mkdirSync(REPORT_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  const reportStem = reportStemForJob(job, targetPath);
  const outputBase = join(REPORT_DIR, reportStem);
  const jsonOutput = `${outputBase}.json`;
  updateJob(job, { report_stem: reportStem });
  const maxFiles = job.mode === "quick" ? "700" : "20000";
  const args = ["scan", targetPath, "--format", "json", "--output", jsonOutput, "--max-files", maxFiles, "--check-deps", "--fail-on", "never"];
  if (job.mode === "quick") {
    args.push("--profile", "dev-quick");
  } else {
    args.push("--profile", "public-default-strict");
  }

  updateJob(job, {
    steps: [
      { name: "prepare_target", status: "completed" },
      { name: "code_scan", status: "running" }
    ]
  });

  const scan = await runCommand("gvskb", args);
  const jsonCandidates = [jsonOutput];
  let parsed = null;
  let jsonPath = "";

  for (const candidate of jsonCandidates) {
    if (existsSync(candidate)) {
      try {
        parsed = JSON.parse(await readFile(candidate, "utf8"));
        jsonPath = candidate;
        break;
      } catch {
        parsed = null;
      }
    }
  }

  if (parsed && jsonPath) {
    updateJob(job, {
      steps: [
        { name: "prepare_target", status: "completed" },
        { name: "code_scan", status: "completed" },
        { name: "render_report", status: "running" }
      ]
    });
    await runCommand("gvskb", ["report", jsonPath, "--format", "html", "--output", outputBase]);
  }

  const findingCount = parsed?.summary?.finding_count ?? parsed?.findings?.length ?? 0;
  const scannedFileCount = parsed?.summary?.scanned_file_count ?? parsed?.scanned_file_count ?? parsed?.scanned_files?.length ?? 0;
  const dependencyFindingCount = parsed?.summary?.dependency_finding_count ?? parsed?.dependency_audit?.summary?.finding_count ?? 0;
  const profileFallback = parsed?.profile_fallback || null;
  const coverageTruncated = (parsed?.skipped_files || []).some((item) => String(item.reason || "").includes("max_files="));
  const dependencyIncomplete = (parsed?.dependency_audit?.audits || []).some((audit) => Number(audit.unchecked_count || 0) > 0 || Number(audit.truncated_count || 0) > 0);
  const baseDecision = profileFallback || coverageTruncated || dependencyIncomplete
    ? "incomplete"
    : parsed?.decision || (
      scannedFileCount === 0 ? "needs_review" : parsed?.summary?.blocked ? "blocked" : findingCount > 0 ? "needs_review" : "allow"
    );
  const decision = job.mode === "quick" && baseDecision === "allow" ? "quick_complete" : baseDecision;
  const finalReportFiles = await readdir(REPORT_DIR).catch(() => []);
  const finalReportItems = [];
  for (const file of finalReportFiles) {
    if (file === `${reportStem}.json` || file === `${reportStem}.html` || file === `${reportStem}.md`) {
      finalReportItems.push({
        file_name: file,
        path: join(REPORT_DIR, file),
        url: `/reports/${encodeURIComponent(file)}`
      });
    }
  }

  updateJob(job, {
    status: scan.ok || parsed ? "completed" : "failed",
    decision,
    steps: [
      { name: "prepare_target", status: "completed" },
      { name: "code_scan", status: scan.ok || parsed ? "completed" : "failed" },
      { name: "render_report", status: finalReportItems.length > 0 ? "completed" : "pending" }
    ],
    reports: finalReportItems,
    checker_exit_code: scan.code,
    checker_stdout_tail: scan.stdout.split(/\r?\n/).filter(Boolean).slice(-12).map(redactLocalPath),
    checker_stderr_tail: scan.stderr.split(/\r?\n/).filter(Boolean).slice(-12).map(redactLocalPath),
    summary: {
      scanned_file_count: scannedFileCount,
      finding_count: findingCount,
      dependency_finding_count: dependencyFindingCount,
      profile_fallback: profileFallback,
      coverage_truncated: coverageTruncated,
      dependency_incomplete: dependencyIncomplete
    }
  });
  await cleanupJobTargets(job);
  await persistJob(job);
}

function adminSummary() {
  const scans = Array.from(jobs.values());
  const todayPrefix = new Date().toISOString().slice(0, 10);
  const today = scans.filter((job) => String(job.created_at || "").startsWith(todayPrefix));
  const allow = scans.filter((job) => job.decision === "allow").length;
  const quickComplete = scans.filter((job) => job.decision === "quick_complete").length;
  const needsReview = scans.filter((job) => job.decision === "needs_review").length;
  const blocked = scans.filter((job) => job.decision === "blocked").length;
  return {
    total: scans.length,
    today: today.length,
    allow,
    quick_complete: quickComplete,
    needs_review: needsReview,
    blocked,
    generated_at: new Date().toISOString()
  };
}

function adminExportPayload() {
  const scans = Array.from(jobs.values())
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map((job) => ({
      scan_id: job.id,
      mode: job.mode,
      target_type: job.target_type,
      status: job.status,
      decision: job.decision,
      scanned_file_count: Number(job.summary?.scanned_file_count || 0),
      finding_count: Number(job.summary?.finding_count || 0),
      dependency_finding_count: Number(job.summary?.dependency_finding_count || 0),
      created_at: job.created_at,
      updated_at: job.updated_at || null
    }));
  return {
    report_type: "관리자 점검 현황",
    generated_at: new Date().toISOString(),
    summary: adminSummary(),
    scans
  };
}

// S1(서버 전환): 관리자 내보내기는 서버 폴더 저장이 아니라 다운로드로 전달한다.
function adminExportFileName() {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
  return `${timestamp}_관리자점검현황.json`;
}

function publicJob(job) {
  const targetLabel = job.target_type === "github_url"
    ? "GitHub repository"
    : job.target_type === "browser_archive"
      ? "Uploaded ZIP archive"
      : "Uploaded folder";
  return {
    id: job.id,
    mode: job.mode,
    target_type: job.target_type,
    target_label: targetLabel,
    status: job.status,
    decision: job.decision,
    summary: job.summary || null,
    steps: job.steps || [],
    reports: (job.reports || []).map(({ file_name, url }) => ({ file_name, url })),
    created_at: job.created_at,
    updated_at: job.updated_at || null,
    error: job.error || null
  };
}

async function startScan(request, response) {
  const body = await readJson(request);
  const mode = ["quick", "standard"].includes(body.scan_mode) ? body.scan_mode : "standard";
  const targetType = ["github_url", "browser_folder", "browser_archive"].includes(body.target_type) ? body.target_type : "";
  if (!targetType) {
    json(response, 400, { error: "invalid_target_type", message: "폴더나 ZIP을 올리거나 GitHub 주소로 검사할 수 있습니다." });
    return;
  }
  const job = createJob(mode, targetType, body.target_ref, body.target_label);

  runScanJob(job).catch(async (error) => {
    updateJob(job, {
      status: "failed",
      decision: "blocked",
      error: String(error.message || error)
    });
    await cleanupJobTargets(job);
    await persistJob(job);
  });

  json(response, 202, {
    scan_id: job.id,
    status: job.status,
    progress_url: `/api/scan/${job.id}/progress`,
    result_url: `/api/scan/${job.id}/result`
  });
}

async function handleApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/health") {
    json(response, 200, { status: "ok", app: "vibecode-security-gate-portal" });
    return;
  }

  if (request.method === "POST" && pathname === "/api/admin/login") {
    if (loginFailures.locked_until > Date.now()) {
      const waitSeconds = Math.ceil((loginFailures.locked_until - Date.now()) / 1000);
      json(response, 429, { error: "login_locked", message: `로그인 시도가 반복 실패해 잠시 잠겼습니다. ${waitSeconds}초 후 다시 시도하세요.` });
      return;
    }
    const body = await readJson(request);
    if (body.id !== ADMIN_ID || !verifyPassword(body.password)) {
      loginFailures.count += 1;
      if (loginFailures.count >= LOGIN_LOCK_THRESHOLD) {
        loginFailures.locked_until = Date.now() + LOGIN_LOCK_MS;
        loginFailures.count = 0;
      }
      json(response, 401, { error: "invalid_admin_credentials", message: "아이디 또는 비밀번호를 확인하세요." });
      return;
    }
    loginFailures.count = 0;
    loginFailures.locked_until = 0;
    const [cookie] = createAdminSession();
    json(response, 200, { status: "authenticated", next: "/admin" }, { "Set-Cookie": cookie });
    return;
  }

  if (request.method === "POST" && pathname === "/api/admin/logout") {
    const token = cookieValue(request, "admin_session");
    if (token) adminSessions.delete(token);
    json(response, 200, { status: "signed_out" }, { "Set-Cookie": "admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
    return;
  }

  if (request.method === "POST" && pathname === "/api/admin/password") {
    if (!requireAdmin(request, response)) return;
    const body = await readJson(request);
    const newPassword = String(body.new_password || "");
    if (!verifyPassword(body.current_password)) {
      json(response, 400, { error: "invalid_current_password", message: "현재 비밀번호가 올바르지 않습니다." });
      return;
    }
    if (newPassword.length < 12) {
      json(response, 400, { error: "password_too_short", message: "새 비밀번호는 12자 이상이어야 합니다." });
      return;
    }
    if (newPassword !== String(body.confirm_password || "")) {
      json(response, 400, { error: "password_mismatch", message: "새 비밀번호가 일치하지 않습니다." });
      return;
    }
    const { salt, hash } = passwordRecord(newPassword);
    adminCredentials = { ...adminCredentials, salt, hash, password_changed_at: new Date().toISOString() };
    saveAdminCredentials(adminCredentials);
    adminSessions.clear();
    const [cookie] = createAdminSession();
    json(response, 200, { status: "password_changed" }, { "Set-Cookie": cookie });
    return;
  }

  if (request.method === "GET" && pathname === "/api/tools/versions") {
    json(response, 200, {
      checker: await serverCheckerVersion(),
      note: "서버에 설치된 체커입니다. 사용자 PC의 도구 상태는 도구 관리자가 확인합니다."
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/local/upload-target") {
    try {
      const uploaded = await receiveBrowserTarget(request);
      json(response, 201, { status: "selected", ...uploaded });
    } catch (error) {
      json(response, 400, { error: String(error.message || error) });
    }
    return;
  }

  if (request.method === "POST" && pathname === "/api/scan/start") {
    await startScan(request, response);
    return;
  }

  if (request.method === "GET" && pathname === "/api/admin/summary") {
    if (!requireAdmin(request, response)) return;
    json(response, 200, adminSummary());
    return;
  }

  if (request.method === "GET" && pathname === "/api/admin/scans") {
    if (!requireAdmin(request, response)) return;
    json(response, 200, {
      scans: Array.from(jobs.values()).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map(publicJob)
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/admin/export") {
    if (!requireAdmin(request, response)) return;
    const fileName = adminExportFileName();
    const payload = `${JSON.stringify(adminExportPayload(), null, 2)}\n`;
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="admin-export.json"; filename*=UTF-8''${encodeURIComponent(fileName)}`
    });
    response.end(payload);
    return;
  }

  const progressMatch = pathname.match(/^\/api\/scan\/([^/]+)\/progress$/);
  if (request.method === "GET" && progressMatch) {
    const job = jobs.get(progressMatch[1]);
    if (!job) return notFound(response);
    json(response, 200, {
      scan_id: job.id,
      status: job.status,
      steps: job.steps,
      ...progressForJob(job),
      error: job.error || null
    });
    return;
  }

  const resultMatch = pathname.match(/^\/api\/scan\/([^/]+)\/result$/);
  if (request.method === "GET" && resultMatch) {
    const job = jobs.get(resultMatch[1]);
    if (!job) return notFound(response);
    json(response, 200, publicJob(job));
    return;
  }

  notFound(response);
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://127.0.0.1:${PORT}`);
    if (!requireTrustedLocalRequest(request, response, url.pathname)) return;
    if (url.pathname === "/health" || url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url.pathname);
      return;
    }

    const reportMatch = url.pathname.match(/^\/reports\/(.+)$/);
    if (reportMatch) {
      serveReport(response, reportMatch[1]);
      return;
    }

    if ((url.pathname === "/admin" || url.pathname === "/admin.html") && !isAdminAuthenticated(request)) {
      redirect(response, "/admin/login");
      return;
    }

    serveStatic(request, response, decodeURIComponent(url.pathname));
  } catch (error) {
    text(response, 500, `server_error: ${String(error.message || error)}`);
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`VibeCode Security Gate Portal: http://127.0.0.1:${PORT}`);
});
