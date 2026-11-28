// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/lib/archive.mjs — 纯 Node 的解包（tar.gz / zip），只依赖 node:zlib。
//
// 为什么不用系统 tar / unzip：构建脚本要在任一平台、任一机器（含无 unzip 的 Linux CI、
// 以及 Windows 与 Linux 的 tar 参数差异）上一致地读包，外部命令的存在性与方言都不能假定。
// zip 的写入见 scripts/pack.mjs（同样是自足的写法）；这里补上读的一侧。
//
// 两个入口都返回 Map<规范化名, Buffer>：键是相对包根的路径（正斜杠、去掉前导 "./" 与尾部 "/"），
// 值是解压后的字节。目录条目不进 Map（目录由写盘一侧按需创建）；符号/硬链接保留为空 Buffer 的
// 轻量标记，不跟随（解包消费方不依赖链接语义）。
import fs from "node:fs";
import zlib from "node:zlib";

const TAR_BLOCK = 512;

/** 读 .tar.gz → Map<name, Buffer>。gunzip 失败、头部损坏、未知 typeflag 均抛出可读错误。 */
export function readTarGz(file) {
  const raw = fs.readFileSync(file);
  let tar;
  try {
    tar = zlib.gunzipSync(raw);
  } catch (e) {
    throw new Error(`readTarGz: ${file} 不是有效的 gzip（${(e && e.message) || e}）`);
  }
  return parseTar(tar, file);
}

/** 读 .zip → Map<name, Buffer>。走 EOCD → 中央目录 → 本地头；支持 store(0) 与 deflate(8)。 */
export function readZip(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 22) throw new Error(`readZip: ${file} 太小，不是有效 zip`);

  const eocd = findEocd(buf, file);
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    throw new Error(`readZip: ${file} 使用了 zip64，本解包器不支持`);
  }

  const out = new Map();
  let p = cdOffset;
  for (let idx = 0; idx < count; idx += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error(`readZip: ${file} 中央目录签名不符（偏移 ${p}），文件可能损坏`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const rawName = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (rawName.endsWith("/")) continue; // 目录条目：跳过（写盘一侧按需建目录）

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`readZip: ${file} 条目 "${rawName}" 的本地头签名不符（偏移 ${localOffset}）`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buf.length) {
      throw new Error(`readZip: ${file} 条目 "${rawName}" 数据越界，文件可能损坏`);
    }
    const raw = buf.subarray(dataStart, dataEnd);

    let content;
    if (method === 0) {
      content = Buffer.from(raw);
    } else if (method === 8) {
      try {
        content = zlib.inflateRawSync(raw);
      } catch (e) {
        throw new Error(`readZip: ${file} 条目 "${rawName}" deflate 解压失败（${(e && e.message) || e}）`);
      }
    } else {
      throw new Error(`readZip: ${file} 条目 "${rawName}" 使用了不支持的压缩方法 ${method}`);
    }

    const norm = normalizeName(rawName);
    if (norm) out.set(norm, content);
  }
  return out;
}

// ── 内部实现 ──────────────────────────────────────────────────────────────

/** 从文件尾部向前找 EOCD 签名（末尾注释最长 65535 字节）。 */
function findEocd(buf, file) {
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= stop; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error(`readZip: ${file} 找不到 EOCD（不是有效 zip）`);
}

/** 统一条目名：正斜杠、去掉前导 "./"、去掉尾部 "/"。 */
function normalizeName(name) {
  let n = String(name).replace(/\\/g, "/");
  while (n.startsWith("./")) n = n.slice(2);
  n = n.replace(/\/+$/, "");
  return n;
}

/** 全零块 = 归档结束标记。 */
function isZeroBlock(block) {
  for (let i = 0; i < block.length; i += 1) if (block[i] !== 0) return false;
  return true;
}

/** NUL 结尾的 C 字符串（按 UTF-8 解码）。 */
function cstr(buf) {
  const end = buf.indexOf(0);
  return buf.toString("utf8", 0, end < 0 ? buf.length : end);
}

/** 解析 tar 数字字段：八进制 ASCII，或 GNU base-256（首字节最高位置 1）。 */
function parseTarNumber(buf) {
  if (buf.length === 0) return 0;
  if (buf[0] & 0x80) {
    let value = buf[0] & 0x7f;
    for (let i = 1; i < buf.length; i += 1) value = value * 256 + buf[i];
    return value;
  }
  const s = cstr(buf).trim();
  if (s === "") return 0;
  const n = parseInt(s, 8);
  if (Number.isNaN(n)) throw new Error(`readTarGz: 无法解析 tar 数字字段 "${s}"`);
  return n;
}

