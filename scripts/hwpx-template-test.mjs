#!/usr/bin/env node
// HWPX 치환 엔진 검증 — 실제 양식이 오기 전까지는 합성 HWPX(zip)로 검증한다.
// 외부 검증 포함: 우리가 쓴 ZIP 을 PowerShell(.NET)이 열 수 있어야 한다 —
// 자기 구현끼리만 맞는 ZIP 이 되는 것을 막는다.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readZipEntries, writeZipEntries, validateTemplate, fillTemplate } from "../src/hwpx-template.mjs";

const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

// 합성 HWPX: mimetype(비압축) + 자리표시자가 든 section XML(압축) + 바이너리 미리보기.
const sectionXml = `<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section">
  <hp:t>기관명: {{기관명}} / 부서: {{부서명}}</hp:t>
  <hp:t>대상: {{점검대상}} · 판정: {{판정}}</hp:t>
  <hp:t>쪼개진 예시: {{기관</hp:t><hp:t>명2}}</hp:t>
</hs:sec>`;
const template = writeZipEntries([
  { name: "mimetype", data: Buffer.from("application/hwp+zip", "utf8"), method: 0, flags: 0, modTime: 0x6000, modDate: 0x58c1 },
  { name: "Contents/section0.xml", data: Buffer.from(sectionXml, "utf8"), method: 8, flags: 0x0800, modTime: 0x6000, modDate: 0x58c1 },
  { name: "Preview/preview.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x7b, 0x7b]), method: 8, flags: 0, modTime: 0x6000, modDate: 0x58c1 }
]);

// 1) 라운드트립: 우리가 쓴 ZIP 을 우리가 다시 읽을 수 있다.
const roundTrip = readZipEntries(template);
assert.equal(roundTrip.length, 3);
assert.equal(roundTrip[0].name, "mimetype");
assert.equal(roundTrip[0].method, 0, "mimetype must stay uncompressed");
assert.equal(roundTrip[0].data.toString("utf8"), "application/hwp+zip");

// 2) 틀 검수: 자리표시자 목록 + 쪼개진 자리표시자 경고.
const validation = validateTemplate(template);
assert.deepEqual(validation.placeholders, ["기관명", "부서명", "점검대상", "판정"]);
assert.ok(validation.warnings.length >= 1, "split placeholders must produce a warning");
assert.ok(validation.warnings[0].includes("기관"), "warning must show the readable fragment");

// 3) 엄격 모드: 값이 빠지면 실패한다 — 공문서 빈칸 방지.
assert.throws(
  () => fillTemplate(template, { 기관명: "경기도청" }),
  /값이 준비되지 않은 자리표시자/,
  "strict mode must fail on missing values"
);

// 4) 치환 + XML 이스케이프: 값에 태그·특수문자가 와도 문서가 깨지지 않는다.
const values = {
  기관명: "경기도청",
  부서명: "AI산업육성과 <총괄> & '데이터'",
  점검대상: "민원 대시보드",
  판정: "제출 가능"
};
const filled = fillTemplate(template, values);
assert.deepEqual(filled.missing, []);
assert.deepEqual(filled.replaced, ["기관명", "부서명", "점검대상", "판정"]);
const filledEntries = readZipEntries(filled.buffer);
const filledXml = filledEntries.find((entry) => entry.name === "Contents/section0.xml").data.toString("utf8");
assert.ok(filledXml.includes("기관명: 경기도청"), "placeholders must be replaced");
assert.ok(filledXml.includes("AI산업육성과 &lt;총괄&gt; &amp; &apos;데이터&apos;"), "values must be XML-escaped");
assert.ok(!/\{\{(기관명|부서명|점검대상|판정)\}\}/.test(filledXml), "no known placeholder may remain");
assert.ok(filledXml.includes("{{기관"), "split placeholders remain untouched for human review");
const previewOut = filledEntries.find((entry) => entry.name === "Preview/preview.png");
assert.deepEqual([...previewOut.data.slice(8)], [0x7b, 0x7b], "binary entries must never be modified");
assert.equal(filledEntries[0].data.toString("utf8"), "application/hwp+zip", "mimetype must survive filling");

// 5) 외부 검증: PowerShell(.NET ZipFile)이 우리가 만든 ZIP 을 해제할 수 있다.
const workDir = await mkdtemp(join(tmpdir(), "hwpx-template-"));
const zipPath = join(workDir, "filled.zip");
await writeFile(zipPath, filled.buffer);
const extractDir = join(workDir, "out");
const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPath.replaceAll("'", "''")}', '${extractDir.replaceAll("'", "''")}')`;
const child = spawn(powershell, ["-NoProfile", "-Command", script], { windowsHide: true });
const [code] = await once(child, "close");
assert.equal(code, 0, "a standard ZIP tool must be able to open our output");
const externalXml = await readFile(join(extractDir, "Contents", "section0.xml"), "utf8");
assert.ok(externalXml.includes("기관명: 경기도청"), "externally extracted XML must show the substituted values");

console.log(JSON.stringify({
  status: "passed",
  placeholders: validation.placeholders,
  split_warnings: validation.warnings.length,
  external_zip_check: "ok"
}, null, 2));
