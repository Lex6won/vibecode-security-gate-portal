# 도구 관리자 (Tool Manager)

공무원 PC에서 실행되어 보안 체커·개발 하네스를 **설치·버전확인·업데이트**하고 AI 도구에 **MCP를 연결**해 주는 프로그램. 아직 실행 진입점(CLI/설치기 창)이 없는 **이관 보존 상태**이며, S8 단계에서 완성한다.

## 왜 서버에서 떼어냈나 (2026-08-13, S1)

포털이 로컬 단독 앱에서 **서버 기반 다중 사용자**로 전환되면서(docs/22), 사용자 PC를 조작하는 코드는 서버에 있을 수 없게 됐다. 웹페이지는 PC에 무엇이 깔렸는지 볼 수도, 설정 파일을 바꿀 수도 없다 — 브라우저가 막아 둔 경계다. 그래서 이 로직은 PC에서 실행되는 별도 프로그램으로 간다.

**폐기가 아니라 이관이다.** `core.mjs`는 `src/server.js`(커밋 `8b91ee0` 이전)에서 검증된 로직을 그대로 옮긴 것이다:

| 함수 | 역할 |
|---|---|
| `simpleVersionStatus` | 설치 버전 vs GitHub 최신 비교 → `current`/`update_available`/`reinstall_required` |
| `installComponent` | 임시 위치에 받기 → 검증 → 기존 백업 → 교체 → 재검증 |
| `applyUpdates` | `--ff-only` 갱신 후 재검증 (dirty/비main 워크트리는 차단) |
| `registerMcp` / `mcpSummary` | Codex·Claude Code·Claude Desktop MCP 등록(설정 백업 후)·상태 확인 |
| `localStatus` | PC 도구 상태 종합 |

`ui-prototype.html`은 구 포털의 `/harness` 화면으로, 도구 관리자 창 UI의 원형이다.

## 역할 경계 (하네스팀 협의, docs/22 §7)

이 층은 **"언제 무엇을 할지 정하고 결과를 보여 주는"** 층이다. 실제 도구 감지·설정 파일 백업·수정·복구는 **하네스 스크립트**가 한다(`gg-validate.ps1`, `checker-bootstrap.mjs` 호출). **감지·설정 로직을 여기에 중복 구현하지 말 것** — 두 곳에 두면 규칙이 갈라진다.

## S8에서 할 일

1. 실행 진입점: 설치기 겸 관리자 창(처음 실행 = 설치, 이후 = 버전 비교·업데이트)
2. 서버 보고: 일회용 등록 토큰으로 등록 후 최소 상태(버전·도구별 연결 여부)를 `POST /api/tools/clients/report`로 보고 — 항목은 docs/23 계약으로 고정
3. 배포: 코드서명(B2) 또는 확보 전 SHA-256 해시 공지
4. `registerMcp`의 직접 설정 수정을 하네스 스크립트 호출로 교체(경계 준수)