/** 校验头部 checksum（tar 规范：checksum 字段按空格计）。signed/unsigned 两种方言都接受。 */
function verifyChecksum(header, offset, file) {
  const stored = parseTarNumber(header.subarray(148, 156));
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < TAR_BLOCK; i += 1) {
    const b = i >= 148 && i < 156 ? 0x20 : header[i];
    unsigned += b;
    signed += (b << 24) >> 24;
  }
  if (stored !== unsigned && stored !== signed) {
    throw new Error(`readTarGz: ${file} 头部校验和不符（偏移 ${offset}：读到 ${stored}，计算 ${unsigned}）`);
  }
}

/** 头里的条目名：ustar 的 prefix 字段（若有）拼在 name 前。 */
function headerName(header) {
  const name = cstr(header.subarray(0, 100));
  const prefix = cstr(header.subarray(345, 500));
  return prefix ? `${prefix}/${name}` : name;
}

/** 解析 PAX 记录：形如「<总长> <key>=<value>\n」的序列，按字节长度推进。 */
function parsePaxRecords(data, file) {
  const rec = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(data.toString("ascii", i, sp), 10);
    if (!Number.isFinite(len) || len <= 0) throw new Error(`readTarGz: ${file} PAX 记录长度非法（偏移 ${i}）`);
    const recEnd = i + len;
    if (recEnd > data.length) throw new Error(`readTarGz: ${file} PAX 记录越界（偏移 ${i}）`);
    const body = data.toString("utf8", sp + 1, recEnd - 1); // 去掉末尾换行
    const eq = body.indexOf("=");
    if (eq >= 0) rec[body.slice(0, eq)] = body.slice(eq + 1);
    i = recEnd;
  }
  return rec;
}

/** tar 块流 → Map。处理 ustar/PAX/GNU 长名；目录跳过；符号/硬链接留空标记。 */
function parseTar(buf, file) {
  const out = new Map();
  let offset = 0;
  let pendingPax = null; // 下一个条目的 PAX 覆盖（typeflag x）
  let globalPax = {}; // 全局 PAX（typeflag g）
  let pendingLongName = null; // GNU 长名（typeflag L）

  // 完整 tar 至少是一个头块或两个结束零块；更短的内容不可能有效，直接判损坏。
  if (buf.length < TAR_BLOCK) throw new Error(`readTarGz: ${file} 内容太短（${buf.length} 字节），不是有效 tar`);

  while (offset + TAR_BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + TAR_BLOCK);
    if (isZeroBlock(header)) break; // 结束标记
    verifyChecksum(header, offset, file);

    const typeflag = String.fromCharCode(header[156]);
    const size = parseTarNumber(header.subarray(124, 136));
    const dataStart = offset + TAR_BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) {
      throw new Error(`readTarGz: ${file} 条目数据越界（偏移 ${offset}，size=${size}），文件可能损坏`);
    }
    const data = buf.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

    if (typeflag === "x") { pendingPax = parsePaxRecords(data, file); continue; }
    if (typeflag === "g") { globalPax = { ...globalPax, ...parsePaxRecords(data, file) }; continue; }
    if (typeflag === "L") { pendingLongName = cstr(data); continue; }
    if (typeflag === "K") continue; // GNU 长链接目标：链接无内容，忽略

    const pax = { ...globalPax, ...(pendingPax || {}) };
    let name = headerName(header);
    if (pendingLongName != null) name = pendingLongName;
    if (pax.path != null) name = pax.path;
    const isDir = String(name).endsWith("/");

    pendingPax = null;
    pendingLongName = null;

    if (typeflag === "5" || isDir) continue; // 目录：跳过

    const norm = normalizeName(name);
    if (!norm) continue;

    if (typeflag === "0" || header[156] === 0 || typeflag === "7") {
      out.set(norm, Buffer.from(data));
    } else if (typeflag === "1" || typeflag === "2") {
      // 硬链接 / 符号链接：轻量标记（空内容），不跟随、不解析目标
      out.set(norm, Buffer.alloc(0));
    } else {
      throw new Error(`readTarGz: ${file} 条目 "${norm}" 有未知 typeflag ${JSON.stringify(typeflag)}`);
    }
  }
  return out;
}
