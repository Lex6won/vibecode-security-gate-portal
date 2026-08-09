# 표준 베이스만 사용 (내부 Harbor). 임의 베이스 금지.
FROM gg-python-web:3.12

# 비root 사용자(베이스 제공) 유지. 소스+의존성만 복사.
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --require-hashes=false -r requirements.txt
COPY app ./app

EXPOSE 8000
# /health 로 헬스체크 (배포 게이트 필수)
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD python -c "import http.client,sys; c=http.client.HTTPConnection('127.0.0.1',8000,timeout=3); c.request('GET','/health'); r=c.getresponse(); sys.exit(0 if r.status==200 else 1)"

# 로그는 stdout(journald 수집). 파일 로그 금지.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
