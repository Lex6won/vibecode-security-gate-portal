// 사용자 계정 저장층 — 매직링크 인증·프로필·감사 기록 (P3)
//
// 파일 기반이며 DB(db/schema.postgresql.sql)가 준비되면 함수 구현만 교체한다.
// 호출부(server.js)는 인터페이스만 안다 — observation-store 와 같은 어댑터 규칙.
//
// 하네스팀 연동합의(docs/28) 반영 사항:
//  - 비밀번호 없음. 이메일 주소는 링크 발송을 위해 평문으로 저장한다.
//  - 기관명·부서명은 자유입력 텍스트이며, 변경 이력을 남긴다.
//    (이메일 인증만으로 실제 소속을 증명하지 않는다 — "사용자가 등록한 소속")
//  - 로그인 링크는 1회용·15분 만료. 프로세스 메모리에만 두고 디스크에 남기지 않는다.
//  - 로그인·프로필 변경 등은 감사 로그(audit.jsonl)에 남긴다.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;
const LINK_REQUEST_WINDOW_MS = 15 * 60 * 1000;
const LINK_REQUEST_LIMIT_PER_EMAIL = 5;

let accountsFile = "";
let auditFile = "";
let accounts = {};
const loginTokens = new Map();
const linkRequestCounters = new Map();

function readJsonFile(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function saveJsonAtomic(path, value) {
  const temporary = `${path}.writing`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export function initAccountStore(directory) {
  mkdirSync(directory, { recursive: true });
  accountsFile = join(directory, "accounts.json");
  auditFile = join(directory, "auth-audit.jsonl");
  accounts = readJsonFile(accountsFile, {});
}

export async function recordAuthAudit(event, email, detail = null) {
  try {
    await appendFile(auditFile, `${JSON.stringify({ event, email, detail, at: new Date().toISOString() })}\n`, "utf8");
  } catch {
    // 감사 기록 실패가 로그인 흐름을 막아선 안 된다.
  }
}

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function emailDomainAllowed(email, allowedDomains) {
  const domain = email.split("@")[1] || "";
  return allowedDomains.includes(domain);
}

// 링크 요청 횟수 제한 — 같은 이메일로 15분에 5회까지.
export function linkRequestAllowed(email) {
  const now = Date.now();
  const counter = linkRequestCounters.get(email);
  if (!counter || now - counter.window_start > LINK_REQUEST_WINDOW_MS) {
    linkRequestCounters.set(email, { window_start: now, count: 1 });
    return true;
  }
  if (counter.count >= LINK_REQUEST_LIMIT_PER_EMAIL) return false;
  counter.count += 1;
  return true;
}

export function getAccount(email) {
  return accounts[email] || null;
}

// 로그인 링크 토큰 발급. 신규 가입이면 기관·부서를 토큰에 실어 두었다가 인증 시 계정을 만든다.
export function createLoginToken(email, profile) {
  const token = randomBytes(32).toString("hex");
  loginTokens.set(token, {
    email,
    organization: String(profile?.organization || "").trim(),
    department: String(profile?.department || "").trim(),
    expires_at: Date.now() + LOGIN_TOKEN_TTL_MS
  });
  return { token, expires_in_minutes: LOGIN_TOKEN_TTL_MS / 60000 };
}

// 1회용: 성공이든 만료든 조회 즉시 폐기한다.
export function consumeLoginToken(token) {
  const pending = loginTokens.get(token);
  loginTokens.delete(token);
  if (!pending || pending.expires_at <= Date.now()) return null;
  return pending;
}

// 인증 완료 시 계정 생성(신규) 또는 로그인 시각 갱신(기존).
export async function upsertAccountOnLogin(pending) {
  const now = new Date().toISOString();
  let account = accounts[pending.email];
  if (!account) {
    account = {
      email: pending.email,
      organization: pending.organization,
      department: pending.department,
      created_at: now,
      verified_at: now,
      last_login_at: now,
      profile_history: []
    };
    accounts[pending.email] = account;
    await recordAuthAudit("account_created", pending.email, { organization: account.organization, department: account.department });
  } else {
    account.last_login_at = now;
    await recordAuthAudit("login", pending.email);
  }
  await saveJsonAtomic(accountsFile, accounts);
  return account;
}

// 프로필(기관·부서) 수정 — 변경 전후를 이력으로 남긴다. 과거 점검의 스냅샷은 바뀌지 않는다.
export async function updateAccountProfile(email, organization, department) {
  const account = accounts[email];
  if (!account) return null;
  const before = { organization: account.organization, department: account.department };
  account.profile_history = account.profile_history || [];
  account.profile_history.push({ ...before, changed_at: new Date().toISOString() });
  account.organization = String(organization || "").trim();
  account.department = String(department || "").trim();
  await saveJsonAtomic(accountsFile, accounts);
  await recordAuthAudit("profile_updated", email, { before, after: { organization: account.organization, department: account.department } });
  return account;
}

export function accountSummary() {
  const entries = Object.values(accounts);
  return { total_accounts: entries.length };
}
