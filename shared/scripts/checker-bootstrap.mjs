#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const REPOSITORY = "https://github.com/Lex6won/vibecode-checker";

function hasArg(name) {
  return process.argv.includes(name);
}

function valueAfter(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function printUsage() {
  console.log(`
vibecode-checker bootstrap helper

This helper prepares vibecode-checker from:
${REPOSITORY}

Usage:
  node shared/scripts/checker-bootstrap.mjs --target tools/vibecode-checker
  node shared/scripts/checker-bootstrap.mjs --target tools/vibecode-checker --yes
  node shared/scripts/checker-bootstrap.mjs --target tools/vibecode-checker --yes --install-python

Safety:
  - Without --yes, this script only prints the plan.
  - With GVSKB_MODE=offline, this script refuses GitHub clone.
  - Python package install runs only with --install-python.
`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

const target = resolve(valueAfter("--target", "tools/vibecode-checker"));
const yes = hasArg("--yes");
const installPython = hasArg("--install-python");
const offline = process.env.GVSKB_MODE === "offline";

if (hasArg("--help") || hasArg("-h")) {
  printUsage();
  process.exit(0);
}

console.log("vibecode-checker 설치/준비 계획");
console.log(`- GitHub: ${REPOSITORY}`);
console.log(`- 대상 경로: ${target}`);
console.log(`- Python 패키지 설치: ${installPython ? "예" : "아니오"}`);

if (!yes) {
  console.log("");
  console.log("아직 설치하지 않았습니다. 사용자가 설치를 확인하면 --yes를 붙여 다시 실행하세요.");
  console.log("Python 패키지 설치까지 필요하면 추가 확인 후 --install-python을 붙이세요.");
  process.exit(2);
}

if (offline && !existsSync(target)) {
  console.error("GVSKB_MODE=offline 상태에서는 GitHub clone을 할 수 없습니다.");
  console.error("외부망에서 받은 vibecode-checker 폴더를 반입한 뒤 --target으로 지정하세요.");
  process.exit(3);
}

if (!existsSync(target)) {
  run("git", ["clone", "--depth", "1", REPOSITORY, target]);
} else {
  console.log("대상 경로가 이미 존재합니다. GitHub clone은 건너뜁니다.");
}

if (installPython) {
  const python = process.env.PYTHON || "python";
  run(python, ["-m", "pip", "install", "-e", target]);
}

console.log("");
console.log("vibecode-checker 준비 절차가 끝났습니다.");
console.log("다음 단계: MCP server_status 또는 gvskb CLI 상태 확인 결과를 manifest에 기록하세요.");
