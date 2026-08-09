"""gg-dashboard 표준 진입점(Track S · 내부 한정).

레일: 실데이터·개인정보 금지(더미), DB는 파라미터 바인딩, 외부 CDN 금지.
접근제어는 nginx 앞단 Keycloak이 담당(Streamlit 자체 인증 없음).
"""
import os

import pandas as pd
import plotly.express as px
import streamlit as st

st.set_page_config(page_title=os.getenv("APP_NAME", "gg-dashboard"), layout="wide")
st.title(os.getenv("APP_NAME", "gg-dashboard"))
st.caption("내부 시제품(L1) · 내부 한정 · 더미 데이터")

# --- 데이터: 실제로는 SQLAlchemy 파라미터 바인딩으로 조회. 여기선 더미. ---
# from sqlalchemy import create_engine, text
# engine = create_engine(os.environ["DATABASE_URL"])
# df = pd.read_sql(text("SELECT dept, amount FROM budget WHERE year = :y"), engine, params={"y": 2026})
df = pd.DataFrame(
    {"부서": ["기획", "복지", "환경", "교통"], "집행률(%)": [72, 65, 88, 54]}
)

col1, col2 = st.columns([2, 1])
with col1:
    st.plotly_chart(px.bar(df, x="부서", y="집행률(%)", title="부서별 예산 집행률"), use_container_width=True)
with col2:
    st.metric("평균 집행률", f"{df['집행률(%)'].mean():.0f}%")
    st.dataframe(df, use_container_width=True, hide_index=True)
