"""PostgreSQL 16 연결. SQLAlchemy 파라미터 바인딩만 사용(SQLi 예방 레일)."""
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

from .config import settings

# DATABASE_URL은 환경변수 주입(코드 리터럴 금지)
engine = create_engine(settings.database_url or "postgresql+psycopg://localhost/gg_webapp", pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
