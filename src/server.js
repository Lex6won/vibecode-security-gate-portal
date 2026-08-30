import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { appendFile, rename, rm, readdir, readFile, stat, statfs, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { pipeline } from "node:stream/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicKey, randomBytes, randomUUID, scryptSync, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import Busboy from "busboy";
import { initObservationStore, toObservationRecord, hasSubmission, recordSubmission, observationSummary, usageStatsSnapshot, observationRecordsSnapshot } from "./observation-store.mjs";
import { initWhitelistStore, whitelistStatus, setWhitelistEntry, whitelistSnapshot, whitelistSummary, recordWhitelistExport } from "./whitelist-store.mjs";
import {
  initAccountStore, recordAuthAudit, normalizeEmail, isValidEmail, emailDomainAllowed,
  linkRequestAllowed, getAccount, createLoginToken, consumeLoginToken,
  upsertAccountOnLogin, updateAccountProfile, accountSummary
} from "./account-store.mjs";
import { writeZipEntries } from "./hwpx-template.mjs";
import { dependencyRiskSummary } from "./scan-summary.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");
const DESIGN_DIR = join(ROOT, "design", "html-prototype");
const TMP_DIR = join(ROOT, "tmp", "scan-targets");
function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return {};
  return Object.fromEntries(readFileSync(filePath, "utf8").split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) return [];
    return [[match[1], match[2].replace(/^['"]|['"]$/g, "")]];
  }));
}

const runtimeEnv = { ...loadDotEnv(join(ROOT, ".env")), ...process.env };
const PORT = Number(runtimeEnv.PORT || 8787);
// 서버 프로파일: 기본은 로컬 단독(127.0.0.1)이며, 집/기관 서버에서는 .env 로
// 바인드 주소와 접속 호스트 허용목록을 명시해야만 외부 접속이 열린다.
// (config/server.env.example 참고 — 기본값을 바꾸지 않는 한 기존 동작과 동일)
const BIND_HOST = runtimeEnv.PORTAL_BIND_HOST || "127.0.0.1";
const EXTRA_ALLOWED_HOSTS = String(runtimeEnv.PORTAL_ALLOWED_HOSTS || "")
  .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
// External Git URLs stay constrained to approved hosts, not arbitrary network locations.
const ALLOWED_GIT_REPOSITORY_HOSTS = new Set(["github.com", "gitlab.aigov.go.kr"]);
const POWERSHELL = join(runtimeEnv.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const MAX_BROWSER_UPLOAD_BYTES = 500 * 1024 * 1024;
const MAX_BROWSER_UPLOAD_FILES = 10000;

// S2(동시성): 체커는 CPU·메모리를 크게 쓰므로 동시 실행을 제한하고 초과분은 큐에 세운다.
const MAX_CONCURRENT_SCANS = Math.max(1, Number(runtimeEnv.PORTAL_MAX_CONCURRENT_SCANS || Math.min(4, cpus().length - 2)) || 1);
const SCAN_QUEUE_LIMIT = Math.max(1, Number(runtimeEnv.PORTAL_SCAN_QUEUE_LIMIT || 20));
const SCAN_TIMEOUT_QUICK_MS = Number(runtimeEnv.PORTAL_SCAN_TIMEOUT_QUICK_MS || 5 * 60 * 1000);
const SCAN_TIMEOUT_STANDARD_MS = Number(runtimeEnv.PORTAL_SCAN_TIMEOUT_STANDARD_MS || 20 * 60 * 1000);
const MIN_FREE_DISK_BYTES = Number(runtimeEnv.PORTAL_MIN_FREE_DISK_BYTES || 2 * 1024 * 1024 * 1024);

// P5(보존정책): 보고서는 기본 90일 보관 후 자동 삭제한다. 0 이면 자동 삭제 없음.
// 기관 정책이 확정되면 이 값(PORTAL_REPORT_RETENTION_DAYS)만 바꾼다 — 화면 고지도 함께 바뀐다.
const REPORT_RETENTION_DAYS = Math.max(0, Number(runtimeEnv.PORTAL_REPORT_RETENTION_DAYS ?? 90) || 0);
const DRAFT_REPORT_RETENTION_HOURS = Math.max(1, Number(runtimeEnv.PORTAL_DRAFT_REPORT_RETENTION_HOURS ?? 24) || 24);
const KOREA_TIME_ZONE = "Asia/Seoul";
const koreaDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: KOREA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

function koreaDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = Object.fromEntries(koreaDateFormatter.formatToParts(date)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function koreaDayBoundary(dateKey, endOfDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return NaN;
  return Date.parse(`${dateKey}T${endOfDay ? "23:59:59.999" : "00:00:00"}+09:00`);
}

function runtimePath(name, fallback) {
  const value = runtimeEnv[name];
  return value && isAbsolute(value) ? value : fallback;
}
const ADMIN_ID = runtimeEnv.ADMIN_ID || "gg0018@gg.go.kr";
const ADMIN_AUTH_FILE = isAbsolute(runtimeEnv.ADMIN_AUTH_FILE || "")
  ? runtimeEnv.ADMIN_AUTH_FILE
  : join(ROOT, runtimeEnv.ADMIN_AUTH_FILE || ".local/admin-auth.json");
// 기본값은 기존 해시를 유지한다. 두 환경의 관리자 계정을 같은 .env 값으로
// 맞춰야 할 때에만 명시적으로 동기화한다.
const ADMIN_CREDENTIALS_SYNC = runtimeEnv.ADMIN_CREDENTIALS_SYNC === "true";
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEVELOPMENT_PLACEHOLDER_PROFILE = { organization: "개발 검증", department: "보안점검" };
const adminSessions = new Map();
const LOCAL_API_TOKEN = runtimeEnv.PORTAL_LOCAL_API_TOKEN || randomBytes(32).toString("hex");
const LOCAL_HOSTS = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  ...EXTRA_ALLOWED_HOSTS
]);
const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 50000;
const MAX_COMPRESSION_RATIO = 200;
const SCAN_HISTORY_FILE = runtimePath("PORTAL_SCAN_HISTORY_FILE", join(ROOT, ".local", "scan-history.jsonl"));
const REPORT_DIR = runtimePath("PORTAL_REPORT_DIR", join(ROOT, "reports"));
const DRAFT_REPORT_DIR = runtimePath("PORTAL_DRAFT_REPORT_DIR", join(ROOT, "tmp", "scan-reports"));
const LOGIN_LOCK_THRESHOLD = 5;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
const loginFailures = { count: 0, locked_until: 0 };

// P3(계정): 매직링크 가입·로그인. 기관 프로파일 — 허용 이메일 도메인은 설정으로 교체 가능.
const ALLOWED_EMAIL_DOMAINS = String(runtimeEnv.PORTAL_ALLOWED_EMAIL_DOMAINS || "gg.go.kr,korea.kr")
  .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
// SMTP 미확정(§9): 개발 모드는 링크를 응답으로 돌려줘 화면에 표시한다. 실발송 어댑터는 SMTP 확정 후.
const AUTH_DEV_MODE = runtimeEnv.PORTAL_AUTH_MODE !== "smtp";
const LOCAL_DEVELOPMENT_AUTH = AUTH_DEV_MODE && ["127.0.0.1", "localhost", "::1"].includes(BIND_HOST);

// ---- Cloudflare Access 연동(선택) -------------------------------------------
// 터널(portal.<도메인>) 관문을 통과한 요청에는 Cloudflare 가 서명한 JWT 헤더
// (Cf-Access-Jwt-Assertion)가 붙는다. 이를 공개키로 검증해 포털 로그인을 대체한다.
// 두 값이 모두 설정된 경우에만 동작한다 — LAN 접속(헤더 없음)은 기존 매직링크 그대로.
// 헤더는 위조 가능하므로 서명·발급자·대상(aud)·만료를 전부 검증한다. 검증 실패 = 없는 것으로 취급.
const ACCESS_TEAM_DOMAIN = String(runtimeEnv.PORTAL_ACCESS_TEAM_DOMAIN || "").trim();
const ACCESS_AUD = String(runtimeEnv.PORTAL_ACCESS_AUD || "").trim();
const ACCESS_BASE = ACCESS_TEAM_DOMAIN
  ? (ACCESS_TEAM_DOMAIN.startsWith("http://") || ACCESS_TEAM_DOMAIN.startsWith("https://")
      ? ACCESS_TEAM_DOMAIN.replace(/\/$/, "")
      : `https://${ACCESS_TEAM_DOMAIN}`)
  : "";
const ACCESS_ENABLED = Boolean(ACCESS_BASE && ACCESS_AUD);
const ACCESS_CERTS_TTL_MS = 60 * 60 * 1000;
let accessCertsCache = { at: 0, keys: null };

