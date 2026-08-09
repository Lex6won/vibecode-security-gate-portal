param(
  [string]$Workspace = "_workspace",
  [string]$OutDir = "dist"
)

$ErrorActionPreference = "Stop"
if (!(Test-Path -LiteralPath $Workspace)) { throw "Workspace not found: $Workspace" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$zip = Join-Path $OutDir "vibecode-handoff-$stamp.zip"
$include = @("source", ".check-reports", "Dockerfile", "00_feature_brief.md", "00_작업현황.md", "01_PRD_서비스기획서.md", "02_화면_기능설계서.md", "03_DB_테이블정의서.md", "04_개발스택_운영환경.md", "05_보안점검보고서.md", "06_MCP_검증결과.md", "07_서버설치_배포가이드.md", "08_배포신청서.md", "09_예외신청서.md", "10_패키지예외신청서.md", "11_패키지검토요청서.md", "vibecode-manifest.json")
$paths = @()
foreach ($item in $include) {
  $p = Join-Path $Workspace $item
  if (Test-Path -LiteralPath $p) { $paths += $p }
}
if ($paths.Count -eq 0) { throw "No handoff artifacts found in $Workspace" }
Compress-Archive -LiteralPath $paths -DestinationPath $zip -Force
Write-Output "PACKAGE=$zip"
