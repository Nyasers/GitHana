// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * lib/gpg-publish.js — 隔离 GPG 公钥在 GitHub 账号上的发布与轮换。
 *
 * ## 只碰自己那把（本文件最重要的一条）
 *
 * 账号级 `GPG keys: write` 能删账号上**任意** GPG 公钥，包括用户个人的正主密钥。
 * 因此本模块的删除路径只有一条：删密钥记录里记下的那一个 key_id。
 * **绝不** `GET` 全量列表后按名字/指纹模糊匹配批量删除——名称可由用户或其它工具改写，
 * 匹配失败会漏删、匹配过宽会误删。
 *
 * 被拒绝的方案：按 key 名称（如 `GitHana`）匹配删除。名称只用来**上传**时标识这把钥匙。
 *
 * ## 发布状态存在密钥记录里（不单开文件）
 *
 * `<dataDir>/gpg.key.json` 的 `published` 字段：`{ keyId, fingerprint, uploadedAt, login, gpgKeyId, name, stale[] }`
 *   - `keyId`     GitHub 侧的数字 id（`DELETE /user/gpg_keys/{keyId}` 的目标），字符串存
 *   - `fingerprint` OpenPGP 完整指纹（本地隔离环里的那把）
 *   - `gpgKeyId`  GitHub 页面展示的 16 位长 key id（= fingerprint 末 16 位），仅供显示
 *   - `name`      上传时用的名字（展示/辨认用，不参与删除匹配）
 *   - `stale[]`   待清理的旧公钥（每项 `{ keyId, fingerprint }`）：上传成功但删旧失败时记在这里，
 *                 下次发布或移除时**逐条核对指纹**后再尝试删除
 *
 * 发布状态说的是**本机这把钥匙**在 GitHub 上的对应关系，所以跟密钥记录同处一份（读写都在
 * lib/openpgp-key.js）。本地已经没钥匙、只剩待清理清单时，记录以「只有 published」的形态
 * 存续——那份清单不能丢，否则账号上会留下再也没人清理的钥匙。
 *
 * ## 删除前必须核对归属（本文件的第二条硬规则）
 *
 * 每次删除前先 `GET /user/gpg_keys`，再过 `ownsRemoteKey()`：**keyId 相等 且远端 key_id 等于
 * 记录指纹末 16 位**。只看 keyId 不够——记录可能来自另一个账号（用户换了登录），那里的同号
 * keyId 是别人的钥匙。指纹对不上一律不动它，宁可留下不一致也不误删。
 *
 * ## 发布流程（先加后删，且两端同进同退）
 *
 *   1. 读记录，`GET /user/gpg_keys` 一次，逐条核对「当前那把 + stale 残留」是否仍在、是否归我们；
 *      对不上的退回 stale、绝不动；
 *   2. `POST /user/gpg_keys`（body `{ name, armored_public_key }`）先上传新公钥
 *      （GitHub 允许账号上并存多把，先加后删能让账号全程都有可用公钥）；
 *   3. `DELETE /user/gpg_keys/{keyId}` 删掉核对过的旧钥匙；404 视为「已不存在」，算成功；
 *      删失败就记进 `stale`，留给下一次；
 *   4. 写回记录。
 *
 * ## 移除流程（删除时本地同步）
 *
 *   远端删除成功后，**本地同步清掉密钥与签名接线**（`gpg.key.json` / `.pub.asc` / gitconfig 里的
 *   `user.signingkey`、`commit.gpgsign`）——本地不留一把账号上已经没了的密钥。
 *   若归属核对不过或删除失败，则中止，**本地也不动**（保持两端一致）。
 *
 * ## 错误映射（AC11 / AC12 / AC13）
 *
 *   403 → 「App 未授予 GPG keys: write」+ 指向 App 权限设置页，不重试、不静默
 *   422 → 原样透出 GitHub 的报错 + 「该邮箱需为账号已验证邮箱」
 *   无 OAuth 凭据 → 「需先完成 GitHub App 授权」（不用 PAT 尝试：PAT 通常没有 gpg_keys 权限）
 *
 * ## 调用方
 *
 *   - lib/gpg-keygen.js：密钥生成成功后自动上传（失败只报告，不中断本地签名链路）
 *   - lib/routes/actions.js：设置页的「上传公钥」「从 GitHub 移除」两个手动按钮
 *
 * GitHub 域调用走自写 REST 通道（tools/lib/rest.js），不经 gh CLI。
 */
