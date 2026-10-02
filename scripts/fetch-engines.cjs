#!/usr/bin/env node
/**
 * 获取全部外部引擎 → engines/（构建机联网，一次执行）。
 * 产物：
 *   engines/lo-ia32 | lo-x64          LibreOffice 7.6.7.2（msiexec /a 解包）
 *   engines/gs-ia32 | gs-x64          Ghostscript 9.56.1
 *   engines/tesseract-ia32 | x64/     tesseract.exe + tessdata/
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ENG = path.join(ROOT, "engines");
const CACHE = path.join(ROOT, ".build-cache");
const mk = (p) => fs.mkdirSync(p, { recursive: true });
/**
 * 执行安装器/命令。受限 shell 下 spawn 直接跑 exe 可能 EACCES，
 * 且 PowerShell Start-Process 对含中文的 FilePath 会 InvalidOperation。
 * 统一方案：复制到 ASCII 临时路径后用 Start-Process 中转执行。
 */
const ex = (cmd, args, opts = {}) => {
  // PATH 中的命令（如 msiexec）直接执行；本地 exe 复制到 ASCII 路径再跑（规避 EACCES）
  const isPathCmd = !cmd.includes("/") && !cmd.includes("\\");
  const target = isPathCmd ? cmd : (() => {
    const tmpDir = path.join(os.tmpdir(), "kit-exe");
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mk(tmpDir);
    const localExe = path.join(tmpDir, path.basename(cmd));
    fs.copyFileSync(cmd, localExe);
    return localExe;
  })();
  const r = isPathCmd
    ? spawnSync("powershell", ["-NoProfile", "-Command",
        `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','"${cmd}"',${toPsArgs(args)} -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`],
        { stdio: "inherit", ...opts })
    : spawnSync("powershell", ["-NoProfile", "-Command",
        `$p = Start-Process -FilePath '${target}' -ArgumentList ${toPsArgs(args)} -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`],
        { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`命令失败: ${cmd} ${args.join(" ")} (exit ${r.status})`);
  return r;
};
function toPsArgs(args) {
  return args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(",");
}

/** 下载（断点续传 + 指数退避重试）。CI 大文件网络抖动必备。 */
async function download(url, dest, opts = {}) {
  const RETRIES = opts.retries != null ? opts.retries : 5;
  mk(path.dirname(dest));
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try { await downloadOnce(url, dest); return; }
    catch (e) {
      if (attempt === RETRIES) throw e;
      const wait = Math.min(30000, 2000 * Math.pow(2, attempt - 1));
      console.log(`  下载失败(${e.message.slice(0, 80)})，${wait / 1000}s 后重试(${attempt + 1}/${RETRIES})…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

function downloadOnce(url, dest) {
  return new Promise((resolve, reject) => {
    const start = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    const headers = { "user-agent": "node" };
    if (start > 0) headers["range"] = `bytes=${start}-`;
    const get = (u) => https.get(u, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); return get(res.headers.location);
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume(); return reject(new Error(`${u} -> HTTP ${res.statusCode}`));
      }
      const f = fs.createWriteStream(dest, { flags: (start > 0 && res.statusCode === 206) ? "a" : "w" });
      res.pipe(f);
      f.on("finish", () => f.close(resolve));
      f.on("error", reject);
    }).on("error", (e) => {
      try { fs.unlinkSync(dest); } catch (_) {/*noop*/}
      reject(e);
    });
    get(url);
  });
}

function extractExe(exe, outDir) {
  // 尝试 NSIS 7z 解包 UB-Mannheim tesseract；失败则尝试 Inno Setup 解包
  mk(outDir);
  try {
    ex("7z", ["x", "-y", `-o${outDir}`, exe]);
  } catch (_) {
    try {
      ex("innounp", ["-x", "-d", outDir, exe]);
    } catch (e) {
      throw new Error(`无法解包 ${path.basename(exe)}：请安装 7-Zip（需在 PATH）或 innounp`);
    }
  }
}

/**
 * 用户态解包 MSI/Installer。
 * 优先 lessmsi（无管理员权限，可处理中文路径）；未提供时退回 msiexec /a。
 * 注意：msiexec /a 需要管理员权限且对非 ASCII 路径有缺陷（错误1324）。
 */
let _lessmsi = null;
function lessmsiExe() {
  if (_lessmsi !== null) return _lessmsi;
  const cands = [
    path.join(CACHE, "lessmsi", "lessmsi.exe"),
    path.join(ROOT, ".build-cache", "lessmsi", "lessmsi.exe"),
  ];
  _lessmsi = cands.find((c) => fs.existsSync(c)) || null;
  return _lessmsi;
}

/** 下载 lessmsi（用户态 MSI 解包器，免管理员） */
async function ensureLessmsi() {
  if (lessmsiExe()) return;
  console.log("\n=== lessmsi（MSI 解包工具）===");
  const zip = path.join(CACHE, "lessmsi.zip");
  if (!fs.existsSync(zip) || fs.statSync(zip).size < 1e5) {
    await download("https://github.com/activescott/lessmsi/releases/download/v2.12.9/lessmsi-v2.12.9.zip", zip);
  }
  const dest = path.join(CACHE, "lessmsi");
  rmrf(dest);
  ex("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`], { timeout: 120e3 });
  if (!lessmsiExe()) throw new Error("lessmsi 解压失败");
}

function adminExtract(installer, targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  const lm = lessmsiExe();
  if (lm) {
    // lessmsi 处理中文路径有缺陷：ASCII 临时目录解包，成功后搬回目标
    const tmpBase = path.join(os.tmpdir(), "kit-extract");
    fs.rmSync(tmpBase, { recursive: true, force: true });
    mk(tmpBase);
    const local = path.join(tmpBase, path.basename(installer));
    fs.copyFileSync(installer, local);
    const out = path.join(tmpBase, "out");
    ex(lm, ["xfo", local, out], { timeout: 1800e3 });
    mk(targetDir);
    fs.renameSync(out, targetDir);
    return;
  }
  // 退回 msiexec /a（需管理员，且源路径不能含中文）
  console.log("  未找到 lessmsi，退回 msiexec /a（需要管理员权限）");
  const tmpBase = path.join(os.tmpdir(), "kit-extract");
  fs.rmSync(tmpBase, { recursive: true, force: true });
  mk(tmpBase);
  const local = path.join(tmpBase, path.basename(installer));
  fs.copyFileSync(installer, local);
  const out = path.join(tmpBase, "target");
  mk(out);
  ex("msiexec", ["/a", local, "/qn", `TARGETDIR=${out}`], { timeout: 900e3 });
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.renameSync(out, targetDir);
}

/** LibreOffice 目录里的真实版本（version.ini: MsiProductVersion） */
function loVersion(dir) {
  try {
    const t = fs.readFileSync(path.join(dir, "program", "version.ini"), "utf8");
    return (t.match(/MsiProductVersion=(.*)/) || [])[1]?.trim() || null;
  } catch (_) { return null; }
}

/** 目录存在且版本匹配才跳过，避免旧版本伪装成目标版本 */
function versionOk(dir, want) {
  if (!fs.existsSync(path.join(dir, "program", "soffice.exe"))) return false;
  const v = loVersion(dir);
  if (v !== want) {
    console.log(`  发现 ${v}（需要 ${want}），将重新获取`);
  }
  return v === want;
}

const libreOffice = async (arch, url) => {
  const dir = path.join(ENG, `lo-${arch}`);
  console.log(`\n=== LibreOffice 7.6.7.2 ${arch} ===`);
  // 不能只看 soffice.exe 存在：历史上 lo-ia32 目录残留的是 7.3.7.2（旧 MSI 解包），
  // 版本不符时必须重取，否则 notices 声称 7.6.7.2 实际跑 7.3.7.2 是虚假陈述。
  if (versionOk(dir, "7.6.7.2")) {
    console.log("  已存在 7.6.7.2，跳过"); return;
  }
  const msi = path.join(CACHE, `LibreOffice_7.6.7.2_${arch === "ia32" ? "Win_x86" : "Win_x86-64"}.msi`);
  if (!fs.existsSync(msi) || fs.statSync(msi).size < 1e8) {
    console.log("  下载 MSI ...");
    await download(url, msi);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  if (!autoExtractMsi(msi, dir)) {
    console.log(`  自动解包失败。请以管理员身份安装一次 ${path.basename(msi)}，`);
    console.log(`  或把已装好的 LibreOffice 目录（含 program\\soffice.exe）复制到：`);
    console.log(`    ${dir}`);
    console.log(`  完成后重跑 npm run fetch:engines（已下载的 MSI 会复用）。`);
  } else {
    console.log(`  完成 ${dir}`);
  }
};

function rmrf(p) {
  for (let i = 0; i < 3; i++) {
    try { fs.rmSync(p, { recursive: true, force: true }); return; }
    catch (e) { if (i === 2) console.log(`  警告: 清理 ${p} 失败（${e.code}），可稍后手工删除`); }
  }
}

/** 依次尝试 lessmsi 与 msiexec /a；任一产出 soffice.exe 即 true。 */
function autoExtractMsi(msi, dir) {
  // 1) lessmsi：用户态，无需管理员。2.12.9 行为：cd 到 ASCII temp 后跑 `lessmsi x lo.msi`（无第二参），
  //    输出固定为 <cwd>/<msi名去扩展名>/SourceDir/...
  const lm = lessmsiExe();
  if (lm) {
    const tmp = path.join(os.tmpdir(), "kit-lomsi");
    rmrf(tmp);
    mk(tmp);
    const local = path.join(tmp, "lo.msi");
    fs.copyFileSync(msi, local);
    try {
      const r = spawnSync(lm, ["x", "lo.msi"], { cwd: tmp, encoding: "utf8", timeout: 2400e3 });
      const out = path.join(tmp, "lo", "SourceDir");
      const src = [path.join(out, "LibreOffice"), out].find((p) => fs.existsSync(path.join(p, "program", "soffice.exe")));
      if (src) {
        fs.mkdirSync(dir, { recursive: true });
        fs.cpSync(src, dir, { recursive: true });
        console.log("  lessmsi 解包完成");
        return true;
      }
      console.log("  lessmsi 未产出 soffice.exe:" + String(r.stdout || r.stderr || "").slice(-200));
    } finally {
      rmrf(tmp);
    }
  }
  // 2) msiexec /a（需管理员；非管理员会失败并留下部分文件）
  try {
    const tmpBase = path.join(os.tmpdir(), "kit-msi");
    fs.rmSync(tmpBase, { recursive: true, force: true });
    mk(tmpBase);
    const local = path.join(tmpBase, path.basename(msi));
    fs.copyFileSync(msi, local);
    const out = path.join(tmpBase, "target");
    mk(out);
    ex("msiexec", ["/a", local, "/qn", `TARGETDIR=${out}`], { timeout: 900e3 });
    if (fs.existsSync(path.join(out, "program", "soffice.exe")) ||
        fs.existsSync(path.join(out, "LibreOffice", "program", "soffice.exe"))) {
      const src = fs.existsSync(path.join(out, "LibreOffice")) ? path.join(out, "LibreOffice") : out;
      fs.mkdirSync(dir, { recursive: true });
      fs.cpSync(src, dir, { recursive: true });
      console.log("  msiexec 解包完成");
      return true;
    }
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch (e) {
    console.log("  msiexec /a 失败：" + e.message.slice(0, 140));
  }
  return false;
}

const ghostscript = async (arch, url) => {
  const dir = path.join(ENG, `gs-${arch}`);
  console.log(`\n=== Ghostscript 9.56.1 ${arch} ===`);
  const exeName = arch === "ia32" ? "gswin32c.exe" : "gswin64c.exe";
  const installer = path.join(CACHE, path.basename(url));
  // 已解包则跳过
  if (findGs(dir, exeName)) { console.log("  已存在，跳过"); return; }
  if (!fs.existsSync(installer)) {
    console.log("  下载 installer ...");
    await download(url, installer);
  }
  // NSIS 静默安装到 ASCII 临时目录（不写系统目录，免管理员）
  const tmp = path.join(os.tmpdir(), "kit-gs");
  fs.rmSync(tmp, { recursive: true, force: true });
  mk(tmp);
  // NSIS: /S 静默；/D= 指定目录（必须放最后，且不能引号包裹）
  ex(installer, ["/S", `/D=${tmp}`], { timeout: 600e3 });
  if (!findGs(tmp, exeName)) throw new Error(`gs 静默安装异常: 未找到 ${exeName}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(tmp, dir, { recursive: true }); // 跨卷 rename 会 EXDEV，用 copy
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`  完成 -> ${findGs(dir, exeName)}`);
};

function findGs(root, exeName) {
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase() === exeName) return p;
    }
  }
  return null;
}

const tesseract = async (arch, api, tag) => {
  const dir = path.join(ENG, `tesseract-${arch}`);
  const target = path.join(dir, "tesseract");
  console.log(`\n=== Tesseract ${tag} ${arch} ===`);
  if (fs.existsSync(path.join(target, "tesseract.exe"))) { console.log("  已存在，跳过"); return; }
  const bit = arch === "ia32" ? "w32" : "w64";
  const assetName = `tesseract-ocr-${bit}-setup-${tag}.exe`;
  const url = api.replace(/\/tags\/.*$/, "") + "/releases/download/" + tag + "/" + assetName;
  const f = path.join(CACHE, assetName);
  if (!fs.existsSync(f) || fs.statSync(f).size < 5e6) {
    console.log(`  下载 ${assetName} ...`);
    await download(url, f);
  }
  // 安装器是带壳 SFX：脚本内无法可靠静默提取（Start-Process 对 /S /D= 转发不稳）。
  // 方案：7za 试解；失败则保留安装包缓存并输出手动提取指引，不阻塞其余引擎。
  const tmp = path.join(os.tmpdir(), "kit-tess");
  fs.rmSync(tmp, { recursive: true, force: true });
  mk(tmp);
  let ok = false;
  try {
    const sz = path.join(ROOT, "node_modules", "7zip-bin", "win", process.arch === "ia32" ? "x86" : "x64", "7za.exe");
    if (fs.existsSync(sz)) {
      spawnSync(sz, ["x", f, `-o${tmp}`, "-y"], { stdio: "pipe", timeout: 600e3 });
      ok = fs.readdirSync(tmp).some((e) => e.toLowerCase().endsWith(".exe"));
    }
  } catch (_) {/*noop*/}
  if (!ok) {
    console.log(`  自动提取失败。请手动执行一次 ${path.basename(f)} 安装到任意目录，`);
    console.log(`  然后把其中的 tesseract.exe、*.dll 与 tessdata 子目录整体复制到：`);
    console.log(`    ${target}`);
    console.log(`  完成后重跑 npm run fetch:engines 即可。`);
    fs.rmSync(tmp, { recursive: true, force: true });
    return false;
  }
  fs.rmSync(target, { recursive: true, force: true });
  mk(target);
  fs.cpSync(tmp, target, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!fs.existsSync(path.join(target, "tesseract.exe"))) throw new Error("tesseract.exe 未解出");
  console.log(`  完成 ${target}`);
  return true;
};

const tessdata = async (dir) => {
  const tess = path.join(dir, "tesseract", "tessdata");
  mk(tess);
  for (const l of ["chi_sim", "eng"]) {
    const f = path.join(tess, `${l}.traineddata`);
    if (fs.existsSync(f) && fs.statSync(f).size > 1e6) continue;
    console.log(`  下载 ${l}.traineddata ...`);
    await download(`https://github.com/tesseract-ocr/tessdata_fast/raw/4.0.0/${l}.traineddata`, f);
  }
};

(async () => {
  mk(ENG); mk(CACHE);
  await ensureLessmsi();
  // bash 的 MSYS 会破坏 --xxx 形式的命令行参数，统一从环境变量取
  const only = (process.env.KIT_ONLY || process.argv[2] || "").replace(/^--?/, "");
  if (!only || only === "gs") {
    await ghostscript("ia32", "https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs9561/gs9561w32.exe");
    await ghostscript("x64", "https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs9561/gs9561w64.exe");
  }
  if (!only || only === "tess") {
    // 32 位：UB-Mannheim 自 5.x 起不再提供 w32 安装包，OCR 在 x86 包中不可用。
    await tesseract("x64", "https://github.com/UB-Mannheim/tesseract/releases?per_page=100", "5.4.0.20240606");
    await tessdata(path.join(ENG, "tesseract-x64"));
  }
  if (!only || only === "lo") {
    await libreOffice("ia32", "https://downloadarchive.documentfoundation.org/libreoffice/old/7.6.7.2/win/x86/LibreOffice_7.6.7.2_Win_x86.msi");
    await libreOffice("x64", "https://downloadarchive.documentfoundation.org/libreoffice/old/7.6.7.2/win/x86_64/LibreOffice_7.6.7.2_Win_x86-64.msi");
  }
  if (only) { console.log(`\n[${only}] 完成`); return; }

  // 断言（gs 目录层级不定，向下找）
  const need = [
    ["lo-ia32", "program/soffice.exe"], ["lo-x64", "program/soffice.exe"],
  ];
  const missing = need.filter(([d, f]) => !fs.existsSync(path.join(ENG, d, f)));
  for (const [d, exe] of [["gs-ia32", "gswin32c.exe"], ["gs-x64", "gswin64c.exe"]]) {
    if (!findGs(path.join(ENG, d), exe)) missing.push(d + "/" + exe);
  }
  // OCR 为可选组件：x86 包无 w32 二进制、x64 包需维护人员预置（安装器无法静默）
  for (const d of ["tesseract-ia32", "tesseract-x64"]) {
    const t = path.join(ENG, d, "tesseract", "tesseract.exe");
    console.log(fs.existsSync(t) ? `  ${d}: OCR 就绪` : `  ${d}: OCR 未安装（可选，x86 包不可用）`);
  }
  if (missing.length) {
    console.error("引擎不完整：\n" + missing.map((m) => "  " + m).join("\n"));
    process.exit(1);
  }
  console.log("\n核心引擎就绪:", ENG);
})().catch((e) => { console.error("\n获取引擎失败:", e.message); process.exit(1); });
