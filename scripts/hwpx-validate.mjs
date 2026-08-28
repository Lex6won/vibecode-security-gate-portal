#!/usr/bin/env node
// 요청서 양식(HWPX 틀) 검수 도구 — 양식을 받으면 가장 먼저 이걸 돌린다.
// 사용: node scripts/hwpx-validate.mjs "C:\경로\보안성검토요청서_틀.hwpx"
// 통과 기준: 자리표시자 목록이 기대와 같고, 경고 0건.
import { readFile } from "node:fs/promises";
import { validateTemplate } from "../src/hwpx-template.mjs";

const target = process.argv[2];
if (!target) {
  console.error("사용법: node scripts/hwpx-validate.mjs <HWPX 틀 파일 경로>");
  process.exit(2);
}

const buffer = await readFile(target);
const { placeholders, warnings } = validateTemplate(buffer);

console.log("자리표시자:", placeholders.length ? placeholders.join(", ") : "(없음)");
if (warnings.length) {
  console.log("\n경고:");
  for (const warning of warnings) console.log(` - ${warning}`);
  console.log("\n틀에서 해당 자리표시자를 지우고 {{이름}} 을 한 번에 다시 붙여넣은 뒤 재검수하세요.");
  process.exit(1);
}
console.log("경고 없음 — 치환에 사용할 수 있는 틀입니다.");
