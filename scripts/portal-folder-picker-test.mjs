#!/usr/bin/env node
// S1(서버 전환): 네이티브 폴더 선택창은 서버에서 제거됐다.
// 이 테스트는 이제 "제거된 것이 되살아나지 않았는지"를 지킨다 —
// 다중 사용자 서버에서 GUI 대화상자는 서버 콘솔에 떠서 아무도 누를 수 없다.
// 파일 선택은 브라우저(webkitdirectory·showDirectoryPicker)가 사용자 PC에서 한다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const serverSource = readFileSync(join(root, "src", "server.js"), "utf8");
const scanPage = readFileSync(join(root, "design", "html-prototype", "security-scan.html"), "utf8");

assert.ok(!serverSource.includes("FolderBrowserDialog"), "server must never open a native folder dialog (it appears on the server console)");
assert.ok(!serverSource.includes("OpenFileDialog"), "server must never open a native file dialog");
assert.ok(!serverSource.includes("pickLocalPath"), "native picker logic must stay migrated to the tool manager");
assert.ok(!serverSource.includes("/api/local/pick-target"), "native picker route must not come back");

assert.ok(scanPage.includes("webkitdirectory"), "folder selection must use the browser Explorer picker");
assert.ok(scanPage.includes("showDirectoryPicker"), "report saving must use the browser directory picker");
assert.ok(scanPage.includes('accept=".zip'), "ZIP selection must use the browser file picker");

console.log(JSON.stringify({ status: "passed", check: "browser_only_file_selection" }));
