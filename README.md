# 공공 바이브코딩 보안 체커 포털

공무원이 AI로 만든 개발 소스를 보안 점검하고, 체커 리포트를 확인하도록 돕는 서비스 프로젝트입니다.

이 프로젝트는 `vibe_harness_codex` 하네스 본체가 아닙니다. 하네스는 설계·구현·테스트·검증 흐름과 정책 레일을 제공하고, 이 포털은 사용자가 그 기능을 쉽게 실행하도록 만드는 웹/데스크톱 서비스입니다.

## 프로젝트 경계

| 구분 | 위치 | 역할 |
|---|---|---|
| 하네스 본체 | `../vibe_harness_codex` | AI 개발 도구용 정책, 검증 스크립트, 템플릿, MCP 기준 |
| 보안 체커 | `../vibecode-checker` 또는 설치된 `gvskb` | 소스·의존성 보안 점검 엔진 |
| 이 포털 | 현재 폴더 | 사용자 화면, 검사 실행, 결과 확인, 설치 상태 점검 |

## 1차 제품 방향

- 웹 UI 기반 로컬 웹앱 우선
- 필요 시 데스크톱 앱으로 포장
- 사용자는 Python, Git, Node 명령을 몰라도 검사 가능
- 로컬 폴더, 압축파일, 공개 GitHub URL 검사
- 간편 점검, 표준 점검 제공
- 체커 원본 HTML/JSON 리포트 보존
- 하네스와 체커 설치 상태, MCP 연결, GitHub 접근 상태 확인
- 현재 구현은 PowerShell과 Windows 로컬 선택 창을 사용하므로 Windows 전용입니다.

## 왜 웹 포털만으로는 부족한가

브라우저 기반 웹 포털은 사용자의 PC에 설치된 Git, 하네스, 체커, MCP 설정 파일을 직접 읽을 수 없습니다. 따라서 개인 PC 설치 상태 점검과 로컬 폴더 검사는 다음 중 하나가 필요합니다.

- 데스크톱 앱
- 로컬 백엔드가 포함된 로컬 웹앱
- 기관 관리 에이전트

기관 중앙 웹 포털은 전체 사용량, 관리자 통계, 정책 배포 상태를 관리할 수 있지만, 사용자 PC의 로컬 설치 상태는 별도 로컬 실행 구성 없이는 확인할 수 없습니다.

## 총괄 관리자 로그인

관리자 현황은 총괄 관리자 1개 계정만 접근할 수 있습니다. 최초 실행 전 `.env.example`을 `.env`로 복사하고 `ADMIN_ID`, `ADMIN_INITIAL_PASSWORD`를 설정하세요. 기본 ID는 `gg0018@gg.go.kr`이며, 초기 비밀번호는 12자 이상으로 직접 지정합니다. 인증 정보는 `.local/admin-auth.json`에 해시로 저장되고 Git에 포함되지 않습니다.

관리자 화면에 로그인한 뒤 `비밀번호 변경`에서 현재 비밀번호를 확인하고 새 비밀번호로 변경할 수 있습니다. 비밀번호 변경 후 기존 세션은 폐기됩니다.

## 폴더 구조

```text
vibecode-security-gate-portal/
├── docs/                         # PRD, 화면 설계, DB 설계, UX 기록
├── design/html-prototype/         # 정적 HTML 화면 시안
├── fixtures/checker-negative-fixture/
│   └── ...                        # 체커 검증용 취약 샘플, 실제 서비스 소스 아님
├── supabase/schema.sql            # 향후 Supabase 연계용 PostgreSQL/RLS 초안
├── tools/pc-status.ps1            # 로컬 PC 상태 점검 계약 스크립트
└── src/                           # 향후 포털 구현 소스 위치
```

## 핵심 설계 문서

| 문서 | 내용 |
|---|---|
| `docs/01_PRD.md` | 제품 목적, 1차 범위, 제외 범위 |
| `docs/02_screen_function_spec.md` | 화면 구성과 화면별 기능 |
| `docs/03_database_design.md` | DB 모델과 화면-DB 매핑 |
| `docs/09_functional_design.md` | 기능 흐름, API, 상태 모델 |
| `docs/10_supabase_design.md` | Supabase 연계, RLS, Storage 정책 |
| `docs/11_single_view_modal_design.md` | 스크롤 없는 단일 화면과 레이어 팝업 UX 기준 |
| `docs/12_harness_checker_implementation_log.md` | 하네스·체커 적용 기록과 개발 비용 기록 |
| `docs/14_service_implementation_status.md` | 서비스 구현 상태, 미구현 범위, 하네스·체커 영향 |
| `docs/16_local_execution_architecture.md` | 로컬 실행 경계, PC 저장, 업데이트·검사 진행률의 확정 설계와 구현 기록 |
| `supabase/schema.sql` | Supabase PostgreSQL 스키마 초안 |

