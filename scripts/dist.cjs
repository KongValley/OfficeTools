#!/usr/bin/env node
/**
 * 打包入口：node scripts/dist.mjs <ia32|x64>
 * 1. 校验 staging/sidecar-<arch> 与 engines 齐全
 * 2. 生成临时 electron-builder 配置（追加 extraResources，指向对应架构目录）
 * 3. electron-builder --win nsis --ia32 | --x64
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ARCH = process.argv[2];
if (ARCH !== "ia32" && ARCH !== "x64") {
  console.error("用法: node scripts/dist.mjs <ia32|x64>");
  process.exit(1);
}
const SUFFIX = ARCH === "ia32" ? "-ia32" : "-x64";
const mk = (p) => fs.mkdirSync(p, { recursive: true });

/* 关键：把改过的 sidecar/worker.py 同步进 staging 两侧，防止"改了源码忘同步"导致打包出旧代码 */
for (const a of ["ia32", "x64"]) {
  const dst = path.join(ROOT, "staging", `sidecar-${a}`, "worker.py");
  if (fs.existsSync(path.dirname(dst))) {
    fs.copyFileSync(path.join(ROOT, "sidecar", "worker.py"), dst);
    console.log(`已同步 worker.py → staging/sidecar-${a}`);
  }
}

/* 前置检查（OCR 为可选：x86 包无 w32 二进制，x64 包需维护人员预置） */
const need = [
  ["staging", `sidecar${SUFFIX}`, "python.exe"],
  ["staging", `sidecar${SUFFIX}`, "worker.py"],
  ["engines", `lo${SUFFIX}`, "program", "soffice.exe"],
];
const gsDir = path.join(ROOT, "engines", `gs${SUFFIX}`);
const gsExe = ARCH === "ia32" ? "gswin32c.exe" : "gswin64c.exe";
const tessDir = path.join(ROOT, "engines", `tesseract${SUFFIX}`);
const hasTesseract = fs.existsSync(path.join(tessDir, "tesseract", "tesseract.exe"));

const missing = need.filter((rel) => !fs.existsSync(path.join(ROOT, ...rel)));
if (missing.length) { console.error("缺少 sidecar/引擎产物：\n" + missing.map((m) => "  " + m.join("/")).join("\n") + "\n请先运行 npm run build:sidecar 和 npm run fetch:engines"); process.exit(1); }
if (!hasTesseract) console.log(`提示：${ARCH} 包不含 OCR 引擎（tesseract），打包时跳过该目录`);
// gs 目录层级不定，向下找
let gsPath = null;
const stack = [gsDir];
while (stack.length && !gsPath) {
  const d = stack.pop();
  let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
  for (const e of ents) e.isDirectory() ? stack.push(path.join(d, e.name)) : (e.name === gsExe && (gsPath = path.join(d, e.name)));
}
if (!gsPath) { console.error(`缺少 Ghostscript 引擎: ${gsDir}`); process.exit(1); }

/* 生成完整 JSON 配置：数组型 extraResources + 单架构 target */
const base = {
  appId: "com.intranet.officekit",
  productName: "办公助手",
  copyright: "内部使用",
  directories: { output: "dist", buildResources: path.join(ROOT, "build") },
  artifactName: "办公助手-Setup-${arch}.${ext}",
  compression: "normal",
  asar: true,
  files: ["electron/**", "renderer/**", "package.json"],
  extraResources: [
    { from: `staging/sidecar${SUFFIX}`, to: "sidecar" },
    { from: `engines/lo${SUFFIX}`, to: "lo" },
    { from: `engines/gs${SUFFIX}`, to: "gs" },
    ...(hasTesseract ? [{ from: `engines/tesseract${SUFFIX}`, to: "tesseract" }] : []),
  ],
  forceCodeSigning: false,
  win: {
    target: [{ target: "nsis", arch: [ARCH] }],
    icon: path.join(ROOT, "build", "icon.ico"),
    signAndEditExecutable: false,
    signingHashAlgorithms: null,
    timeStampServer: "",
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    language: "2052",
    installerLanguages: ["zh_CN", "en_US"],
  },
};
const cfgPath = path.join(ROOT, ".electron-builder.dist.json");
fs.writeFileSync(cfgPath, JSON.stringify(base, null, 2));

/* 启动 electron-builder：-c 指向刚生成的 JSON。直接调 node 执行 bin，避开 npx 在 MSYS 下的退出码丢失 */
const flag = ARCH === "ia32" ? "--ia32" : "--x64";
const builderBin = path.join(ROOT, "node_modules", "electron-builder", "out", "cli", "cli.js");
const r = spawnSync(process.execPath, [builderBin, "--win", "nsis", flag, "--config", cfgPath,
  "--publish", "never"], {
  cwd: ROOT, stdio: "inherit",
  env: {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",   // 跳过代码签名（内网产物不需要签名）
    ELECTRON_BUILDER_CACHE: path.join(os.tmpdir(), "kit-ebcache"),
    // 双重保险：防止 CI 环境下 electron-builder 自动推断发布目标而去找 GH_TOKEN
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
  },
});
fs.rmSync(cfgPath, { force: true });
if (r.error) { console.error("执行失败:", r.error.message); process.exit(1); }
if (r.status !== 0) { console.error("electron-builder exit:", r.status); process.exit(r.status); }

const want = path.join(ROOT, "dist", `办公助手-Setup-${ARCH === "ia32" ? "ia32" : "x64"}.exe`);
if (!fs.existsSync(want)) {
  const dirFiles = fs.existsSync(path.join(ROOT, "dist")) ? fs.readdirSync(path.join(ROOT, "dist")) : [];
  console.error(`未找到产物 ${want}\ndist 目录:`, dirFiles);
  process.exit(1);
}
const mb = (fs.statSync(want).size / 1048576).toFixed(0);
console.log(`\n打包完成: ${want} (${mb} MB)`);
