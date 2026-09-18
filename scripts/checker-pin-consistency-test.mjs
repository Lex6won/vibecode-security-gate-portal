#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pin = readFileSync(resolve(root, "config", "checker.commit"), "utf8").trim().toLowerCase();
const fixtureMeta = JSON.parse(readFileSync(
  resolve(root, "fixtures", "checker-reports", "gate-blocked-by-kev.meta.json"),
  "utf8"
));
const workflow = readFileSync(resolve(root, ".github", "workflows", "ci.yml"), "utf8");

assert.match(pin, /^[0-9a-f]{40}$/, "checker pin must be a full commit SHA");
assert.equal(fixtureMeta.checker_commit, pin, "fixture and runtime checker pins must match");
assert.match(workflow, /config\/checker\.commit/, "CI must read the shared checker pin");

console.log(`checker pin consistency test passed (${pin.slice(0, 12)})`);
