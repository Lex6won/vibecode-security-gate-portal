"""smoke test — /health 200 확인(배포 게이트 최소 기준). qa-operator가 실행."""
import os

os.environ.setdefault("DATABASE_URL", "sqlite://")  # 스모크는 DB 불필요, 헬스만 확인
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_index():
    r = client.get("/")
    assert r.status_code == 200


def test_security_headers():
    r = client.get("/health")
    assert r.headers.get("X-Frame-Options") == "DENY"
    assert "default-src 'self'" in r.headers.get("Content-Security-Policy", "")
