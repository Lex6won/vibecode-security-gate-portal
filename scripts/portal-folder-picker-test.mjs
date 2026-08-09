#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const serverSource = readFileSync(join(root, "src", "server.js"), "utf8");
const powerShell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

assert.ok(serverSource.includes("System.Windows.Forms.FolderBrowserDialog"), "folder picker must use the Windows folder selection dialog");
assert.ok(serverSource.includes("$dialog.AutoUpgradeEnabled = $true"), "folder picker must request the upgraded Windows dialog when available");
assert.ok(serverSource.includes("[Console]::OutputEncoding = $OutputEncoding"), "native picker must return UTF-8 paths to Node");

const unicodeDirectory = join(mkdtempSync(join(tmpdir(), "portal-picker-")), String.fromCodePoint(0xD55C, 0xAE00, 0xACBD, 0xB85C));
mkdirSync(unicodeDirectory);
const escapedUnicodeDirectory = unicodeDirectory.replaceAll("'", "''");
const encodingProbe = spawnSync(powerShell, [
  "-NoProfile",
  "-Command",
  `$OutputEncoding = New-Object System.Text.UTF8Encoding($false); [Console]::OutputEncoding = $OutputEncoding; [Console]::Out.Write('${escapedUnicodeDirectory}')`
], { encoding: "buffer", windowsHide: true });
try {
  assert.equal(encodingProbe.status, 0, `UTF-8 path probe failed: ${encodingProbe.stderr.toString("utf8")}`);
  const decodedPath = encodingProbe.stdout.toString("utf8");
  assert.equal(decodedPath, unicodeDirectory, "PowerShell must return a Korean path as UTF-8");
  assert.ok(existsSync(decodedPath), "Node must validate the UTF-8 Korean path returned by PowerShell");
} finally {
  rmSync(dirname(unicodeDirectory), { recursive: true, force: true });
}

console.log(JSON.stringify({ status: "passed", check: "windows_folder_picker_and_utf8_path" }));
