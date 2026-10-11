# scripts/hana-app-tools — 官方作者工具拷贝

这里放的是 Hana 自带作者工具的**原样拷贝**，用于让本仓库与 CI 不依赖"本机恰好装了 Hana"。
来源、版本、哈希与许可说明见 `PROVENANCE.json`。

## 收录判定：看依赖闭包，而不是看名字

| 工具 | 是否收录 | 依据（实测） |
|------|----------|--------------|
| `extension-index-build.mjs` | ✅ | 只 import `node:fs` / `node:path` / `node:url`，**无外部依赖**，可独立运行 |
| `validate-app.mjs` | ❌ | import 了 `@earendil-works/pi-coding-agent` 等 Hana **内部包**（不在 npm 上），脱离 Hana 安装的 node_modules 无法运行；连闭包一起 vendor 既重又与 Hana 版本绑死 |
| `extension-pack.mjs` | ❌ | 需要 `jsdom`(6.9MB) 与 `sharp`(原生)；而包由本仓库 `scripts/pack.mjs` 自己出 |

所以：**索引能自足出，静态校验不行**。`scripts/pack.mjs` 与 `scripts/build-index.mjs` 都按
「仓库内拷贝优先 → HANA_APP_TOOLS_ROOT → 本机 Hana（取最新版本）」这条链找工具，找不到时
明确报错或标注，不假装通过。

## 升级

Hana 升级后，这份拷贝要跟着刷新（它绑定 Hana 版本）——半手工步骤已收进脚本：

```bash
node scripts/sync-app-tools.mjs          # 从本机宿主刷新拷贝并更新 PROVENANCE.json
node scripts/sync-app-tools.mjs --check  # 只校验漂移（有则 exit 1）
```

源按 `--source` → `<HANA_HOME>/artifacts/server/<最新版本>/scripts` → 已装 skill 的
`scripts/` 依次探测，且**不进 CI**（源是本机宿主）。刷新后请连同改动一起提交。

为什么必须跟着升：内嵌工具的校验阈值会随版本变。一个实例——索引构建器的归档上限从
`0.970.9` 的 50 MiB 放宽到了现版的 300 MiB；用旧拷贝会把其实合法的包判成超限。
