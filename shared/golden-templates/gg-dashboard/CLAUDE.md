# gg-dashboard — 프로젝트 AI 규칙 (골든 템플릿, Track S)

- 런타임 Python 3.12 / PostgreSQL 16 고정.
- **내부 한정.** 시민 접근이면 Track S 금지 → gg-webapp/gg-spa로 재설계 요청.
- 접근제어는 nginx 앞단 Keycloak. Streamlit에 인증 직접 구현 금지.
- 비밀값 `.env`/환경변수만. DB는 SQLAlchemy 파라미터 바인딩(문자열 조립 금지).
- 개인정보 평문·실데이터 금지. 개발은 더미.
- 외부통신(CDN·외부 API·LLM) 금지. 차트·자산 self-host.
- 패키지는 requirements.txt(승인 카탈로그) 안에서만.
- 보안 검증은 여기서 안 함 — gg-check/gg-release의 security-checker(gvskb)가 게이트에서.
