#!/usr/bin/env node
import d from "node:fs";
import b from "node:path";
import { fileURLToPath as O } from "node:url";
const k = Object.freeze([
  "app",
  "skill",
  "recipe",
  "connector",
  "role",
  "bundle"
]), _ = new Set(k);
function R(e) {
  return typeof e == "string" && _.has(e);
}
function P(e) {
  return !(typeof e != "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(e) || e.endsWith(".") || e.endsWith("-") || e.includes("..") || e.includes("--"));
}
function z(e) {
  if (typeof e != "string" || !e) return !1;
  const r = e.indexOf("/");
  return r > 0 && r === e.lastIndexOf("/") && r < e.length - 1;
}
const I = 2, A = 300 * 1024 * 1024;
function m(e) {
  return !!e && typeof e == "object" && !Array.isArray(e);
}
function p(e) {
  return typeof e == "string" && e.length > 0;
}
function $(e) {
  return Array.isArray(e) && e.every((r) => typeof r == "string");
}
function C(e) {
  if (typeof e != "string" || !e) return !1;
  try {
    return new URL(e).protocol === "https:";
  } catch {
    return !1;
  }
}
function L(e) {
  return typeof e == "string" && /^[0-9a-f]{64}$/.test(e);
}
function M(e) {
  return Number.isInteger(e) && e > 0;
}
function F(e) {
  return Number.isInteger(e) && e >= 0;
}
function T(e) {
  return typeof e == "string" && e.length > 0 && !Number.isNaN(Date.parse(e));
}
function N(e, r) {
  return m(e) ? C(e.url) ? L(e.sha256) ? M(e.size) ? e.size > A ? `${r}.size exceeds the ${A} byte limit` : e.format !== "zip" ? `${r}.format must be "zip"` : null : `${r}.size must be a positive integer` : `${r}.sha256 must be 64 lowercase hex characters` : `${r}.url must be an https URL` : `${r} must be an object`;
}
function B(e, r) {
  return m(e) ? z(e.capability) ? e.scope !== void 0 && !m(e.scope) ? `${r}.scope must be an object` : e.reason !== void 0 && typeof e.reason != "string" ? `${r}.reason must be a string` : null : `${r}.capability must be a "<namespace>/<name>" string` : `${r} must be an object`;
}
function H(e, r) {
  return m(e) ? p(e.version) ? e.minAppVersion !== void 0 && !p(e.minAppVersion) ? `${r}.minAppVersion must be a non-empty string` : N(e.archive, `${r}.archive`) : `${r}.version must be a non-empty string` : `${r} must be an object`;
}
function J(e, r) {
  return m(e) ? e.downloads !== void 0 && !F(e.downloads) ? `${r}.downloads must be a non-negative integer` : null : `${r} must be an object`;
}
function K(e, r) {
  return m(e) ? e.minAppVersion !== void 0 && !p(e.minAppVersion) ? `${r}.minAppVersion must be a non-empty string` : e.formFactors !== void 0 && !$(e.formFactors) ? `${r}.formFactors must be an array of strings` : null : `${r} must be an object`;
}
function D(e, r) {
  if (!m(e)) return `${r} must be an object`;
  if (!R(e.kind))
    return `${r}.kind must be one of ${k.join(", ")}`;
  if (!P(e.id)) return `${r}.id is not a safe extension id`;
  if (!p(e.name)) return `${r}.name must be a non-empty string`;
  if (!p(e.publisher)) return `${r}.publisher must be a non-empty string`;
  if (typeof e.description != "string") return `${r}.description must be a string`;
  if (!p(e.version)) return `${r}.version must be a non-empty string`;
  const n = N(e.archive, `${r}.archive`);
  if (n) return n;
  if (!Array.isArray(e.permissions)) return `${r}.permissions must be an array`;
  for (let t = 0; t < e.permissions.length; t += 1) {
    const i = B(e.permissions[t], `${r}.permissions[${t}]`);
    if (i) return i;
  }
  if (e.versions !== void 0) {
    if (!Array.isArray(e.versions)) return `${r}.versions must be an array`;
    for (let t = 0; t < e.versions.length; t += 1) {
      const i = H(e.versions[t], `${r}.versions[${t}]`);
      if (i) return i;
    }
  }
  if (e.compatibility !== void 0) {
    const t = K(e.compatibility, `${r}.compatibility`);
    if (t) return t;
  }
  if (e.homepage !== void 0 && typeof e.homepage != "string") return `${r}.homepage must be a string`;
  if (e.repository !== void 0 && typeof e.repository != "string") return `${r}.repository must be a string`;
  if (e.license !== void 0 && typeof e.license != "string") return `${r}.license must be a string`;
  if (e.icon !== void 0 && typeof e.icon != "string") return `${r}.icon must be a string`;
  if (e.categories !== void 0 && !$(e.categories)) return `${r}.categories must be an array of strings`;
  if (e.keywords !== void 0 && !$(e.keywords)) return `${r}.keywords must be an array of strings`;
  if (e.readmeUrl !== void 0 && typeof e.readmeUrl != "string") return `${r}.readmeUrl must be a string`;
  if (e.stats !== void 0) {
    const t = J(e.stats, `${r}.stats`);
    if (t) return t;
  }
  return null;
}
function W(e, r) {
  return m(e) && typeof e.id == "string" && e.id ? e.id : `#${r}`;
}
function X(e) {
  if (!m(e)) return { errors: ["market index must be a JSON object"] };
  if (!p(e.sourceId)) return { errors: ["sourceId must be a non-empty string"] };
  if (!p(e.name)) return { errors: ["name must be a non-empty string"] };
  if (!T(e.publishedAt)) return { errors: ["publishedAt must be a parseable date string"] };
  if (!Array.isArray(e.items)) return { errors: ["items must be an array"] };
  const r = [], n = [];
  return e.items.forEach((t, i) => {
    const l = D(t, `items[${i}]`);
    if (l) {
      n.push(`dropped market item ${W(t, i)}: ${l}`);
      return;
    }
    r.push(t);
  }), {
    index: {
      schemaVersion: I,
      sourceId: e.sourceId,
      name: e.name,
      publishedAt: e.publishedAt,
      items: r
    },
    warnings: n
  };
}
function y(e) {
  const r = Number.parseInt(e, 10);
  return Number.isFinite(r) && r >= 0 ? r : 0;
}
function x(e) {
  const r = String(e || "0.0.0").trim(), n = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(r);
  return n ? {
    major: y(n[1]),
    minor: y(n[2]),
    patch: y(n[3]),
    prerelease: n[4] || "",
    raw: r
  } : null;
}
function q(e, r) {
  if (!e && !r) return 0;
  if (!e) return 1;
  if (!r) return -1;
  const n = e.split("."), t = r.split("."), i = Math.max(n.length, t.length);
  for (let l = 0; l < i; l += 1) {
    const c = n[l], f = t[l];
    if (c === void 0) return -1;
    if (f === void 0) return 1;
    const g = /^\d+$/.test(c) ? Number.parseInt(c, 10) : null, o = /^\d+$/.test(f) ? Number.parseInt(f, 10) : null;
    if (g !== null && o !== null && g !== o) return g > o ? 1 : -1;
    if (g !== null && o === null) return -1;
    if (g === null && o !== null) return 1;
    if (c !== f) return c > f ? 1 : -1;
  }
  return 0;
}
function Z(e, r) {
  const n = x(e), t = x(r);
  if (!n && !t) return String(e || "").localeCompare(String(r || ""), void 0, { numeric: !0 });
  if (!n) return -1;
  if (!t) return 1;
  for (const i of ["major", "minor", "patch"])
    if (n[i] !== t[i]) return n[i] > t[i] ? 1 : -1;
  return q(n.prerelease, t.prerelease);
}
const Y = O(import.meta.url), S = "{{BASE_URL}}";
function v(e) {
  return !!e && typeof e == "object" && !Array.isArray(e);
}
function G(e) {
  const r = { entries: null, baseUrl: null, sourceId: null, name: null, out: null };
  for (let n = 0; n < e.length; n++) {
    const t = e[n];
    t === "--entries" ? r.entries = e[++n] : t === "--base-url" ? r.baseUrl = e[++n] : t === "--source-id" ? r.sourceId = e[++n] : t === "--name" ? r.name = e[++n] : t === "--out" ? r.out = e[++n] : (console.error(`extension-index-build: unknown argument ${t}`), process.exit(1));
  }
  return r;
}
function Q() {
  console.error(
    "Usage: node scripts/extension-index-build.mjs --entries <dir> --base-url <https://…> --source-id <id> --name <name> [--out index.v2.json]"
  ), process.exit(1);
}
function w(e) {
  if (typeof e != "string" || !e) return !1;
  try {
    return new URL(e).protocol === "https:";
  } catch {
    return !1;
  }
}
function ee(e, r) {
  if (typeof e != "string")
    throw new Error(`archive.url must be a string, got ${JSON.stringify(e)}`);
  return e.startsWith(S) ? r.replace(/\/+$/, "") + e.slice(S.length) : e;
}
function re(e) {
  if (!d.existsSync(e) || !d.statSync(e).isDirectory())
    throw new Error(`--entries must be an existing directory: ${e}`);
  const r = d.readdirSync(e).filter((n) => n.endsWith(".entry.json")).sort();
  if (r.length === 0)
    throw new Error(`no *.entry.json files found in ${e}`);
  return r.map((n) => {
    const t = b.join(e, n), i = JSON.parse(d.readFileSync(t, "utf-8"));
    if (!v(i) || typeof i.kind != "string" || typeof i.id != "string" || typeof i.version != "string" || !v(i.archive))
      throw new Error(`${t}: not a valid entry (missing kind/id/version/archive).`);
    return { fileName: n, entry: i };
  });
}
function ne({ fileName: e, entry: r }) {
  return r.kind !== "skill" && r.kind !== "recipe" ? !1 : r.version === "0.0.0" && e === `${r.kind}-${r.id}.entry.json`;
}
function te({ entriesDir: e, baseUrl: r, sourceId: n, name: t, publishedAt: i }) {
  if (!w(r))
    throw new Error(`--base-url must be an https URL, got ${JSON.stringify(r)}`);
  if (typeof n != "string" || !n.trim())
    throw new Error("--source-id is required and must be a non-empty string.");
  if (typeof t != "string" || !t.trim())
    throw new Error("--name is required and must be a non-empty string.");
  const l = re(e).map(({ fileName: u, entry: s }) => ({
    fileName: u,
    entry: {
      ...s,
      archive: { ...s.archive, url: ee(s.archive.url, r) }
    }
  })), c = /* @__PURE__ */ new Map();
  for (const u of l) {
    const s = `${u.entry.kind}:${u.entry.id}`;
    c.has(s) || c.set(s, []), c.get(s).push(u);
  }
  const f = [];
  for (const u of c.values()) {
    const s = u.filter(ne);
    if (s.length > 0) {
      const a = { ...s[0].entry };
      delete a.versions, f.push(a);
      continue;
    }
    const j = [...u].sort((a, U) => Z(U.entry.version, a.entry.version)), [V, ...h] = j, E = { ...V.entry };
    h.length > 0 && (E.versions = h.map(({ entry: a }) => ({
      version: a.version,
      ...a.compatibility?.minAppVersion ? { minAppVersion: a.compatibility.minAppVersion } : {},
      archive: a.archive
    }))), f.push(E);
  }
  f.sort((u, s) => u.kind === s.kind ? u.id.localeCompare(s.id) : u.kind.localeCompare(s.kind));
  const g = {
    schemaVersion: I,
    sourceId: n.trim(),
    name: t.trim(),
    publishedAt: i || (/* @__PURE__ */ new Date()).toISOString(),
    items: f
  }, o = X(g);
  if ("errors" in o)
    throw new Error(`generated market index failed self-check:
${o.errors.join(`
`)}`);
  if (o.warnings.length > 0)
    throw new Error(
      `generated market index dropped ${o.warnings.length} item(s) on self-check (this script fully controls its own output, so a dropped item is a bug in it, not a tolerable third-party quirk):
${o.warnings.join(`
`)}`
    );
  return o.index;
}
async function ie() {
  const e = G(process.argv.slice(2));
  (!e.entries || !e.baseUrl || !e.sourceId || !e.name) && Q();
  const r = te({
    entriesDir: b.resolve(e.entries),
    baseUrl: e.baseUrl,
    sourceId: e.sourceId,
    name: e.name
  }), n = b.resolve(e.out || "index.v2.json");
  d.mkdirSync(b.dirname(n), { recursive: !0 }), d.writeFileSync(n, `${JSON.stringify(r, null, 2)}
`, "utf-8"), console.log(`extension-index-build: wrote ${n} (${r.items.length} item(s))`);
}
process.argv[1] && d.realpathSync(process.argv[1]) === d.realpathSync(Y) && ie().catch((e) => {
  console.error(`extension-index-build: ${e instanceof Error ? e.message : String(e)}`), process.exitCode = 1;
});
export {
  te as buildExtensionIndex
};
