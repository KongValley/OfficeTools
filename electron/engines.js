/**
 * 引擎封装：LibreOffice（soffice） / Python 侧车 / Ghostscript / Tesseract。
 * 路径解析：开发态取仓库根 engines/ staging/；打包后取 process.resourcesPath/。
 * 架构选择：process.arch === 'ia32' → -ia32 目录，否则 -x64。
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ARCH = process.arch === "ia32" ? "ia32" : "x64";
// 装机态判定：app.asar 内的 __dirname 已含 app.asar（打包后主进程 require 都从这里解析）。
// electron 22 下 process.defaultApp 在部分时序不为 false，故以 asar 路径特征为准，环境变量显式覆盖。
const SUFFIX = ARCH === "ia32" ? "-ia32" : "-x64";
const PACKAGED = process.env.ELECTRON_KIT_PACKAGED === "1"
  || __dirname.includes("app.asar");

// 无 GPU + 老机器：引擎进程不让 OpenMP/线程库按“全部核心”铺开（核心多的编译机会带进 64 线程调度），
// 统一限到 2（内网机的典型可用核心），既降抖动也避免内存翻倍。可用环境变量覆盖。
const CPU_LIMIT = process.env.OFFICEKIT_CPUS || "2";
const ENGINE_ENV = {
  ...process.env,
  OMP_NUM_THREADS: CPU_LIMIT,
  OPENBLAS_NUM_THREADS: CPU_LIMIT,
  MKL_NUM_THREADS: CPU_LIMIT,
  NUMEXPR_NUM_THREADS: CPU_LIMIT,
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
};

function findIn(root, rel) {
  // gs 解包目录层级不定：向下找第一个匹配文件
  const direct = path.join(root, rel);
  if (fs.existsSync(direct)) return direct;
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  const target = path.basename(rel).toLowerCase();
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase() === target) return p;
    }
  }
  return null;
}

const Engines = {
  /** 引擎根目录 */
  base(kind) {
    const dev = path.join(__dirname, "..");
    const roots = PACKAGED
      ? { lo: path.join(process.resourcesPath, "lo"),
          gs: path.join(process.resourcesPath, "gs"),
          tesseract: path.join(process.resourcesPath, "tesseract"),
          sidecar: path.join(process.resourcesPath, "sidecar") }
      : { lo: path.join(dev, "engines", "lo" + SUFFIX),
          gs: path.join(dev, "engines", "gs" + SUFFIX),
          tesseract: path.join(dev, "engines", "tesseract" + SUFFIX),
          sidecar: path.join(dev, "staging", "sidecar" + SUFFIX) };
    return roots[kind];
  },

  soffice() {
    const root = this.base("lo");
    const exe = findIn(root, path.join("program", "soffice.exe"));
    if (!exe) throw new Error(`找不到 LibreOffice 引擎（${root}）。请先运行 npm run fetch:engines`);
    return exe;
  },
  gs() {
    const root = this.base("gs");
    const name = ARCH === "ia32" ? "gswin32c.exe" : "gswin64c.exe";
    const exe = findIn(root, name);
    if (!exe) throw new Error(`找不到 Ghostscript 引擎（${root}）。请先运行 npm run fetch:engines`);
    return exe;
  },
  tesseract() {
    const root = this.base("tesseract");
    const exe = path.join(root, "tesseract", "tesseract.exe");
    if (!fs.existsSync(exe)) throw new Error("OCR 引擎未安装（仅 64 位版本提供）。请使用 64 位安装包，或联系维护人员放置 OCR 引擎");
    return exe;
  },
  tessdataDir() {
    return path.join(path.dirname(this.tesseract()), "tessdata");
  },

  /** 常驻 Python 侧车（懒启动 + 空闲 120s 退出） */
  _proc: null, _buf: "", _nextId: 1, _waiting: new Map(), _timer: null,

  sidecarCommand() {
    const dir = this.base("sidecar");
    const py = path.join(dir, "python.exe");
    if (!fs.existsSync(py)) throw new Error(`找不到 Python 侧车（${dir}）。请先运行 npm run build:sidecar`);
    return { py, cwd: dir };
  },

  sidecarAlive() { return !!this._proc; },

  _ensureSidecar() {
    if (this._proc) return;
    const { py, cwd } = this.sidecarCommand();
    const proc = spawn(py, ["entry.pyw"], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: ENGINE_ENV,
      windowsHide: true,
    });
    this._proc = proc;
    this._buf = "";
    let errBuf = "";
    proc.stderr.on("data", (d) => {
      errBuf += d;
      if (errBuf.length > 800) errBuf = errBuf.slice(-800);
    });
    proc.stdout.on("data", (d) => {
      this._buf += d.toString("utf8");
      let i;
      while ((i = this._buf.indexOf("\n")) >= 0) {
        const line = this._buf.slice(0, i).trim();
        this._buf = this._buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        const w = this._waiting.get(msg.id);
        if (w) {
          this._waiting.delete(msg.id);
          if (msg.ok) w.resolve(msg.data || {});
          else w.reject(new Error(msg.error || "侧车返回失败"));
        }
      }
    });
    proc.on("exit", (code) => {
      const left = [...this._waiting.values()];
      this._waiting.clear();
      this._proc = null;
      for (const w of left) w.reject(new Error(`侧车退出(code=${code}) ${errBuf.trim()}`.slice(0, 300)));
    });
    this._armIdleTimer();
  },

  _armIdleTimer() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.killSidecar(), 120000);
  },

  killSidecar() {
    clearTimeout(this._timer);
    if (this._proc) {
      try { spawnSync("taskkill", ["/pid", String(this._proc.pid), "/T", "/F"], { stdio: "ignore" }); }
      catch (_) { /* noop */ }
      this._proc = null;
    }
    this._waiting.forEach((w) => w.reject(new Error("侧车已停止")));
    this._waiting.clear();
  },

  runSidecar(cmd, args) {
    this._ensureSidecar();
    const id = this._nextId++;
    const payload = JSON.stringify({ id, cmd, args }) + "\n";
    return new Promise((resolve, reject) => {
      this._waiting.set(id, { resolve, reject });
      this._armIdleTimer();
      try { this._proc.stdin.write(payload); }
      catch (e) { this._waiting.delete(id); reject(e); }
    });
  },

  /** 一次性子进程工具（soffice/gs/tesseract） */
  _runOnce(exe, args, timeoutMs, onLog) {
    return new Promise((resolve, reject) => {
      const p = spawn(exe, args, { windowsHide: true, env: ENGINE_ENV });
      let err = "", timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { p.kill(); } catch (_) {/*noop*/ } }, timeoutMs);
      p.stderr.on("data", (d) => { err += d.toString("utf8"); });
      p.on("error", (e) => { clearTimeout(timer); reject(e); });
      p.on("exit", (code) => {
        clearTimeout(timer);
        if (onLog) onLog({ code, err });
        if (timedOut) return reject(new Error("转换超时"));
        if (code !== 0) return reject(new Error((err || `exit ${code}`).slice(0, 300)));
        resolve();
      });
    });
  },

  /** Office → PDF。逐文件；每文件独立 LO profile。 */
  async officeToPdf(file, outDir, log) {
    return this.officeConvert(file, outDir, "pdf", log);
  },

  /** Office → 任意 LibreOffice 目标格式（html/docx/xlsx/pptx/odt/ods/odp/rtf...）。
      target 传 LibreOffice 扩展名；输出名 = 源名换扩展名。 */
  async officeConvert(file, outDir, target, log) {
    const soffice = this.soffice();
    const ext_ = String(target || "").toLowerCase().replace(/^\./, "");
    if (!ext_) throw new Error("未指定目标格式");
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lokit-"));
    try {
      await this._runOnce(soffice, [
        "--headless", "--norestore", "--invisible", "--nodefault", "--nolockcheck",
        `-env:UserInstallation=file:///${profile.replace(/\\/g, "/")}`,
        "--convert-to", ext_, "--outdir", outDir, file,
      ], 120000, (r) => log && log(file, "office", r));
      // soffice 输出名 = 源文件名换目标扩展名
      const out = path.join(outDir,
        path.basename(file).replace(/\.[^.]+$/, "") + "." + ext_);
      if (!fs.existsSync(out)) throw new Error(`未生成 ${ext_} 文件（格式组合可能不支持）`);
      return out;
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
  },

  async compressPdf(inFile, outFile, level) {
    const map = { screen: "screen", ebook: "ebook", printer: "printer" };
    const setting = map[level] || "ebook";
    await this._runOnce(this.gs(), [
      "-sDEVICE=pdfwrite", `-dPDFSETTINGS=/${setting}`,
      "-dCompatibilityLevel=1.5", "-dNOPAUSE", "-dBATCH", "-dQUIET",
      `-sOutputFile=${outFile}`, inFile,
    ], 180000);
    if (!fs.existsSync(outFile)) throw new Error("压缩未生成输出文件");
    return outFile;
  },

  async ocrImage(inFile, outBase, lang) {
    await this._runOnce(this.tesseract(), [
      inFile, outBase, "-l", lang || "chi_sim+eng",
    ], 300000);
    return outBase + ".txt";
  },
};

module.exports = { Engines, ARCH };
