#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const releaseFile = join(root, "local-artifacts", "harness", "release-index.json");

if (!existsSync(releaseFile)) {
  process.stderr.write(`로컬 시험 설치파일 정보가 없습니다: ${releaseFile}\n`);
  process.stderr.write("docs/39_로컬_하네스_시험운영.md의 준비 절차를 먼저 실행하세요.\n");
  process.exit(2);
}

process.env.PORTAL_HARNESS_LOCAL_RELEASE_FILE = releaseFile;
// This is the checker wheel currently installed for the localhost portal.
// Keeping an explicit pilot pin turns accidental checker replacement into a
// configuration error instead of silently accepting a different executable.
process.env.PORTAL_EXPECTED_CHECKER_COMMIT ||= "b27fccacf77c602800f70cf1e62bfde3ec8e2e4a";
await import("../src/server.js");
