// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers

/**
 * scripts/dev/check-services.mjs — 服务面的纯函数自检（不开宿主、不跑 git）。
 *
 * 为什么单独一份：`lib/services.js` 里真正跨进程的是两个 handler，它们要宿主才能跑；而夹在
 * 中间的两段纯逻辑——载荷归一 与 工具回执 → 结构化结果的解析——恰恰是最容易默默错的地方
 * （回执格式一改，解析就悄悄把成功读成失败，或把失败读成成功）。这两段在这里逐条钉住。
 *
 * 用法：node scripts/dev/check-services.mjs
 * 退出码：0 全过；1 有断言失败。
 */
import assert from "node:assert/strict";

import { normalizeCommitPayload, commitOutcome } from "../../lib/services.js";

let failed = 0;
function case_(name, fn) {
  try {
    fn();
    console.log("  ok  " + name);
  } catch (e) {
    failed += 1;
    console.error("  FAIL " + name + "\n       " + String((e && e.message) || e));
  }
}

console.log("[check-services] normalizeCommitPayload");

case_("合法载荷原样收下（cwd 必填、message 可空）", () => {
  const r = normalizeCommitPayload({ cwd: "  E:/repo  ", message: "hi" });
  assert.equal(r.ok, true);
  assert.equal(r.value.cwd, "E:/repo", "cwd 去两端空白");
  assert.equal(r.value.message, "hi");
  assert.equal(r.value.allowEmpty, false, "缺省不允许空提交");
});

case_("cwd 缺失 / 空串 / 非对象 → 拒，并说清是哪一条", () => {
  for (const bad of [null, undefined, [], "x", {}, { cwd: "" }, { cwd: "   " }]) {
    const r = normalizeCommitPayload(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(r.error && r.error.length > 0);
  }
});

case_("paths 必须是数组（跨进程边界不做隐式转换）", () => {
  assert.equal(normalizeCommitPayload({ cwd: "/r", paths: "a.txt" }).ok, false);
  const ok = normalizeCommitPayload({ cwd: "/r", paths: ["a.txt", "b.txt"] });
  assert.deepEqual(ok.value.paths, ["a.txt", "b.txt"]);
});

case_("allowEmpty 只认布尔真", () => {
  assert.equal(normalizeCommitPayload({ cwd: "/r", allowEmpty: "yes" }).value.allowEmpty, false);
  assert.equal(normalizeCommitPayload({ cwd: "/r", allowEmpty: true }).value.allowEmpty, true);
});

console.log("[check-services] commitOutcome");

case_("结构化回执（details 里就有事实）→ 直接用，不去解文本", () => {
  const r = commitOutcome({
    content: [{ type: "text", text: "commit created: a3a0f57  e2e\nfiles: 2" }],
    details: { ok: true, action: "commit", hash: "a3a0f57", files: 2 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.commit, "a3a0f57");
  assert.equal(r.files, 2);
});

case_("结构化回执说失败 → 失败，并带出给人看的那段", () => {
  const r = commitOutcome({
    content: [{ type: "text", text: "githana_git: nothing to commit" }],
    details: { ok: false },
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /nothing to commit/);
});

case_("成功的提交回执 → ok + 短 hash", () => {
  const r = commitOutcome("commit created: c3c74ee  probe: commit from inside a dshana worktree\nfiles: 1\n  · b.txt");
  assert.equal(r.ok, true);
  assert.equal(r.commit, "c3c74ee");
});

case_("amend 的回执也要认（它是另一种措辞）", () => {
  const r = commitOutcome("commit amended: abc1234  fix message");
  assert.equal(r.ok, true);
  assert.equal(r.commit, "abc1234");
  assert.equal(r.amended, true);
});

case_("失败回执 → ok=false，且原文保留（不吞诊断）", () => {
  const r = commitOutcome("githana_git(action=commit) argument error: paths entries must be relative paths");
  assert.equal(r.ok, false);
  assert.match(r.error, /must be relative paths/);
});

case_("空回执 → ok=false，不当成成功", () => {
  for (const bad of ["", null, undefined, "   "]) {
    const r = commitOutcome(bad);
    assert.equal(r.ok, false, String(bad));
    assert.ok(r.error.length > 0);
  }
});

case_("只是提到了 commit created 但不是开头 → 不算成功（防误判）", () => {
  const r = commitOutcome("error: something failed\ncommit created: deadbee  in the log");
  assert.equal(r.ok, false);
});

if (failed > 0) {
  console.error("[check-services] " + failed + " 条断言失败");
  process.exit(1);
}
console.log("[check-services] ok（全部通过）");
