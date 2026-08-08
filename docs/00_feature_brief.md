# 기능 요약: 취약점 검출 검증용 민원 보조 시제품

## 목적

`vibecode-checker`가 공공기관 바이브코딩 산출물에서 반드시 확인해야 하는 대표 위험을 실제로 찾아내는지 검증하기 위한 의도적 취약 샘플입니다.

## 업무 시나리오

- 내부 직원이 주민 민원/복지 신청 내용을 조회한다.
- 첨부파일을 업로드하고 파일명을 기준으로 내용을 미리 본다.
- 간단한 계산식과 네트워크 진단 명령을 실행한다.
- 민원 내용을 외부 AI 요약 API로 보내는 흐름을 포함한다.

## 성숙도와 위험 신호

- maturity_level: L2 internal-tool test fixture
- service_exposure: internal-staff
- network_profile: admin-network
- data_level: red-test-fixture
- risk_flags:
  - personal_data_sample
  - hardcoded_secret
  - sql_injection
  - command_injection
  - code_execution
  - unsafe_deserialization
  - path_traversal
  - unsafe_file_upload
  - reflected_xss
  - insecure_tls
  - internal_network_value
  - llm_pii_prompt
  - risky_dependency_manifest

## 주의

이 소스는 실행하거나 배포하기 위한 코드가 아닙니다. 체커 회귀 테스트와 리포트 검증을 위한 취약 코드 모음입니다.