import { callRest, apiRoot, errorDetail } from "../tools/lib/rest.js";
import { getToolDataDir, getToolOAuthMeta, getToolSecretToken } from "../tools/lib/context.js";
import { runCli } from "../tools/lib/exec.js";
import { clearKey, readPublished, writePublished } from "./openpgp-key.js";

/** 本 App 上传的 GPG 公钥名里的固定后缀（辨认来源用）。 */
export const PUBLISH_NAME_SUFFIX = "@GitHana";

/**
 * 上传时给这把钥匙的展示名：`<账号 id>+<login>@GitHana`（形如 `61904116+ProjectNyaser@GitHana`）。
 *
 * 结构化而不是固定串：账号上可能同时存在用户自己加的、或别的工具加的钥匙，名字带上账号 id
 * 与 login 就不会撞车。名字只用于展示与人工辨认——**删除匹配一律不认名字**：名字在 GitHub
 * 页面上随时可以改，只看名字等于把「删哪把」交给一个可变的字符串。
 */
export function publishNameFor({ id, login } = {}) {
  const who = [id === undefined || id === null || id === "" ? "" : String(id), String(login || "").trim()]
    .filter(Boolean)
    .join("+");
  return (who || "unknown") + PUBLISH_NAME_SUFFIX;
}

/** App 权限设置页（403 时引导用户去补 GPG keys: write）。 */
const APP_SETTINGS_URL = "https://github.com/organizations/Nyasers/settings/apps/githana-app";

// ─────────────────────────── REST 封装 ───────────────────────────

/**
 * 调一次 api.github.com 的端点（会带本 App 的 OAuth 令牌）。
 * 返回 { ok, status, json, text, error }——与 lib/oauth.js 消费的形状一致。
 */
async function ghApi(one, options = {}) {
  const r = await callRest([one], { timeoutSec: 60, ...options });
  if (!r.ok) return { ok: false, status: null, json: null, text: "", error: r.message };
  return r.results[0] || { ok: false, status: null, json: null, text: "", error: "no result" };
}

// ─────────────────────────── 凭据前置检查 ───────────────────────────

/**
 * 发布动作的前置检查：没有可用 OAuth 凭据就直接拒绝。
 * 不用 PAT 尝试——PAT 通常没有 `gpg_keys` 权限，试了只会得到一堆 403。
 * @returns {string | null} 可读错误；null = 可以继续
 */
export function publishPrecondition() {
  // 先看 needsReauth：这种情况进程内令牌已被清空，但「重新授权」比「没授权」更准确，
  // 也更接近用户实际需要做的动作。
  const meta = getToolOAuthMeta();
  if (meta && meta.needsReauth === true) {
    return "re-authorization required: the last token refresh failed (the refresh_token is no longer valid or the authorization was revoked). Go to the settings page and click \"Sign in with GitHub\" again.";
  }
  if (!getToolSecretToken()) {
    return "GitHub App authorization is required first: there is no usable OAuth credential, so the account-level GPG public key API cannot be reached. Go to the settings page and click \"Sign in with GitHub\".";
  }
  return null;
}

// ─────────────────────────── GitHub GPG 接口 ───────────────────────────

/**
 * 列出账号上的 GPG 公钥。**只用于核对**记录里的 keyId 是否还在，
 * 绝不据此做任何批量删除。
 */
async function listUserGpgKeys() {
  const r = await ghApi({ url: apiRoot("/user/gpg_keys"), paginate: true, timeoutMs: 60_000 });
  if (!r.ok) return { ok: false, keys: [], status: r.status, r };
  return { ok: true, keys: Array.isArray(r.json) ? r.json : [], r };
}

/** 上传公钥：POST /user/gpg_keys（多行 armored key 走 JSON 体，不拼 argv）。 */
async function uploadGpgKey({ name, armoredPublicKey }) {
  return ghApi({
    method: "POST",
    url: apiRoot("/user/gpg_keys"),
    json: { name, armored_public_key: armoredPublicKey },
    timeoutMs: 60_000,
  });
}

/** 删除公钥：DELETE /user/gpg_keys/{id}。 */
async function deleteGpgKey(keyId) {
  return ghApi({
    method: "DELETE",
    url: apiRoot("/user/gpg_keys/" + encodeURIComponent(String(keyId))),
    timeoutMs: 60_000,
  });
}

