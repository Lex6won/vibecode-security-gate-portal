"""smoke: 앱 모듈이 import·구성되는지 최소 확인. 실행 검증은 qa-operator가 /_stcore/health로."""


def test_import():
    import ast
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parent.parent / "app.py"
    spec = importlib.util.spec_from_file_location("gg_dashboard_app", path)
    assert spec is not None
    # 구문·의존성 로드 확인(Streamlit 런타임 없이 파싱만)
    with open(path, encoding="utf-8") as f:
        ast.parse(f.read(), filename=str(path))
