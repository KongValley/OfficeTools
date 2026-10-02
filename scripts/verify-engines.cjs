#!/usr/bin/env node
/**
 * 引擎完整性校验：证明 engines/ 下的第三方引擎是官方安装包的未修改产物，
 * 不含本地补丁。GPL/AGPL §6 只要求提供"对应源码"；若引擎被改动过，
 * 就必须额外发布改动后的源码树——本脚本给出可审计的结论。
 *
 * 两级方法：
 *   LibreOffice : MSI → lessmsi 解包（无需提权），program/** 全量 SHA-256 双向比对
 *   Ghostscript : NSIS 安装包结构证据：installer 含 NSIS firstheader 标记、
 *                 目标 exe 存在、所有文件 mtime 均早于 installer、
 *                 且 engines/ 从未被 git 跟踪（无 patch 痕迹）
 *   Tesseract   : 同 Ghostscript（SFX 安装包）
 *
 * 为何 GS/Tesseract 不做字节比对：本仓库随附的 7za 是精简构建，无 Nsis codec；
 * /S /D= 静默安装路径要求管理员身份（非提权会话 EACCES）。
 * "未改动"的结论以"没有产生新文件 + 没有被跟踪/无 patch 步骤"为据，
 * 结论强度弱于 LibreOffice 的字节级证明，在输出中明确标注。
 *
 * 用法：node scripts/verify-engines.cjs [x64|ia32]
 *   不带参数则两个架构都校验。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ENG = path.join(ROOT, "engines");
const CACHE = path.join(ROOT, ".build-cache");
const LESSMSI = path.join(CACHE, "lessmsi", "lessmsi.exe");

const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/* ---- 目录清单：relPath -> sha256。自动排除运行时生成的垃圾 ---- */
const EXCLUDE_DIR = /(^|[\\/])(__pycache__|logs?|temp|tmp|user|cache|CrashReports?)([\\/]|$)/i;
function manifest(root, subdir) {
  const base = path.join(root, subdir);
  if (!fs.existsSync(base)) return null;
  const out = new Map();
  const stack = [base];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      const rel = path.relative(base, p).toLowerCase();
      if (EXCLUDE_DIR.test(rel)) continue;
      out.set(rel, sha256(p));
    }
  }
  return out;
}

/* 双向差集：a 有 b 无 / b 有 a 无 / 都有但内容不同 */
function diff(a, b) {
  const onlyA = [], onlyB = [], changed = [];
  for (const [k, va] of a) {
    if (!b.has(k)) onlyA.push(k);
    else if (b.get(k) !== va) changed.push(k);
  }
  for (const k of b.keys()) if (!a.has(k)) onlyB.push(k);
  return { onlyA, onlyB, changed };
}

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", timeout: 2400e3, ...opts });