function base64UrlToBuffer(value) {
  return Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

async function fetchAccessKeys() {
  if (accessCertsCache.keys && Date.now() - accessCertsCache.at < ACCESS_CERTS_TTL_MS) {
    return accessCertsCache.keys;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${ACCESS_BASE}/cdn-cgi/access/certs`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`http_${response.status}`);
    const jwks = await response.json();
    const keys = new Map();
    for (const jwk of jwks.keys || []) {
      if (jwk.kty === "RSA" && jwk.kid) keys.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
    }
    if (keys.size) accessCertsCache = { at: Date.now(), keys };
    return accessCertsCache.keys;
  } catch {
    // 조회 실패 시 이전 키가 있으면 그대로 쓴다(로그인 가용성) — 없으면 검증 불가로 거부.
    return accessCertsCache.keys;
  }
}

async function accessEmailFromRequest(request) {
  if (!ACCESS_ENABLED) return null;
  const token = String(request.headers["cf-access-jwt-assertion"] || "");
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(base64UrlToBuffer(parts[0]).toString("utf8"));
    const payload = JSON.parse(base64UrlToBuffer(parts[1]).toString("utf8"));
    if (header.alg !== "RS256") return null;
    const keys = await fetchAccessKeys();
    const key = keys?.get(header.kid);
    if (!key) return null;
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`, "utf8");
    if (!cryptoVerify("RSA-SHA256", signed, key, base64UrlToBuffer(parts[2]))) return null;
    const now = Math.floor(Date.now() / 1000);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== ACCESS_BASE) return null;
    if (!audiences.includes(ACCESS_AUD)) return null;
    if (!(Number(payload.exp) > now - 30)) return null;
    if (payload.nbf && !(Number(payload.nbf) <= now + 30)) return null;
    const email = normalizeEmail(String(payload.email || ""));
    if (!isValidEmail(email) || !emailDomainAllowed(email, ALLOWED_EMAIL_DOMAINS)) return null;
    return email;
  } catch {
    return null;
  }
}
const USER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const USER_CONCURRENT_SCANS = Math.max(1, Number(runtimeEnv.PORTAL_USER_CONCURRENT_SCANS || 1));
const userSessions = new Map();

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
    if (ADMIN_CREDENTIALS_SYNC) {
      const initialPassword = runtimeEnv.ADMIN_INITIAL_PASSWORD;
      if (!initialPassword || initialPassword.length < 12) {
        throw new Error("ADMIN_CREDENTIALS_SYNC=true에는 12자 이상의 ADMIN_INITIAL_PASSWORD가 필요합니다.");
      }
      if (!verifyPassword(initialPassword, stored)) {
        const { salt, hash } = passwordRecord(initialPassword);
        const synced = { ...stored, salt, hash, password_changed_at: new Date().toISOString() };
        saveAdminCredentials(synced);
        return synced;
      }
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
    // Repository addresses are retained only as normalized Git targets so a user's own history
    // can identify the scanned project after a server restart. Local source paths are never kept.
    target_ref: job.target_type === "github_url" ? String(job.target_ref || "") : undefined,
    target_label: job.target_label || "",
    status: job.status,
    decision: job.decision,
    summary: job.summary || null,
    steps: job.steps || [],
    reports: (job.reports || []).map(({ file_name, path, url }) => ({ file_name, path, url })),
    draft_reports: (job.draft_reports || []).map(({ file_name, path, url }) => ({ file_name, path, url })),
    report_stem: job.report_stem || null,
    draft_expires_at: job.draft_expires_at || null,
    draft_expired: job.draft_expired === true,
    report_render_error: job.report_render_error || null,
    observations_submitted_at: job.observations_submitted_at || null,
    // P3: 소유자와 점검 시점의 소속 스냅샷. 이후 프로필을 바꿔도 이 값은 불변이다(연동합의).
    owner_email: job.owner_email || null,
    owner_organization: job.owner_organization || null,
    owner_department: job.owner_department || null,
    review_request: job.review_request || null,
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
        if (record?.id) {
          const job = { temporary_paths: [], ...record };
          refreshDependencySummaryFromStoredReport(job);
          jobs.set(record.id, job);
        }
      } catch {
        // Skip corrupted lines instead of losing the whole history.
      }
    }
  } catch {
    // A broken history file must not prevent the portal from starting.
  }
}

function refreshDependencySummaryFromStoredReport(job) {
  const artifacts = [...(job.draft_reports || []), ...(job.reports || [])];
  const jsonReport = artifacts.find((report) => (
    String(report?.file_name || "").endsWith(".json")
      && !String(report?.file_name || "").endsWith(".sbom.cdx.json")
      && typeof report?.path === "string"
      && [REPORT_DIR, DRAFT_REPORT_DIR].some((directory) => pathInside(directory, report.path))
  ));
  if (!jsonReport || !existsSync(jsonReport.path)) return;

  try {
    const parsed = JSON.parse(readFileSync(jsonReport.path, "utf8"));
    const dependencyRisk = dependencyRiskSummary(parsed?.dependency_audit);
    job.summary = {
      ...(job.summary || {}),
      dependency_finding_count: dependencyRisk.vulnerable_package_count,
      dependency_advisory_count: dependencyRisk.advisory_count,
      dependency_review_count: dependencyRisk.review_package_count
    };
  } catch {
    // A missing or malformed historical report must not hide the scan history.
  }
}

loadScanHistory();
initObservationStore(runtimePath("PORTAL_OBSERVATION_DIR", join(ROOT, ".local", "observations")));
initAccountStore(runtimePath("PORTAL_ACCOUNT_DIR", join(ROOT, ".local", "accounts")));
initWhitelistStore(runtimePath("PORTAL_WHITELIST_DIR", join(ROOT, ".local", "whitelist")));

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

// P5(보존정책): 보존기한이 지난 보고서를 삭제한다. 화면 고지("N일 보관 후 자동 삭제")와
// 실제 동작을 일치시키는 장치다 — 무기한 축적은 상시 서버에서 디스크 사고가 된다.
async function purgeExpiredReports() {
  if (REPORT_RETENTION_DAYS <= 0 || !existsSync(REPORT_DIR)) return;
  const cutoff = Date.now() - REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of await readdir(REPORT_DIR)) {
    const target = join(REPORT_DIR, entry);
    try {
      const info = await stat(target);
      if (info.isFile() && info.mtimeMs < cutoff) {
        await rm(target, { force: true });
        removed += 1;
      }
    } catch {
      // 하나가 잠겨 있어도 나머지 정리는 계속한다.
    }
  }
  if (removed) console.log(`보존기한(${REPORT_RETENTION_DAYS}일)이 지난 보고서 ${removed}개를 삭제했습니다.`);
}

function artifactKind(fileName) {
  if (fileName.endsWith("_보안성검토제출자료.zip")) return "submission_package";
  if (fileName.endsWith("_보안성검토요청서.html")) return "review_request";
  if (fileName.endsWith(".sbom.cdx.json")) return "sbom";
  if (fileName.endsWith(".html")) return "html_report";
  if (fileName.endsWith(".md")) return "markdown_report";
  return "json_report";
}

const LANGUAGE_BY_EXTENSION = new Map([
  [".js", "JavaScript"], [".mjs", "JavaScript"], [".cjs", "JavaScript"],
  [".ts", "TypeScript"], [".tsx", "TypeScript"], [".jsx", "JavaScript"],
  [".py", "Python"], [".java", "Java"], [".kt", "Kotlin"],
  [".cs", "C#"], [".go", "Go"], [".rb", "Ruby"], [".php", "PHP"],
  [".rs", "Rust"], [".c", "C"], [".h", "C"], [".cc", "C++"], [".cpp", "C++"],
  [".vue", "Vue"], [".svelte", "Svelte"], [".swift", "Swift"], [".sql", "SQL"]
]);

function languageCountsFromReport(parsed) {
  const counts = {};
  const reported = parsed?.language;
  if (reported && typeof reported === "object" && !Array.isArray(reported)) {
    for (const [language, count] of Object.entries(reported)) {
      if (Number(count) > 0) counts[String(language)] = Number(count);
    }
  }
  for (const file of parsed?.scanned_files || []) {
    const extension = extname(String(file || "")).toLowerCase();
    const language = LANGUAGE_BY_EXTENSION.get(extension);
    if (language) counts[language] = (counts[language] || 0) + 1;
  }
  return counts;
}

function isSafeReportFileName(fileName) {
  return /^[\p{L}\p{N} ._-]+$/u.test(fileName) && !fileName.includes("..");
}

function pathInside(directory, candidate) {
  const root = resolve(directory);
  const target = resolve(candidate);
  return target.startsWith(root + sep);
}

async function purgeExpiredDraftReports() {
  const now = Date.now();
  const expiredJobs = Array.from(jobs.values()).filter((job) => {
    if (job.review_request || !(job.draft_reports || []).length) return false;
    const expiry = Date.parse(job.draft_expires_at || "");
    return Number.isFinite(expiry) && expiry <= now;
  });
  for (const job of expiredJobs) {
    await Promise.all((job.draft_reports || []).map(async (report) => {
      if (report.path && pathInside(DRAFT_REPORT_DIR, report.path)) {
        await rm(report.path, { force: true }).catch(() => {});
      }
    }));
    updateJob(job, { draft_reports: [], draft_expired: true });
    await persistJob(job);
  }
}

await purgeExpiredReports().catch(() => {});
await purgeExpiredDraftReports().catch(() => {});
setInterval(() => {
  purgeExpiredReports().catch(() => {});
  purgeExpiredDraftReports().catch(() => {});
}, 6 * 60 * 60 * 1000).unref();

