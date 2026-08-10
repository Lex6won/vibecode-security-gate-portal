# 하네스·체커 구현 기록

## 목적

포털 구현 과정에서 하네스와 체커가 각각 어떤 역할을 했고, 어떤 결과를 만들었는지 기록한다.

## 적용 기준

- 하네스: `Lex6won/vibe_harness_codex`
- 체커: `Lex6won/vibecode-checker`
- 포털 프로젝트: `vibecode-security-gate-portal`

## 2026-08-09 기록

### 하네스 적용

적용한 파일:

- `AGENTS.md`
- `shared/`
- `.mcp.json`
- `.codex/config.toml`

역할:

- 구현 언어를 Python, JavaScript, TypeScript 허용 범위로 제한했다.
- 새 패키지 설치 전 체커 게이트를 사용해야 한다는 기준을 제공했다.
- MCP 설정은 `gvskb-server`를 사용해야 한다는 기준을 제공했다.
- 구현 전후에 `gg-validate.ps1` 검증을 요구했다.

검증 결과:

- 1차 실행: `powershell.exe` 실행 파일을 찾지 못해 실패했다.
- 재실행: `.\shared\scripts\gg-validate.ps1` 직접 호출로 진행했다.
- 하네스 파일 자체는 확인됐으나, 포털 README에 하네스 배포 기준과 체커 프로필 기준이 부족해 실패했다.

조치:

- README에 하네스/체커 공식 저장소, `gvskb-server`, `dev-quick`, `profile_fallback`, `network_profile`, 최종 스모크 테스트 기준을 보강해야 한다.

### 체커 확인

실행:

```text
gvskb version
gvskb doctor
```

결과:

- 버전: `vibecode-checker (gvskb) 0.3.0`
- doctor: ERROR 0, WARN 3
- WARN 사유:
  - `PYTHONUTF8` 미설정
  - `PYTHONIOENCODING` 미설정
  - Semgrep adapter disabled

조치:

- 포털 서버에서 체커 호출 시 `PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`을 환경변수로 주입하도록 구현했다.
- Semgrep 미설치는 JS/TS 정밀도 한계로 기록한다. 최종 제출 점검 전 보완 후보로 남긴다.

### 구현 선택

선택:

- Node.js 내장 모듈 기반 로컬 웹앱
- 새 npm 패키지 추가 없음

이유:

- 현재 PC에서 `python`은 Microsoft Store 별칭으로만 잡혀 있다.
- 이번 1차 API 골격은 Node.js 내장 모듈만으로 구현 가능했다.
- 패키지 사용 금지가 아니라, 필요한 패키지는 체커 게이트로 확인한 뒤 사용한다.
- 체커 CLI는 `gvskb`로 동작하므로 로컬 API에서 직접 호출 가능하다.

패키지 원칙:

- 패키지를 쓰지 않는 것이 목표가 아니다.
- 필요한 패키지는 사용한다.
- 단, 설치 전 체커 게이트를 통해 실재 여부, 취약점, 악성 패키지, 쿨다운, 검토 필요 여부를 확인한다.
- 차단 또는 판정 불가가 나오면 대체 패키지, 표준 라이브러리 구현, 예외 검토 순서로 처리한다.

구현한 기능:

- `/health`
- `/api/local/status`
- `/api/local/update/preview`
- `/api/local/update/apply`
- `/api/local/mcp/register`
- `/api/scan/start`
- `/api/scan/{scan_id}/progress`
- `/api/scan/{scan_id}/result`
- 정적 HTML 시안 라우팅

아직 남은 기능:

- GitHub URL clone 검사
- 압축파일 해제 검사
- MCP 설정 백업 및 실제 등록
- 업데이트 실제 적용
- 보고서 ZIP 패키징
- Supabase 동기화

## 역할 요약

