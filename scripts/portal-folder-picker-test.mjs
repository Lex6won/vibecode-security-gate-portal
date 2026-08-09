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
const pickerSource = serverSource.match(/\$source = @'\r?\n([\s\S]*?)\r?\n'@\r?\nAdd-Type -TypeDefinition \$source/);

assert.ok(pickerSource, "modern folder-picker C# source must be present in server.js");
assert.ok(serverSource.includes("FOS_PICKFOLDERS") === false, "use the typed PickFolders option instead of an unverified flag literal");
assert.ok(serverSource.includes("FileDialogOptions.PickFolders"), "folder picker must enable the modern PickFolders option");
assert.ok(!serverSource.includes("BrowseForFolder"), "legacy Shell BrowseForFolder must not be used");
assert.ok(serverSource.includes("[Console]::OutputEncoding = $OutputEncoding"), "native picker must return UTF-8 paths to Node");
assert.match(serverSource, /Guid\("43826D1E-E718-42EE-BC55-A1E261C37BFE"\), InterfaceType\(ComInterfaceType\.InterfaceIsIUnknown\)\]\s+private interface IShellItem/);
assert.match(serverSource, /Guid\("42F85136-DB7E-439C-85F1-E4075D135FC8"\), InterfaceType\(ComInterfaceType\.InterfaceIsIUnknown\)\]\s+private interface IFileDialog/);

const command = `$source = @'\n${pickerSource[1]}\n'@\nAdd-Type -TypeDefinition $source\n$probe = [PortalFolderPicker]::Probe()\nif ([string]::IsNullOrWhiteSpace($probe) -or -not (Test-Path -LiteralPath $probe)) { throw 'shell-item probe failed' }\n[Console]::Out.Write('compiled-and-probed')`;
const result = spawnSync(powerShell, ["-NoProfile", "-STA", "-Command", command], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true
});

assert.equal(result.status, 0, `modern folder picker must compile: ${result.stderr || result.stdout}`);
assert.equal(result.stdout.trim(), "compiled-and-probed", `modern folder picker probe failed: ${result.stderr || result.stdout}`);

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

console.log(JSON.stringify({ status: "passed", check: "modern_windows_folder_picker_and_shell_item" }));
