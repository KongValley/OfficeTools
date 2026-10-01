#!/usr/bin/env node
/**
 * 一次性性能基准（构建机手动运行）：node scripts/bench.cjs
 *
 * 测量项：
 *   1. 50 页中文 PDF 大样本（--bench-fixture 生成）
 *   2. pdf2word / merge / watermark / pdf2img / ocr 的耗时
 *   3. 引擎进程峰值 RSS（tasklist 每 250ms 轮询）
 *   4. 输出体积
 *
 * 结果直接打印表格，并写入 perf-report.md（README 手工摘录）。
 * 不复用 engines.js（无峰值钩子），自行 spawn 并实现 JSONL 协议。
 */
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const ARCH = process.arch === "ia32" ? "ia32" : "x64";
const SIDE = path.join(ROOT, "staging", `sidecar-${ARCH}`);
const PY = path.join(SIDE, "python.exe");
const WORKER = path.join(SIDE, "worker.py");
const ROWS = [];

/* ---------- 进程内存采样（tasklist） ---------- */
function rssOf(pid) {
  if (!pid || pid <= 0) return 0;
  try {
    const r = spawnSync("tasklist", ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"], {
      encoding: "utf8", timeout: 5000,
    });
    // "映像名称","PID",...,"内存使用量"  形如 "123,456 K"
    const m = /\d[\d,]* K"?$/.exec((r.stdout || "").trim());
    if (!m) return 0;
    return parseInt(m[0].replace(/[^\d]/g, ""), 10); // KB
  } catch (_) {
    return 0;
  }
}

/** 每 250ms 轮询 pid 的 RSS，返回峰值 KB */
async function pollPeak(pid, stop) {
  let peak = 0;
  while (!stop()) {
    peak = Math.max(peak, rssOf(pid));
    await new Promise((r) => setTimeout(r, 250));
  }
  return peak;
}

/* ---------- 侧车 JSONL ---------- */
class Sidecar {
  constructor() {
    this.proc = spawn(PY, [WORKER], {
      cwd: SIDE,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      windowsHide: true,
    });
    this.buf = "";
    this.next = 1;
    this.waiting = new Map();
    this.proc.stdout.on("data", (d) => {
      this.buf += d.toString("utf8");
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        const w = this.waiting.get(msg.id);
        if (w) {
          this.waiting.delete(msg.id);
          msg.ok ? w.res(msg.data || {}) : w.rej(new Error(msg.error || "fail"));
        }
      }
    });
    this.proc.on("exit", () => this.stop = true);
  }

  call(cmd, args) {
    const id = this.next++;
    return new Promise((res, rej) => {
      this.waiting.set(id, { res, rej });
      this.proc.stdin.write(JSON.stringify({ id, cmd, args }) + "\n");
    });
  }

  kill() {
    try { spawnSync("taskkill", ["/pid", String(this.proc.pid), "/T", "/F"], { stdio: "ignore" }); }
    catch (_) {/*noop*/}
  }
}

/* ---------- 记录 ---------- */
function row(name, ms, peakKB, outSize) {
  ROWS.push({ name, ms, peakMB: peakKB ? (peakKB / 1024).toFixed(0) : "n/a", outSize });
  console.log(`  ${name.padEnd(18)} ${String(ms).padStart(6)}ms  peak=${peakKB ? (peakKB / 1024).toFixed(0) + "MB" : "n/a"}  out=${outSize}B`);
}

/** 测量一个 sidecar 命令（含侧车进程峰值轮询） */
async function benchSidecar(sc, name, cmd, args) {
  const stop = { v: false };
  const sampler = pollPeak(sc.proc.pid, () => stop.v);
  const t0 = Date.now();
  const r = await sc.call(cmd, args);
  const ms = Date.now() - t0;
  stop.v = true;
  const peakKB = await sampler;
  const outSize = r && r.out ? fs.statSync(r.out).size : 0;
  row(name, ms, peakKB, outSize);
  return r;
}

