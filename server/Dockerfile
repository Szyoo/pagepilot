# pagepilot-server：构建上下文是 server/ 目录
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DATA_DIR=/data \
    PORT=8000

WORKDIR /app
COPY pyproject.toml ./
COPY pagepilot_server ./pagepilot_server
RUN pip install . \
 && useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin app \
 && mkdir -p /data && chown app:app /data

USER app
VOLUME ["/data"]
# 只供反向代理访问，部署时不要对外发布端口
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/api/health' % os.environ.get('PORT','8000'), timeout=4)" || exit 1

CMD ["sh", "-c", "exec uvicorn pagepilot_server.app:create_app --factory --host 0.0.0.0 --port \"${PORT}\""]
