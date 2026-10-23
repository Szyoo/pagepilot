# pagepilot-server

PagePilot 扩展的配套后台：存放并下发规则，接收扩展上报的页面抓取、操作录制与运行报告，并提供管理页。完整设计见 [docs/backend.md](../docs/backend.md)，消息格式见 [docs/protocol.md](../docs/protocol.md)。

## 本地运行

需要 Python 3.12+。

```sh
cd server
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
SZYYW_SSO=1 DATA_DIR=./data .venv/bin/uvicorn pagepilot_server.app:create_app --factory --port 8000
```

身份只来自反向代理注入的请求头，本地调试时手动带上：

```sh
curl -H 'X-Portal-Sub: dev' -H 'X-Role: admin' http://localhost:8000/api/me
```

## 测试

```sh
cd server
.venv/bin/pytest -q
```

若仓库根已安装 Node 依赖（`pnpm install`），协议测试还会用扩展的 Zod schema 校验后台输出；否则该项跳过。

## Docker

```sh
docker build -t pagepilot-server server
docker run -e SZYYW_SSO=1 -v pagepilot-data:/data pagepilot-server
```

容器只应经反向代理访问，不要对外发布端口。

## 环境变量

| 变量              | 默认    | 说明                                                       |
| ----------------- | ------- | ---------------------------------------------------------- |
| `SZYYW_SSO`       | 空      | 必须为 `1` 才信任身份头，否则除 `/api/health` 外都返回 503 |
| `DATA_DIR`        | `/data` | 数据目录，数据库为其中的 `pagepilot.db`                    |
| `RETENTION_DAYS`  | `90`    | 抓取、录制、运行报告的保留天数                             |
| `ALLOWED_ORIGINS` | 空      | 额外允许的 `Origin`，逗号分隔                              |
| `PORT`            | `8000`  | 监听端口（容器内）                                         |

## 接口一览

| 接口                                                                                          | 说明                     |
| --------------------------------------------------------------------------------------------- | ------------------------ |
| `GET /api/health`                                                                             | 健康检查（公开）         |
| `GET /api/me`                                                                                 | 当前用户 `{ sub, role }` |
| `WS /api/ext/ws`                                                                              | 扩展实时通道             |
| `GET /api/ext/stream?since=`                                                                  | SSE 下行                 |
| `GET /api/ext/poll?since=`                                                                    | 轮询下行                 |
| `POST /api/ext/uplink`                                                                        | 上行消息                 |
| `GET /api/rules`、`PUT/DELETE /api/rules/{id}`、`POST /api/rules/validate`                    | 规则                     |
| `GET /api/recordings[/{id}]`、`DELETE /api/recordings/{id}`、`POST /api/recordings/{id}/rule` | 录制                     |
| `GET /api/captures[/{id}]`、`DELETE /api/captures/{id}`                                       | 抓取                     |
| `GET /api/runs[/{runId}]`                                                                     | 运行报告                 |
| `GET /`                                                                                       | 管理页                   |
