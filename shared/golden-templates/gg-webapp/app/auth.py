"""Keycloak OIDC 인증 스텁(레일). 로그인·해시 직접 구현 금지.

행정망 공용 인증(Keycloak)에 위임한다. 아래는 표준 연동 골격이며,
실제 배포 시 OIDC_* 환경변수와 세션/미들웨어를 연결한다.
대민(외부망) 서비스는 시민 인증 + 관리자 계정 분리 정책을 별도 적용.
"""
from authlib.integrations.starlette_client import OAuth

from .config import settings

oauth = OAuth()
if settings.oidc_issuer:
    oauth.register(
        name="keycloak",
        client_id=settings.oidc_client_id,
        client_secret=settings.oidc_client_secret,
        server_metadata_url=f"{settings.oidc_issuer}/.well-known/openid-configuration",
        client_kwargs={"scope": "openid profile email"},
    )


def current_user(request):
    """세션에서 인증 사용자 조회. 미인증이면 None."""
    return request.session.get("user")
