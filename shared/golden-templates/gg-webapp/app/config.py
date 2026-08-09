"""환경변수 기반 설정. 비밀값은 코드에 두지 않는다(레일)."""
import os


class Settings:
    app_name: str = os.getenv("APP_NAME", "gg-webapp")
    # base_path는 하드코딩 금지 — 환경변수 주입
    base_path: str = os.getenv("APP_BASE_PATH", "/apps/gg-webapp")
    env: str = os.getenv("APP_ENV", "dev")

    database_url: str = os.getenv("DATABASE_URL", "")
    session_secret: str = os.getenv("SESSION_SECRET", "")

    oidc_issuer: str = os.getenv("OIDC_ISSUER", "")
    oidc_client_id: str = os.getenv("OIDC_CLIENT_ID", "")
    oidc_client_secret: str = os.getenv("OIDC_CLIENT_SECRET", "")


settings = Settings()
