#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const serverSource = readFileSync(join(root, "src", "server.js"), "utf8");
const powerShell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const pickerSource = serverSource.match(/\$source = @'\r?\n([\s\S]*?)\r?\n'@\r?\nAdd-Type -TypeDefinition \$source/);

assert.ok(pickerSource, "modern folder-picker C# source must be present in server.js");
assert.ok(serverSource.includes("FOS_PICKFOLDERS") === false, "use the typed PickFolders option instead of an unverified flag literal");
assert.ok(serverSource.includes("FileDialogOptions.PickFolders"), "folder picker must enable the modern PickFolders option");
assert.ok(!serverSource.includes("BrowseForFolder"), "legacy Shell BrowseForFolder must not be used");

const command = `$source = @'\n${pickerSource[1]}\n'@\nAdd-Type -TypeDefinition $source\n[Console]::Out.Write('compiled')`;
const result = spawnSync(powerShell, ["-NoProfile", "-STA", "-Command", command], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true
});

assert.equal(result.status, 0, `modern folder picker must compile: ${result.stderr || result.stdout}`);
assert.equal(result.stdout.trim(), "compiled", `modern folder picker probe failed: ${result.stderr || result.stdout}`);
console.log(JSON.stringify({ status: "passed", check: "modern_windows_folder_picker" }));
