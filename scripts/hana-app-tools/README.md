# scripts/hana-app-tools — 官方作者工具（原样拷贝）

这里放的是 **Hana 自带作者工具的原样拷贝**，目的是让本仓库与 CI 不依赖"本机恰好装了 Hana"
也能跑官方静态校验。来源、版本、哈希、许可说明见同目录 `PROVENANCE.json`。

## 为什么只有 validate-app.mjs

| 工具 | 是否拷入 | 原因 |
|------|----------|------|
| `validate-app.mjs` | ✅ | 官方静态校验；运行期只需 `yauzl` + `@cordisjs/plugin-loader`（≈73KB）|
| `extension-pack.mjs` | ❌ | 需要 `jsdom`(6.9MB) 与 `sharp`(原生)，而**包由本仓库 `scripts/pack.mjs` 自己出** |
| `app-validation-smoke.mjs` | ❌ | 需要完整 Hana + 独立 Electron 运行时，不属于仓库级检查 |

`scripts/pack.mjs` 会优先用这份拷贝做**额外关卡**；没有它时（例如尚未同步过的 checkout）
退回到本机 Hana 安装里的同名脚本；两者都没有则照常出包，并把 `officialValidation: "unavailable"`
写进输出，**不假装通过**。

## 同步 / 升级

Hana 升级后，这份拷贝要跟着刷新（它绑定 Hana 版本）：

```bash
node scripts/sync-hana-tools.mjs              # 从本机 Hana 安装重新拷贝，并更新 PROVENANCE.json
node scripts/sync-hana-tools.mjs --check      # 只比对本机版本与拷贝是否一致（CI 可用）
```

刷新后请连同 `PROVENANCE.json` 一起提交，让"这份工具来自哪个 Hana 版本"始终可查。
