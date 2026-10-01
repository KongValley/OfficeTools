/**
 * 主进程：单窗口 + 串行任务队列 + IPC + 日志 + 设置。
 * 工具集合（与 renderer 对齐）：
 *  office2pdf, pdf2word, pdf_merge, pdf_split, pdf_extract,
 *  pdf_delete, pdf_rotate, pdf_compress, pdf2img, img2pdf,
 *  ocr, encrypt, decrypt, watermark
 */
const {
  app, BrowserWindow, ipcMain, dialog, shell,
} = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Engines, ARCH } = require("./engines");

const APP_DIR = path.join(app.getPath("appData"), "办公助手");
const LOG_DIR = path.join(APP_DIR, "logs");
const CONFIG = path.join(APP_DIR, "config.json");
fs.mkdirSync(LOG_DIR, { recursive: true });

let win = null;
const logFile = path.join(LOG_DIR, `app-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.log`);
function log(...a) {
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${a.join(" ")}\n`);
  } catch (_) {/*noop*/ }
}

const DEFAULT_SETTINGS = {
  outDirMode: "same",      // same | fixed
  fixedOutDir: "",
  pdfDpi: 150,
  compressLevel: "ebook",
  ocrLang: "chi_sim+eng",
  watermarkText: "内部资料",
  watermarkOpacity: 0.15,
  watermarkTile: true,
};
function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(CONFIG, "utf8")) }; }
  catch (_) { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(cfg) {
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
}

/* ---------------- 任务队列（串行 concurrency=1） ---------------- */
const queue = [];
let running = false;

const TOOLS = new Set([
  "office2pdf", "pdf2word", "pdf_merge", "pdf_split", "pdf_extract", "pdf_delete",
  "pdf_rotate", "pdf_compress", "pdf2img", "img2pdf", "imgcompress", "ocr", "encrypt", "decrypt", "watermark",
]);

const OFFICE_EXT = [".doc", ".docx", ".rtf", ".odt", ".txt", ".xls", ".xlsx", ".ods", ".ppt", ".pptx", ".odp"];
const PDF_EXT = [".pdf"];
const IMG_EXT = [".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tif", ".tiff", ".webp"];

function ext(f) { return path.extname(f).toLowerCase(); }

function emit(taskId, fileIndex, fileTotal, file, status, message, extra) {
  if (win) win.webContents.send("task-update", {
    taskId, fileIndex, fileTotal, file, status, message, ...extra,
  });
}

function ensureUnique(p) {
  if (!fs.existsSync(p)) return p;
  const dir = path.dirname(p), base = path.basename(p), e = ext(base);
  const stem = base.slice(0, base.length - e.length);
  for (let i = 1; i < 999; i++) {
    const c = path.join(dir, `${stem}-${i}${e}`);
    if (!fs.existsSync(c)) return c;
  }
  return p;
}

function outDirFor(file, settings) {
  const dir = settings.outDirMode === "fixed" && settings.fixedOutDir
    // 用户在设置里手输/粘贴的目录可能带正斜杠，规范化后 join 才不会产生混合路径
    ? settings.fixedOutDir.replace(/\//g, "\\") : path.dirname(file);
  return dir;
}

async function processFile(task, file, fileIndex, fileTotal, tmpDir, settings) {
  const tool = task.tool;
  const opts = task.options || {};
  const outDir = outDirFor(file, settings);
  fs.mkdirSync(outDir, { recursive: true });
  const stem = path.basename(file).replace(/\.[^.]+$/, "");
  emit(task.id, fileIndex, fileTotal, file, "running", "处理中");

  let out = null, message = "";

  switch (tool) {
    case "office2pdf": {
      if (!OFFICE_EXT.includes(ext(file))) throw new Error("不支持的文件类型");
      out = await Engines.officeToPdf(file, outDir, (f, kind, r) =>
        log(`office2pdf file=${f} exit=${r.code}`));
      break;
    }
    case "pdf2word": {
      if (!PDF_EXT.includes(ext(file))) throw new Error("仅支持 PDF 文件");
      out = path.join(outDir, `${stem}.docx`);
      await Engines.runSidecar("pdf2word", { in: file, out });
      break;
    }
    case "pdf_merge": {
      out = path.join(outDir, `${stem}-合并.pdf`);
      // undefined 字段 JSON 序列化时省略 → sidecar args.get("pages")=None → 全页合并（兼容旧路径）
      await Engines.runSidecar("pdf_pages", { files: task.files, out, op: "merge",
        pages: Array.isArray(opts.pageSpecs) ? opts.pageSpecs : undefined });
      break;
    }
    case "pdf_split": {
      out = path.join(tmpDir, path.basename(file));
      // 每文件页码串（未填=全拆）；split 也走同一通道，行内空框即旧行为
      await Engines.runSidecar("pdf_pages", { in: file, op: "split", out_dir: outDir,
        pages: Array.isArray(opts.pageSpecs) ? (opts.pageSpecs[fileIndex] || "") : opts.pages });
      message = "拆分完成";
      break;
    }
    case "pdf_extract": {
      out = path.join(outDir, `${stem}-提取.pdf`);
      await Engines.runSidecar("pdf_pages", { in: file, out, op: "extract", pages: opts.pages });
      break;
    }
    case "pdf_delete": {
      out = path.join(outDir, `${stem}-删页后.pdf`);
      // 每文件页码串（未填=不删，输出与原页数一致）
      await Engines.runSidecar("pdf_pages", { in: file, out, op: "delete",
        pages: Array.isArray(opts.pageSpecs) ? (opts.pageSpecs[fileIndex] || "") : opts.pages });
      break;
    }
    case "pdf_rotate": {
      out = path.join(outDir, `${stem}-旋转.pdf`);
      await Engines.runSidecar("pdf_pages", { in: file, out, op: "rotate",
        pages: opts.pages || "", rotate: opts.rotate || 90 });
      break;
    }
    case "pdf_compress": {
      out = path.join(outDir, `${stem}-压缩.pdf`);
      await Engines.compressPdf(file, out, settings.compressLevel);
      const before = fs.statSync(file).size, after = fs.statSync(out).size;
      message = `已压缩 ${(before / 1048576).toFixed(1)}MB → ${(after / 1048576).toFixed(1)}MB`;
      break;
    }
    case "pdf2img": {
      out = path.join(outDir, `${stem}_p1.png`);
      const r = await Engines.runSidecar("pdf2img", { in: file, out_dir: outDir,
        dpi: settings.pdfDpi, fmt: opts.fmt || "png" });
      if (r.fallback_png) message = "当前环境不支持 JPG，已输出 PNG";
      else if (r.count > 1) message = `共 ${r.count} 张`;
      break;
    }
    case "img2pdf": {
      out = path.join(outDir, `${stem}-图片合成.pdf`);
      await Engines.runSidecar("img2pdf", { files: task.files, out });
      break;
    }
    case "imgcompress": {
      if (!IMG_EXT.includes(ext(file))) throw new Error("仅支持图片文件");
      const r = await Engines.runSidecar("imgcompress", {
        in: file, out_dir: outDir,
        quality: opts.quality, scale: opts.scale,
      });
      out = r.out;
      const pct = r.in_bytes > 0 && r.out_bytes <= r.in_bytes
        ? `，减小 ${(100 - r.out_bytes / r.in_bytes * 100).toFixed(0)}%`
        : "";
      message = r.count > 1 ? `压缩 ${r.count} 张${pct}` : `压缩完成${pct}`;
      break;
    }
    case "ocr": {
      if (!PDF_EXT.includes(ext(file)) && !IMG_EXT.includes(ext(file)))
        throw new Error("仅支持 PDF 或图片");
      const r = await Engines.runSidecar("ocr", {
        in: file, out_dir: outDir, lang: settings.ocrLang,
        mode: opts.mode || "txt", dpi: Number(opts.dpi) || Number(settings.pdfDpi) || 150,
      });
      out = r.out;
      message = r.chars !== undefined ? `识别 ${r.chars} 字` : `共 ${r.pages} 页`;
      break;
    }
    case "encrypt": {
      out = path.join(outDir, `${stem}-加密.pdf`);
      await Engines.runSidecar("encrypt", { in: file, out,
        user_pw: opts.user_pw, owner_pw: opts.owner_pw });
      break;
    }
    case "decrypt": {
      out = path.join(outDir, `${stem}-解密.pdf`);
      await Engines.runSidecar("decrypt", { in: file, out, password: opts.password });
      break;
    }
    case "watermark": {
      out = path.join(outDir, `${stem}-水印.pdf`);
      await Engines.runSidecar("watermark", { in: file, out,
        text: opts.text || settings.watermarkText, opacity: Number(opts.opacity ?? settings.watermarkOpacity),
        rotate: Number(opts.rotate) || 45, color: opts.color || "gray", tile: !!settings.watermarkTile });
      break;
    }
    default:
      throw new Error("未知工具");
  }

  if (tool === "pdf_merge" || tool === "img2pdf") {
    // 合并类：一次任务只产出一个文件
    emit(task.id, fileIndex, fileTotal, file, "done", message || "完成", { out, lastFile: true });
  } else {
    emit(task.id, fileIndex, fileTotal, file, "done", message || "完成", { out });
  }
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const task = queue.shift();
      if (task.cancelled) {
        emit(task.id, 0, 0, "", "cancelled", "已取消");
        continue;
      }
      const settings = loadSettings();
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "officekit-task-"));
      const files = task.files || [];
      try {
        for (let i = 0; i < files.length; i++) {
          if (task.cancelled) break;
          const file = files[i];
          try {
            await processFile(task, file, i, files.length, tmpDir, settings);
          } catch (e) {
            log(`task=${task.id} tool=${task.tool} file=${file} ERROR ${e.message}`);
            emit(task.id, i, files.length, file, "error", e.message.slice(0, 300));
          }
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      if (!task.cancelled) emit(task.id, files.length, files.length, "", "finished", "全部完成");
    }
  } finally {
    running = false;
    Engines.killSidecar(); // 空闲即回收
  }
}

/* ---------------- IPC ---------------- */
ipcMain.handle("submit-task", (e, tool, files, options) => {
  if (!TOOLS.has(tool)) return { ok: false, error: "未知工具" };
  if (!Array.isArray(files) || !files.length) return { ok: false, error: "未选择文件" };
  // 用渲染进程传来的 taskId（否则事件 taskId 对不上，UI 收不到更新）
  const id = options && options.taskId ? String(options.taskId) : `t${Date.now()}`;
  const task = { id, tool, files: files.slice(), options, cancelled: false };
  queue.push(task);
  log(`submit task=${id} tool=${tool} files=${files.length}`);
  emit(id, 0, files.length, "", "queued", "排队中");
  pump();
  return { ok: true, taskId: id };
});

ipcMain.handle("cancel-task", (e, taskId) => {
  const t = queue.find((x) => x.id === taskId);
  if (t) { t.cancelled = true; queue.splice(queue.indexOf(t), 1); }
  return { ok: true };
});

function sizeLabel(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + " MB";
  return Math.max(1, Math.round(bytes / 1024)) + " KB";
}

ipcMain.handle("stat-files", (e, files) => (Array.isArray(files) ? files : []).map((f) => {
  let label = "-";
  try { label = sizeLabel(fs.statSync(f).size); } catch (_) {/*文件已移动/删除*/ }
  return { path: f, sizeLabel: label };
}));

ipcMain.handle("get-settings", () => loadSettings());
ipcMain.handle("set-settings", (e, cfg) => { saveSettings(cfg); return { ok: true }; });
ipcMain.handle("open-log-dir", () => shell.openPath(LOG_DIR));
// 资源管理器/ShellExecute 不接受正斜杠混合路径（Electron 拖拽 File.path 即如此），
// 统一规范化为反斜杠后再打开；用 openPath 开所在目录而非 showItemInFolder 选中文件
//（后者对中文/混合路径会弹"找不到文件"）。
ipcMain.handle("open-out", (e, p) => (
  p ? shell.openPath(path.dirname(String(p).replace(/\//g, "\\"))) : undefined));
/* 按页传入文件类型，让对话框默认选中匹配的格式（否则永远默认第一项=办公文档）。
   扩展名从上面的 OFFICE_EXT/IMG_EXT 派生（去掉点），单一数据源不漂移。 */
const stripDot = (a) => a.map((e) => e.slice(1));
const EXT_KINDS = {
  office: stripDot(OFFICE_EXT),
  pdf: stripDot(PDF_EXT),
  image: stripDot(IMG_EXT),
};
const ALL_FILTERS = [
  { name: "办公文档", extensions: EXT_KINDS.office },
  { name: "PDF", extensions: EXT_KINDS.pdf },
  { name: "图片", extensions: EXT_KINDS.image },
];
ipcMain.handle("select-files", async (e, kind) => {
  const exts = EXT_KINDS[kind];
  const filters = exts ? [{ name: "所选类型", extensions: exts }] : ALL_FILTERS;
  const r = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters,
  });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle("pick-out-dir", async () => {
  const r = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});

app.on("window-all-closed", () => app.quit());

// 内网机器无 GPU：禁用硬件 GPU，走 SwiftShader 软件渲染；
// --in-process-gpu 让 GPU 逻辑并入主进程（不单独起 GPU 进程），
// 规避受限用户下独立 GPU 进程反复崩溃/重启。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("use-gl", "swiftshader");
app.commandLine.appendSwitch("in-process-gpu");
// 单次调用：多个 feature 用逗号分隔（重复调用会互相覆盖）
// - 无网络场景：网络/站点隔离特性关掉，避免 restricted 环境下 network service 反复崩溃
// - 拼写检查、原生遮挡计算对本地表单无意义，省 CPU
app.commandLine.appendSwitch("disable-features",
  "IsolateOrigins,site-per-process,WinUseBrowserSpellChecker,CalculateNativeWinOcclusion");

// 单实例：重复启动时聚焦已有窗口（避免多个进程各自占 ~150MB 内存）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}
app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1100, height: 720, minWidth: 960, minHeight: 640,
    icon: path.join(__dirname, "..", "build", "icon.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // 无 GPU 慢机器：最小化后不让渲染进程被节流
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  log(`app ready arch=${ARCH} version=${app.getVersion()}`);
});
app.on("quit", () => Engines.killSidecar());
