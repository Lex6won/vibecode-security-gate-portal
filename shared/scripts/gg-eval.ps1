param(
  [string]$Root = ".",
  [string]$EvalDir = "evals"
)

$ErrorActionPreference = "Stop"
$rootPath = Resolve-Path -LiteralPath $Root
$evalPath = Join-Path $rootPath $EvalDir

if (!(Test-Path -LiteralPath $evalPath)) {
  throw "Eval directory not found: $evalPath"
}

$failures = New-Object System.Collections.Generic.List[string]
$cases = Get-ChildItem -LiteralPath $evalPath -Filter "*.json" -File

foreach ($case in $cases) {
  try {
    $json = Get-Content -LiteralPath $case.FullName -Encoding UTF8 -Raw | ConvertFrom-Json
  } catch {
    $failures.Add("INVALID JSON: $($case.Name) - $($_.Exception.Message)") | Out-Null
    continue
  }

  if (-not $json.name) { $failures.Add("MISSING name: $($case.Name)") | Out-Null }
  if (-not $json.expect -or $json.expect.Count -eq 0) { $failures.Add("MISSING expect[]: $($case.Name)") | Out-Null }
}

if ($failures.Count -gt 0) {
  Write-Output "EVAL CHECK FAILED"
  $failures | ForEach-Object { Write-Output "- $_" }
  exit 1
}

Write-Output "EVAL CHECK PASSED ($($cases.Count) cases)"
exit 0