const staticRoutes = new Map([
  ["/", "main page.html"],
  ["/first-screen-gg-v2-1.html", "main page.html"],
  ["/scan", "security-scan.html"],
  ["/my", "my-scans.html"],
  ["/harness", "tools.html"],
  ["/tools", "tools.html"],
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

// P3(계정): 일반 사용자 세션 — 매직링크 인증 후 발급되는 HttpOnly 쿠키.
function createUserSession(email) {
  const token = randomBytes(32).toString("hex");
  userSessions.set(token, { email, expires_at: Date.now() + USER_SESSION_TTL_MS });
  return `portal_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${USER_SESSION_TTL_MS / 1000}`;
}

function currentUser(request) {
  const token = cookieValue(request, "portal_session");
  const session = userSessions.get(token);
  if (!session) return null;
  if (session.expires_at <= Date.now()) {
    userSessions.delete(token);
    return null;
  }
  return getAccount(session.email);
}

function requireUser(request, response) {
  const account = currentUser(request);
  if (!account) {
    json(response, 401, { error: "login_required", message: "이메일 인증 후 이용할 수 있습니다." });
    return null;
  }
  return account;
}

// 소유자 검증: 남의 검사는 존재 여부도 알리지 않는다(404). 관리자는 전체 열람.
function canViewJob(request, job) {
  if (isAdminAuthenticated(request)) return true;
  const account = currentUser(request);
  if (!account) return false;
  return Boolean(job.owner_email) && job.owner_email === account.email;
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
    // https 는 터널·리버스프록시 뒤에서 허용 호스트로 접속할 때 필요하다.
    return (url.protocol === "http:" || url.protocol === "https:") && LOCAL_HOSTS.has(url.host.toLowerCase());
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
    json(response, 421, { error: "local_host_required", message: "허용된 포털 주소로만 요청할 수 있습니다." });
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
  const root = resolve(DESIGN_DIR);
  // 경계는 디렉터리 구분자까지 확인한다 — 접두어만 보면 형제 폴더(html-prototype-v2 등)가 새어 나간다.
  if (resolved !== root && !resolved.startsWith(root + sep)) return null;
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
    "X-Frame-Options": "DENY",
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

function serveStoredArtifact(response, directory, filename, viewInline = false) {
  let decoded = "";
  try {
    decoded = decodeURIComponent(filename || "");
  } catch {
    notFound(response);
    return;
  }
  // 공백 허용: 보고서 파일명은 사용자가 붙인 라벨(공백 포함)로 만들어진다.
  // 경로 문자는 여전히 불허 — 아래 resolve 경계 검사와 이중 방어.
  if (!isSafeReportFileName(decoded)) {
    notFound(response);
    return;
  }
  const target = resolve(join(directory, decoded));
  if (!pathInside(directory, target) || !existsSync(target) || !statSync(target).isFile()) {
    notFound(response);
    return;
  }
  const type = contentTypes[extname(target).toLowerCase()] || "application/octet-stream";
  const asciiFilename = decoded.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  response.writeHead(200, {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `${viewInline ? "inline" : "attachment"}; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(decoded)}`
  });
  createReadStream(target).pipe(response);
}

function serveReport(response, filename, viewInline = false) {
  serveStoredArtifact(response, REPORT_DIR, filename, viewInline);
}

function serveDraftArtifact(response, filename, viewInline = false) {
  serveStoredArtifact(response, DRAFT_REPORT_DIR, filename, viewInline);
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

// P5 후속: 하네스가 게시하는 release-index.json 을 실시간으로 읽어와 설치 안내에 반영한다.
// 하드코딩하지 않는 이유 — 정식 서명본으로 바뀌면(installer_published) 하네스 쪽 JSON만
// 바뀌고 포털 코드는 그대로다. Lovable 은 보안부서 정책 확인 전까지 표기하지 않는다(연동합의 2차 개정).
const HARNESS_RELEASE_URL = runtimeEnv.PORTAL_HARNESS_RELEASE_URL
  || "https://lex6won.github.io/vibecode-harness/releases/release-index.json";
const HARNESS_RELEASE_CACHE_MS = 5 * 60 * 1000;
const HARNESS_TOOL_LABELS = {
  codex: "Codex CLI",
  "claude-code": "Claude Code",
  "google-antigravity": "Google Antigravity",
  "claude-desktop": "Claude 데스크톱",
  "chatgpt-codex-desktop": "ChatGPT 데스크톱"
  // lovable-github: 보안부서 정책 확인 전까지 의도적으로 미표기.
};
let harnessReleaseCache = { at: 0, value: null };

// 외부 피드에서 온 값을 그대로 링크로 쓰지 않는다. https 가 아닌 주소(javascript: 등)는
// 버리고 null 로 만든다 — 화면은 download_url 이 없으면 "확인할 수 없습니다"로 닫히므로
// 피드가 오염돼도 사용자에게 위험한 링크가 뜨지 않는다.
function safeInstallerUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

async function fetchHarnessRelease() {
  if (Date.now() - harnessReleaseCache.at < HARNESS_RELEASE_CACHE_MS && harnessReleaseCache.value) {
    return harnessReleaseCache.value;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(HARNESS_RELEASE_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`http_${response.status}`);
    const data = await response.json();
    const supportedTools = (data.capabilities?.supported_tools || [])
      .filter((tool) => Object.hasOwn(HARNESS_TOOL_LABELS, tool))
      .map((tool) => ({ id: tool, label: HARNESS_TOOL_LABELS[tool] }));
    const value = {
      available: true,
      status: data.status || null,
      is_demo: String(data.status || "").includes("demo"),
      message: data.message || null,
      version: data.installer?.version || null,
      download_url: safeInstallerUrl(data.installer?.download_url),
      sha256: data.installer?.sha256 || null,
      signature_status: data.installer?.signature_status || null,
      expires_at: data.installer?.expires_at || null,
      supported_tools: supportedTools
    };
    harnessReleaseCache = { at: Date.now(), value };
    return value;
  } catch {
    // 확인 실패는 정직하게 "확인 불가"로 보고한다 — 최신처럼 보이게 하지 않는다.
    const value = { available: false };
    harnessReleaseCache = { at: Date.now(), value };
    return value;
  }
}

function safeReportNamePart(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
}

function targetLabelForDisplay(targetType, targetRef, targetLabel = "") {
  if (targetType === "github_url") {
    try {
      const url = new URL(String(targetRef || ""));
      const path = url.pathname.replace(/\.git$/i, "").replace(/\/$/, "");
      if (url.hostname && path) return `${url.hostname}${path}`;
    } catch {
      // The scan request validates repository URLs later. Keep the supplied label for the error path.
    }
  }
  return String(targetLabel || "").trim().slice(0, 160);
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
      const pathParts = new URL(String(job.target_ref)).pathname.split("/").filter(Boolean);
      targetName = safeReportNamePart(String(pathParts.at(-1) || "").replace(/\.git$/i, ""));
    } catch {
      targetName = "";
    }
  }
  if (!targetName) targetName = safeReportNamePart(job.target_label);
  if (!targetName) targetName = safeReportNamePart(basename(targetPath));
  // 점검 방식을 파일명에 남긴다 — 간편/표준 보고서가 이름부터 구분돼야
  // "차이가 없다"는 오해가 생기지 않는다(실제로는 프로파일·규칙 수가 다르다).
  const modeName = job.mode === "quick" ? "간편점검" : "표준점검";
  const base = [targetName, koreaReportTimestamp(new Date()), modeName].filter(Boolean).join("_");
  let candidate = base;
  let suffix = 2;
  while ([".json", ".html", ".md", ".sbom.cdx.json"].some((extension) =>
    existsSync(join(REPORT_DIR, `${candidate}${extension}`)) || existsSync(join(DRAFT_REPORT_DIR, `${candidate}${extension}`))
  )) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function renderReadableReports(job, jsonPath, outputBase) {
  const renderDir = join(TMP_DIR, `${job.id}-render`);
  await rm(renderDir, { recursive: true, force: true });
  mkdirSync(renderDir, { recursive: true });
  job.temporary_paths.push(renderDir);

  // gvskb report can use report metadata for its own filename. Render inside an
  // isolated directory first, then the portal assigns the user-facing filename.
  const rendered = await runCommand("gvskb", ["report", jsonPath, "--format", "html", "--output", join(renderDir, "report")], { timeout_ms: 120000 });
  if (!rendered.ok) {
    return { error: "결과 리포트를 생성하지 못했습니다. 점검 데이터와 SBOM은 확인할 수 있습니다." };
  }

  const files = await readdir(renderDir).catch(() => []);
  const moveGenerated = async (extension) => {
    const sourceName = files.find((file) => file.toLowerCase().endsWith(`.${extension}`));
    if (!sourceName) return false;
    await rename(join(renderDir, sourceName), `${outputBase}.${extension}`);
    return true;
  };
  try {
    const hasHtml = await moveGenerated("html");
    const hasMarkdown = await moveGenerated("md");
    return {
      has_html: hasHtml,
      has_markdown: hasMarkdown,
      error: hasHtml ? null : "결과 리포트를 생성하지 못했습니다. 점검 데이터와 SBOM은 확인할 수 있습니다."
    };
  } catch {
    return { error: "결과 리포트 파일을 준비하지 못했습니다. 점검 데이터와 SBOM은 확인할 수 있습니다." };
  }
}

function createJob(mode, targetType, targetRef, targetLabel = "") {
  const id = randomUUID();
  const job = {
    id,
    mode,
    target_type: targetType,
    target_ref: targetRef,
    target_label: targetLabelForDisplay(targetType, targetRef, targetLabel),
    status: "queued",
    decision: "incomplete",
    steps: [],
    reports: [],
    draft_reports: [],
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
  if (job.status === "queued") {
    const position = queuePosition(job.id);
    if (position && position > 0) {
      return {
        percent: 2,
        queue_position: position,
        message: `앞에 ${position}건이 있습니다. 창을 닫으셔도 검사는 계속되고, 내 점검 이력에서 결과를 보실 수 있습니다.`
      };
    }
    return { percent: 4, message: "곧 검사를 시작합니다." };
  }
  return { percent: 0, message: "검사를 기다리고 있습니다." };
}

function isAllowedGitRepositoryUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && ALLOWED_GIT_REPOSITORY_HOSTS.has(url.hostname.toLowerCase())
      && url.pathname.split("/").filter(Boolean).length >= 2;
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
    if (!isAllowedGitRepositoryUrl(targetUrl)) {
      throw new Error("GitHub 또는 승인된 GitLab URL만 지원합니다. https://github.com/소유자/저장소 또는 https://gitlab.aigov.go.kr/그룹/저장소 형식으로 입력해 주세요.");
    }
    mkdirSync(TMP_DIR, { recursive: true });
    const cloneDir = join(TMP_DIR, job.id);
    await rm(cloneDir, { recursive: true, force: true });
    const clone = await runCommand("git", ["clone", "--depth", "1", targetUrl, cloneDir]);
    if (!clone.ok) {
      throw new Error(`Git 저장소를 가져오지 못했습니다: ${redactLocalPath(clone.stderr || clone.stdout)}`);
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

  mkdirSync(DRAFT_REPORT_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
  const reportStem = reportStemForJob(job, targetPath);
  const outputBase = join(DRAFT_REPORT_DIR, reportStem);
  const jsonOutput = `${outputBase}.json`;
  const sbomOutput = `${outputBase}.sbom.cdx.json`;
  updateJob(job, { report_stem: reportStem });
  const maxFiles = job.mode === "quick" ? "700" : "20000";
  const sbomProjectName = safeReportNamePart(job.target_label) || safeReportNamePart(basename(targetPath)) || "security-scan";
  const args = ["scan", targetPath, "--format", "json", "--output", jsonOutput, "--max-files", maxFiles, "--check-deps", "--sbom", sbomOutput, "--project-name", sbomProjectName, "--fail-on", "never"];
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

  const scanTimeoutMs = job.mode === "quick" ? SCAN_TIMEOUT_QUICK_MS : SCAN_TIMEOUT_STANDARD_MS;
  const scan = await runCommand("gvskb", args, { timeout_ms: scanTimeoutMs });
  const scanTimedOut = !scan.ok && /command timed out/.test(scan.stderr);
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

  let reportRender = { error: null };
  if (parsed && jsonPath) {
    updateJob(job, {
      steps: [
        { name: "prepare_target", status: "completed" },
        { name: "code_scan", status: "completed" },
        { name: "render_report", status: "running" }
      ]
    });
    reportRender = await renderReadableReports(job, jsonPath, outputBase);
  }

  const findingCount = parsed?.summary?.finding_count ?? parsed?.findings?.length ?? 0;
  const scannedFileCount = parsed?.summary?.scanned_file_count ?? parsed?.scanned_file_count ?? parsed?.scanned_files?.length ?? 0;
  const dependencyRisk = dependencyRiskSummary(parsed?.dependency_audit);
  const dependencyFindingCount = dependencyRisk.vulnerable_package_count;
  const profileFallback = parsed?.profile_fallback || null;
  const coverageTruncated = (parsed?.skipped_files || []).some((item) => String(item.reason || "").includes("max_files="));
  const dependencyIncomplete = (parsed?.dependency_audit?.audits || []).some((audit) => Number(audit.unchecked_count || 0) > 0 || Number(audit.truncated_count || 0) > 0);
  const baseDecision = profileFallback || coverageTruncated || dependencyIncomplete
    ? "incomplete"
    : parsed?.decision || (
      scannedFileCount === 0 ? "needs_review" : parsed?.summary?.blocked ? "blocked" : findingCount > 0 ? "needs_review" : "allow"
    );
  const decision = scanTimedOut
    ? "incomplete"
    : job.mode === "quick" && baseDecision === "allow" ? "quick_complete" : baseDecision;
  if (scanTimedOut) {
    const limitMinutes = Math.round(scanTimeoutMs / 60000);
    job.error = `검사 시간이 ${limitMinutes}분을 넘어 중단했습니다. 대상을 나누어 올리거나, 불필요한 폴더(node_modules 등)를 빼고 다시 시도해 주세요.`;
  }
  const draftReportFiles = await readdir(DRAFT_REPORT_DIR).catch(() => []);
  const draftReportItems = [];
  for (const file of draftReportFiles) {
    if (file === `${reportStem}.json` || file === `${reportStem}.html` || file === `${reportStem}.md` || file === `${reportStem}.sbom.cdx.json`) {
      draftReportItems.push({
        file_name: file,
        path: join(DRAFT_REPORT_DIR, file),
        url: `/artifacts/${encodeURIComponent(file)}`,
        kind: artifactKind(file)
      });
    }
  }
  const sbomGenerated = draftReportItems.some((report) => report.kind === "sbom");
  // The checker deliberately avoids a zero-component SBOM when no supported dependency manifest exists.
  const sbomStatus = sbomGenerated
    ? "generated"
    : parsed?.dependency_audit
      ? "not_generated"
      : "no_dependency_manifest";

  updateJob(job, {
    status: scan.ok || parsed ? "completed" : "failed",
    decision,
    steps: [
      { name: "prepare_target", status: "completed" },
      { name: "code_scan", status: scan.ok || parsed ? "completed" : "failed" },
      { name: "render_report", status: reportRender.error ? "failed" : "completed" }
    ],
    reports: [],
    draft_reports: draftReportItems,
    draft_expires_at: draftReportItems.length
      ? new Date(Date.now() + DRAFT_REPORT_RETENTION_HOURS * 60 * 60 * 1000).toISOString()
      : null,
    draft_expired: false,
    report_render_error: reportRender.error,
    checker_exit_code: scan.code,
    checker_stdout_tail: scan.stdout.split(/\r?\n/).filter(Boolean).slice(-12).map(redactLocalPath),
    checker_stderr_tail: scan.stderr.split(/\r?\n/).filter(Boolean).slice(-12).map(redactLocalPath),
    summary: {
      scanned_file_count: scannedFileCount,
      finding_count: findingCount,
      // 화면 요약은 체커 리포트의 실측값을 그대로 쓴다 — 파생 판정으로 재가공하면
      // 내려받은 보고서와 화면 숫자가 어긋난다(2026-08-29 실측: warn 196 이 "0건"으로 표시).
      block_count: Number(parsed?.summary?.by_decision?.block ?? 0),
      warn_count: Number(parsed?.summary?.by_decision?.warn ?? 0),
      blocked: Boolean(parsed?.summary?.blocked),
      highest_severity: parsed?.summary?.highest_severity || null,
      dependency_finding_count: dependencyFindingCount,
      dependency_advisory_count: dependencyRisk.advisory_count,
      dependency_review_count: dependencyRisk.review_package_count,
      language_counts: languageCountsFromReport(parsed),
      sbom_status: sbomStatus,
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
  const todayKey = koreaDateKey();
  const today = scans.filter((job) => koreaDateKey(job.created_at) === todayKey);
  const allow = scans.filter((job) => job.decision === "allow").length;
  const quickComplete = scans.filter((job) => job.decision === "quick_complete").length;
  const needsReview = scans.filter((job) => job.decision === "needs_review").length;
  const blocked = scans.filter((job) => job.decision === "blocked").length;
  const incomplete = scans.filter((job) => job.decision === "incomplete").length;
  return {
    total: scans.length,
    today: today.length,
    allow,
    quick_complete: quickComplete,
    needs_review: needsReview,
    incomplete,
    attention: needsReview + incomplete,
    blocked,
    observations: observationSummary(),
    accounts: accountSummary(),
    pending_review_requests: scans.filter((job) => job.review_request?.status === "submitted").length,
    generated_at: new Date().toISOString()
  };
}

function dashboardFilters(searchParams) {
  return {
    from: String(searchParams.get("from") || ""),
    to: String(searchParams.get("to") || ""),
    query: String(searchParams.get("query") || "").trim().toLowerCase(),
    status: String(searchParams.get("status") || ""),
    ecosystem: String(searchParams.get("ecosystem") || ""),
    language: String(searchParams.get("language") || ""),
    whitelist: String(searchParams.get("whitelist") || "")
  };
}

function matchesDashboardDate(value, filters) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return false;
  if (filters.from && timestamp < koreaDayBoundary(filters.from)) return false;
  if (filters.to && timestamp > koreaDayBoundary(filters.to, true)) return false;
  return true;
}

function monthBuckets() {
  const months = [];
  const [year, month] = koreaDateKey().split("-").map(Number);
  for (let index = 5; index >= 0; index -= 1) {
    const value = new Date(Date.UTC(year, month - 1 - index, 1, 12));
    months.push({ key: koreaDateKey(value).slice(0, 7), label: `${value.getUTCMonth() + 1}월`, count: 0 });
  }
  return months;
}

function dashboardDimensionStats(scans, field, outputKey) {
  const groups = new Map();
  for (const scan of scans) {
    const value = String(scan[field] || "미입력");
    const entry = groups.get(value) || { [outputKey]: value, scan_count: 0, latest_scanned_at: null };
    entry.scan_count += 1;
    if (!entry.latest_scanned_at || String(scan.created_at || "") > entry.latest_scanned_at) {
      entry.latest_scanned_at = scan.created_at || null;
    }
    groups.set(value, entry);
  }
  return Array.from(groups.values())
    .sort((a, b) => b.scan_count - a.scan_count || String(a[outputKey]).localeCompare(String(b[outputKey])))
    .slice(0, 20);
}

function adminDashboardSnapshot(searchParams) {
  const filters = dashboardFilters(searchParams);
  const query = filters.query;
  const whitelist = whitelistSnapshot();
  const observations = observationRecordsSnapshot().filter((record) => {
    if (!matchesDashboardDate(record.observed_at, filters)) return false;
    if (filters.ecosystem && record.ecosystem !== filters.ecosystem) return false;
    const listStatus = whitelistStatus(record.ecosystem, record.package_name) || "unlisted";
    return !filters.whitelist || listStatus === filters.whitelist;
  });
  const matchingObservationScanIds = new Set(observations
    .filter((record) => !query || `${record.ecosystem} ${record.package_name} ${record.package_version}`.toLowerCase().includes(query))
    .map((record) => record.scan_id));
  const scans = Array.from(jobs.values()).filter((job) => {
    if (!matchesDashboardDate(job.created_at, filters)) return false;
    if (filters.status === "attention" && !["needs_review", "incomplete"].includes(job.decision)) return false;
    if (filters.status && filters.status !== "attention" && job.decision !== filters.status) return false;
    if (filters.language && !Object.hasOwn(job.summary?.language_counts || {}, filters.language)) return false;
    if ((filters.ecosystem || filters.whitelist) && !matchingObservationScanIds.has(job.id)) return false;
    if (!query) return true;
    const searchable = [job.id, job.target_label, job.owner_email, job.owner_organization, job.owner_department, job.target_type, job.decision]
      .filter(Boolean).join(" ").toLowerCase();
    return searchable.includes(query) || matchingObservationScanIds.has(job.id);
  });
  const months = monthBuckets();
  const monthsByKey = new Map(months.map((month) => [month.key, month]));
  // 실제 체커가 분석한 소스 파일 수만 이력에서 합산한다.
  // 원본 소스는 보관하지 않으므로 GitHub의 바이트 비율과는 다른 지표다.
  const languageCounts = new Map();
  for (const job of scans) {
    const bucket = monthsByKey.get(koreaDateKey(job.created_at).slice(0, 7));
    if (bucket) bucket.count += 1;
    for (const [language, count] of Object.entries(job.summary?.language_counts || {})) {
      const entry = languageCounts.get(language) || { file_count: 0, target_names: new Set() };
      entry.file_count += Number(count || 0);
      if (job.target_label) entry.target_names.add(String(job.target_label));
      languageCounts.set(language, entry);
    }
  }

  const packageGroups = new Map();
  for (const record of observations) {
    const listStatus = whitelistStatus(record.ecosystem, record.package_name) || "unlisted";
    if (query && !`${record.ecosystem} ${record.package_name} ${record.package_version}`.toLowerCase().includes(query)) continue;
    const key = `${record.ecosystem}:${record.package_name}`;
    const entry = packageGroups.get(key) || {
      ecosystem: record.ecosystem,
      package_name: record.package_name,
      observation_count: 0,
      versions: new Set(),
      exact_versions: new Set(),
      whitelist_status: listStatus
    };
    entry.observation_count += 1;
    if (record.package_version) entry.versions.add(record.package_version);
    if (record.version_exact && record.package_version) entry.exact_versions.add(record.package_version);
    packageGroups.set(key, entry);
  }
  const packages = Array.from(packageGroups.values())
    .map((entry) => ({
      ...entry,
      versions: [...entry.versions].sort(),
      exact_version_count: entry.exact_versions.size
    }))
    .sort((a, b) => b.observation_count - a.observation_count || a.package_name.localeCompare(b.package_name))
    .slice(0, 8);
  const whitelistEntries = Object.values(whitelist).filter((entry) => {
    if (filters.ecosystem && entry.ecosystem !== filters.ecosystem) return false;
    if (filters.whitelist && entry.status !== filters.whitelist) return false;
    return !query || `${entry.ecosystem} ${entry.package_name} ${entry.reason || ""}`.toLowerCase().includes(query);
  }).sort((a, b) => String(b.decided_at).localeCompare(String(a.decided_at)));
  return {
    filters,
    scan_count: scans.length,
    monthly_scans: months,
    language_measure: "scanned_source_file_count",
    languages: Array.from(languageCounts, ([label, entry]) => ({
      label,
      value: entry.file_count,
      file_count: entry.file_count,
      target_count: entry.target_names.size
    }))
      .filter((entry) => entry.value > 0).sort((a, b) => b.value - a.value).slice(0, 8),
    packages,
    users: dashboardDimensionStats(scans, "owner_email", "email"),
    organizations: dashboardDimensionStats(scans, "owner_organization", "organization"),
    departments: dashboardDimensionStats(scans, "owner_department", "department"),
    whitelist: whitelistEntries
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
  const targetName = targetLabelForDisplay(job.target_type, job.target_ref, job.target_label) || job.target_label || "";
  const retainedReports = job.reports || [];
  const draftReports = job.draft_reports || [];
  const visibleArtifacts = job.review_request || !draftReports.length ? retainedReports : draftReports;
  const targetLabel = job.target_type === "github_url"
    ? "Git repository"
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
    reports: retainedReports.map(({ file_name, url, kind }) => ({ file_name, url, kind: kind || artifactKind(file_name) })),
    artifacts: visibleArtifacts.map(({ file_name, url, kind }) => ({
      file_name,
      url,
      kind: kind || artifactKind(file_name)
    })),
    artifact_storage: job.review_request ? "submitted" : "temporary",
    draft_expires_at: job.draft_expires_at || null,
    draft_expired: job.draft_expired === true,
    report_render_error: job.report_render_error || null,
    // P5(신뢰 표시): 원본 미보관과 보존기한을 응답에 실어 화면이 사실을 말하게 한다.
    source_retained: false,
    report_retention_days: REPORT_RETENTION_DAYS || null,
    observations_submitted_at: job.observations_submitted_at || null,
    // 소유자 검증 뒤에만 응답되므로 본인 라벨·소속 스냅샷·검토요청 상태를 보여줄 수 있다.
    target_name: targetName,
    owner_organization: job.owner_organization || null,
    owner_department: job.owner_department || null,
    review_request: job.review_request
      ? {
        status: job.review_request.status,
        requested_at: job.review_request.requested_at,
        request_document: job.review_request.request_document || null,
        submission_package: job.review_request.submission_package || null
      }
      : null,
    created_at: job.created_at,
    updated_at: job.updated_at || null,
    error: job.error || null
  };
}

// S2(동시성): 큐. 슬롯이 빌 때만 실행하고, 나머지는 접수 순서대로 기다린다.
const scanQueue = [];
let runningScans = 0;

function queuePosition(jobId) {
  const index = scanQueue.indexOf(jobId);
  return index < 0 ? null : index + 1;
}

function pumpScanQueue() {
  while (runningScans < MAX_CONCURRENT_SCANS && scanQueue.length > 0) {
    const jobId = scanQueue.shift();
    const job = jobs.get(jobId);
    if (!job || job.status !== "queued") continue;
    runningScans += 1;
    runScanJob(job)
      .catch(async (error) => {
        updateJob(job, {
          status: "failed",
          decision: "incomplete",
          error: String(error.message || error)
        });
        await cleanupJobTargets(job);
        await persistJob(job);
      })
      .finally(() => {
        runningScans -= 1;
        pumpScanQueue();
      });
  }
}

// S2(워터마크): 디스크 여유가 임계 미만이면 받아 놓고 실패시키지 않고 접수 자체를 막는다.
async function hasDiskCapacity() {
  try {
    const stats = await statfs(ROOT);
    return stats.bavail * stats.bsize >= MIN_FREE_DISK_BYTES;
  } catch {
    // 확인 실패가 서비스 중단이 되어선 안 된다. 실제 부족은 검사 단계에서 드러난다.
    return true;
  }
}

function capacityExhausted(response) {
  json(response, 503, {
    error: "capacity_exhausted",
    message: "지금은 접수가 어렵습니다. 잠시 후 다시 시도해 주세요."
  });
}

// P2→P3 전환: 관측 축적은 점검 완료 시 자동이다(2026-08-28 확정 — "그 데이터는 이미 서버에 있다").
// 시작 화면이 "서버에 남는 것/남지 않는 것"을 고지하고, 서버가 보관 중인 검사 JSON에서
// 허용목록 필드만 추려 적재한다. 클라이언트는 데이터를 만들지 않는다.
// 주의: 반드시 상태가 completed 로 바뀌기 **전에** 호출한다 — 완료를 본 클라이언트가
// 적재 완료 전의 결과를 읽는 경합을 막는다(2026-08-28 guard 에서 실제로 잡힌 레이스).
async function recordObservationsForJob(job, reportItems) {
  if (hasSubmission(job.id)) return;
  const jsonReport = (reportItems || []).find((report) => report.file_name?.endsWith(".json") && !report.file_name.endsWith(".sbom.cdx.json"));
  let audits = [];
  if (jsonReport?.path && existsSync(jsonReport.path)) {
    try {
      const parsed = JSON.parse(await readFile(jsonReport.path, "utf8"));
      audits = parsed?.dependency_audit?.audits || [];
    } catch {
      audits = [];
    }
  }
  const records = [];
  for (const audit of audits) {
    for (const check of audit.checks || []) {
      if (!check?.name || !check?.version) continue; // 버전 미확정 관측은 적재하지 않는다(§5-D)
      records.push(toObservationRecord(check, {
        scanId: job.id,
        ecosystem: audit.ecosystem,
        sourceScope: audit.source_kind,
        projectLabel: job.target_label || "",
        departmentCode: job.owner_department || null // 점검 시점 스냅샷 (부서명)
      }));
    }
  }
  try {
    await recordSubmission(job.id, records);
    job.observations_submitted_at = new Date().toISOString();
  } catch {
    // 축적 실패가 점검 결과 전달을 막아선 안 된다.
  }
}

function escapeRequestHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function displayDecision(decision) {
  if (decision === "allow") return "승인";
  if (decision === "quick_complete") return "고위험 없음";
  if (decision === "needs_review") return "조건부 승인";
  if (decision === "blocked") return "배포 미승인";
  if (decision === "incomplete") return "재점검 필요";
  return "점검 완료";
}

function reviewRequestDocument(job, reports) {
  const rows = [
    ["점검 대상", job.target_label || "-"],
    ["점검 방식", job.mode === "quick" ? "간편 점검" : "표준 점검"],
    ["점검 일시", koreaReportTimestamp(new Date()).replace("_", " ")],
    ["요청 기관", job.owner_organization || "-"],
    ["요청 부서", job.owner_department || "-"],
    ["요청자", job.owner_email || "-"],
    ["점검 판정", displayDecision(job.decision)]
  ];
  const tableRows = rows.map(([label, value]) => `<tr><th>${escapeRequestHtml(label)}</th><td>${escapeRequestHtml(value)}</td></tr>`).join("");
  const attachmentNames = reports.map((report) => {
    if (report.kind === "html_report") return "점검 결과 리포트";
    if (report.kind === "json_report") return "패키지 목록·점검 데이터";
    if (report.kind === "sbom") return "소프트웨어 명세서(SBOM)";
    return "점검 요약";
  });
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>보안성검토 요청서</title><style>body{font-family:Malgun Gothic,Arial,sans-serif;margin:40px;color:#14253d}h1{font-size:26px}p{line-height:1.6}table{border-collapse:collapse;width:100%;margin-top:24px}th,td{border:1px solid #9eb2c9;padding:12px;text-align:left}th{width:180px;background:#eef5fb}</style></head><body><h1>보안성검토 요청서</h1><p>공공 바이브코딩 보안 게이트 포털에서 생성한 요청서입니다.</p><table>${tableRows}</table><p>첨부: ${escapeRequestHtml(attachmentNames.join(", ") || "점검 결과 리포트")}</p></body></html>`;
}

async function createSubmissionArtifacts(job, reports) {
  const stem = safeReportNamePart(job.report_stem) || `${safeReportNamePart(job.target_label) || "security-scan"}_${koreaReportTimestamp()}`;
  const requestFileName = `${stem}_보안성검토요청서.html`;
  const packageFileName = `${stem}_보안성검토제출자료.zip`;
  const requestPath = join(REPORT_DIR, requestFileName);
  const packagePath = join(REPORT_DIR, packageFileName);
  if (existsSync(requestPath) || existsSync(packagePath)) {
    throw new Error("같은 이름의 제출 자료가 있어 생성할 수 없습니다. 점검을 다시 실행해 주세요.");
  }
  const requestDocument = reviewRequestDocument(job, reports);
  try {
    await writeFile(requestPath, requestDocument, "utf8");
    const reportEntries = await Promise.all(reports.map(async (report) => ({
      name: `02_점검리포트/${report.file_name}`,
      data: await readFile(report.path),
      method: 8,
      flags: 0x0800,
      modTime: 0,
      modDate: 0
    })));
    const packageBuffer = writeZipEntries([
      { name: "01_보안성검토요청서.html", data: Buffer.from(requestDocument, "utf8"), method: 8, flags: 0x0800, modTime: 0, modDate: 0 },
      ...reportEntries
    ]);
    await writeFile(packagePath, packageBuffer);
  } catch (error) {
    await Promise.all([rm(requestPath, { force: true }), rm(packagePath, { force: true })]);
    throw error;
  }
  return [
    { file_name: requestFileName, path: requestPath, url: `/reports/${encodeURIComponent(requestFileName)}`, kind: "review_request" },
    { file_name: packageFileName, path: packagePath, url: `/reports/${encodeURIComponent(packageFileName)}`, kind: "submission_package" }
  ];
}

async function promoteDraftReports(job) {
  const drafts = job.draft_reports || [];
  if (!drafts.length) {
    throw new Error(job.draft_expired
      ? "보안성검토용 임시 보고서 보관 시간이 지나 다시 점검해야 합니다."
      : "제출할 보고서를 찾지 못했습니다. 점검을 다시 실행해 주세요.");
  }
  mkdirSync(REPORT_DIR, { recursive: true });
  const prepared = drafts.map((draft) => {
    const fileName = String(draft.file_name || "");
    const source = resolve(String(draft.path || ""));
    const destination = resolve(join(REPORT_DIR, fileName));
    if (!isSafeReportFileName(fileName) || !pathInside(DRAFT_REPORT_DIR, source) || !pathInside(REPORT_DIR, destination) || !existsSync(source)) {
      throw new Error("제출할 보고서 파일을 확인하지 못했습니다. 점검을 다시 실행해 주세요.");
    }
    if (existsSync(destination)) {
      throw new Error("같은 이름의 보관 보고서가 있어 제출을 완료할 수 없습니다. 점검을 다시 실행해 주세요.");
    }
    return { fileName, source, destination };
  });
  const moved = [];
  let submissionArtifacts = [];
  try {
    for (const item of prepared) {
      await rename(item.source, item.destination);
      moved.push(item);
    }
    const originalReports = prepared.map(({ fileName, destination }) => ({
      file_name: fileName,
      path: destination,
      url: `/reports/${encodeURIComponent(fileName)}`,
      kind: artifactKind(fileName)
    }));
    submissionArtifacts = await createSubmissionArtifacts(job, originalReports);
  } catch (error) {
    await Promise.all(submissionArtifacts.map(async (artifact) => {
      if (existsSync(artifact.path)) await rm(artifact.path, { force: true }).catch(() => {});
    }));
    await Promise.all(moved.reverse().map(async (item) => {
      if (existsSync(item.destination)) await rename(item.destination, item.source).catch(() => {});
    }));
    throw error;
  }
  const reports = [
    ...prepared.map(({ fileName, destination }) => ({
      file_name: fileName,
      path: destination,
      url: `/reports/${encodeURIComponent(fileName)}`,
      kind: artifactKind(fileName)
    })),
    ...submissionArtifacts
  ];
  updateJob(job, {
    reports,
    draft_reports: [],
    draft_expires_at: null,
    draft_expired: false
  });
  return reports;
}

async function startScan(request, response) {
  const account = requireUser(request, response);
  if (!account) return;
  // 소속(기관명·부서명)은 가입 때가 아니라 첫 점검 직전에 받는다 — 진입장벽을 낮추되,
  // 관측·이력에 부서 스냅샷이 비는 일은 없게 점검 시작은 소속 없이는 못 한다.
  if (!String(account.organization || "").trim() || !String(account.department || "").trim()) {
    json(response, 400, { error: "profile_required", message: "점검을 시작하려면 기관명과 부서명을 먼저 입력해 주세요." });
    return;
  }
  const body = await readJson(request);
  const mode = ["quick", "standard"].includes(body.scan_mode) ? body.scan_mode : "standard";
  const targetType = ["github_url", "browser_folder", "browser_archive"].includes(body.target_type) ? body.target_type : "";
  if (!targetType) {
    json(response, 400, { error: "invalid_target_type", message: "폴더나 ZIP을 올리거나 승인된 Git 저장소 주소로 검사할 수 있습니다." });
    return;
  }
  // 사용자당 동시 점검 제한(23번 계약) — 큐 독점을 막는다.
  const activeOwned = Array.from(jobs.values())
    .filter((job) => job.owner_email === account.email && ["queued", "running"].includes(job.status)).length;
  if (activeOwned >= USER_CONCURRENT_SCANS) {
    json(response, 409, {
      error: "user_scan_limit",
      message: "진행 중인 점검이 있습니다. 끝난 뒤 다시 시도해 주세요. (내 점검 이력에서 확인)"
    });
    return;
  }
  if (scanQueue.length >= SCAN_QUEUE_LIMIT) {
    capacityExhausted(response);
    return;
  }
  if (!(await hasDiskCapacity())) {
    capacityExhausted(response);
    return;
  }
  const job = createJob(mode, targetType, body.target_ref, body.target_label);
  // 점검 시점의 소속 스냅샷 — 이후 프로필 변경에 영향받지 않는다.
  job.owner_email = account.email;
  job.owner_organization = account.organization || null;
  job.owner_department = account.department || null;
  scanQueue.push(job.id);
  pumpScanQueue();

  json(response, 202, {
    scan_id: job.id,
    status: job.status,
    queue_position: queuePosition(job.id),
    progress_url: `/api/scan/${job.id}/progress`,
    result_url: `/api/scan/${job.id}/result`
  });
}

async function handleApi(request, response, pathname, searchParams = new URLSearchParams()) {
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

  // ---- Cloudflare Access 자동 로그인 ---------------------------------------
  // 관문의 서명 JWT 로 이메일 소유가 이미 증명됐으므로 매직링크를 생략한다.
  // 신규 계정은 기관명·부서명을 함께 받아야 한다(매직링크 가입과 동일 규칙).
  if (request.method === "POST" && pathname === "/api/auth/access-login") {
    if (!ACCESS_ENABLED) {
      notFound(response);
      return;
    }
    const email = await accessEmailFromRequest(request);
    if (!email) {
      json(response, 401, { error: "access_required", message: "관문 인증을 확인하지 못했습니다. 새로고침 후 다시 시도해 주세요." });
      return;
    }
    const body = await readJson(request);
    const organization = String(body.organization || "").trim();
    const department = String(body.department || "").trim();
    const isNew = !getAccount(email);
    // 소속은 요구하지 않는다(보내주면 저장) — 첫 점검 직전에 1회 입력받는다.
    await upsertAccountOnLogin({ email, organization, department });
    await recordAuthAudit("access_login", email, { new_account: isNew });
    const cookie = createUserSession(email);
    json(response, 200, { status: "logged_in", email }, { "Set-Cookie": cookie });
    return;
  }

  // 개발 클론은 외부 Cloudflare Access 관문이 없으므로, 루프백에서만 세션을 자동 생성한다.
  // 외부 주소에서는 이 경로가 존재하지 않아 Access 인증 외의 우회 수단이 되지 않는다.
  if (request.method === "POST" && pathname === "/api/auth/development-login") {
    if (!LOCAL_DEVELOPMENT_AUTH) {
      notFound(response);
      return;
    }
    const email = normalizeEmail(runtimeEnv.PORTAL_DEV_AUTO_LOGIN_EMAIL || "developer@gg.go.kr");
    let account = await upsertAccountOnLogin({ email, organization: "", department: "" });
    // Earlier development builds stored these explanatory labels as if they were real
    // affiliations. Clear only that exact placeholder pair; real user-entered profiles stay intact.
    if (account.organization === DEVELOPMENT_PLACEHOLDER_PROFILE.organization
      && account.department === DEVELOPMENT_PLACEHOLDER_PROFILE.department) {
      account = await updateAccountProfile(email, "", "");
    }
    await recordAuthAudit("development_login", account.email, { loopback: true });
    json(response, 200, { status: "logged_in", email: account.email, development: true }, { "Set-Cookie": createUserSession(account.email) });
    return;
  }

  // ---- P3: 매직링크 가입·로그인 -------------------------------------------
  if (request.method === "POST" && pathname === "/api/auth/request-link") {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    if (!isValidEmail(email)) {
      json(response, 400, { error: "invalid_email", message: "이메일 주소를 확인해 주세요." });
      return;
    }
    if (!emailDomainAllowed(email, ALLOWED_EMAIL_DOMAINS)) {
      json(response, 400, {
        error: "email_domain_not_allowed",
        message: `기관 메일(${ALLOWED_EMAIL_DOMAINS.map((domain) => "@" + domain).join(", ")})로만 가입할 수 있습니다.`
      });
      return;
    }
    // 관문(Cloudflare Access)을 통과해 들어온 요청은 그 신원과 같은 계정으로만 로그인할 수 있다.
    // LAN 직접 접속은 관문 JWT 가 없어 null 이므로 시연용 개발 로그인 흐름은 그대로 유지된다.
    const accessIdentity = await accessEmailFromRequest(request);
    if (accessIdentity && accessIdentity !== email) {
      await recordAuthAudit("link_identity_mismatch", email, { access_identity: accessIdentity });
      json(response, 403, {
        error: "email_mismatch",
        message: "보안 관문에서 인증된 계정으로만 로그인할 수 있습니다."
      });
      return;
    }
    if (!linkRequestAllowed(email)) {
      json(response, 429, { error: "too_many_requests", message: "요청이 잦습니다. 15분 뒤 다시 시도해 주세요." });
      return;
    }
    const isNew = !getAccount(email);
    // 소속은 여기서 요구하지 않는다 — 첫 점검 직전에 1회 입력(진입장벽 최소화).
    const { token, expires_in_minutes } = createLoginToken(email, body);
    await recordAuthAudit("link_requested", email, { new_account: isNew });
    const loginPath = `/auth/complete?token=${token}`;
    if (AUTH_DEV_MODE) {
      // SMTP 미확정 — 링크를 응답으로 돌려줘 화면에 표시한다(테스트·시연용). 실발송 전환 시 이 필드는 사라진다.
      json(response, 200, { status: "sent", mode: "dev", dev_login_url: loginPath, expires_in_minutes });
      return;
    }
    json(response, 200, { status: "sent", mode: "email", expires_in_minutes, message: "메일로 받은 링크를 열면 로그인됩니다." });
    return;
  }

  if (request.method === "GET" && pathname === "/api/auth/session") {
    const account = currentUser(request);
    if (!account) {
      // 관문(Access)을 이미 통과한 사람에게는 매직링크를 다시 시키지 않는다 —
      // 화면이 이 정보로 "바로 시작" 경로를 보여준다.
      const accessEmail = await accessEmailFromRequest(request);
      json(response, 200, {
        logged_in: false,
        report_retention_days: REPORT_RETENTION_DAYS || null,
        access_email: accessEmail,
        access_registered: accessEmail ? Boolean(getAccount(accessEmail)) : false
      });
      return;
    }
    json(response, 200, {
      logged_in: true,
      email: account.email,
      organization: account.organization || "",
      department: account.department || "",
      report_retention_days: REPORT_RETENTION_DAYS || null
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/auth/logout") {
    const token = cookieValue(request, "portal_session");
    if (token) userSessions.delete(token);
    json(response, 200, { status: "signed_out" }, { "Set-Cookie": "portal_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
    return;
  }

  if (request.method === "POST" && pathname === "/api/auth/profile") {
    const account = requireUser(request, response);
    if (!account) return;
    const body = await readJson(request);
    const organization = String(body.organization || "").trim();
    const department = String(body.department || "").trim();
    if (!organization || !department) {
      json(response, 400, { error: "profile_incomplete", message: "기관명과 부서명을 모두 입력해 주세요." });
      return;
    }
    const updated = await updateAccountProfile(account.email, organization, department);
    json(response, 200, { status: "updated", organization: updated.organization, department: updated.department });
    return;
  }

  if (request.method === "GET" && pathname === "/api/my/scans") {
    const account = requireUser(request, response);
    if (!account) return;
    const mine = Array.from(jobs.values())
      .filter((job) => job.owner_email === account.email)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map(publicJob);
    json(response, 200, { scans: mine });
    return;
  }

  if (request.method === "GET" && pathname === "/api/tools/versions") {
    json(response, 200, {
      checker: await serverCheckerVersion(),
      note: "서버에 설치된 체커입니다. 사용자 PC의 도구 상태는 도구 관리자가 확인합니다."
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/harness/release") {
    json(response, 200, await fetchHarnessRelease());
    return;
  }

  if (request.method === "POST" && pathname === "/api/local/upload-target") {
    if (!requireUser(request, response)) return;
    if (!(await hasDiskCapacity())) {
      capacityExhausted(response);
      return;
    }
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
    // P4(현황 보강): 큐·디스크는 요약과 함께 — 화면이 서버 상태를 한 번에 본다.
    let diskFreeBytes = null;
    try {
      const stats = await statfs(ROOT);
      diskFreeBytes = stats.bavail * stats.bsize;
    } catch {
      diskFreeBytes = null;
    }
    json(response, 200, {
      ...adminSummary(),
      queue: { running: runningScans, waiting: scanQueue.length, limit: MAX_CONCURRENT_SCANS },
      disk_free_bytes: diskFreeBytes,
      whitelist: whitelistSummary()
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/admin/dashboard") {
    if (!requireAdmin(request, response)) return;
    json(response, 200, adminDashboardSnapshot(searchParams));
    return;
  }

  // P4: 관측 축적 → 화이트리스트 근거 화면. 이 데이터는 판정이 아니다(역할합의) —
  // 담기·제외는 보안부서 제출용 목록 구성이며 검사 경로는 이 목록을 읽지 않는다.
  if (request.method === "GET" && pathname === "/api/admin/packages") {
    if (!requireAdmin(request, response)) return;
    const packages = Object.values(usageStatsSnapshot())
      .map((entry) => ({
        ecosystem: entry.ecosystem,
        package_name: entry.package_name,
        observation_count: entry.observation_count,
        manifest_count: entry.manifest_count,
        department_count: (entry.department_codes || []).length,
        project_count: (entry.project_labels || []).length,
        versions: entry.versions || [],
        latest_version: entry.latest_version,
        has_vulnerable_observation: entry.has_vulnerable_observation === true,
        has_malicious_observation: entry.has_malicious_observation === true,
        first_observed_at: entry.first_observed_at,
        last_observed_at: entry.last_observed_at,
        whitelist_status: whitelistStatus(entry.ecosystem, entry.package_name)
      }))
      .sort((a, b) => b.observation_count - a.observation_count);
    json(response, 200, {
      packages,
      note: "관측 축적 데이터입니다. 담기·제외는 보안부서 화이트리스트 검토를 위한 근거 구성이며 승인·차단이 아닙니다."
    });
    return;
  }

  if (request.method === "POST" && pathname === "/api/admin/whitelist") {
    if (!requireAdmin(request, response)) return;
    const body = await readJson(request);
    const ecosystem = String(body.ecosystem || "").trim();
    const packageName = String(body.package_name || "").trim();
    const action = String(body.action || "");
    if (!ecosystem || !packageName || !["include", "exclude", "reset"].includes(action)) {
      json(response, 400, { error: "invalid_whitelist_request", message: "ecosystem, package_name, action(include/exclude/reset)을 확인하세요." });
      return;
    }
    // 관측된 적 없는 패키지는 근거가 없으므로 목록에 올릴 수 없다.
    const observed = usageStatsSnapshot()[`${ecosystem}:${packageName}`];
    if (!observed) {
      json(response, 404, { error: "package_not_observed", message: "관측 이력이 없는 패키지는 근거 목록에 담을 수 없습니다." });
      return;
    }
    const entry = await setWhitelistEntry(ecosystem, packageName, action, body.reason, ADMIN_ID);
    json(response, 200, { status: "recorded", action, entry });
    return;
  }

  if (request.method === "GET" && pathname === "/api/admin/whitelist/export") {
    if (!requireAdmin(request, response)) return;
    // 내보내기에는 패키지 식별 정보만 싣는다 — 부서명·프로젝트명·이메일은 넣지 않는다.
    const stats = usageStatsSnapshot();
    const listed = Object.values(whitelistSnapshot());
    const packageFields = (entry) => {
      const observed = stats[`${entry.ecosystem}:${entry.package_name}`] || {};
      return {
        ecosystem: entry.ecosystem,
        package_name: entry.package_name,
        versions: observed.versions || [],
        latest_version: observed.latest_version || null,
        observation_count: observed.observation_count || 0,
        reason: entry.reason || null,
        decided_at: entry.decided_at
      };
    };
    const payload = {
      report_type: "화이트리스트 근거 목록",
      note: "보안부서 검토·이미지 반영용 근거 자료입니다. 이 목록 자체는 승인·차단 판정이 아닙니다.",
      generated_at: new Date().toISOString(),
      included: listed.filter((entry) => entry.status === "included").map(packageFields),
      excluded: listed.filter((entry) => entry.status === "excluded").map(packageFields)
    };
    await recordWhitelistExport("json", { included: payload.included.length, excluded: payload.excluded.length }, ADMIN_ID);
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
    const fileName = `${timestamp}_화이트리스트근거.json`;
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="whitelist-evidence.json"; filename*=UTF-8''${encodeURIComponent(fileName)}`
    });
    response.end(`${JSON.stringify(payload, null, 2)}\n`);
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

  // P3: 보안성검토 요청 — 완료된 본인 점검을 보안부서 검토 대기열에 올린다.
  // 판정은 사람이 한다. 이 요청은 전달일 뿐 어떤 자동 판정도 붙지 않는다.
  const reviewMatch = pathname.match(/^\/api\/scan\/([^/]+)\/request-review$/);
  if (request.method === "POST" && reviewMatch) {
    const job = jobs.get(reviewMatch[1]);
    if (!job || !canViewJob(request, job)) return notFound(response);
    if (job.status !== "completed") {
      json(response, 409, { error: "not_reviewable", message: "완료된 점검만 검토를 요청할 수 있습니다." });
      return;
    }
    if (job.review_request) {
      json(response, 409, { error: "already_requested", message: "이미 검토를 요청한 점검입니다." });
      return;
    }
    let reports;
    try {
      reports = await promoteDraftReports(job);
      await recordObservationsForJob(job, reports);
    } catch (error) {
      json(response, 409, { error: "report_promotion_failed", message: String(error.message || error) });
      return;
    }
    const requestDocument = reports.find((report) => report.kind === "review_request");
    const submissionPackage = reports.find((report) => report.kind === "submission_package");
    if (!requestDocument || !submissionPackage) {
      json(response, 500, { error: "submission_artifacts_missing", message: "제출 자료를 만들지 못했습니다. 다시 시도해 주세요." });
      return;
    }
    updateJob(job, {
      review_request: {
        status: "submitted",
        requested_at: new Date().toISOString(),
        request_document: { file_name: requestDocument.file_name, url: requestDocument.url },
        submission_package: { file_name: submissionPackage.file_name, url: submissionPackage.url }
      }
    });
    await persistJob(job);
    json(response, 200, {
      status: "submitted",
      request_document: job.review_request.request_document,
      submission_package: job.review_request.submission_package,
      message: "보안성검토 요청서와 점검 리포트를 하나의 제출자료 ZIP으로 만들었습니다."
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/admin/review-requests") {
    if (!requireAdmin(request, response)) return;
    const requests = Array.from(jobs.values())
      .filter((job) => job.review_request)
      .sort((a, b) => String(b.review_request.requested_at).localeCompare(String(a.review_request.requested_at)))
      .map((job) => ({
        scan_id: job.id,
        target_name: job.target_label || "",
        decision: job.decision,
        owner_email: job.owner_email || null,
        owner_organization: job.owner_organization || null,
        owner_department: job.owner_department || null,
        requested_at: job.review_request.requested_at,
        status: job.review_request.status,
        reports: (job.reports || []).map(({ file_name, url }) => ({ file_name, url }))
      }));
    json(response, 200, { requests });
    return;
  }

  const progressMatch = pathname.match(/^\/api\/scan\/([^/]+)\/progress$/);
  if (request.method === "GET" && progressMatch) {
    const job = jobs.get(progressMatch[1]);
    if (!job || !canViewJob(request, job)) return notFound(response);
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
    if (!job || !canViewJob(request, job)) return notFound(response);
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
      await handleApi(request, response, url.pathname, url.searchParams);
      return;
    }

    // P3: 매직링크 인증 완료 — 토큰은 1회용이며 만료·오류 시 안내와 함께 되돌린다.
    if (url.pathname === "/auth/complete") {
      const pending = consumeLoginToken(String(url.searchParams.get("token") || ""));
      if (!pending) {
        await recordAuthAudit("login_link_rejected", null);
        redirect(response, "/scan?auth=expired");
        return;
      }
      await upsertAccountOnLogin(pending);
      const cookie = createUserSession(pending.email);
      response.writeHead(302, { Location: "/scan", "Cache-Control": "no-store", "Set-Cookie": cookie });
      response.end();
      return;
    }

    const artifactMatch = url.pathname.match(/^\/artifacts\/(.+)$/);
    if (artifactMatch) {
      const fileName = decodeURIComponent(artifactMatch[1]);
      const owningJob = Array.from(jobs.values())
        .find((job) => !job.review_request && (job.draft_reports || []).some((report) => report.file_name === fileName));
      if (!owningJob || !canViewJob(request, owningJob)) {
        notFound(response);
        return;
      }
      serveDraftArtifact(response, artifactMatch[1], url.searchParams.get("view") === "1");
      return;
    }

    const reportMatch = url.pathname.match(/^\/reports\/(.+)$/);
    if (reportMatch) {
      // 보고서 파일도 소유자(또는 관리자)만 받는다 — scan_id 를 몰라도 파일명 공유로 새는 것을 막는다.
      const fileName = decodeURIComponent(reportMatch[1]);
      const owningJob = Array.from(jobs.values())
        .find((job) => (job.reports || []).some((report) => report.file_name === fileName));
      if (!owningJob || !canViewJob(request, owningJob)) {
        notFound(response);
        return;
      }
      serveReport(response, reportMatch[1], url.searchParams.get("view") === "1");
      return;
    }

    if ((url.pathname === "/admin" || url.pathname === "/admin.html") && !isAdminAuthenticated(request)) {
      redirect(response, "/admin/login");
      return;
    }

    if (url.pathname === "/help" || url.pathname === "/help.html") {
      redirect(response, "/");
      return;
    }

    serveStatic(request, response, decodeURIComponent(url.pathname));
  } catch (error) {
    text(response, 500, `server_error: ${String(error.message || error)}`);
  }
}).listen(PORT, BIND_HOST, () => {
  console.log(`VibeCode Security Gate Portal: http://${BIND_HOST}:${PORT}`);
});