| 도구 | 이번 구현에서 한 일 | 결과 |
|---|---|---|
| 하네스 | 구현 언어, 패키지 설치, MCP 명령, 검증 기준을 제한 | 새 패키지 없이 Node 내장 구현으로 결정 |
| 체커 | 설치 상태와 doctor 상태 확인, 향후 scan API 실행 대상 | `gvskb 0.3.0`, WARN 3 확인 |
| 포털 | 하네스와 체커를 사용자 화면/API로 연결 | 로컬 API 골격 생성 |

## 일반 개발 대비 추가 비용 기록

정확한 토큰 예산 추적은 이번 세션에 별도 goal budget이 설정되어 있지 않아 자동 집계되지 않았다. 따라서 이번 기록은 실제 추가 단계와 추정 비용으로 남긴다.

### 추가된 단계

하네스 때문에 추가된 단계:

- 하네스 권한 파일과 정책 파일 확인
- 포털 프로젝트에 `AGENTS.md`, `shared/`, `.mcp.json`, `.codex/config.toml` 적용
- `gg-validate.ps1` 실행
- README 필수 운영 기준 보강
- 새 패키지 설치 없이 구현 가능한지 검토
- Python Store 별칭 문제 확인

체커 때문에 추가된 단계:

- `gvskb version` 확인
- `gvskb doctor` 확인
- doctor WARN 원인 분석
- 체커 호출 환경변수 `PYTHONUTF8`, `PYTHONIOENCODING` 반영
- 향후 `scan_path`/CLI scan 결과를 포털 API와 연결하는 구조 설계

### 이번 구현 기준 추정

| 항목 | 일반 개발 | 하네스·체커 적용 개발 |
|---|---:|---:|
| 설계 확인 | 낮음 | 중간 |
| 구현 속도 | 빠름 | 보통 |
| 검증 단계 | 수동 간단 확인 | 하네스 검증 + 체커 doctor + 보안 스캔 |
| 기록 작업 | 거의 없음 | 역할·결과·비용 기록 필요 |
| 초기 시간 | 1.0배 | 약 1.3~1.6배 |
| 초기 토큰 | 1.0배 | 약 1.4~1.8배 |
| 후반 재작업 위험 | 높음 | 낮음 |

### 비용 해석

초기에는 하네스와 체커 때문에 시간이 더 든다. 특히 파일 적용, 정책 확인, 검증 실패 보정, 결과 기록이 추가된다.

대신 다음 위험을 줄인다.

- 임의 패키지 설치
- 체커 미연결 상태에서 보안 완료로 착각
- `main` 자동 업데이트 같은 위험한 운영 방식
- 검사 실패를 통과로 표시
- 구현 후 뒤늦은 구조 변경

### 다음부터 정확히 측정할 지표

- 하네스 확인 시작 시각
- 구현 시작 시각
- 첫 실행 성공 시각
- 체커 첫 점검 시각
- 체커 최종 통과 시각
- 하네스 검증 실패 횟수
- 체커 findings 수
- 하네스 때문에 변경한 파일 수
- 체커 때문에 수정한 코드 수
- Codex goal token budget 또는 세션 토큰 사용량

## 구현 제약 기록

브라우저 폴더 선택은 보안상 사용자 PC의 실제 절대 경로를 서버에 제공하지 않는다.

따라서 순수 브라우저 화면만으로는 `gvskb scan <local-path>`를 바로 실행하기 어렵다. 해결 방식은 다음 중 하나다.

- 로컬 브릿지/데스크톱 앱에서 OS 파일 선택 대화상자를 열고 절대 경로를 서버에 전달
- 사용자가 로컬 경로를 직접 입력
- 파일 업로드 방식으로 임시 폴더에 저장한 뒤 검사

현재 구현은 로컬 API 골격과 체커 CLI 연결을 먼저 만들었고, 실제 폴더 선택 자동 연결은 로컬 브릿지 또는 데스크톱 포장 단계에서 완성한다.

## 2026-08-09 추가 기록: README 검증과 하네스 강제의 차이

