FROM gg-python-web:3.12
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .

EXPOSE 8501
# Streamlit 헬스: /_stcore/health (nginx가 /health 로 매핑)
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD python -c "import http.client,sys; c=http.client.HTTPConnection('127.0.0.1',8501,timeout=3); c.request('GET','/_stcore/health'); r=c.getresponse(); sys.exit(0 if r.status==200 else 1)"

# base_path·헤더는 환경변수/실행옵션으로 주입. 로그 stdout.
CMD ["streamlit", "run", "app.py", "--server.port=8501", "--server.address=0.0.0.0", "--server.headless=true"]
