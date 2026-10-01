#!/usr/bin/env node
/**
 * 构建双架构 Python 侧车：staging/sidecar-ia32 与 staging/sidecar-x64
 * 依赖：构建机联网，一次执行。
 * 步骤（计划步骤 2）：
 *  1. 下载 python 3.8.10 embeddable zip（win32 / amd64）
 *  2. 解压到 staging/sidecar-<arch>/，改写 python38._pth（启用 import site + worker 目录）
 *  3. 引导 pip（get-pip.py）
 *  4. pip install requirements（--only-binary，embedded Python 自带架构解析）
 *  5. 复制 sidecar/worker.py 与启动脚本 entry.pyw
 *  6. 捆绑 VC++ 运行时 DLL（ia32 从 SysWOW64 取，x64 从 System32 取）
 *  7. 每架构执行 python.exe entry.pyw --check 验证依赖
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const STAGING = path.join(ROOT, "staging");
const CACHE = path.join(ROOT, ".build-cache");
const PY = "3.8.10";
const VC_DLLS = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];

const mk = (p) => fs.mkdirSync(p, { recursive: true });
const ex = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`命令失败: ${cmd} ${args.join(" ")} (exit ${r.status})`);
  return r;
};

function download(url, dest) {
  mk(path.dirname(dest));
  return new Promise((resolve, reject) => {
    const get = (u) => https.get(u, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return get(res.headers.location);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${url} -> HTTP ${res.statusCode}`));
      }
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on("finish", () => f.close(resolve));
    }).on("error", reject);
    get(url);
  });
}

async function fetchZip(archTag) {
  const dest = path.join(CACHE, `python-${PY}-embed-${archTag}.zip`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 5e6) return dest;
  console.log(`  下载 python-${PY}-embed-${archTag}.zip ...`);
  await download(`https://www.python.org/ftp/python/${PY}/python-${PY}-embed-${archTag}.zip`, dest);
  return dest;
}

function unzip(zip, dest) {
  mk(dest);
  const ps = spawnSync("powershell", ["-NoProfile", "-Command",
    `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`], { stdio: "inherit" });
  if (ps.status !== 0) throw new Error(`解压失败: ${zip}`);
}

function patchPth(dir) {
  const pth = path.join(dir, "python38._pth");
  if (!fs.existsSync(pth)) throw new Error(`${pth} 不存在`);
  let t = fs.readFileSync(pth, "utf8");
  t = t.replace(/^#\s*import site.*$/m, "import site");
  if (!t.includes("Lib\\site-packages")) t += "\nLib\\site-packages\n";
  t = t.replace(/^site-packages$/m, "Lib\\site-packages"); // 兜底：去掉错误的顶层条目
  fs.writeFileSync(pth, t);
}

function vcDlls(targetDir, arch) {
  const srcDir = arch === "ia32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "SysWOW64")
    : path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  const required = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];
  const copied = [];
  // 1) 本机已有优先
  for (const dll of required) {
    const s = path.join(srcDir, dll);
    if (fs.existsSync(s)) {
      fs.copyFileSync(s, path.join(targetDir, dll));
      copied.push(dll);
    }
  }
  // 2) 可能还缺的（典型：x86 机的 vcruntime140_1）→ redist兜底，拿不到仅告警
  const missing = required.filter((d) => !copied.includes(d));
  if (!missing.length) return Promise.resolve();
  console.log(`  本机 ${srcDir} 缺 ${missing.join(", ")}，尝试官方 VC++ redist`);
  const url = arch === "ia32" ? "https://aka.ms/vs/17/release/vc_redist.x86.exe" : "https://aka.ms/vs/17/release/vc_redist.x64.exe";
  const cab = path.join(CACHE, arch === "ia32" ? "vc_redist.x86.exe" : "vc_redist.x64.exe");
  const ready = (!fs.existsSync(cab) || fs.statSync(cab).size < 10e6) ? download(url, cab) : Promise.resolve();
  return ready.then(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vcredist-"));
    try {
      ex(cab, ["/layout", tmp, "/q", "/norestart"], { timeout: 300e3 });
      const find = (dll) => {
        const stack = [tmp];
        while (stack.length) {
          const d = stack.pop();
          let ents;
          try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
          for (const e of ents) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) stack.push(p);
            else if (e.name.toLowerCase() === dll) return p;
          }
        }
        return null;
      };
      for (const dll of missing) {
        const src = find(dll);
        if (!src) {
          console.warn(`  警告: 未能捆绑 ${dll}。目标机若报缺少该 DLL，装一次 VC++ 2015-2022 Redistributable(${arch}) 即可。`);
          continue;
        }
        fs.copyFileSync(src, path.join(targetDir, dll));
        copied.push(dll);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}

function runPython(exe, args, cwd) {
  const env = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
  const r = spawnSync(exe, args, { cwd, stdio: "inherit", env, timeout: 1800e3 });
  if (r.status !== 0) throw new Error(`命令失败: ${exe} ${args.join(" ")} (exit ${r.status})`);
}

const buildArch = async (arch, zipTag) => {
  const dir = path.join(STAGING, `sidecar-${arch}`);
  console.log(`\n=== 构建 sidecar-${arch} ===`);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  mk(dir);
  unzip(await fetchZip(zipTag), dir);

  // 3. 引导 pip（embedded 无 get-pip 时用本机 python 引导不可行，用官方 get-pip.py）
  patchPth(dir);
  const pyExe = path.join(dir, "python.exe");
  const getpip = path.join(CACHE, "get-pip-3.8.py");
  if (!fs.existsSync(getpip)) {
    console.log("  下载 get-pip.py (3.8 专用) ...");
    await download("https://bootstrap.pypa.io/pip/3.8/get-pip.py", getpip);
  }
  runPython(pyExe, [getpip, "--no-warn-script-location", "--disable-pip-version-check"], dir);

  // 4. 安装 requirements
  const reqs = ["PyMuPDF==1.23.7", "pdf2docx==0.5.8", "opencv-python-headless==4.8.1.78",
    "python-docx==1.1.2", "fonttools==4.47.2", "numpy==1.24.4", "fire==0.7.1"];
  const tmpReq = path.join(dir, "_reqs.txt");
  let pkgs = reqs;
  try {
    fs.writeFileSync(tmpReq, reqs.join("\n"));
    runPython(pyExe, ["-m", "pip", "install", "--no-cache-dir", "--no-warn-script-location",
      "--only-binary=:all:", "-r", tmpReq], dir);
  } catch (e) {
    console.log("  numpy 1.24.4 不可用，降级 1.23.5 重试");
    pkgs = reqs.map((r) => (r.startsWith("numpy") ? "numpy==1.23.5" : r));
    fs.writeFileSync(tmpReq, pkgs.join("\n"));
    runPython(pyExe, ["-m", "pip", "install", "--no-cache-dir", "--no-warn-script-location",
      "--only-binary=:all:", "-r", tmpReq], dir);
  }
  fs.rmSync(tmpReq, { force: true });

  // 5. 入口：entry.pyw 常驻；copy worker.py
  fs.copyFileSync(path.join(ROOT, "sidecar", "worker.py"), path.join(dir, "worker.py"));
  fs.writeFileSync(path.join(dir, "entry.pyw"),
    "import runpy, sys\nsys.argv[0] = 'worker.py'\nrunpy.run_path('worker.py', run_name='__main__')\n");

  // 6. VC++ DLL
  await vcDlls(dir, arch);

  // 清理 pip 缓存目录，控制体积
  for (const junk of ["__pycache__"]) fs.rmSync(path.join(dir, junk), { recursive: true, force: true });

  // 7. 依赖快检
  runPython(pyExe, [path.join(dir, "entry.pyw"), "--check"], dir);
  console.log(`  sidecar-${arch} 构建完成`);
};

(async () => {
  mk(STAGING); mk(CACHE);
  await buildArch("ia32", "win32");
  await buildArch("x64", "amd64");
  console.log("\n双架构侧车构建完成");
})().catch((e) => { console.error("\n构建失败:", e.message); process.exit(1); });