## 하네스 적용 기준

이 포털은 공공 바이브코딩 `표준 운영 하네스` 기준으로 구현합니다.

공식 배포 기준:

- 하네스: `https://github.com/Lex6won/vibe_harness_codex`
- 체커: `https://github.com/Lex6won/vibecode-checker`
- 하네스 설치 예시: `git clone https://github.com/Lex6won/vibe_harness_codex.git`
- 체커 설치 예시: `git clone https://github.com/Lex6won/vibecode-checker.git`

사용자 경험 기준:

- 초보 공무원이 `구상 → 표준 템플릿 구현 → 보안 점검 → 결과 확인` 흐름을 따라가도록 설계합니다.
- 처음에는 아래 파일을 수정 대상으로 보지 않는 것이 좋습니다: `shared/`, `AGENTS.md`, `.mcp.json`, `.codex/config.toml`.
- 일반 사용자 안내 문구는 `shared/assets/coaching-messages.md` 기준을 따릅니다.

검증 기준:

- 하네스 기본 검증: `.\shared\scripts\gg-validate.ps1 -Root . -Level L1`
- 최종 하네스 스모크 테스트: `node .\shared\scripts\harness-final-smoke.mjs .`
- 빠른 개발 중 체커 프로필: `dev-quick`
- `GVSKB_POLICIES_DIR`를 사용할 때는 상대경로가 아니라 절대경로만 허용합니다.
- `network_profile`은 배포·네트워크 분류이며 체커 프로필이 아닙니다.
- 체커 결과에 `profile_fallback`이 있으면 검증 미완료로 기록합니다.
- MCP 서버 명령은 `gvskb-server`를 사용합니다.

개발 중 강제 게이트:

README 문구만 맞추는 것은 하네스 적용으로 보지 않습니다.
개발 중에는 아래 명령을 통과해야 합니다.

```bash
npm run guard
```

`guard`는 다음을 함께 확인합니다.

- JavaScript 문법 확인
- 하네스 필수 파일과 MCP 설정 확인
- 패키지 게이트 기록 확인
- 4개 사용자 시나리오 테스트
- `gvskb doctor` 상태 확인
- `src` 대상 `dev-quick` 보안 점검

커밋 전에는 `.githooks/pre-commit`이 같은 명령을 실행합니다.
새로 clone한 PC에서는 아래 설정을 1회 적용해야 합니다.

```bash
git config core.hooksPath .githooks
```

이 설정이 없으면 하네스 파일은 있어도 커밋 전 강제 검증이 실행되지 않습니다.

패키지 사용 기준:

- 패키지를 사용하지 않는 것이 원칙이 아니다.
- 필요한 패키지는 사용할 수 있다.
- 다만 Python, JavaScript, TypeScript 패키지를 새로 설치하거나 버전을 바꾸기 전에는 체커 게이트로 확인한다.
- npm 패키지는 `node .\shared\enforcement\gvskb_gate.js check <package>`로 먼저 확인한다.
- PyPI 패키지는 `python .\shared\enforcement\gvskb_gate.py check <package> --ecosystem pypi`로 먼저 확인한다.
- 차단, 판정 불가, 쿨다운, 검토 필요가 나오면 대체 패키지나 무패키지 구현을 먼저 검토한다.

## 상태 점검 버튼의 실제 역할

`상태 점검`은 읽기 전용이어야 합니다.

- 하네스 로컬 경로와 GitHub 최신 여부 확인
- 체커 `gvskb version`, `gvskb doctor` 확인
- MCP 설정 파일 등록 여부 확인
- GitHub, OSV, PyPI, npm 연결 가능성 확인

업데이트는 상태 점검과 분리합니다. 업데이트 버튼은 변경 내용을 먼저 보여주고, 사용자가 승인한 뒤에만 실행합니다.

## 현재 주의사항

`fixtures/checker-negative-fixture`는 일부러 취약하게 만든 테스트 입력입니다. 실행 서비스가 아니며, 운영망이나 실제 민원 데이터 환경에서 실행하지 않습니다.
