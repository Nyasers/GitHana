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

Hana 升级后，这份拷贝要跟着刷新（它绑定 Hana 版本）：

```bash
# 覆盖式重新拷贝，并更新 PROVENANCE.json 里的版本与哈希
# （目前是手工步骤：从 <HANA_HOME>/artifacts/server/<version>/scripts/ 复制，
#   然后把新哈希写进 PROVENANCE.json）
```

刷新后请连同 `PROVENANCE.json` 一起提交，让"这份工具来自哪个 Hana 版本"始终可查。