/* ---------- 主流程 ---------- */
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "officekit-bench-"));
  console.log(`bench arch=${ARCH}\n`);

  // 1) 50 页中文大样本
  process.stdout.write("  生成 50 页样本 ...");
  const fx = path.join(tmp, "bench50.pdf");
  const g = spawnSync(PY, [WORKER, "--bench-fixture", fx, "50"], { encoding: "utf8", timeout: 180000 });
  if (!fs.existsSync(fx)) { console.error("样本生成失败:", g.stderr); process.exit(1); }
  console.log(` ${fs.statSync(fx).size}B`);

  // 2) 侧车常驻，逐项测
  const sc = new Sidecar();
  console.log("\n  == 功能耗时与内存峰值 ==");

  await benchSidecar(sc, "pdf2word", "pdf2word",
    { in: fx, out: path.join(tmp, "bench50.docx") });
  await benchSidecar(sc, "merge x2", "pdf_pages",
    { files: [fx, fx], out: path.join(tmp, "merge100.pdf"), op: "merge" });
  await benchSidecar(sc, "split", "pdf_pages",
    { in: fx, op: "split", out_dir: path.join(tmp, "split") });
  await benchSidecar(sc, "watermark", "watermark",
    { in: fx, out: path.join(tmp, "wm.pdf"), text: "内部资料", opacity: 0.15, tile: true });
  await benchSidecar(sc, "pdf2img(150dpi)", "pdf2img",
    { in: fx, out_dir: path.join(tmp, "imgs"), dpi: 150, fmt: "png" });

  // 3) OCR：x64 才有 tesseract。样本是中文 → 用 chi_sim+eng（真实场景）
  const tess = path.join(ROOT, "engines", `tesseract-${ARCH}`, "tesseract", "tesseract.exe");
  if (fs.existsSync(tess)) {
    await benchSidecar(sc, "ocr(chi+eng)", "ocr",
      { in: fx, out_dir: tmp, lang: "chi_sim+eng", mode: "txt", dpi: 150 });
  } else {
    console.log("  ocr              跳过（ia32 无 tesseract）");
  }

  // 4) soffice 单进程峰值（docx→PDF）
  const soRoot = path.join(ROOT, "engines", `lo-${ARCH}`, "program");
  const so = path.join(soRoot, "soffice.exe");
  if (fs.existsSync(so)) {
    // 先造 1 页 docx（复用 selftest 的手法）
    const mkdx = spawnSync(PY, ["-c",
      "import sys;sys.path.insert(0,'.');import worker;import tempfile,os;d=tempfile.mkdtemp();p=worker._make_docx(os.path.join(d,'a.docx'));print(p)"],
      { cwd: SIDE, encoding: "utf8" });
    const dx = mkdx.stdout.trim().split(/\r?\n/).pop();
    if (dx && fs.existsSync(dx)) {
      const prof = fs.mkdtempSync(path.join(os.tmpdir(), "lobench-"));
      const stop = { v: false };
      const args_ = ["--headless", "--norestore", "--invisible", "--nodefault", "--nolockcheck",
        `-env:UserInstallation=file:///${prof.replace(/\\/g, "/")}`,
        "--convert-to", "pdf", "--outdir", tmp, dx];
      const t0 = Date.now();
      const p = spawn(so, args_, { windowsHide: true });
      const sampler = pollPeak(p.pid, () => p.exitCode !== null || stop.v);
      p.on("exit", () => { stop.v = true; });
      await new Promise((r) => p.on("close", r));
      const peakKB = await sampler;
      row("office2pdf(docx)", Date.now() - t0, peakKB, 0);
      fs.rmSync(prof, { recursive: true, force: true });
    }
  }

  // 5) Ghostscript 压缩峰值
  const gsExe = ARCH === "ia32" ? "gswin32c.exe" : "gswin64c.exe";
  let gsPath = null;
  const gsRoot = path.join(ROOT, "engines", `gs-${ARCH}`);
  (function find(dir) {
    if (!fs.existsSync(dir) || gsPath) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === gsExe) { gsPath = p; return; }
      if (e.isDirectory()) find(p);
    }
  })(gsRoot);
  if (gsPath) {
    const cz = path.join(tmp, "bench50_small.pdf");
    const t0 = Date.now();
    const p = spawn(gsPath, ["-sDEVICE", "pdfwrite", "-dPDFSETTINGS=/ebook",
      "-dNOPAUSE", "-dBATCH", "-dQUIET", `-sOutputFile=${cz}`, fx], { windowsHide: true });
    const stop = { v: false };
    const sampler = pollPeak(p.pid, () => p.exitCode !== null || stop.v);
    p.on("exit", () => { stop.v = true; });
    await new Promise((r) => p.on("close", r));
    const peakKB = await sampler;
    row("compress(gs)", Date.now() - t0, peakKB, fs.existsSync(cz) ? fs.statSync(cz).size : 0);
  }

  sc.kill();

  // 6) 汇总
  const lines = [
    `性能基准（arch=${ARCH}, ${os.arch()}, 50 页样本 ${fs.statSync(fx).size}B）`,
    "",
    "| 功能 | 耗时 | 引擎进程峰值 | 输出体积 |",
    "|---|---|---|---|",
    ...ROWS.map((r) => `| ${r.name} | ${r.ms}ms | ${r.peakMB}MB | ${r.outSize}B |`),
    "",
  ];
  console.log("\n" + lines.join("\n"));
  fs.appendFileSync(path.join(ROOT, "perf-report.md"), lines.join("\n") + "\n");
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error("bench 失败:", e); process.exit(1); });
