# gg-webapp — 프로젝트 AI 규칙 (골든 템플릿)

이 프로젝트를 수정할 때 AI가 지킬 레일. vibecode-harness 규칙의 프로젝트 로컬 사본.

- 런타임은 Python 3.12 / PostgreSQL 16 고정. 상위 문법·다른 DB 금지.
- 비밀값은 `.env`/환경변수만. 코드에 키·비밀번호 리터럴 금지.
- DB는 SQLAlchemy 파라미터 바인딩만. f-string/문자열 조립 쿼리·`os.system` 금지.
- 개인정보(이름·전화·주민번호 등) 평문 저장 금지. 개발은 더미 데이터.
- 외부통신(CDN·외부 API·LLM) 코드 추가 금지. 정적자산은 `app/static/` self-host.
  꼭 필요하면 코드 대신 예외신청(gg-submit)로 안내.
- 인증은 `app/auth.py`(Keycloak OIDC)만. 로그인·해시 직접 구현 금지.
- 패키지는 `requirements.txt`(승인 카탈로그) 안에서만. 새 패키지는 예외신청.
- `/health`·보안헤더·base_path 미들웨어는 제거·변경 금지.
- 보안 검사는 여기서 하지 않는다. 검증은 gg-check/gg-release의 security-checker(gvskb)가 게이트에서.
