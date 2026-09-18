#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const releaseFile = join(root, "local-artifacts", "harness", "release-index.json");
const checkerCommitFile = join(root, "config", "checker.commit");

if (!existsSync(releaseFile)) {
  process.stderr.write(`로컬 시험 설치파일 정보가 없습니다: ${releaseFile}\n`);
  process.stderr.write("docs/39_로컬_하네스_시험운영.md의 준비 절차를 먼저 실행하세요.\n");
  process.exit(2);
}

process.env.PORTAL_HARNESS_LOCAL_RELEASE_FILE = releaseFile;
// This is the checker wheel currently installed for the localhost portal.
// Keeping an explicit pilot pin turns accidental checker replacement into a
// configuration error instead of silently accepting a different executable.
const checkerCommit = readFileSync(checkerCommitFile, "utf8").trim().toLowerCase();
if (!/^[0-9a-f]{40}$/.test(checkerCommit)) {
  throw new Error(`Invalid checker commit pin: ${checkerCommitFile}`);
}
process.env.PORTAL_EXPECTED_CHECKER_COMMIT ||= checkerCommit;
process.env.PORTAL_DEPLOYMENT_MODE ||= "local";
process.env.PORTAL_AUTH_PROVIDER ||= "local-dev";
await import("../src/server.js");