/**
 * 这把远端公钥是不是记录里那一条（删除前必须过这一关）。
 *
 * 判据两条同时成立：**keyId 相等** 且 **远端 key_id 等于记录指纹末 16 位**。
 * 只看 keyId 不够：记录文件可能来自另一个账号（用户换了登录），那个账号上同号的 keyId
 * 是**别人的**钥匙，照着一个对不上的 keyId 去删就是误删。指纹对不上就一律不动它。
 *
 * @param {object} remoteKey GET /user/gpg_keys 里的一条
 * @param {{ keyId: string, fingerprint: string }} want
 */
function ownsRemoteKey(remoteKey, want) {
  if (!remoteKey || !want) return false;
  if (String(remoteKey.id) !== String(want.keyId)) return false;
  const wantKeyId = String(want.fingerprint || "").slice(-16).toUpperCase();
  if (!wantKeyId) return false;
  return String(remoteKey.key_id || "").toUpperCase() === wantKeyId;
}

/** 记录里的待清理公钥列表（keyId + 指纹，删除前逐条核对）。 */
function staleList(rec) {
  const arr = rec && Array.isArray(rec.stale) ? rec.stale : [];
  return arr
    .map((e) => ({
      keyId: String((e && e.keyId) || ""),
      fingerprint: String((e && e.fingerprint) || ""),
    }))
    .filter((e) => e.keyId);
}

/**
 * 撤掉隔离 gitconfig 里的签名接线。删掉本地密钥后必须撤：留着 `commit.gpgsign=true`
 * 加一个已不存在的 `user.signingkey`，之后每次提交都会签名失败。
 */
async function unwireGitSigning() {
  await runCli("git", ["config", "--global", "--unset", "user.signingkey"], {});
  await runCli("git", ["config", "--global", "--unset", "commit.gpgsign"], {});
}

/** 把 GitHub 的失败响应翻成可读文案（AC11 / AC12）。 */
function mapFailure(status, detail) {
  if (status === 403) {
    return (
      "GitHub rejected the request (403): this App has not been granted the `GPG keys: write` permission. " +
      "Check on the App permission settings page that the permission is Read and write, and re-approve the installation: " + APP_SETTINGS_URL +
      "\nGitHub response: " + detail
    );
  }
  if (status === 422) {
    return (
      "GitHub rejected the request (422): the public key was rejected. " + detail +
      "\nthat email must be a verified email of the account — the email in the public key's UID must be one verified for this account, " +
      "otherwise GitHub will not accept the key."
    );
  }
  if (status === 401) {
    return "GitHub rejected the request (401): the OAuth token is invalid or has expired; re-authorize on the settings page.\nGitHub response: " + detail;
  }
  if (status === 404) {
    return "GitHub returned 404: the target resource does not exist.\nGitHub response: " + detail;
  }
  return `GitHub call failed${status ? ` (HTTP ${status})` : ""}: ${detail}`;
}

// ───────────────────────────── 发布 / 移除 ─────────────────────────────

/**
 * 发布（或轮换）公钥。先加后删：整个过程中账号上至少有一把可用公钥。
 *
 * 轮换顺序有意是「先传新、再删旧」而不是反过来：先删会在中间留一段空窗（那一刻账号上
 * 没有本 App 的密钥，期间签的提交无法验签）；而 GitHub 允许账号上并存多把公钥，先加后删
 * 没有这个缺口。旧钥匙只有在**核对过归属**之后才会被删；核对不过或删不掉，它被记进 stale
 * 留给下一次，宁可不一致也不误删。
 *
 * @param {{ dataDir?: string, pubkeyArmored: string, fingerprint?: string, login?: string, id?: number|string }} args
 * @returns {Promise<{ ok: boolean, keyId?: string, gpgKeyId?: string, fingerprint?: string,
 *   uploadedAt?: string, login?: string, replaced?: string|null, pending?: number, message: string }>}
 */