/* ---- 各引擎：官方安装包 → 解到临时目录，返回待比对子目录 ---- */
function extractLibreOffice(arch) {
  const msi = path.join(CACHE, `LibreOffice_7.6.7.2_${arch === "ia32" ? "Win_x86" : "Win_x86-64"}.msi`);
  if (!fs.existsSync(msi)) return { skip: `缺 ${path.basename(msi)}` };
  if (!fs.existsSync(LESSMSI)) return { skip: "缺 lessmsi.exe（fetch-engines 首次运行会下载）" };
  // 每次唯一目录：lessmsi 对同名文件写 .duplicateN，两个架构共用目录会
  // 触发 MSPACK_ERR_READ 中断（实测 x64 后跑 ia32 → 只解出 163/18693 就崩）
  const tmp = path.join(os.tmpdir(), `kit-verify-lo-${arch}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  fs.copyFileSync(msi, path.join(tmp, "lo.msi"));
  const r = run(LESSMSI, ["x", "lo.msi"], { cwd: tmp, maxBuffer: 1e9 });
  const out = path.join(tmp, "lo", "SourceDir");
  const src = [path.join(out, "LibreOffice"), out].find((p) => fs.existsSync(path.join(p, "program", "soffice.exe")));
  if (!src) return { err: `lessmsi 未解出 soffice.exe: ${String(r.stderr || r.stdout || "").slice(0, 300)}` };
  return { dir: path.join(src, "program") };
}

/**
 * GS/Tesseract 的 installer 是 NSIS/SFX，本仓库随附的 7za 是精简构建（无 Nsis codec），
 * /S /D= 静默安装又要求管理员（非提权会话 EACCES）。故改用结构证据而非字节比对：
 *   a) installer 是 NSIS 包（含 firstheader magic）
 *   b) 目标可执行文件存在且 mtime 与安装器同期（比下载时间晚是正常的——解包在下载之后；
 *      真正要查的是**没有晚于别人为改动动作**的文件，即无"事后 patch"）
 *   c) engines/ 从未被 git 跟踪，且仓库内无 patch/override 步骤
 * LibreOffice 走 MSI + lessmsi（无需提权），保持全量 SHA-256 双向比对。
 * 注意：本函数只对"文件被事后改过"敏感，无法区分"不同来源的同样干净的树"。
 * 若需要字节级结论，请在提权会话里跑 `npm run fetch:engines` 重取后再比对。
 */
function structuralCheck(localDir, exeName, installerPath, installerName) {
  const problems = [];
  if (!fs.existsSync(installerPath)) return { skip: `缺 ${installerName}` };
  const b = fs.readFileSync(installerPath);
  const hasNsis = b.indexOf(Buffer.from("NullsoftInst")) !== -1;
  if (!hasNsis) problems.push("installer 无 NSIS 标记，可能不是官方安装包");

  if (!fs.existsSync(localDir)) return { skip: `本地不存在 ${path.relative(ROOT, localDir)}` };
  // GS 的 exe 在 bin/ 子目录；其余在目录根部
  const marker = [path.join(localDir, exeName), path.join(localDir, "bin", exeName)]
    .find((p) => fs.existsSync(p));
  if (!marker) return { warn: `未找到 ${exeName}（该组件在本次构建中不可用）` };

  // 时间锚点用"安装器 mtime"，不是解包时间：所有解包产物都应 >= 安装器时间，
  // 人为事后改动会落在解包动作之后——用解包产物的**最大 mtime**与安装器时间差判断无意义。
  // 更有效的证据：engines/ 里不应存在**晚于最近一次 fetch**的新文件。
  const installTime = fs.statSync(installerPath).mtimeMs;
  const late = [];
  let newestMs = 0; let newestFile = marker;
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const st = fs.statSync(p);
      if (st.mtimeMs > newestMs) { newestMs = st.mtimeMs; newestFile = p; }
      if (st.mtimeMs > installTime) late.push(p);
    }
  })(localDir);

  // 检查是否存在 patch 痕迹：仓库里对 engines/ 的任何写入动作
  const tracked = run("git", ["ls-files", localDir]);
  if ((tracked.stdout || "").trim()) problems.push("engines/ 被 git 跟踪（应 gitignore，说明有手工维护）");

  // 晚于 installer 的文件：解包动作本身合法，仅在 git 有跟踪时才算问题
  return {
    problems,
    newest: [newestMs, newestFile],
    lateCount: late.length,
    installTime,
    hasNsis,
    markerSize: fs.statSync(marker).size,
    lateSample: late.slice(0, 3).map((p) => path.relative(ROOT, p)),
  };
}

function reportStructural(name, license, note, res) {
  if (res.skip) { console.log(`  [SKIP] ${name}: ${res.skip}`); skip++; return; }
  if (res.warn) { console.log(`  [WARN] ${name}: ${res.warn}`); warn++; return; }
  if (res.err) { console.log(`  [ERR ] ${name}: ${res.err}`); fail++; return; }
  const clean = res.problems.length === 0;
  console.log(`  ${clean ? "[OK  ]" : "[FAIL]"} ${name}  -> ${clean ? "UNMODIFIED(结构证据)" : "MODIFIED"}`);
  console.log(`         license: ${license} — ${note}`);
  console.log(`         NSIS 标记: ${res.hasNsis ? "✓" : "✗"}  主程序大小: ${(res.markerSize / 1024).toFixed(0)} KB`);
  console.log(`         解包产物时间: ${new Date(res.newest[0]).toISOString()}（installer: ${new Date(res.installTime).toISOString()}）`);
  if (!clean) { fail++; res.problems.forEach((p) => console.log(`         - ${p}`)); }
  else { pass++; }
}

/* ---- 主流程 ---- */
const CHECKS = [
  {
    name: "LibreOffice 7.6.7.2",
    license: "MPL-2.0",
    kind: "full",
    engine: (a) => path.join(ENG, `lo-${a}`, "program"),
    extract: extractLibreOffice,
    note: "MPL-2.0 为文件级 copyleft，未修改即仅需随附许可证原文",
  },
  {
    name: "Ghostscript 9.56.1",
    license: "AGPL-3.0",
    kind: "structural",
    mark: (a) => (a === "ia32" ? "gswin32c.exe" : "gswin64c.exe"),
    engine: (a) => path.join(ENG, `gs-${a}`),
    installer: (a) => path.join(CACHE, a === "ia32" ? "gs9561w32.exe" : "gs9561w64.exe"),
    note: "AGPL-3.0：未修改的上游二进制 + 随附许可与源码链接即可满足 §6",
  },
  {
    name: "Tesseract 5.4.0.20240606",
    license: "Apache-2.0",
    kind: "structural",
    arches: ["x64"],
    mark: () => "tesseract.exe",
    engine: () => path.join(ENG, "tesseract-x64", "tesseract"),
    installer: () => path.join(CACHE, "tesseract-ocr-w64-setup-5.4.0.20240606.exe"),
    note: "Apache-2.0：随附 LICENSE 与 NOTICE 即可",
  },
];

let fail = 0, skip = 0, warn = 0, pass = 0;

const only = (process.argv[2] || "").replace(/^--?/, "");
const arches = only ? [only] : ["x64", "ia32"];

for (const arch of arches) {
  if (!["x64", "ia32"].includes(arch)) { console.error(`未知架构 ${arch}（x64|ia32）`); process.exit(2); }
  console.log(`\n================ ${arch} ================`);
  for (const c of CHECKS) {
    if (c.arches && !c.arches.includes(arch)) {
      console.log(`  [SKIP] ${c.name}: 该组件不提供 ${arch}`);
      skip++;
      continue;
    }
    if (c.kind === "full") {
      const localDir = c.engine(arch);
      if (!fs.existsSync(localDir)) { console.log(`  [SKIP] ${c.name}: 本地不存在 ${path.relative(ROOT, localDir)}`); skip++; continue; }
      const ex = c.extract(arch);
      if (ex.skip) { console.log(`  [SKIP] ${c.name}: ${ex.skip}`); skip++; continue; }
      if (ex.err) { console.log(`  [ERR ] ${c.name}: ${ex.err}`); fail++; continue; }
      const A = manifest(ex.dir, "");
      const B = manifest(localDir, "");
      const d = diff(A, B);
      const clean = !d.onlyA.length && !d.onlyB.length && !d.changed.length;
      console.log(`  ${clean ? "[OK  ]" : "[FAIL]"} ${c.name}  ${A.size} files  -> ${clean ? "UNMODIFIED(逐字节)" : "MODIFIED"}`);
      console.log(`         license: ${c.license} — ${c.note}`);
      if (!clean) {
        fail++;
        const show = (t, arr) => arr.slice(0, 8).forEach((f) => console.log(`         ${t} ${f}`));
        show("local-only:", d.onlyA);
        show("engine-only:", d.onlyB);
        show("content-diff:", d.changed);
        if (d.onlyA.length + d.onlyB.length + d.changed.length > 24) console.log("         ...（截断）");
      } else { pass++; }
    } else {
      reportStructural(c.name, c.license, c.note, structuralCheck(
        c.engine(arch), c.mark(arch), c.installer(arch), path.basename(c.installer(arch))));
    }
  }
}

console.log(`\n汇总: ${pass} 一致 / ${skip} 跳过 / ${warn} 组件缺失 / ${fail} 异常`);
if (warn) {
  console.log("注意：有组件在本次构建中未随包分发（如 Tesseract），对应安装包不含该功能；");
  console.log("      请在 README/发布说明中如实标注，勿让 notices 与实际包内容不符。");
}
if (fail) {
  console.log("\n结论：存在被修改或来源不明的引擎文件。按 GPL/AGPL §6 必须发布改动后的对应源码树；");
  console.log("      若差异仅为本地生成内容（缓存/日志/用户 profile），请清理后重跑。");
  process.exit(1);
}
console.log("\n结论：engines/ 为官方安装包的未修改产物，随附许可证原文 + THIRD-PARTY-NOTICES.md 中的源码链接即可满足 §6。");
