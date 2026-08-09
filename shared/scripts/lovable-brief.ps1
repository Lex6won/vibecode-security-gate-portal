param([string]$Design = "_workspace/02_화면_기능설계서.md")
Write-Output "Lovable은 프로토타입 전용입니다. 실데이터 입력 금지, 운영 직반입 금지, Supabase 직접 의존 금지."
if (Test-Path -LiteralPath $Design) { Get-Content -LiteralPath $Design -Encoding UTF8 }