export async function publishKey({ dataDir, pubkeyArmored, fingerprint, login, id } = {}) {
  const dir = dataDir || getToolDataDir();
  const armored = String(pubkeyArmored || "").trim();
  const fpr = String(fingerprint || "").trim();
  const pre = publishPrecondition();
  if (pre) return { ok: false, message: pre };
  if (!armored) {
    return { ok: false, message: "there is no public key to upload: generate the isolated GPG key first." };
  }

  const prev = readPublished(dir);
  const stale = staleList(prev);

  // 1) 先上传新公钥（账号全程都有可用公钥；先删后传会留空窗）。
  const up = await uploadGpgKey({ name: publishNameFor({ id, login }), armoredPublicKey: armored });
  if (!up.ok) {
    return { ok: false, message: "failed to upload the public key." + mapFailure(up.status, errorDetail(up)) };
  }
  const key = up.json && typeof up.json === "object" ? up.json : {};
  const keyId = key.id === undefined || key.id === null ? "" : String(key.id);
  const gpgKeyId = key.key_id ? String(key.key_id) : fpr ? fpr.slice(-16) : "";
  const uploadedAt = new Date().toISOString();
  const account = String(login || (getToolOAuthMeta() || {}).login || "");

  // 2) 旧钥匙进待清理队列：当前记录里的那把（发布前那把）+ 上次没删干净的残留。
  const toRemove = [];
  if (prev && prev.keyId) toRemove.push({ keyId: prev.keyId, fingerprint: prev.fingerprint });
  for (const s of stale) toRemove.push(s);

  // 3) 一次取列表，逐条核对归属后删。核对不过的不动它（宁可留下不一致也不误删）。
  let replaced = null;
  const leftOver = [];
  if (toRemove.length) {
    const listed = await listUserGpgKeys();
    if (!listed.ok) {
      // 删不了不等于上传失败：新钥匙已经上去了，旧钥匙留着继续有效，下次再清。
      writePublished(dir, { keyId, fingerprint: fpr, uploadedAt, login: account, gpgKeyId, name: publishNameFor({ id, login }), stale: toRemove });
      return {
        ok: true,
        keyId,
        gpgKeyId,
        fingerprint: fpr,
        uploadedAt,
        login: account,
        replaced: null,
        pending: toRemove.length,
        message:
          "the new public key was uploaded to the GitHub account" + (account ? " @" + account : "") + " (key_id " + (keyId || "?") + ")." +
          "cleaning up the old public key did not finish (cannot read the account's public key list, so nothing is deleted blindly): " + mapFailure(listed.status, errorDetail(listed)) +
          ". The old key is still valid; the next publish or remove will try again.",
      };
    }
    const byId = new Map(listed.keys.map((k) => [String(k && k.id), k]));
    for (const want of toRemove) {
      const remote = byId.get(String(want.keyId));
      if (!remote) continue; // 已不在账号上：无需处理
      if (!ownsRemoteKey(remote, want)) {
        // 号码对上了但指纹不是我们那把（记录来自别的账号等）：坚决不动，也不无限重试。
        continue;
      }
      const del = await deleteGpgKey(want.keyId);
      if (del.ok || del.status === 404) {
        replaced = want.keyId;
      } else {
        leftOver.push(want);
      }
    }
  }

  writePublished(dir, { keyId, fingerprint: fpr, uploadedAt, login: account, gpgKeyId, name: publishNameFor({ id, login }), stale: leftOver });

  return {
    ok: true,
    keyId,
    gpgKeyId,
    fingerprint: fpr,
    uploadedAt,
    login: account,
    replaced,
    pending: leftOver.length,
    message:
      "the public key was uploaded to the GitHub account" + (account ? " @" + account : "") + " (key_id " + (keyId || "?") + ")" +
      (replaced ? ", and the old one was removed (key_id " + replaced + ")" : "") +
      (leftOver.length ? "; " + leftOver.length + " old key(s) could not be removed and will be retried next time" : "") +
      ". Commits signed with the isolated key will show as Verified from now on.",
  };
}

/**
 * 从 GitHub 移除本 App 上传的公钥，并同步清掉本地密钥与签名接线。
 *
 * 处理两类目标：记录里当前那把（`keyId`）+ stale[] 里待清理的旧公钥。两者都**先核对归属
 * 再删**（`ownsRemoteKey`），核对不过或删失败就留在 stale[] 里下次再试。
 *
 * 本 App 在账号上没有钥匙（远端已不存在）也算移除完成：本地不该继续留一把账号上没有的密钥。
 * 没有记录、也没有 stale 时无事可做（绝不猜、绝不枚举）。
 */