사용자 검토 의견:

- “프로젝트 README에 작성해야지만 하네스를 사용한다면 잘못된 것 아닌가?”
- “하네스가 설치되면 개발할 때 강제해야 한다.”
- “다른 사람들이 하네스를 설치해도 같은 문제가 생길 수 있으니, 왜 그런지 나중에 확인할 수 있도록 기록해야 한다.”

판단:

- 맞다. README 마커 검증은 하네스 적용 여부를 설명하는 문서 검증일 뿐이다.
- 문서 검증만으로는 직접 `npm install`, `pip install`, 커밋, 배포를 막을 수 없다.
- 따라서 하네스는 문서가 아니라 실행 지점에 연결되어야 한다.

이번 조치:

- `scripts/portal-harness-gate.mjs`를 추가했다.
- `npm run harness:gate`로 하네스 필수 파일, MCP 설정, 패키지 게이트 기록, 구현 언어 정책, 체커 doctor 상태를 확인한다.
- `npm run security:scan`으로 `src`를 `dev-quick` 프로파일로 스캔한다.
- `npm run guard`가 문법 확인, 하네스 게이트, 체커 스캔을 함께 실행한다.
- `.githooks/pre-commit`을 추가하고 `git config core.hooksPath .githooks`를 설정했다.

다른 사용자 PC에서도 같은 문제가 생기는 이유:

- 하네스 파일이 복사되어 있어도, 개발자가 직접 터미널에서 명령을 실행하면 하네스 게이트를 우회할 수 있다.
- Codex, Claude Code, Claude Desktop, ChatGPT Desktop, 일반 IDE가 동일한 MCP 설정 파일을 자동 공유하지 않는다.
- Git hook은 저장소 로컬 설정이므로 clone 직후 자동 활성화되지 않을 수 있다.
- Windows PC는 Python, Node.js, Git, PATH 상태가 서로 달라 같은 하네스라도 실행 가능성이 다르다.

하네스 자체에 필요한 개선:

- 설치 스크립트가 `core.hooksPath` 설정까지 자동 수행해야 한다.
- 설치 후 `npm run guard` 또는 동등한 검증 명령을 자동으로 1회 실행해야 한다.
- 패키지 설치는 `gvskb_gate` 래퍼를 통해 유도하고, 직접 설치가 발생하면 하네스 우회로 기록해야 한다.
- Codex, Claude Code, Claude Desktop, ChatGPT Desktop별 MCP 등록 상태를 분리해서 확인해야 한다.
- “README 마커 통과”와 “실행 게이트 통과”를 별도 상태로 표시해야 한다.

현재 남은 한계:

- Git hook은 개발자가 끌 수 있으므로 최종 제출 또는 CI 단계에서 다시 `npm run guard`를 실행해야 한다.
- 일반 브라우저 웹 포털은 사용자의 로컬 경로와 설치 상태를 직접 읽을 수 없으므로 데스크톱 앱 또는 로컬 브리지 권한이 필요하다.
- 체커가 찾은 결과는 보안 검토 증거이며 공식 승인 자체는 아니다.

검증 결과:

- `npm run check`: 통과
- `git diff --check`: 통과
- `npm run harness:gate`: 통과
- `npm run security:scan`: 통과
- `npm run guard`: 통과
- MCP `scan_path` 대상 `src`: 검사 파일 1건, findings 0건, block 0건
- `/api/local/status`: 하네스 파일, 체커, MCP 외에 `execution_gate` 항목을 추가했다.

확인된 WARN:

- `gvskb doctor`는 Semgrep 미설치 때문에 종합 상태가 WARN이고 종료코드 1을 반환한다.
- doctor 요약은 `ERROR 0`, `WARN 1`이다.
- 개발 게이트에서는 ERROR만 차단하고 WARN은 기록한다.
- 이유: Semgrep 미설치만으로 개발을 막으면 과차단이며, JS/TS regex 엔진 검사는 계속 수행된다.

