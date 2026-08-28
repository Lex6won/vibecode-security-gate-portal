# 릴리스 번들 생성 — 망연계(파일전송) 반입용 오프라인 패키지 (docs/29 부록B)
# 사용: .\scripts\build-release-bundle.ps1 -Tag v0.3.0
# 산출: dist\portal-bundle-<태그>.zip + 같은 이름의 .sha256 매니페스트
# 번들 내용: 소스 스냅샷(git archive) + node_modules(오프라인 의존성) + 무결성 매니페스트
# PowerShell 5.1 호환.
param(
  [Parameter(Mandatory = $true)][string]$Tag
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

git rev-parse --verify ("refs/tags/" + $Tag) | Out-Null
if (-not $?) { throw "태그가 없습니다: $Tag (먼저 git tag $Tag && git push origin $Tag)" }

$stage = Join-Path $env:TEMP ("portal-bundle-" + $Tag)
$distDir = Join-Path $repo "dist"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null
New-Item -ItemType Directory -Force $distDir | Out-Null

Write-Host "== 1/4 소스 스냅샷 (git archive $Tag) =="
$srcZip = Join-Path $stage "source.zip"
git archive --format=zip --output $srcZip $Tag
if (-not $?) { throw "git archive 실패" }
Expand-Archive -Path $srcZip -DestinationPath (Join-Path $stage "portal") -Force
Remove-Item $srcZip

Write-Host "== 2/4 오프라인 의존성 (npm ci) =="
Push-Location (Join-Path $stage "portal")
npm ci --ignore-scripts
if (-not $?) { Pop-Location; throw "npm ci 실패" }
Pop-Location

Write-Host "== 3/4 무결성 매니페스트 (SHA-256) =="
$commit = git rev-list -n 1 $Tag
$manifest = New-Object System.Collections.Generic.List[string]
$manifest.Add("bundle: portal-bundle-" + $Tag)
$manifest.Add("tag: " + $Tag)
$manifest.Add("commit: " + $commit)
$manifest.Add("created: " + (Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"))
$manifest.Add("")
$portalDir = Join-Path $stage "portal"
Get-ChildItem $portalDir -Recurse -File | ForEach-Object {
  $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
  $rel = $_.FullName.Substring($portalDir.Length + 1)
  $manifest.Add($hash + "  " + $rel)
}
$manifestPath = Join-Path $stage "MANIFEST.sha256"
[System.IO.File]::WriteAllLines($manifestPath, $manifest)

Write-Host "== 4/4 번들 압축 =="
$bundleZip = Join-Path $distDir ("portal-bundle-" + $Tag + ".zip")
if (Test-Path $bundleZip) { Remove-Item $bundleZip }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $bundleZip
$bundleHash = (Get-FileHash $bundleZip -Algorithm SHA256).Hash
[System.IO.File]::WriteAllText(($bundleZip + ".sha256"), ($bundleHash + "  " + (Split-Path -Leaf $bundleZip) + "`r`n"))
Remove-Item -Recurse -Force $stage

Write-Host ""
Write-Host ("번들:        " + $bundleZip)
Write-Host ("전체 해시:   " + $bundleHash)
Write-Host "반입 절차: ZIP + .sha256 를 함께 전달 → 반입 후 해시 대조 → docs/29 부록B 설치 절차 수행"