export async function unpublishKey({ dataDir } = {}) {
  const dir = dataDir || getToolDataDir();
  const pre = publishPrecondition();
  if (pre) return { ok: false, removed: false, message: pre };

  const rec = readPublished(dir);
  const stale = staleList(rec);
  // 只有 stale、没有 keyId 的记录同样要处理：它就是上次没删干净的残留。
  if (!rec || (!rec.keyId && !stale.length)) {
    return { ok: true, removed: false, message: "there is no publish record for this App locally, so nothing was deleted on GitHub." };
  }

  // 删除前核对归属：号码对上还不够，指纹必须也是我们那把（记录可能来自另一个账号）。
  const listed = await listUserGpgKeys();
  if (!listed.ok) {
    return {
      ok: false,
      removed: false,
      message: "removal aborted: cannot read the account's GPG public key list (nothing is deleted blindly)." + mapFailure(listed.status, errorDetail(listed)),
    };
  }
  const byId = new Map(listed.keys.map((k) => [String(k && k.id), k]));

  // 当前那把：归属核对不过就中止（不动它，本地也不动）。
  const remote = rec.keyId ? byId.get(String(rec.keyId)) || null : null;
  if (remote && !ownsRemoteKey(remote, rec)) {
    return {
      ok: false,
      removed: false,
      message:
        "removal aborted: key_id " + rec.keyId + " in the record corresponds to a different key on the account" +
        " (remote key_id " + (remote.key_id || "?") + ", last 16 chars of the recorded fingerprint " +
        String(rec.fingerprint || "").slice(-16) + "). It is left untouched.",
    };
  }
  let remoteDeleted = false;
  if (remote) {
    const del = await deleteGpgKey(rec.keyId);
    if (!del.ok && del.status !== 404) {
      return { ok: false, removed: false, message: "removal failed." + mapFailure(del.status, errorDetail(del)) };
    }
    remoteDeleted = del.ok;
  }

  // stale 残留：逐条核对后删；核对不过或删失败都留在队列里，绝不因“这次没删掉”而丢掉记录。
  const leftOver = [];
  for (const s of stale) {
    const r2 = byId.get(String(s.keyId));
    if (!r2) continue; // 已不在账号上：无需再处理
    if (!ownsRemoteKey(r2, s)) {
      leftOver.push(s);
      continue;
    }
    const d2 = await deleteGpgKey(s.keyId);
    if (!d2.ok && d2.status !== 404) leftOver.push(s);
  }

  // 远端删除完成后，本地同步清掉：密钥文件 + 隔离 gitconfig 里的签名接线。
  // 本地留着一把账号上已不存在的密钥，会让后续每次提交签名都失败。
  clearKey(dir);
  await unwireGitSigning();
  // 还有没删掉的旧公钥时保留记录（keyId 置空），让下次发布或移除能接着重试。
  writePublished(dir, leftOver.length ? { keyId: "", stale: leftOver } : null);

  return {
    ok: true,
    removed: true,
    clearedLocal: true,
    keyId: rec.keyId || null,
    pending: leftOver.length,
    message:
      (rec.keyId
        ? remoteDeleted
          ? "removed the public key from GitHub (key_id " + rec.keyId + ")"
          : "that public key no longer exists on GitHub (key_id " + rec.keyId + ")"
        : "this App has no current public key on the account") +
      (leftOver.length ? "; another " + leftOver.length + " old public key(s) could not be removed and will be retried next time" : "") +
      "; the local key and signing configuration were cleared as well, so commits will no longer be signed automatically.",
  };
}

/**
 * 给设置页看的发布状态（只读，不发网络请求）。
 * @returns {{ published: boolean, keyId: string|null, gpgKeyId: string|null,
 *   fingerprint: string|null, uploadedAt: string|null, login: string|null,
 *   name: string|null, pending: number }}
 */
export function publishedInfo(dataDir) {
  const rec = readPublished(dataDir);
  return {
    published: !!(rec && rec.keyId),
    keyId: rec && rec.keyId ? rec.keyId : null,
    gpgKeyId: rec && (rec.gpgKeyId || rec.fingerprint) ? rec.gpgKeyId || rec.fingerprint.slice(-16) : null,
    fingerprint: rec && rec.fingerprint ? rec.fingerprint : null,
    uploadedAt: rec && rec.uploadedAt ? rec.uploadedAt : null,
    login: rec && rec.login ? rec.login : null,
    name: rec && rec.name ? rec.name : null,
    // 待清理的旧公钥数（上传成了但上次没删掉）；仅用于界面提示，不阻塞任何操作。
    pending: rec ? staleList(rec).length : 0,
  };
}
