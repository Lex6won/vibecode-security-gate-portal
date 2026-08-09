# gg-node-api — 프로젝트 AI 규칙 (골든 템플릿, Track N)

- 런타임 Node 20.19 이상, 21 미만 고정. 승인 npm_backend 카탈로그만(express·helmet·express-rate-limit·pg·pino·zod·openid-client·jose).
- lockfile 필수, `npm ci --ignore-scripts` 전제(공급망 공격 방어).
- 보안 헤더(helmet)·호출률 제한(express-rate-limit)·`/health` 제거 금지.
- DB는 pg 파라미터 바인딩($1)만. 문자열 조립 쿼리 금지.
- 입력 검증은 zod. 비밀값 `.env`/secret만, 리터럴 금지.
- 인증 직접 구현 금지: Keycloak OIDC(openid-client)/jose 위임. 대민은 시민 인증 + 관리자 분리.
- 외부통신(CDN·외부 API·BaaS) 금지. supabase-js·firebase 금지.
- 검증은 게이트(security-checker/gvskb `scan_dependencies` 포함).
