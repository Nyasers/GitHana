# GitHana 令牌签发服务

GitHub App 的私钥只属于 App owner。把它放在一台服务器上，由容器内的签发服务换取
installation token（1 小时有效），客户端只拿令牌、永远不见私钥。

官方公共实例是 `https://githana.nyase.ru`，GitHana 默认就用它：用户只需把 `githana-app`
安装到目标仓库，不需要建 App、不需要部署、也不需要配置任何 secret。下面的部署步骤是给
self-host 的人看的，也是在维护那个公共实例时用的。

部署形态：

- **podman 容器**跑 `githana-token-server.mjs`，非 root 用户；
- 私钥以只读方式挂进容器（`/key/privkey.pem`）；
- 端口只绑宿主 `127.0.0.1:8787`，外层由 Cloudflare Tunnel 暴露成 HTTPS；
- 客户端用**自己的 GitHub 登录令牌**调 `POST /token`，服务端用 `GET /user` 验明身份，并用
  同一张令牌校验请求者对目标仓库有 push 权限，不需要额外分发共享 secret。

## 文件

| 文件 | 用途 |
|---|---|
| `githana-token-server.mjs` | HTTP 签发服务 |
| `Containerfile` | 镜像定义 |

## 服务器准备

```sh
mkdir -p /root/githana
# 私钥：GitHub App 设置页 → Private keys → Generate a private key，上传到
#   /root/githana/privkey.pem
chmod 600 /root/githana/privkey.pem

# 环境变量（可选的白名单默认不设，任何人都能请求；App 安装范围与 push 校验是真正的边界）
umask 077
printf 'REQUIRE_PUSH=true\nGITHUB_APP_ID=5271075\nAPP_KEY_FILE=/key/privkey.pem\n' \
  > /root/githana/issuer.env
chmod 600 /root/githana/issuer.env
```

可选收紧：`ALLOWED_LOGINS`（GitHub 登录名）与 `ALLOWED_OWNERS`（仓库 owner）逗号分隔；
不设则不限（真正的边界是 push 校验与 App 安装范围）。`BOT_LOGIN` / `BOT_NAME` / `BOT_EMAIL`
可改 bot 身份，默认 `githana-app[bot]` 与它的 noreply 邮箱。

`BIND_HOST` 默认 `127.0.0.1`（裸机运行直接安全）；容器镜像里设成 `0.0.0.0`，否则 `-p` 发布
不到容器内的回环地址。

## 构建与运行

私钥对容器用户必须可读：镜像以 `node`（UID 1000）运行，root 属主的 `0600` 文件挂进去是读不到的。

```sh
chown 1000:1000 /root/githana/privkey.pem
chmod 0400 /root/githana/privkey.pem
```

```sh
cd /root/githana/deploy
podman build -t localhost/githana-token:local -f Containerfile .

podman run -d --name githana-token --restart=unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -e BIND_HOST=0.0.0.0 \
  -v /root/githana/privkey.pem:/key/privkey.pem:ro \
  --env-file /root/githana/issuer.env \
  localhost/githana-token:local

curl -sS http://127.0.0.1:8787/health
# {"ok":true}
```

## Cloudflare Tunnel

控制台（Zero Trust → Networks → Tunnels）里给现有 tunnel 加一条 Public Hostname：

| 字段 | 值 |
|---|---|
| Subdomain | `githana-token` |
| Domain | 你的域名（与现有 hostname 同一个） |
| Path | 留空 |
| Service | `HTTP` → `127.0.0.1:8787` |

保存后 `https://githana-token.<domain>` 就是签发地址。GitHana 客户端要把这个地址写在两处，
两处值必须一致，改完重新打包：

| 位置 | 用途 |
|---|---|
| `lib/app-auth.js` 的 `ISSUER_URL` | 客户端去哪里换 token |
| `tools/lib/rest.worker.mjs` 的 `ALLOWED_HOSTS` | 出站白名单，不放行就报 `rejected outbound`（`lib/routes/status.js` 的 `REST_ALLOWED_HOSTS` 报告值同步） |

## 接口

```
GET  /health   -> { "ok": true }
GET  /identity -> { "login", "name", "email", "app_id" }   // bot 身份（公开信息，客户端写 CoA 用）
POST /token
Authorization: Bearer <GitHub user token>
Content-Type: application/json

{ "owner": "Nyasers", "repo": "githana" }

-> { "token": "...", "expires_at": "...", "installation_id": 170179328,
     "permissions": { ... }, "repository_selection": "selected" }
```

触发方式：设置页把「提交」「评论」或「拉取请求」身份选为 App bot 时，GitHana 会自动调本服务；
工具参数不参与决定（没有 `via` / `as` 这类参数），用户不需要手动操作。`Authorization` 用的是
GitHana 已经登录的 GitHana App OAuth 令牌。

错误：401（用户令牌无效）、403（无仓库写权限 / 白名单拒绝）、404（App 未安装或仓库不可见）、
429（限流）、502（GitHub 侧失败）。

其余路径（包括 `/`）不暴露服务形状，一律 302 到 `REDIRECT_URL`（默认
`https://github.com/Nyasers/GitHana`）。

## 安全边界

- 私钥只读挂载，容器内非 root；
- 端口只绑 `127.0.0.1`，公网入口只有 Cloudflare Tunnel；
- 调用者必须持有有效的 GitHub 用户令牌；服务端每次向 GitHub `GET /user` 验证（结果缓存
  5 分钟），再用同一张令牌校验他对目标仓库有 push 权限，不信任客户端自称的身份；
- 只对通过 push 校验、且在 App 安装范围内的仓库签发（`ALLOWED_OWNERS` 默认空 = 不限，
  它是可选的额外收紧）；请求体限 4KB，全局固定窗口限流 120 次/分钟；
- 日志不打印令牌；
- 只签发 installation token（1 小时、安装范围），不返回私钥，也不能签发任意 App 的令牌。
