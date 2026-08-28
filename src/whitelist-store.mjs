// 화이트리스트 근거 목록 저장층 (P4)
//
// 절대 규칙 — 역할 경계(docs/27):
//  - 이 목록은 **판정이 아니다**. 관리자가 보안부서에 제출할 화이트리스트 "근거"를
//    구성(담기·제외)하고 이미지 반영용으로 저장·내보내기 하는 것까지가 전부다.
//  - 어떤 검사·판정 경로도 이 목록을 읽지 않는다. 승인은 보안부서 판정 →
//    레지스트리 번들 → 체커 verdict 경로로만 돌아온다.
//  - 모든 변경(담기·제외·해제·내보내기)은 감사 기록을 남긴다(08-24 확정).
//
// 파일 기반 어댑터 — DB 전환 시 함수 구현만 교체한다(observation-store 와 동일 규칙).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

let whitelistFile = "";
let auditFile = "";
let entries = {};

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

export function initWhitelistStore(directory) {
  mkdirSync(directory, { recursive: true });
  whitelistFile = join(directory, "whitelist.json");
  auditFile = join(directory, "whitelist-audit.jsonl");
  entries = readJsonFile(whitelistFile, {});
}

async function recordWhitelistAudit(action, detail) {
  try {
    await appendFile(auditFile, `${JSON.stringify({ action, ...detail, at: new Date().toISOString() })}\n`, "utf8");
  } catch {
    // 감사 기록 실패가 관리자 작업을 막아선 안 되지만, 기록 없는 변경도 안 된다.
    throw new Error("감사 기록을 남기지 못해 변경을 중단했습니다.");
  }
}

function entryKey(ecosystem, packageName) {
  return `${ecosystem}:${packageName}`;
}

export function whitelistStatus(ecosystem, packageName) {
  return entries[entryKey(ecosystem, packageName)]?.status || null;
}

// action: "include"(담기) | "exclude"(제외) | "reset"(해제)
export async function setWhitelistEntry(ecosystem, packageName, action, reason, actor) {
  const key = entryKey(ecosystem, packageName);
  const before = entries[key]?.status || null;
  await recordWhitelistAudit(action, { ecosystem, package_name: packageName, before, reason: reason || null, actor });
  if (action === "reset") {
    delete entries[key];
  } else {
    entries[key] = {
      ecosystem,
      package_name: packageName,
      status: action === "include" ? "included" : "excluded",
      reason: reason || null,
      decided_at: new Date().toISOString(),
      decided_by: actor
    };
  }
  await saveJsonAtomic(whitelistFile, entries);
  return entries[key] || null;
}

export function whitelistSnapshot() {
  return entries;
}

export function whitelistSummary() {
  const values = Object.values(entries);
  return {
    included: values.filter((entry) => entry.status === "included").length,
    excluded: values.filter((entry) => entry.status === "excluded").length
  };
}

export async function recordWhitelistExport(format, counts, actor) {
  await recordWhitelistAudit("export", { format, ...counts, actor });
}
