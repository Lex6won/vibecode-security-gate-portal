# 에이전트 핸드오프 계약

에이전트 수가 많아질수록 각 에이전트는 자유롭게 다음 단계를 추측하지 않는다. 모든 에이전트는 이 계약에 따라 입력을 확인하고, 산출물을 남기고, 다음 에이전트와 중단 조건을 명시한다.

## 공통 핸드오프 패킷

모든 에이전트는 작업 후 `_workspace/00_작업현황.md`와 manifest에 아래 내용을 남긴다.

| 필드 | 의미 |
|---|---|
| `from_agent` | 현재 작업한 에이전트 |
| `to_agent` | 다음 담당 에이전트 |
| `work_mode` | 신규 설계·구현 / 기존 코드 수정 / 배포·이관 준비 / 파일럿 평가 |
| `maturity_level` | L0 / L1 / L2 / L3 / L4 |
| `status` | pass / warn / block / needs-user / done |
| `inputs_read` | 읽은 핵심 산출물 |
| `outputs_written` | 생성·수정한 산출물 |
| `decisions` | 이번 단계에서 확정한 결정 |
| `open_questions` | 다음 단계 전에 필요한 질문 |
| `risk_flags` | 개인정보, 외부통신, 파일업로드, 대민, 패키지 등 |
| `package_decisions` | 새 패키지, 차단 패키지, 대체 패키지, 검토 필요 상태 |
| `next_action` | 다음 에이전트가 해야 할 일 |

## 상태값 의미

- `pass`: 다음 에이전트로 진행 가능.
- `warn`: 진행은 가능하지만 사용자가 알아야 할 위험 또는 예외가 있음.
- `block`: 다음 단계 진행 금지. 수정, 예외신청, 사람 판단 필요.
- `needs-user`: 업무 판단이 필요해 사용자 답변 전 진행 금지.
- `done`: 해당 모드의 목표 산출물 완료. 승인 완료라는 뜻은 아님.

## 라우팅 규칙

### 신규 설계·구현
`intake-guide → stage-advisor → feature-discovery → prd-writer → public-risk-analyst → platform-architect → data-modeler → template-engineer → gg-platform-coder → security-checker → qa-operator → deploy-doc-writer`

- L0이면 PRD/feature brief까지 완료 가능.
- L1이면 `thin-l1-policy.md`에 따라 feature brief, 최소 manifest, source, quick 검사까지만 필수다. pass 상태의 별도 handoff 파일은 생략하고 작업현황 한 줄로 대체할 수 있다.
- L2이면 standard 검사와 운영환경 문서 갱신 필요.
- L3이면 release-packager로 승격한다.

### 기존 코드 수정
`intake-guide → stage-advisor → change-coder → security-checker(quick) → qa-operator`

- Track 변경, 사용자 범위 변경, 대민 전환, DB/인증 큰 변경은 신규 설계 또는 배포·이관 흐름으로 승격한다.

### 배포·이관 준비
`stage-advisor → release-packager → security-checker(full) → submit-packager`

- MCP full 결과와 체커가 저장한 HTML/JSON 리포트 2종 없이는 제출 준비 완료로 표시하지 않는다.
- submit-packager는 최종 리포트 2종을 보안팀 또는 AX 전담팀에 제출해야 함을 안내한다.
- deploy-doc-writer는 운영팀 설치 인계나 기관 양식이 필요할 때만 조건부로 호출한다.
- L4 정식 운영 승인 여부는 하네스가 단독 판정하지 않는다.

### 파일럿 평가
`stage-advisor → pilot-evaluator`

- 평가 대상은 사람이 아니라 하네스 질문, 절차, 산출물, 보안 가드레일이다.

## 중단 조건

다음 경우 `block` 또는 `needs-user`로 멈춘다.

- 사용자 범위가 불명확하고 내부/대민 판단이 불가능함.
- 개인정보 또는 민감정보가 있는데 저장·권한·마스킹 기준이 없음.
- 행정망 서비스에 외부 CDN/API/LLM/MCP가 필수인데 대체안 또는 예외신청이 없음.
- denied 패키지를 요구함.
- denied/unknown/restricted 패키지를 요구했지만 `shared/references/package-alternatives.yaml` 기준 대체안, 기능 축소안, 예외/검토 요청 중 하나가 기록되지 않음.
- 보안검증 결과가 block인데 수정 없이 다음 단계로 가려 함.
- 배포·이관 요청인데 full checker 결과, HTML 리포트, JSON 증적, 또는 제출 안내가 없음.

## 충돌 해결

- 최신 사용자 요청이 우선이다.
- 보안/운영 기준과 사용자 요청이 충돌하면 기준을 우선하고 대체안을 제시한다.
- 패키지 정책과 기능 요구가 충돌하면 먼저 표준 라이브러리, 골든 템플릿 기본 패키지, 승인 core 패키지 순으로 대체하고, 그래도 불가능할 때만 예외신청으로 보낸다.
- 에이전트 판단이 충돌하면 `stage-advisor`가 성숙도, `public-risk-analyst`가 위험등급, `platform-architect`가 기술 Track, `security-checker`가 검증 결과의 최종 근거가 된다.

## 최소 원칙

다음 에이전트를 부르기 전에 “무엇을 읽었고, 무엇을 썼고, 왜 넘기는지”가 기록되어야 한다.

