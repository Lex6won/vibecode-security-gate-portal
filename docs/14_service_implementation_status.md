# 서비스 구현 상태

## 결론

현재 구현은 `1차 로컬 포털 MVP 골격 + GitHub URL 보안점검 실행` 단계다.

화면 시안만 있는 상태는 벗어났지만, 최종 제품 전체가 완성된 것은 아니다.
지금 사용 가능한 핵심 흐름은 다음이다.

1. 로컬 서버 실행
2. 화면 라우팅
3. 내 PC 상태 점검 API
4. GitHub URL 기반 보안점검 시작
5. 진행 상태 조회
6. 결과 조회
7. 하네스·체커 개발 게이트 실행

## 구현된 기능

| 영역 | 구현 상태 | 설명 |
|---|---|---|
| 로컬 웹 서버 | 구현 | Node.js 내장 모듈 기반 서버 |
| 화면 제공 | 구현 | 홈, 보안점검, 하네스/MCP, 도움말, 관리자 화면 제공 |
| 상태 점검 | 구현 | 하네스, 체커, MCP, 실행 게이트 상태 확인 |
| 실행 게이트 확인 | 구현 | `guard`, pre-commit, 패키지 게이트 존재 확인 |
| GitHub URL 점검 | 구현 | `git clone --depth 1` 후 정적 보안점검 실행 |
| 보안점검 API | 구현 | `/api/scan/start`, `/progress`, `/result` |
| 체커 연동 | 구현 | `gvskb scan`, `gvskb doctor`, `dev-quick` 사용 |
| 화면-API 연결 | 부분 구현 | GitHub URL 점검과 상태 점검은 실제 API 연결 |
| 보고서 저장 | 구현 | 서버 `reports/` 폴더에 JSON, HTML, Markdown 저장 |
| 보고서 다운로드 | 구현 | `/reports/{file}` 경로로 결과 파일 다운로드 |
| 관리자 API | 구현 | 현재 세션 점검 요약과 이력 조회 |

## 아직 미구현 또는 부분 구현

| 영역 | 상태 | 이유 |
|---|---|---|
| 폴더 선택 후 즉시 검사 | 구현 | 로컬 선택 창과 브라우저 선택 경로를 모두 지원하며, 원본은 이 PC에서만 처리 |
| 압축파일 검사 | 구현 | 로컬 ZIP 선택과 브라우저 업로드 ZIP을 안전한 임시 경로에서 검사 |
| HTML 보고서 생성 | 구현 | `gvskb report`로 HTML/Markdown 생성 |
| 하네스·체커 설치 실행 | 구현 | 공식 저장소 기준 staging, 검증, 백업, 교체, 재검증 순서로 적용 |
| MCP 자동 등록 | 구현 | 선택한 도구의 설정을 백업한 뒤에만 사용자 승인으로 등록 |
| 관리자 실제 데이터 | 부분 구현 | 현재 세션의 점검 이력은 API 연결, Supabase 영속 저장은 미구현 |
| 관리자 로그인 | 구현 | scrypt 비밀번호 해시, HttpOnly 세션, 총괄 관리자 API 권한 검증 적용 |
| Supabase 저장 | 미구현 | 스키마 초안만 있음 |

## 하네스가 실제로 한 일

- 구현 언어를 JavaScript/TypeScript/Python 범위로 제한했다.
- 패키지를 임의로 추가하지 않게 했다.
- 새 패키지를 쓸 때 체커 게이트를 먼저 통과하도록 기준을 만들었다.
- MCP 설정 명령을 `gvskb-server` 기준으로 제한했다.
- `gg-validate.ps1`로 하네스 구성 파일을 검증했다.
- `npm run guard`와 pre-commit 훅으로 문서가 아닌 실행 지점에 게이트를 걸었다.

## 체커가 실제로 한 일

- `gvskb version`, `gvskb doctor`로 설치 상태를 확인했다.
- `gvskb scan src --profile dev-quick`로 구현 소스를 점검했다.
- MCP `scan_path`로 CLI 결과를 교차 검증했다.
- 현재 `src/server.js`에 대해 findings 0건을 반환했다.
- Semgrep 미설치 WARN을 발견했고, 이를 개발 게이트에서는 기록 대상으로 분류했다.

## 구현 중 하네스·체커 때문에 생긴 추가 작업

| 추가 작업 | 이유 | 결과 |
|---|---|---|
| 하네스 파일 적용 | 프로젝트가 표준 흐름을 따르게 하기 위해 | `AGENTS.md`, `shared/`, `.mcp.json`, `.codex/` 적용 |
| README 보강 | 하네스 검증 기준 충족 | 문서 기준 통과 |
| 실행 게이트 추가 | README만으로는 강제 불가 | `npm run guard`, pre-commit 추가 |
| 체커 doctor 보정 | WARN 종료코드가 과차단을 만들 수 있음 | ERROR만 차단, WARN 기록 |
| 패키지 정책 기록 | 패키지 사용 금지가 아니라 사전 검증이 원칙 | `docs/13_package_gate_log.md` 추가 |
| 보안스캔 반복 | 구현 변경 후 회귀 확인 | CLI/MCP 모두 findings 0 |

