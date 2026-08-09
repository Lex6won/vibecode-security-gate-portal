# vibecode-checker 설치·연결 정책

하네스의 보안점검은 `vibecode-checker(gvskb)`가 담당한다. 하네스는 보안검사 로직을 직접 구현하지 않는다. 따라서 보안점검 단계에 들어가기 전에 체커가 설치되어 있거나 MCP/CLI로 연결되어 있어야 한다.

## 1. 기본 원칙

1. 먼저 `vibecode-checker` MCP의 `server_status` 또는 동등한 상태 확인을 시도한다.
2. MCP가 없으면 로컬 CLI 또는 로컬 소스 경로를 확인한다.
3. 둘 다 없으면 사용자에게 체커가 없음을 알리고 설치 여부를 확인한다.
4. 사용자가 명시적으로 동의하기 전에는 GitHub clone, pip install, npm install, MCP 설정 변경을 하지 않는다.
5. 설치 출처는 기본적으로 GitHub `https://github.com/Lex6won/vibecode-checker`만 사용한다.
6. 기본 모드는 online이다. 망분리/offline 환경으로 확인되어 `GVSKB_MODE=offline`을 명시한 경우에는 외부 GitHub clone을 시도하지 않는다. 외부망에서 받은 폴더를 반입해 로컬 경로로 지정하게 한다.
7. 하네스 자체의 배포·업데이트 기준도 GitHub `https://github.com/Lex6won/vibe_harness_codex`다. 로컬 폴더는 작업 복사본이며, 기관별 차이는 우선 `shared/institution-profile.yaml`로 관리한다.
8. 기본 하네스는 체커 내장 표준 프로파일(`dev-quick` 등)을 사용한다. 기관 고유 정책이 생기기 전에는 하네스가 별도 정책 사본을 MCP에 주입하지 않는다.
9. 기관 고유 정책 때문에 `GVSKB_POLICIES_DIR`을 사용해야 하면 상대경로를 쓰지 말고 반드시 절대경로를 사용한다. MCP 서버의 작업 디렉터리는 사용자가 연 프로젝트 폴더일 수 있다.
10. MCP 설정은 `gvskb mcp`가 아니라 `gvskb-server` 실행파일 또는 `python -m gvskb.server` 형식을 사용한다. Windows에서 `python`이 Microsoft Store 별칭이면 `gvskb-server`가 더 안전한 기본값이다.
11. ChatGPT 데스크톱의 Codex, Codex CLI, Codex IDE 확장은 `.codex/config.toml` 또는 사용자 전역 `~/.codex/config.toml`의 `[mcp_servers.vibecode-checker]`를 공유한다. Claude Code는 루트 `.mcp.json`을 사용하고, Claude Code 호환본은 `.claude/.mcp.json`을 둘 수 있으나 원본 기준은 아니다. Claude Desktop은 Claude Code 설정과 자동으로 같아지지 않으므로 Desktop Extension 또는 `.mcpb` 패키지로 별도 연결한다.
12. MCP 설정은 BOM 없는 UTF-8이어야 하며, 기본 env는 `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`이다. `GVSKB_MODE=offline`은 망분리·오프라인 환경에서만 추가한다.

## 2. 사용자 안내 문구

체커가 없으면 다음처럼 안내한다.

```text
보안점검용 vibecode-checker가 현재 연결되어 있지 않습니다.
기획·설계는 계속할 수 있지만, 패키지 검사와 보안점검 완료 처리는 체커 연결 후 가능합니다.

GitHub https://github.com/Lex6won/vibecode-checker 를 기준으로 로컬에 설치/준비할까요?
설치 과정에서는 GitHub clone과 Python 패키지 설치가 발생할 수 있습니다.
```

사용자가 동의하면 설치 절차로 넘어간다. 동의하지 않으면 보안검증 상태를 `incomplete`로 기록하고, 구현·배포 게이트에서는 차단 또는 보류한다.

## 3. 설치/준비 방식

권장 기본 경로는 기관 또는 사용자 환경에 맞춰 정하되, 예시는 다음과 같다.

```text
tools/vibecode-checker/
```

하네스가 설치를 돕는 경우에도 다음을 지킨다.

- GitHub 주소를 사용자에게 보여준다.
- 설치 대상 경로를 사용자에게 보여준다.
- 외부 네트워크 사용과 패키지 설치가 발생함을 알린다.
- 설치 후 `server_status` 또는 CLI 상태 확인 결과를 기록한다.
- 설치 후 quick 점검이 필요한 경우 `scan_path(profile="dev-quick")` 결과의 `profile`이 실제로 `dev-quick`인지 확인한다.
- 체커가 `dev-quick`을 알 수 없는 프로파일로 보고 기본 프로파일로 대체하면 설치 성공과 별개로 quick 보안검증은 미완료다. GitHub 기준 최신 체커로 갱신하거나 기관 고유 정책 절대경로를 바로잡은 뒤 다시 확인한다.
- 실패하면 실패 원인과 수동 설치 경로를 남긴다.

## 4. 제공 스크립트

하네스는 JavaScript 기반 준비 스크립트를 제공할 수 있다.

```powershell
node .\shared\scripts\checker-bootstrap.mjs --target .\tools\vibecode-checker
```

이 명령은 기본적으로 설치하지 않고 안내만 출력한다. 실제 GitHub clone을 하려면 사용자가 확인한 뒤 `--yes`를 붙인다.

```powershell
node .\shared\scripts\checker-bootstrap.mjs --target .\tools\vibecode-checker --yes
```

Python 패키지 설치까지 진행하려면 추가 확인 후 `--install-python`을 붙인다.

```powershell
node .\shared\scripts\checker-bootstrap.mjs --target .\tools\vibecode-checker --yes --install-python
```

Codex CLI/IDE에서 전역 MCP 등록이 필요하면 다음 명령을 사용한다.

```powershell
codex mcp add vibecode-checker `
  --env PYTHONUTF8=1 `
  --env PYTHONIOENCODING=utf-8 `
  -- gvskb-server
```

망분리·오프라인 환경으로 확인된 경우에만 다음처럼 `GVSKB_MODE=offline`을 추가한다.

```powershell
codex mcp add vibecode-checker `
  --env PYTHONUTF8=1 `
  --env PYTHONIOENCODING=utf-8 `
  --env GVSKB_MODE=offline `
  -- gvskb-server
```

## 5. 기록 항목

설치 또는 연결 확인 결과는 `_workspace/vibecode-manifest.json`의 `security_check` 또는 `enforcement`에 기록한다.

- checker_status: connected / installed / missing / failed / user-declined
- checker_source: MCP / CLI / GitHub clone / local path
- checker_repository: `https://github.com/Lex6won/vibecode-checker`
- checker_path
- checked_at
- install_user_confirmed: true / false
- install_result
- server_status_result_id 또는 버전

## 6. 금지사항

- 사용자 확인 없이 외부 네트워크에 접속하지 않는다.
- 사용자 확인 없이 Python 패키지를 설치하지 않는다.
- GitHub 주소를 임의로 바꾸지 않는다.
- `GVSKB_POLICIES_DIR`에 `.claude/...` 같은 상대경로를 넣지 않는다.
- 개인 이름, 이메일, 사번, PC명, IP 등 개인식별자를 caller 또는 설치 로그에 넣지 않는다.
- 체커가 없는데 보안검증 완료, 패키지 승인 완료, 배포 준비 완료라고 표시하지 않는다.
