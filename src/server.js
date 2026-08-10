import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { appendFile, copyFile, rename, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import Busboy from "busboy";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const DESIGN_DIR = join(ROOT, "design", "html-prototype");
const REPORT_DIR = join(ROOT, "reports");
const TMP_DIR = join(ROOT, "tmp", "scan-targets");
const HARNESS_SOURCE_DIR = resolve(ROOT, "..", "vibe_harness_codex");
const LOCAL_TOOLS_DIR = join(ROOT, "tools");
const LOCAL_HARNESS_DIR = join(LOCAL_TOOLS_DIR, "vibe_harness_codex");
const LOCAL_CHECKER_DIR = join(LOCAL_TOOLS_DIR, "vibecode-checker");
const HARNESS_REPOSITORY = "https://github.com/Lex6won/vibe_harness_codex.git";
const CHECKER_REPOSITORY = "https://github.com/Lex6won/vibecode-checker.git";
const PORT = Number(process.env.PORT || 8787);
const POWERSHELL = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const MAX_BROWSER_UPLOAD_BYTES = 500 * 1024 * 1024;
const MAX_BROWSER_UPLOAD_FILES = 10000;
const OPERATION_LOG_FILE = runtimePath("PORTAL_OPERATION_LOG_FILE", join(ROOT, ".local", "gate-operation-log.jsonl"));

function harnessSourceDir() {
  return existsSync(HARNESS_SOURCE_DIR) ? HARNESS_SOURCE_DIR : LOCAL_HARNESS_DIR;
}

function runtimePath(name, fallback) {
  const value = process.env[name];
  return value && isAbsolute(value) ? value : fallback;
}

async function writeGateOperation(action, target, result) {
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

const staticRoutes = new Map([
  ["/", "main page.html"],
  ["/first-screen-gg-v2-1.html", "main page.html"],
  ["/scan", "security-scan.html"],
  ["/harness", "skill-harness.html"],
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
  createReadStream(target).pipe(response);
}

function serveReport(response, filename) {
  const decoded = decodeURIComponent(filename || "");
  if (!/^[A-Za-z0-9._-]+$/.test(decoded)) {
    notFound(response);
    return;
  }
  const target = resolve(join(REPORT_DIR, decoded));
  if (!target.startsWith(resolve(REPORT_DIR)) || !existsSync(target) || !statSync(target).isFile()) {
    notFound(response);
    return;
  }
  const type = contentTypes[extname(target).toLowerCase()] || "application/octet-stream";
  response.writeHead(200, {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `attachment; filename="${decoded.replace(/"/g, "")}"`
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

function folderPickerScript(title) {
  const safeTitle = escapePowerShellLiteral(title);
  return `Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = '${safeTitle}'; $dialog.UseDescriptionForTitle = $true; $dialog.AutoUpgradeEnabled = $true; $dialog.ShowNewFolderButton = $true; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }; $dialog.Dispose()`;
}

async function pickLocalPath(kind) {
  const testPath = kind === "archive"
    ? process.env.PORTAL_TEST_ARCHIVE_PATH
    : process.env.PORTAL_TEST_PICK_PATH;
  if (testPath) return resolve(testPath);

  const isFolder = kind === "folder" || kind === "save_dir";
  const folderTitle = kind === "save_dir" ? "결과 저장 폴더 선택" : "검사할 프로젝트 폴더 선택";
  const utf8Output = "$OutputEncoding = New-Object System.Text.UTF8Encoding($false); [Console]::OutputEncoding = $OutputEncoding\n";
  const script = isFolder
    ? folderPickerScript(folderTitle)
    : "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.OpenFileDialog; $dialog.Title = '검사할 ZIP 파일 선택'; $dialog.Filter = 'ZIP archive (*.zip)|*.zip'; $dialog.Multiselect = $false; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) }; $dialog.Dispose()";
  const picked = await runCommand(POWERSHELL, ["-NoProfile", "-STA", "-Command", `${utf8Output}${script}`], {
    timeout_ms: 300000,
    windowsHide: false
  });
  const selectedPath = picked.stdout.trim();
  if (!selectedPath) {
    throw new Error(picked.stderr.trim() || "선택이 취소되었습니다.");
  }
  if (!existsSync(selectedPath)) {
    throw new Error("선택한 경로를 확인할 수 없습니다.");
  }
  if (isFolder && !statSync(selectedPath).isDirectory()) {
    throw new Error("폴더를 선택해야 합니다.");
  }
  if (!isFolder && (extname(selectedPath).toLowerCase() !== ".zip" || !statSync(selectedPath).isFile())) {
    throw new Error("ZIP 압축파일만 선택할 수 있습니다.");
  }
  return resolve(selectedPath);
}

async function extractZip(archivePath, destination) {
  const archive = escapePowerShellLiteral(archivePath);
  const output = escapePowerShellLiteral(destination);
  const extracted = await runCommand(
    POWERSHELL,
    ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${output}' -Force`],
    { timeout_ms: 300000 }
  );
  if (!extracted.ok) {
    throw new Error(`ZIP 압축을 풀지 못했습니다. ${extracted.stderr || extracted.stdout}`.trim());
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

async function checkerSummary() {
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

async function mcpSummary() {
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

async function executionGateSummary() {
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

async function localStatus() {
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
  if (remote?.status === "current") {
    return { component, status: "current", message: "최신 버전입니다.", github_checked: true };
  }
  if (remote?.status === "update_available") {
    if (local?.dirty || (local?.branch && local.branch !== "main")) {
      return {
        component,
        status: "update_blocked",
        message: local.dirty
          ? "설치 폴더에 미커밋 변경이 있어 자동 업데이트를 진행할 수 없습니다."
          : "공식 main 브랜치가 아닌 설치본이라 자동 업데이트를 진행할 수 없습니다.",
        github_checked: true
      };
    }
    return { component, status: "update_available", message: "업데이트가 필요합니다.", github_checked: true };
  }
  return { component, status: "check_unavailable", message: "GitHub에서 최신 버전을 확인할 수 없습니다. 잠시 후 다시 확인하세요.", github_checked: false };
}

async function simpleVersionStatus(target) {
  if (target === "harness") {
    const sourceDir = harnessSourceDir();
    const local = await gitSummary(sourceDir);
    const remote = local.installed
      ? await remoteMainSummary(sourceDir, local)
      : await officialRemoteSummary(HARNESS_REPOSITORY);
    return simpleVersionResult("하네스", local, remote);
  }

  if (target === "checker") {
    const pipShow = await runCommand("pip.exe", ["show", "vibecode-checker"], { timeout_ms: 10000 });
    const editableMatch = pipShow.stdout.match(/^Editable project location:\s*(.+)$/mi);
    const editablePath = editableMatch?.[1]?.trim() || "";
    if (!editablePath) {
      const version = await runCommand("gvskb", ["version"], { timeout_ms: 10000 });
      return version.ok
        ? { component: "체커", status: "check_unavailable", message: "설치 방식 때문에 GitHub 기준 최신 여부를 확인할 수 없습니다.", github_checked: false }
        : simpleVersionResult("체커", { installed: false }, await officialRemoteSummary(CHECKER_REPOSITORY));
    }
    const local = await gitSummary(editablePath);
    const remote = await remoteMainSummary(editablePath, local);
    return simpleVersionResult("체커", local, remote);
  }

  return { component: "", status: "invalid_target", message: "확인할 대상을 찾을 수 없습니다.", github_checked: false };
}

async function installComponent(target) {
  const version = await simpleVersionStatus(target);
  if (version.status === "check_unavailable") {
    return { status: "blocked", reason: "github_check_required", message: "GitHub 기준을 확인하지 못해 설치를 시작하지 않았습니다. 다시 확인하세요." };
  }
  if (version.status !== "not_installed") {
    return { status: "already_installed", message: "이미 설치되어 있습니다. 설치 버전을 확인하세요." };
  }

  if (target === "harness") {
    mkdirSync(LOCAL_TOOLS_DIR, { recursive: true });
    const cloned = await runCommand("git", ["clone", "--depth", "1", HARNESS_REPOSITORY, LOCAL_HARNESS_DIR], { timeout_ms: 120000 });
    if (!cloned.ok) {
      return { status: "failed", reason: "clone_failed", message: "하네스 공식 저장소를 가져오지 못했습니다.", detail: (cloned.stderr || cloned.stdout).trim().slice(-500) };
    }
    const validated = await runCommand(
      POWERSHELL,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(LOCAL_HARNESS_DIR, "shared", "scripts", "gg-validate.ps1")],
      { cwd: LOCAL_HARNESS_DIR, timeout_ms: 120000 }
    );
    return validated.ok
      ? { status: "installed", message: "하네스 설치와 기본 검증이 완료되었습니다.", location: LOCAL_HARNESS_DIR }
      : { status: "needs_review", reason: "validation_failed", message: "하네스는 설치했지만 기본 검증을 통과하지 못했습니다.", detail: (validated.stderr || validated.stdout).trim().slice(-500) };
  }

  const sourceDir = harnessSourceDir();
  const bootstrap = join(sourceDir, "shared", "scripts", "checker-bootstrap.mjs");
  if (!existsSync(bootstrap)) {
    return { status: "blocked", reason: "harness_bootstrap_missing", message: "체커 설치에 필요한 하네스 설치 파일을 찾지 못했습니다. 하네스를 먼저 설치하세요." };
  }
  mkdirSync(LOCAL_TOOLS_DIR, { recursive: true });
  const installed = await runCommand("node", [bootstrap, "--target", LOCAL_CHECKER_DIR, "--yes", "--install-python"], { timeout_ms: 300000 });
  if (!installed.ok) {
    return { status: "failed", reason: "checker_install_failed", message: "체커 설치를 완료하지 못했습니다. Python 3.11 이상과 pip 설치 상태를 확인하세요.", detail: (installed.stderr || installed.stdout).trim().slice(-500) };
  }
  const doctor = await runCommand("gvskb", ["doctor"], { timeout_ms: 120000 });
  return doctor.ok
    ? { status: "installed", message: "체커 설치와 상태 점검이 완료되었습니다.", location: LOCAL_CHECKER_DIR }
    : { status: "needs_review", reason: "doctor_failed", message: "체커는 설치했지만 상태 점검을 통과하지 못했습니다.", detail: (doctor.stderr || doctor.stdout).trim().slice(-500) };
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

async function registerMcp(target) {
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

async function updatePreview() {
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

async function applyUpdates(targets = ["harness", "checker"]) {
  const preview = await updatePreview();
  const requestedTargets = targets.filter((target) => target === "harness" || target === "checker");
  const eligibleTargets = requestedTargets.length ? requestedTargets : ["harness", "checker"];
  const blockedTargets = preview.blocked_targets.filter((target) => eligibleTargets.includes(target));
  if (blockedTargets.length) {
    return {
      status: "blocked",
      reason: "update_not_eligible",
      blocked_targets: blockedTargets,
      blocked_reasons: Object.fromEntries(blockedTargets.map((target) => [target, preview.blocked_reasons[target]]))
    };
  }

  const results = [];
  for (const item of preview.items.filter((candidate) => eligibleTargets.includes(candidate.target))) {
    const repoPath = item.target === "harness" ? harnessSourceDir() : (await checkerSummary()).source?.path;
    if (!repoPath || !existsSync(repoPath)) {
      results.push({ target: item.target, status: "manual_update_required", reason: "editable_git_checkout_missing" });
      continue;
    }
    const pulled = await runCommand("git", ["-C", repoPath, "pull", "--ff-only", "origin", "main"], { timeout_ms: 120000 });
    results.push({ target: item.target, status: pulled.ok ? "updated_or_current" : "failed", detail: (pulled.stderr || pulled.stdout).trim().slice(-500) });
  }

  const harnessValidation = eligibleTargets.includes("harness")
    ? await runCommand(
      POWERSHELL,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(harnessSourceDir(), "shared", "scripts", "gg-validate.ps1")],
      { cwd: harnessSourceDir(), timeout_ms: 120000 }
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

function createJob(mode, targetType, targetRef, saveDir = "", targetLabel = "") {
  const id = randomUUID();
  const job = {
    id,
    mode,
    target_type: targetType,
    target_ref: targetRef,
    target_label: safeReportNamePart(targetLabel),
    save_dir: saveDir,
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

async function saveReportsToDirectory(job, reports) {
  if (!job.save_dir) return [];
  const destination = resolve(job.save_dir);
  if (!existsSync(destination) || !statSync(destination).isDirectory()) {
    throw new Error("The selected report directory is unavailable.");
  }
  const saved = [];
  const total = reports.length;
  updateJob(job, { save_progress: { completed: 0, total } });
  for (const [index, report] of reports.entries()) {
    const source = resolve(report.path);
    const target = resolve(join(destination, report.file_name));
    const destinationRelative = relative(destination, target);
    if (destinationRelative.startsWith("..") || isAbsolute(destinationRelative)) {
      throw new Error("The report destination is invalid.");
    }
    await copyFile(source, target);
    saved.push({ file_name: report.file_name, saved_to: target });
    updateJob(job, { save_progress: { completed: index + 1, total } });
  }
  return saved;
}

function updateJob(job, patch) {
  Object.assign(job, patch);
  job.updated_at = new Date().toISOString();
}

const scanStepProgress = {
  prepare_target: { percent: 16, message: "검사 대상을 준비하고 있습니다." },
  code_scan: { percent: 62, message: "체커가 코드와 의존성을 점검하고 있습니다." },
  render_report: { percent: 86, message: "검사 보고서를 만들고 있습니다." },
  save_reports: { percent: 96, message: "선택한 PC 폴더에 결과를 저장하고 있습니다." }
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
    if (active.name === "save_reports") {
      const completed = Number(job.save_progress?.completed || 0);
      const total = Number(job.save_progress?.total || 0);
      const percent = total ? Math.min(99, 96 + Math.floor((completed / total) * 3)) : 96;
      return { percent, message: `결과물 ${completed}/${total}개를 선택한 위치에 저장하고 있습니다.`, elapsed_seconds: elapsed };
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

async function prepareScanTarget(job) {
  if (job.target_type === "folder" || job.target_type === "browser_folder") {
    const targetPath = resolve(String(job.target_ref || ""));
    if (!targetPath || !existsSync(targetPath)) {
      throw new Error("검사 대상을 찾지 못했습니다.");
    }
    if (job.target_type === "browser_folder") job.temporary_paths.push(targetPath);
    return targetPath;
  }

  if (job.target_type === "archive" || job.target_type === "browser_archive") {
    const archivePath = resolve(String(job.target_ref || ""));
    if (!existsSync(archivePath) || !statSync(archivePath).isFile()) {
      throw new Error("The selected archive is unavailable.");
    }
    if (extname(archivePath).toLowerCase() !== ".zip") {
      throw new Error("Only ZIP archives are supported.");
    }
    mkdirSync(TMP_DIR, { recursive: true });
    const extractedDir = join(TMP_DIR, `${job.id}-archive`);
    await rm(extractedDir, { recursive: true, force: true });
    mkdirSync(extractedDir, { recursive: true });
    job.temporary_paths.push(extractedDir);
    if (job.target_type === "browser_archive") job.temporary_paths.push(dirname(archivePath));
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
      throw new Error(`GitHub 저장소를 가져오지 못했습니다: ${clone.stderr || clone.stdout}`);
    }
    job.temporary_paths.push(cloneDir);
    return cloneDir;
  }

  throw new Error("압축파일 검사는 업로드 저장소와 해제 검증 구현 후 연결합니다.");
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

  if (job.save_dir) {
    updateJob(job, {
      steps: [
        { name: "prepare_target", status: "completed" },
        { name: "code_scan", status: scan.ok || parsed ? "completed" : "failed" },
        { name: "render_report", status: finalReportItems.length > 0 ? "completed" : "pending" },
        { name: "save_reports", status: "running" }
      ]
    });
  }
  let savedReports = [];
  let saveError = null;
  try {
    savedReports = await saveReportsToDirectory(job, finalReportItems);
  } catch (error) {
    saveError = String(error.message || error);
  }

  updateJob(job, {
    status: scan.ok || parsed ? "completed" : "failed",
    decision,
    steps: [
      { name: "prepare_target", status: "completed" },
      { name: "code_scan", status: scan.ok || parsed ? "completed" : "failed" },
      { name: "render_report", status: finalReportItems.length > 0 ? "completed" : "pending" },
      ...(job.save_dir ? [{ name: "save_reports", status: saveError ? "failed" : "completed" }] : [{ name: "save_reports", status: "skipped" }])
    ],
    reports: finalReportItems,
    saved_reports: savedReports,
    report_save_error: saveError,
    checker_exit_code: scan.code,
    checker_stdout_tail: scan.stdout.split(/\r?\n/).filter(Boolean).slice(-12),
    checker_stderr_tail: scan.stderr.split(/\r?\n/).filter(Boolean).slice(-12),
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

async function saveAdminExport(saveDir) {
  const destination = resolve(String(saveDir || ""));
  if (!saveDir || !existsSync(destination) || !statSync(destination).isDirectory()) {
    throw new Error("저장할 폴더를 확인할 수 없습니다. 폴더를 다시 선택하세요.");
  }
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
  const fileName = `${timestamp}_관리자점검현황.json`;
  const target = resolve(join(destination, fileName));
  const destinationRelative = relative(destination, target);
  if (destinationRelative.startsWith("..") || isAbsolute(destinationRelative)) {
    throw new Error("선택한 폴더에 보고서를 저장할 수 없습니다.");
  }
  await writeFile(target, `${JSON.stringify(adminExportPayload(), null, 2)}\n`, "utf8");
  return { file_name: fileName, saved_location_label: basename(destination) || destination };
}

function publicJob(job) {
  const targetLabel = job.target_type === "github_url"
    ? "GitHub repository"
    : job.target_type === "archive" || job.target_type === "browser_archive"
      ? "Local ZIP archive"
      : "Local folder";
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
    saved_reports: (job.saved_reports || []).map(({ file_name }) => ({ file_name })),
    saved_location_label: job.saved_reports?.length ? basename(job.save_dir) || job.save_dir : null,
    report_save_error: job.report_save_error || null,
    created_at: job.created_at,
    updated_at: job.updated_at || null,
    error: job.error || null
  };
}

async function startScan(request, response) {
  const body = await readJson(request);
  const mode = ["quick", "standard"].includes(body.scan_mode) ? body.scan_mode : "standard";
  const targetType = ["folder", "archive", "github_url", "browser_folder", "browser_archive"].includes(body.target_type) ? body.target_type : "folder";
  const saveDir = body.save_dir ? resolve(String(body.save_dir)) : "";
  const job = createJob(mode, targetType, body.target_ref, saveDir, body.target_label);

  runScanJob(job).catch(async (error) => {
    updateJob(job, {
      status: "failed",
      decision: "blocked",
      error: String(error.message || error)
    });
    await cleanupJobTargets(job);
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
    const body = await readJson(request);
    if (body.id !== ADMIN_ID || !verifyPassword(body.password)) {
      json(response, 401, { error: "invalid_admin_credentials", message: "아이디 또는 비밀번호를 확인하세요." });
      return;
    }
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

  if (request.method === "GET" && pathname === "/api/local/status") {
    json(response, 200, await localStatus());
    return;
  }

  if (request.method === "GET" && pathname === "/api/local/version-status") {
    const target = new URL(request.url || "/", "http://localhost").searchParams.get("target");
    if (target !== "harness" && target !== "checker") {
      json(response, 400, { error: "invalid_version_target" });
      return;
    }
    json(response, 200, await simpleVersionStatus(target));
    return;
  }

  if (request.method === "POST" && pathname === "/api/local/update/preview") {
    json(response, 200, await updatePreview());
    return;
  }

  if (request.method === "POST" && pathname === "/api/local/update/apply") {
    const body = await readJson(request);
    if (body.approval_token !== "user-confirmed") {
      json(response, 409, { status: "blocked", reason: "approval_required" });
      return;
    }
    const result = await applyUpdates(Array.isArray(body.targets) ? body.targets : undefined);
    await writeGateOperation("update", Array.isArray(body.targets) ? body.targets.join(",") : "all", result);
    json(response, 200, result);
    return;
  }

  if (request.method === "POST" && pathname === "/api/local/component/install") {
    const body = await readJson(request);
    const target = body.target === "harness" || body.target === "checker" ? body.target : "";
    if (!target) {
      json(response, 400, { error: "invalid_install_target", message: "설치할 대상을 찾지 못했습니다." });
      return;
    }
    if (body.approval_token !== "user-confirmed") {
      json(response, 409, { status: "blocked", reason: "approval_required", message: "설치 전 사용자 확인이 필요합니다." });
      return;
    }
    const result = await installComponent(target);
    await writeGateOperation("install", target, result);
    json(response, 200, result);
    return;
  }

  if (request.method === "POST" && pathname === "/api/local/pick-target") {
    const body = await readJson(request);
    const kind = ["folder", "archive", "save_dir"].includes(body.kind) ? body.kind : "";
    if (!kind) {
      json(response, 400, { error: "invalid_picker_kind" });
      return;
    }
    try {
      const selectedPath = await pickLocalPath(kind);
      json(response, 200, {
        status: "selected",
        path: selectedPath,
        label: kind === "archive" ? basename(selectedPath) : basename(selectedPath) || selectedPath
      });
    } catch (error) {
      json(response, 409, { status: "cancelled", error: String(error.message || error) });
    }
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

  if (request.method === "POST" && pathname === "/api/local/mcp/register") {
    const body = await readJson(request);
    const target = ["codex", "claude-code", "claude-desktop"].includes(body.target) ? body.target : "codex";
    if (body.approval_token !== "user-confirmed") {
      const mcp = await mcpSummary();
      json(response, 200, {
        status: mcp.tools[target]?.status === "registered" ? "already_registered" : "needs_user_approval",
        target,
        connection: mcp.tools[target],
        applies_without_approval: false,
        next_action: "체커 실행 명령과 설정 파일을 확인한 뒤 사용자 승인으로 등록합니다."
      });
      return;
    }
    const result = await registerMcp(target);
    await writeGateOperation("mcp_register", target, result);
    const mcp = await mcpSummary();
    json(response, 200, { target, ...result, connection: mcp.tools[target] });
    return;
  }

  if (request.method === "GET" && pathname === "/api/local/mcp/status") {
    const target = new URL(request.url || "/", "http://localhost").searchParams.get("target");
    const mcp = await mcpSummary();
    if (target && !Object.hasOwn(mcp.tools, target)) {
      json(response, 400, { error: "invalid_mcp_target", message: "확인할 AI 도구가 올바르지 않습니다." });
      return;
    }
    json(response, 200, target ? { target, connection: mcp.tools[target] } : mcp);
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

  if (request.method === "POST" && pathname === "/api/admin/export") {
    if (!requireAdmin(request, response)) return;
    try {
      const body = await readJson(request);
      json(response, 200, { status: "saved", ...(await saveAdminExport(body.save_dir)) });
    } catch (error) {
      json(response, 400, { error: "admin_export_failed", message: String(error.message || error) });
    }
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
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/health" || url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url.pathname);
      return;
    }

    const reportMatch = url.pathname.match(/^\/reports\/(.+)$/);
    if (reportMatch) {
      serveReport(response, reportMatch[1]);
      return;
    }

    if (url.pathname === "/admin" && !isAdminAuthenticated(request)) {
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
