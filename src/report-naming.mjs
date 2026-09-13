import { basename } from "node:path";

/**
 * 보고서 파일 이름.
 *
 * 무엇이 잘못돼 있었나: 이름을 대상명·분 단위 시각·점검 종류로 만들고, **파일이
 * 이미 있는지만 보고** _2, _3 을 붙였다. 파일은 점검이 끝난 뒤에 생기므로, 같은
 * 대상을 같은 분에 두 번 점검하면 둘 다 "아직 없음"을 보고 같은 이름을 고른다 —
 * 나중 것이 먼저 것을 덮어쓴다. 결재 증적으로 쓰는 보고서가 조용히 사라진다.
 *
 * 그래서 작업 id 를 이름에 항상 넣는다. 작업 id 는 만들어질 때 이미 유일하므로
 * 파일이 생기기 전에도 이름이 갈린다. 존재 검사는 그대로 두되 안전망일 뿐이다.
 */

export function safeReportNamePart(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48);
}

export function koreaReportTimestamp(date = new Date()) {
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

/** 작업 id 에서 파일 이름에 넣을 짧은 꼬리표. 없으면 빈 문자열. */
export function jobTag(jobId) {
  const compact = String(jobId || "").replace(/[^0-9a-z]/gi, "").toLowerCase();
  return compact.slice(0, 8);
}

export const REPORT_EXTENSIONS = Object.freeze([".json", ".html", ".md", ".sbom.cdx.json"]);

/**
 * @param {object} job         target_type · target_ref · target_label · mode · id
 * @param {string} targetPath  대상 경로(라벨이 없을 때 이름으로 쓴다)
 * @param {object} [options]
 * @param {Date}   [options.now]     시각 — 테스트가 고정한다
 * @param {(stem: string) => boolean} [options.exists]  같은 이름의 산출물이 이미 있는가
 */
export function reportStemForJob(job, targetPath, { now = new Date(), exists = () => false } = {}) {
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
  if (!targetName) targetName = safeReportNamePart(basename(String(targetPath || "")));
  // 점검 방식을 파일명에 남긴다 — 간편/표준 보고서가 이름부터 구분돼야
  // "차이가 없다"는 오해가 생기지 않는다(실제로는 프로파일·규칙 수가 다르다).
  const modeName = job.mode === "quick" ? "간편점검" : "표준점검";
  const base = [targetName, koreaReportTimestamp(now), modeName, jobTag(job.id)].filter(Boolean).join("_");
  let candidate = base;
  let suffix = 2;
  while (exists(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}