운영 전 보완:

- 최종 제출 단계에서는 Semgrep 설치 또는 WSL/Linux 기반 스캔을 별도 권장한다.
- CI 또는 제출 패키지 단계에서는 `npm run guard`를 다시 실행해 로컬 hook 우회를 보완한다.
- 새 dependency가 생기면 `docs/13_package_gate_log.md`에 체커 게이트 결과를 먼저 남긴다.

## 2026-08-09 추가 기록: 서비스 구현 중심 재정리

사용자 검토 의견:

- 구현이 메인 목적이다.
- 체커와 하네스는 구현 과정에서 제대로 제한하고 돕는지 확인하기 위한 수단이다.
- 구현 내용, 하네스·체커가 한 일, 추가 시간과 토큰 비용이 함께 기록되어야 한다.

조치:

- `docs/14_service_implementation_status.md`를 추가했다.
- 서비스 구현 완료 범위와 미구현 범위를 분리했다.
- GitHub URL 점검 흐름을 실제 API와 연결했다.
- 하네스 설치 화면의 상태 점검 버튼을 실제 `/api/local/status`와 연결했다.
- 구현 중 하네스와 체커가 만든 추가 작업, 추가 시간·토큰 비용을 별도 표로 정리했다.
- API 결과 판정에서 검사 파일 0건은 안전으로 보지 않고 `needs_review`로 처리하도록 보정했다.

현재 구현 판정:

- 전체 제품 완성은 아니다.
- 1차 로컬 포털 MVP 골격, GitHub URL 기반 보안점검, HTML/Markdown 보고서 생성, 제출 ZIP 생성은 구현됐다.
- 관리자 화면은 현재 세션 점검 이력까지 API로 연결됐다.
- 폴더/압축파일 검사, 관리자 영속 DB, Supabase 연동, 실제 하네스 설치 적용은 다음 구현 단계다.

추가 구현에서 확인한 하네스·체커 역할:

- 하네스는 새 npm 패키지 사용 전 체커 게이트가 필요하다는 제약을 걸었다.
- 이 제약 때문에 ZIP 생성을 외부 패키지 없이 Node 내장 Buffer 기반으로 구현했다.
- 체커는 변경된 `src/server.js`를 `dev-quick`으로 점검했고 findings 0을 반환했다.
- 체커는 GitHub 접근을 external surface로 기록했다. 서비스 기능상 필요한 접근이지만 경기도 방화벽 허용 항목으로 관리해야 한다.

추가 비용 추정:

- 보고서/ZIP/관리자 API 구현 자체: 일반 구현 대비 약 1.0배
- 하네스 제약 확인과 무패키지 ZIP 구현 선택: 약 1.2~1.4배
- 체커 재점검과 결과 기록: 약 1.1~1.2배
- 토큰 사용은 구현 설명, 검증 로그, 하네스/체커 영향 기록 때문에 일반 구현 대비 약 1.3~1.6배로 추정한다.

체커·하네스 개선 후보:

- 하네스 설치 시 `core.hooksPath`를 자동 설정하고 상태 점검에 표시해야 한다.
- 체커 doctor가 WARN만 있어도 종료코드 1을 반환하는 동작은 개발 게이트에서 해석이 필요하다. CLI가 `--fail-on error` 같은 doctor 옵션을 제공하면 좋다.
- 체커 `scan --format json --output reports/id`가 확장자 없는 JSON을 저장한다. 포털 연동 관점에서는 `.json` 확장자 저장 옵션이 더 직관적이다.
- 브라우저 기반 포털에서 로컬 폴더 절대경로를 얻을 수 없으므로, 하네스/체커 쪽 문서에 “웹 단독 불가, 데스크톱 브리지 필요”를 명확히 적어야 한다.

## 2026-08-10 추가 기록: 로컬 HTTP 경계와 보고서 다운로드 보강