## 시간·토큰 추가 비용 추정

정확한 토큰 계측은 현재 세션에서 별도 goal budget이 없어서 자동 집계되지 않았다.
대신 이번 구현 흐름 기준으로 추정한다.

| 구분 | 일반 구현 대비 |
|---|---:|
| 초기 설계·검증 시간 | 약 1.3~1.6배 |
| 문서·기록 시간 | 약 1.5~2.0배 |
| 보안 점검·재검증 시간 | 약 1.2~1.5배 |
| 전체 토큰 사용량 | 약 1.4~1.8배 |
| 후반 재작업 위험 | 감소 |

## 다음 구현 우선순위

1. 폴더/압축파일 검사를 위한 데스크톱 브리지 또는 로컬 앱 방식 결정
2. Supabase 저장과 관리자 영속 이력 화면 연결
3. 하네스 설치·MCP 등록의 백업, 적용, 재검증 구현
4. ZIP 업로드 검사와 압축 해제 안전검증 구현
5. 관리자 로그인 인증과 권한 처리 구현

## 2026-08-09 구현 검증

| 검증 | 결과 |
|---|---|
| `/health` | 정상 |
| `/api/local/status` | `execution_gate` 포함 정상 |
| 로컬 폴더 API 검사 | `src` 1개 파일 스캔, findings 0, decision `allow` |
| GitHub URL API 검사 | `octocat/Hello-World` clone 후 스캔, 검사 파일 0건으로 `needs_review` |
| 화면 연결 | 보안점검 화면의 GitHub URL 점검, 하네스 화면의 상태 점검 API 연결 |
| 관리자 API | 현재 세션 기준 total/today/allow 집계 확인 |

검사 파일 0건은 안전으로 보지 않는다.
서버 판정도 `needs_review`로 처리한다.

## 2026-08-09 추가 구현

- `gvskb report`를 사용해 검사 JSON에서 HTML/Markdown 보고서를 생성한다.
- 외부 zip 패키지를 설치하지 않고 Node.js 내장 Buffer로 ZIP을 생성했다.
- `/reports/{file}` 다운로드 경로를 추가했다.
- `/api/admin/summary`, `/api/admin/scans`를 추가했다.
- 관리자 화면이 현재 세션 점검 이력을 API에서 읽도록 연결했다.

하네스 영향:

- ZIP 생성 패키지를 새로 추가하지 않고 내장 구현을 선택했다.
- 새 패키지를 쓰려면 `gvskb_gate` 기록이 필요했기 때문에 구현 범위를 더 보수적으로 잡았다.

체커 영향:

- `src/server.js` 변경 후 `dev-quick` 스캔으로 findings 0을 확인했다.
- GitHub 외부 접근은 external surface info로 기록된다.
- 서비스 기능상 필요한 접근이지만, 기관 방화벽 허용 항목으로 문서화해야 한다.

## 2026-08-09 사용자 시나리오 테스트

하네스에는 `health_or_smoke_test_recorded` 기준과 `qa-operator` 역할은 있었지만,
이 포털의 4개 사용자 시나리오를 자동으로 실행하는 테스트는 없었다.

따라서 `scripts/portal-scenario-test.mjs`를 추가했다.
새 패키지 없이 Node.js 내장 기능만 사용한다.

검증한 시나리오:

1. 모든 주요 페이지 로드
2. 빠른 점검 실행
3. 표준 점검 실행과 HTML·JSON·Markdown 보고서 생성
4. 하네스/MCP 상태 확인
5. 관리자 현황 조회

검증 결과:

- `npm run scenario:test`: 통과
- `npm run button:test`: 통과
- `npm run guard`: 통과
- 체커 MCP `scripts` 점검: 검사 파일 2건, findings 0건

발견해서 수정한 오류:

- `MCP 등록` API가 501을 반환해 사용자 시나리오 관점에서 실패로 보였다.
- 실제 설정을 무단 변경하지 않고 `already_registered` 또는 `needs_user_approval` 상태를 반환하도록 수정했다.
- `scenario:test`를 `guard`에 포함해 커밋 전 자동 실행되게 했다.
- `button:test`를 `guard`에 포함해 주요 링크, 버튼, 탭, 모달 닫기, 상태 점검 API 연결을 커밋 전 자동 확인하게 했다.
- 이 테스트가 `/admin` 라우트에서 상대 홈 링크가 `/admin/main page.html`로 해석되는 문제와 `href="#"` placeholder 링크를 발견했고, 내부 이동 링크를 `/`, `/scan`, `/harness`, `/admin/login` 같은 서버 라우트 기준으로 정리했다.