외부 소스 분석을 바탕으로 적대적 검증을 수행해 다음 결함을 재현했다.

- 임의 `Host` 헤더로 `/api/local/status`를 요청해도 `200`이 반환되어 로컬 경로와 설치 상태가 노출됐다.
- 체커가 생성한 한글 `보안점검` 보고서가 `/reports/` 다운로드 경로에서 `404`가 됐다.
- `/admin.html` 직접 요청은 인증 없이 관리자 화면 HTML을 반환했다.

수정 내용:

- 로컬 서버는 `127.0.0.1:PORT`와 `localhost:PORT` Host만 수용한다.
- 상태 변경 API는 동일 로컬 Origin과 서버 기동 시 생성한 요청 토큰을 함께 확인한다. 정적 HTML에는 동일 출처 API 호출에만 토큰을 붙이는 짧은 bootstrap을 주입한다.
- 보고서 파일명은 경로 구분자와 `..`을 계속 차단하면서 유니코드 문자·숫자를 허용한다. 다운로드 헤더에는 ASCII 대체 이름과 UTF-8 `filename*`을 함께 제공한다.
- `/admin`과 `/admin.html`은 동일한 관리자 인증 경계를 적용한다.

회귀 테스트 보강:

- 악성 Host 거부, 외부 Origin 거부, 상태 변경 요청의 토큰 누락 거부를 확인한다.
- 한글 보고서 URL의 실제 `200` 다운로드와 UTF-8 파일명 헤더를 확인한다.
- `/admin.html` 직접 접근이 로그인으로 리다이렉트되는지 확인한다.

## 2026-08-09 추가 기록: 사용자 시나리오 테스트

사용자 검토 의견:

- 모든 페이지와 기능을 사용자 입장에서 직접 테스트해야 한다.
- 하네스에 이 기준이 있는지도 확인해야 한다.

확인:

- 하네스에는 `health_or_smoke_test_recorded`, `qa-operator`, L1/L2 테스트 게이트 기준이 있다.
- 다만 이 포털의 `빠른 점검`, `제출 점검`, `하네스/MCP`, `관리자` 4대 시나리오를 실제로 실행하는 테스트는 없다.

조치:

- `scripts/portal-scenario-test.mjs`를 추가했다.
- `npm run scenario:test`를 추가했다.
- `npm run guard`에 `scenario:test`를 포함했다.
- 새 브라우저 자동화 패키지는 설치하지 않았다. 하네스 denylist에 Playwright/Puppeteer가 운영 런타임 부담으로 명시되어 있어, Node 내장 fetch와 로컬 서버 기반으로 테스트했다.

시나리오 테스트 결과:

- 주요 페이지 로드: 통과
- 빠른 점검: 통과
- 제출 점검 및 ZIP 생성: 통과
- 하네스/MCP 상태 확인: 통과
- 관리자 현황 조회: 통과

수정한 문제:

- `/api/local/mcp/register`가 501을 반환했다.
- 실제 설정 변경은 사용자 승인·백업 전에는 하면 안 되므로, 501 대신 `already_registered` 또는 `needs_user_approval`를 반환하게 했다.

추가 비용 추정:

- 시나리오 테스트 작성과 게이트 편입: 일반 구현 대비 약 1.2배 시간
- 테스트 실행과 결과 기록: 약 10~30초/회 추가
- 토큰 비용: 검증 흐름 설명과 기록 때문에 약 1.2~1.4배 추가

하네스 개선 후보:

- `harness-final-smoke.mjs`가 프로젝트별 사용자 시나리오 테스트 스크립트 존재 여부를 확인할 수 있어야 한다.
- L1/L2 웹앱에는 `scenario:test` 또는 동등한 smoke 명령을 표준으로 요구하는 편이 좋다.
- 하네스 문서에 “health만으로는 사용자 기능 검증이 아니다”를 명시해야 한다.
