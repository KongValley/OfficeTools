/* 办公助手 renderer：原生 JS，无框架。
 * 左侧导航 7 项 + 右侧页面。文件列表分页（50/页）。任务面板增量更新。
 *
 * 许可证：GPL-3.0-or-later，见仓库根目录 LICENSE.md 与 THIRD-PARTY-NOTICES.md。
 */
(function () {
  "use strict";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Electron 拖拽给的 File.path 带正斜杠（C:/Users/...），ShellExecute/资源管理器不接受
  // 混合斜杠路径（"打开"会弹"找不到文件"）。入口统一规范化，下游显示/sidecar/stat 全走反斜杠。
  const norm = (p) => String(p).replace(/\//g, "\\");

  /* ---------- 页面定义 ---------- */
  const PAGES = [
    { id: "convert", name: "格式转换" },
    { id: "amount", name: "金额大写" },
    { id: "time", name: "时间计算" },
    { id: "todo", name: "待办列表" },
    { id: "pages", name: "PDF 页面工具" },
    { id: "tocpage", name: "目录书签" },
    { id: "misc", name: "PDF 整理" },
    { id: "compress", name: "PDF 压缩" },
    { id: "pdf2img", name: "PDF 转图片" },
    { id: "img2pdf", name: "图片转 PDF" },
    { id: "imgcompress", name: "图片压缩" },
    { id: "ocr", name: "OCR 识别" },
    { id: "security", name: "加密与水印" },
    { id: "settings", name: "设置" },
  ];

  /* 16px stroke 图标：内联 SVG，零请求零打包改动 */
  const ICONS = {
    convert: '<path d="M17 3l4 4-4 4"/><path d="M21 7H8a4 4 0 0 0-4 4v1"/><path d="M7 21l-4-4 4-4"/><path d="M3 17h13a4 4 0 0 0 4-4v-1"/>',
    pages: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>',
    tocpage: '<path d="M4 6h16M4 6l2-2M4 6l2 2M4 12h10M4 12l2-2M4 12l2 2M4 18h13M4 18l2-2M4 18l2 2"/>',
    misc: '<path d="M3 5h18v14H3z"/><path d="M7 9l3 3-3 3M13 15h4"/>',
    amount: '<path d="M12 1v22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    time: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>',
    todo: '<path d="M9 11l3 3 8-8"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    compress: '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/><line x1="8" y1="12" x2="16" y2="12"/>',
    pdf2img: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    img2pdf: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 12 12 17 22 12"/><polyline points="2 17 12 22 22 17"/>',
    imgcompress: '<path d="M4 14h6v6"/><path d="M10 20l-6-6"/><path d="M20 10V4h-6"/><path d="M14 10l6-6"/><line x1="4" y1="4" x2="9" y2="9"/><line x1="15" y1="15" x2="20" y2="20"/>',
    ocr: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="3" y1="12" x2="21" y2="12"/>',
    security: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  };
  const svg = (name, cls) =>
    `<svg class="${cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;

  let settings = {};
  let currentTask = null;         // 当前任务 id
  let taskActive = false;         // 任务进行中：控制取消按钮与耗时计时器
  let taskStartAt = 0, taskElapsed = "";
  let elapsedTimer = null;
  const taskRows = new Map();     // taskId -> [{file, status, message, out}]
  let filePage = 0;
  const PAGE_SIZE = 50;
  const sizes = new Map();        // path -> 体积字符串
  const fileSpecs = new Map();    // path -> 用户填的页码串（merge 每文件）

  /* ---------- 纯计算工具：金额大写 / 日期计算（无引擎依赖，无文件操作） ---------- */
  /* 财务大写数字（人民币票据用），非日常计数 */
  const CN_DIGITS = "零壹贰叁肆伍陆柒捌玖";
  const CN_UNITS = ["", "拾", "佰", "仟"];
  const CN_GROUPS = ["", "万", "亿", "万亿"];

  /* 整数部分转财务大写（四位一组：个/万/亿/万亿）。
     段内：数字间的连续零压缩为一个「零」（101 → 壹佰零壹）。
     段间补零（满足其一）：
       - 本组首位是被跳过的前导零（g[0]==="0"）：10001 → 壹万零壹
       - 前一已输出组末位是零（/0$/）：1005000 → 壹佰万零伍仟
     例：200020002 → 贰亿零贰万零贰；123456789 → 完整不补 */
  function intToCn(intStr) {
    const s = String(intStr).replace(/^0+/, "");
    if (!s) return "";
    const n = s.length;
    let out = "";
    let prevG = "";   // 上一个已输出组的原始四位串（含前导零）
    for (let gi = Math.floor((n - 1) / 4); gi >= 0; gi--) {
      const end = n - gi * 4;
      const start = Math.max(0, end - 4);
      if (start >= end) continue;
      const g = s.slice(start, end);
      let seg = "", zero = false;
      for (let i = 0; i < g.length; i++) {
        const d = Number(g[i]);
        const unit = CN_UNITS[g.length - 1 - i];   // 组内位单位
        if (d === 0) {
          zero = true;
        } else {
          if (zero && seg) seg += "零";
          seg += CN_DIGITS[d] + unit;
          zero = false;
        }
      }
      if (!seg) continue;                    // 全零组（如 100000 的低位组）不输出
      // 补零：前组末位是零、或本组首位是零（二者只补一个「零」）
      if (out && !out.endsWith("零") && (prevG.endsWith("0") || g[0] === "0")) out += "零";
      out += seg + CN_GROUPS[gi];
      prevG = g;
    }
    return out;
  }

  /* 金额（元）转人民币大写。分位按第三位四舍五入。 */
  function amountToCn(input) {
    const s = String(input).trim().replace(/,/g, "").replace(/元/g, "").replace(/[¥￥]/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    const neg = s.startsWith("-");
    const abs = neg ? s.slice(1) : s;
    const [ip, fp = ""] = abs.split(".");
    // 第三位小数决定分位是否进位（0.005 → 1 分）
    const cents = Math.round(Number("0." + (fp + "00").slice(0, 3)) * 100) % 100;
    const jiao = Math.floor(cents / 10), fen = cents % 10;
    const yuan = intToCn(ip) || "零";      // 0.05 → 零元零伍分
    let out = yuan + "元";
    if (cents === 0) {
      out += "整";
    } else if (jiao > 0) {
      // 「整」只在无角无分时用；壹元伍角（分位为零）不加整
      out += CN_DIGITS[jiao] + "角" + (fen > 0 ? CN_DIGITS[fen] + "分" : "");
    } else {
      out += "零" + CN_DIGITS[fen] + "分";   // 零角 X 分：角位为零显式补零
    }
    return (neg ? "负" : "") + out;
  }

  /* 日期工具：本地产字符串 → 本地 00:00 Date（避免 UTC 偏移） */
  function parseDateStr(s) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s).trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1
      || d.getDate() !== Number(m[3])) return null;
    return d;
  }
  function fmtDate(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  const DAY_MS = 86400000;
  function daysBetween(a, b) {
    return Math.round((b - a) / DAY_MS);
  }
  /* [a,b] 区间内周一至五的天数；a > b 时按交换后的区间计算 */
  function workdaysBetween(a, b) {
    if (daysBetween(a, b) < 0) return workdaysBetween(b, a);
    let n = 0;
    for (let t = a.getTime(); t <= b.getTime(); t += DAY_MS) {
      const wd = new Date(t).getDay();
      if (wd !== 0 && wd !== 6) n++;
    }
    return n;
  }
  function addDays(d, n) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  }

  const state = { files: [] };    // 当前页选择的文件

  /* ---------- 导航 ---------- */
  function buildNav() {
    const ul = $("#nav-list");
    ul.innerHTML = PAGES.map((p) =>
      `<li data-page="${p.id}">${svg(p.id, "ico")}${p.name}</li>`).join("");
    $$("li", ul).forEach((li) => li.addEventListener("click", () => showPage(li.dataset.page)));
    showPage("convert");
  }

  function showPage(id) {
    $$("#nav-list li").forEach((li) => li.classList.toggle("active", li.dataset.page === id));
    $$(".page").forEach((p) => p.classList.toggle("active", p.id === "page-" + id));
    if (id === "settings") { activeList = ""; refreshSettingsForm(); renderFileList(); return; }
    emptyHint = EMPTY_HINTS[id] || emptyHint;
    // 有子页的页：保持该页当前活动子页为列表宿主；无子页：页 id 即后缀
    const activeSub = $(`.page#page-${id} .subpage.active`);
    activeList = activeSub ? activeSub.id : id;
    renderFileList();
  }

  /* ---------- 通用文件选择 ---------- */
  /* 按页/子页的引导文案与文件类型；kind 决定选择框默认 filter：
     office/pdf/image，null = 三类全列（不预设） */
  const EMPTY_HINTS = {
    convert: { title: "把 Office 文档拖进来", sub: "支持 doc/docx/xls/xlsx/ppt/pptx/rtf/odt/txt 等", kind: "office" },
    "s-office": { title: "把 Office 文档拖进来", sub: "支持 doc/docx/xls/xlsx/ppt/pptx/rtf/odt/txt 等", kind: "office" },
    "s-p2w": { title: "把 PDF 拖进来", sub: "仅支持文字版 PDF（扫描件请先用 OCR 识别）", kind: "pdf" },
    pages: { title: "把 PDF 拖进来", sub: "合并/拆分/提取/删除/旋转页面", kind: "pdf", pageSpec: true },
    tocpage: { title: "把 PDF 拖进来", sub: "查看/生成/编辑 PDF 目录书签", kind: "pdf" },
    misc: { title: "把 PDF 拖进来", sub: "加页码 / 清元数据 / 重排页面 / 裁边距", kind: "pdf" },
    "s-ofmt": { title: "把 Office 文档拖进来", sub: "doc/docx/xls/xlsx/ppt/pptx/rtf/odt 等，转成所选格式", kind: "office" },
    compress: { title: "把 PDF 拖进来", sub: "压缩图片精度以减小体积", kind: "pdf" },
    pdf2img: { title: "把 PDF 拖进来", sub: "按 DPI 渲染成 PNG/JPG", kind: "pdf" },
    img2pdf: { title: "把图片拖进来", sub: "按当前文件顺序合成 PDF", sortable: true, kind: "image" },
    imgcompress: { title: "把图片拖进来", sub: "JPG/PNG 批量压缩，可调质量与缩放", kind: "image" },
    ocr: { title: "把扫描件拖进来", sub: "支持 PDF 与图片，识别为文本或可搜索 PDF", kind: null },
    security: { title: "把 PDF 拖进来", sub: "AES-256 加密/解密，或添加文字水印", kind: "pdf" },
    "u-enc": { title: "把 PDF 拖进来", sub: "AES-256 加密", kind: "pdf" },
    "u-dec": { title: "把 PDF 拖进来", sub: "输入原密码解除加密", kind: "pdf" },
    "u-wm": { title: "把 PDF 拖进来", sub: "添加可调角度/颜色的文字水印", kind: "pdf" },
  };
  let emptyHint = EMPTY_HINTS["s-office"];
  /* 当前活动文件列表的后缀（每页一份列表，id 必须唯一） */
  let activeList = "s-office";
  /* 从拖拽区向上找所属子页/页 id，得到该页列表后缀 */
  function suffixOf(el) {
    const sub = el.closest(".subpage");
    if (sub && sub.id) return sub.id;
    const pg = el.closest(".page");
    if (pg && pg.id) return pg.id.replace(/^page-/, "");
    return activeList;
  }

  function setFiles(files) {
    state.files = files;
    filePage = 0;
    renderFileList();
    statNewFiles();
  }

  /* 文件体积走 stat-files IPC；失败的路径留空，不阻塞列表渲染 */
  function statNewFiles() {
    const fresh = state.files.filter((f) => !sizes.has(f));
    if (!fresh.length) return;
    (window.kit && window.kit.statFiles ? window.kit.statFiles(fresh) : Promise.resolve([]))
      .then((list) => {
        (list || []).forEach((r) => sizes.set(r.path, r.sizeLabel));
        renderFileList();
      })
      .catch(() => {/*体积缺失不阻塞，显示空*/ });
  }

  /* 12px 类型图标：按扩展名取色，其他用灰 O */
  function iconFor(f) {
    const e = (f.split(".").pop() || "").toLowerCase();
    const spec = {
      doc: ["W", "#2563eb"], docx: ["W", "#2563eb"], rtf: ["W", "#2563eb"], odt: ["W", "#2563eb"], txt: ["T", "#2563eb"],
      xls: ["X", "#16a34a"], xlsx: ["X", "#16a34a"], ods: ["X", "#16a34a"],
      ppt: ["P", "#ea580c"], pptx: ["P", "#ea580c"], odp: ["P", "#ea580c"],
      pdf: ["D", "#dc2626"],
      png: ["I", "#9333ea"], jpg: ["I", "#9333ea"], jpeg: ["I", "#9333ea"],
      bmp: ["I", "#9333ea"], gif: ["I", "#9333ea"], tif: ["I", "#9333ea"], tiff: ["I", "#9333ea"], webp: ["I", "#9333ea"],
    }[e] || ["O", "#94a3b8"];
    return `<svg class="fi-ico" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="4" fill="${spec[1]}" fill-opacity=".12" stroke="${spec[1]}" stroke-width="1.5"/>
      <text x="12" y="16.5" text-anchor="middle" font-size="11" font-family="Arial" fill="${spec[1]}">${spec[0]}</text></svg>`;
  }

  function renderFileList() {
    const el = $("#file-list-" + activeList);
    if (!el) return;
    const countEl = $("#file-count-" + activeList);
    if (countEl) countEl.textContent = state.files.length ? `待处理 ${state.files.length} 个文件` : "";
    if (!state.files.length) {
      el.innerHTML = `<div class="empty empty-lg">
        ${svg("pages")}<div class="em">${emptyHint.title}</div>
        <div class="es">${emptyHint.sub || ""}</div></div>`;
      const pg0 = $("#pager-" + activeList);
      if (pg0) pg0.innerHTML = "";
      return;
    }
    const start = filePage * PAGE_SIZE;
    const slice = state.files.slice(start, start + PAGE_SIZE);
    const sortable = !!emptyHint.sortable;
    const pageSpec = !!emptyHint.pageSpec;
    el.innerHTML = slice.map((f, i) => `
      <div class="fi">${iconFor(f)}<span class="nm">${esc(f)}</span>
      <span class="sz">${esc(sizes.get(f) || "")}</span>
      ${pageSpec ? `<input class="spec" data-spec="${start + i}" placeholder="全部" title="页码，如 1,3-5；留空=全部页">` : ""}
      <span class="ops">${sortable ? `
        <button class="link" data-up="${start + i}" title="上移">↑</button>
        <button class="link" data-down="${start + i}" title="下移">↓</button>` : ""}
      <button class="small" data-rm="${start + i}">移除</button></span></div>`).join("");
    // 每文件页码输入：值存 fileSpecs（path -> 串），页大小回填/重渲染不丢
    $$("[data-spec]", el).forEach((inp) => {
      const f = state.files[start + Number(inp.dataset.spec)];
      inp.value = fileSpecs.get(f) || "";
      inp.addEventListener("input", () => fileSpecs.set(f, inp.value.trim()));
    });
    $$("[data-rm]", el).forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      state.files.splice(Number(b.dataset.rm), 1);
      renderFileList();
    }));
    const move = (i, d) => {
      if (i + d < 0 || i + d >= state.files.length) return;
      const t = state.files[i];
      state.files[i] = state.files[i + d];
      state.files[i + d] = t;
      // 翻页边界：被移项的页位置可能跨页，回退到可见页
      renderFileList();
    };
    $$("[data-up]", el).forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation(); move(Number(b.dataset.up), -1);
    }));
    $$("[data-down]", el).forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation(); move(Number(b.dataset.down), 1);
    }));
    const pages = Math.max(1, Math.ceil(state.files.length / PAGE_SIZE));
    const pager = $("#pager-" + activeList);
    pager.innerHTML = `${state.files.length > PAGE_SIZE ? `
      <span>共 ${state.files.length} 个</span>
      <button class="small" id="pg-prev" ${filePage === 0 ? "disabled" : ""}>上一页</button>
      <span>${filePage + 1}/${pages}</span>
      <button class="small" id="pg-next" ${filePage >= pages - 1 ? "disabled" : ""}>下一页</button>` : ""}
      <button class="link" id="file-clear">清空</button>`;
    const clear = $("#file-clear");
    if (clear) clear.addEventListener("click", () => setFiles([]));
    const pp = $("#pg-prev"), pn = $("#pg-next");
    if (pp) pp.addEventListener("click", () => { filePage--; renderFileList(); });
    if (pn) pn.addEventListener("click", () => { filePage++; renderFileList(); });
  }

  /* ---------- 任务面板 ---------- */
  function submit(tool, options) {
    if (!state.files.length) { alert("请先选择文件"); return; }
    currentTask = "t" + Date.now();
    taskRows.set(currentTask, state.files.map((f) => ({ file: f, status: "queued", message: "" })));
    taskActive = true;
    taskStartAt = Date.now();
    taskElapsed = "";
    renderTaskPanel();
    window.kit.submitTask(tool, state.files.slice(), { taskId: currentTask, ...options })
      .then((r) => {
        if (r && !r.ok) { showSubmitError(r.error || "提交失败"); return; }
        // 提交成功：选中列表即任务队列，清空待处理（失败时保留供重试）
        state.files = [];
        filePage = 0;
        fileSpecs.clear();
        renderFileList();
      })
      .catch((e) => showSubmitError(String(e && e.message || e)));
  }

  function showSubmitError(msg) {
    const rows = taskRows.get(currentTask);
    if (rows) { rows.forEach((r) => { r.status = "error"; r.message = msg; }); taskActive = false; renderTaskPanel(); }
  }

  function elapsedText() {
    if (!taskStartAt) return "";
    return ((Date.now() - taskStartAt) / 1000).toFixed(1) + "s";
  }

  function stopElapsedTimer() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  function taskFinishing() {
    taskActive = false;
    stopElapsedTimer();
    taskElapsed = elapsedText();
    renderTaskPanel();
  }

  function renderTaskPanel() {
    const tbody = $("#task-body");
    if (!tbody) return;
    const rows = taskRows.get(currentTask) || [];
    const progress = $("#task-progress");
    const cancelBtn = $("#btn-cancel");
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5">暂无任务</td></tr>';
      $("#task-summary").textContent = "";
      $("#btn-open-out").style.display = "none";
      if (cancelBtn) cancelBtn.style.display = "none";
      if (progress) progress.style.width = "0%";
      return;
    }
    const start = filePage * PAGE_SIZE;
    const slice = rows.slice(start, start + PAGE_SIZE);
    const STATUS = { queued: "等待", running: "处理中", done: "完成", error: "失败",
      cancelled: "已取消", finished: "结束" };
    tbody.innerHTML = slice.map((r, i) => `
      <tr><td>${start + i + 1}</td><td class="file">${esc(r.file)}</td>
      <td><span class="badge badge-${r.status}">${STATUS[r.status] || r.status}</span></td>
      <td>${esc(r.message || "")}${r.status === "done" && r.out ? ' <button class="link" data-open="1">打开</button>' : ""}</td></tr>`).join("");
    // 打开按钮按行重绑（innerHTML 重建后旧监听失效）
    slice.forEach((r, i) => {
      const btn = tbody.children[i] && tbody.children[i].querySelector("[data-open]");
      if (btn) btn.addEventListener("click", () => window.kit.openOut(r.out));
    });
    const done = rows.filter((r) => r.status === "done").length;
    const failed = rows.filter((r) => r.status === "error").length;
    const settled = done + failed;
    if (progress) progress.style.width = (settled / rows.length * 100).toFixed(1) + "%";
    $("#task-summary").textContent = taskActive
      ? `任务 ${currentTask}：共 ${rows.length} 个，已完成 ${settled}，已用 ${elapsedText()}`
      : `完成 ${done} 个 · 失败 ${failed} 个 · 耗时 ${taskElapsed || elapsedText()}`;
    $("#btn-open-out").style.display = done === rows.length && rows.length ? "" : "none";
    if (cancelBtn) cancelBtn.style.display = taskActive ? "" : "none";
    if (taskActive && !elapsedTimer) {
      elapsedTimer = setInterval(renderTaskPanel, 1000);
    } else if (!taskActive) {
      stopElapsedTimer();
    }
  }

  function onUpdate(p) {
    if (p.taskId !== currentTask) return;
    const rows = taskRows.get(currentTask);
    if (!rows) return;
    if (p.status === "finished" || p.status === "cancelled" && p.fileIndex === 0) {
      if (p.status === "finished") {
        rows.forEach((r) => { if (r.status === "queued") r.status = "cancelled"; });
      }
      return taskFinishing();
    }
    if (typeof p.fileIndex === "number" && rows[p.fileIndex]) {
      rows[p.fileIndex].status = p.status;
      rows[p.fileIndex].message = p.message || "";
      rows[p.fileIndex].out = p.out;
      rows[p.fileIndex].lastFile = p.lastFile;
    }
    renderTaskPanel();
  }

  /* ---------- 各页构建 ---------- */
  /* 文件卡片：id 带后缀（每页一份，HTML id 必须唯一，否则 $("#file-list") 只命中第一个） */
  function fileCard(suffix) {
    return `<div class="card">
      <div class="row" style="justify-content:space-between;margin-bottom:8px">
        <label id="file-count-${suffix}" style="font-weight:600;color:#334155"></label>
      </div>
      <div class="drop" id="drop-${suffix}">
        ${svg("pdf2img", "drop-ico")}
        <div class="t1">点击选择文件</div>
        <div class="t2">或拖拽到此处</div>
      </div>
      <div class="file-list" id="file-list-${suffix}" style="margin-top:8px"></div>
      <div class="pager" id="pager-${suffix}"></div>
    </div>`;
  }

  function pageConvert() {
    return `<div class="page" id="page-convert">
      <h2>格式转换</h2>
      <div class="subtabs">
        <span class="active" data-sub="s-office">Office → PDF</span>
        <span data-sub="s-p2w">PDF → Word</span>
        <span data-sub="s-ofmt">Office 互转</span>
      </div>
      <div class="subpage active" id="s-office">
        ${fileCard("s-office")}
        <button class="primary" id="go-office">开始转换为 PDF</button>
        <div class="hint">支持 doc / docx / xls / xlsx / ppt / pptx / rtf / odt / txt / ods / odp，
          输出与源文件同目录。复杂排版的 Word 与 Office 真实效果可能略有差异。</div>
      </div>
      <div class="subpage" id="s-p2w">
        ${fileCard("s-p2w")}
        <button class="primary" id="go-p2w">开始转换为 Word</button>
        <div class="hint">仅支持文字版 PDF（扫描件请先用 OCR 识别）。输出名固定为 原名.docx。</div>
      </div>
      <div class="subpage" id="s-ofmt">
        ${fileCard("s-ofmt")}
        <div class="row"><label>目标格式</label>
        <select id="ofmt-target">
          <option value="html">HTML 网页</option>
          <option value="docx">Word (docx)</option>
          <option value="xlsx">Excel (xlsx)</option>
          <option value="pptx">PowerPoint (pptx)</option>
          <option value="odt">ODF 文字 (odt)</option>
          <option value="ods">ODF 表格 (ods)</option>
          <option value="odp">ODF 演示 (odp)</option>
          <option value="rtf">RTF</option>
        </select></div>
        <button class="primary" id="go-ofmt">开始转换</button>
        <div class="hint">由 LibreOffice 引擎转换，个别格式组合可能不支持（如 ppt→xlsx），失败会在任务列表提示。
          输出与源文件同目录。</div>
      </div>
    </div>`;
  }

  function pagePages() {
    const ops = [["merge", "合并多个 PDF"], ["split", "拆分（每页一个文件）"],
      ["extract", "提取页码"], ["delete", "删除页码"], ["rotate", "旋转页面"]];
    return `<div class="page" id="page-pages">
      <h2>PDF 页面工具</h2>
      <div class="card"><h3>操作</h3>
        <div class="row"><select id="op-sel">${ops.map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}</select>
        <input type="text" id="op-pages" placeholder="页码，如 1,3-5" style="display:none">
        <select id="op-rotate" style="display:none">
          <option value="90">旋转 90°</option><option value="180">旋转 180°</option><option value="270">旋转 270°</option>
        </select></div>
        <div class="hint" id="op-hint"></div>
      </div>
      ${fileCard("pages")}
      <button class="primary" id="go-pages">开始处理</button>
    </div>`;
  }

  /* 金额大写 / 时间计算 / 待办三个工具页：纯前端计算 + 待办走 IPC 持久化 */
  function pageAmount() {
    return `<div class="page" id="page-amount">
      <h2>金额大写转换</h2>
      <div class="card"><h3>金额 → 大写</h3>
        <div class="row"><label>小写金额</label>
        <input type="text" id="amt-in" placeholder="如 1234.56 或 1,234.56" style="min-width:220px"></div>
        <div class="row"><label>大写金额</label>
        <output id="amt-out" style="font-size:16px;color:#1e293b;min-height:24px">—</output></div>
        <div class="hint">支持负数与最多两位小数；分位按第三位四舍五入。可直接粘贴含逗号/¥/「元」的文本。</div>
      </div>
      <div class="card"><h3>常用金额速查</h3>
        <div class="row" id="amt-quick">
          <button class="small" data-amt="100">100</button>
          <button class="small" data-amt="1000">1,000</button>
          <button class="small" data-amt="10000">10,000</button>
          <button class="small" data-amt="100000">100,000</button>
          <button class="small" data-amt="1000000">100万</button>
          <button class="small" data-amt="1234.56">1,234.56</button>
        </div>
        <div class="hint">点击填入上方输入框。</div>
      </div>
    </div>`;
  }

  function pageTime() {
    return `<div class="page" id="page-time">
      <h2>时间计算器</h2>
      <div class="card"><h3>日期间隔</h3>
        <div class="row"><label>开始</label><input type="text" id="dt-a" placeholder="YYYY-MM-DD">
        <label>结束</label><input type="text" id="dt-b" placeholder="YYYY-MM-DD">
        <button class="small" id="dt-calc">计算</button></div>
        <div class="row" id="dt-diff"></div>
        <div class="hint">间隔天数 = 结束 − 开始（不含首日）。结束早于开始时自动交换。</div>
      </div>
      <div class="card"><h3>工作日推算</h3>
        <div class="row"><label>起始日</label><input type="text" id="wd-start" placeholder="YYYY-MM-DD">
        <label>天数</label><input type="number" id="wd-days" value="10" min="1" max="2000" style="min-width:70px">
        <button class="small" id="wd-calc">推算</button></div>
        <div class="row" id="wd-out"></div>
        <div class="hint">从起始日次日开始数 N 个工作日（跳过周六周日），给出截止日与中间经历的周末数。</div>
      </div>
      <div class="card"><h3>日期相加</h3>
        <div class="row"><label>基准日</label><input type="text" id="ad-start" placeholder="YYYY-MM-DD">
        <label>天数</label><input type="number" id="ad-days" value="30" style="min-width:80px">
        <button class="small" id="ad-calc">计算</button></div>
        <div class="row" id="ad-out"></div>
        <div class="hint">自然日加减，可为负数。跨月跨年与闰年 2 月 29 日均已处理。</div>
      </div>
    </div>`;
  }

  function pageTodo() {
    return `<div class="page" id="page-todo">
      <h2>待办列表</h2>
      <div class="card">
        <div class="row"><input type="text" id="todo-in" placeholder="输入待办事项，回车添加" style="flex:1;min-width:240px">
        <button class="primary" id="todo-add" style="padding:7px 18px;font-size:14px">添加</button></div>
        <div class="row"><label class="hint">
          <input type="checkbox" id="todo-hide-done"> 隐藏已完成</label>
          <span class="hint" id="todo-count"></span>
          <button class="link" id="todo-clear-done" style="margin-left:auto">清除已完成</button></div>
        <div id="todo-list" class="todo-list"></div>
      </div>
    </div>`;
  }

  function pageToc() {
    return `<div class="page" id="page-tocpage">
      <h2>目录书签</h2>
      <div class="card"><h3>自动生成</h3>
        <div class="row"><label>标题字号阈值</label>
        <input type="number" id="toc-minsize" value="14" min="6" max="48" step="1" style="min-width:80px">
        <span class="hint">字号不小于该值的文字行视为标题</span></div>
        <div class="hint">自动按每页文本字号识别一级标题。识别不准时请在下方手动编辑。</div>
      </div>
      <div class="card"><h3>手动编辑 / 读取</h3>
        <div class="row" style="justify-content:space-between">
          <span class="hint">每行一条：层级|标题|页码（如 <code>1|第一章 概述|3</code>）。层级 1=一级。</span>
          <button class="small" id="toc-load">读取当前书签</button>
        </div>
        <textarea id="toc-items" placeholder="1|第一章 概述|1&#10;1|第二章 方案|4"></textarea>
        <div class="hint">有内容 = 按此设置书签；清空 = 按上方阈值自动生成。</div>
      </div>
      ${fileCard("tocpage")}
      <button class="primary" id="go-toc">开始处理</button>
    </div>`;
  }

  function pageMisc() {
    const ops = [["number", "加页码"], ["metadata", "清除元数据"],
      ["reorder", "页面重排"], ["crop", "裁剪边距"]];
    return `<div class="page" id="page-misc">
      <h2>PDF 整理</h2>
      <div class="card"><h3>操作</h3>
        <div class="row"><select id="misc-sel">${ops.map(([v, n]) => `<option value="${v}">${n}</option>`).join("")}</select>
        <span id="misc-num-opts">
          <select id="num-pos">
            <option value="bottom-center">页脚居中</option><option value="bottom-right">页脚右侧</option>
            <option value="bottom-left">页脚左侧</option><option value="top-center">页眉居中</option>
          </select>
          <select id="num-fmt">
            <option value="第{n}页">第N页</option><option value="{n}">N</option>
            <option value="第{n}页/共{total}页">第N页/共M页</option><option value="-{n}-">-N-</option>
          </select>
          <select id="num-color">
            <option value="gray">灰色</option><option value="black">黑色</option>
            <option value="red">红色</option><option value="blue">蓝色</option>
          </select>
          <label>起始</label><input type="number" id="num-start" value="1" min="1" step="1" style="min-width:64px">
        </span>
        <span id="misc-reorder-opts" style="display:none">
          <input type="text" id="reorder-order" placeholder="如 3,1-2,5（须覆盖全部页）" style="min-width:240px">
        </span>
        <span id="misc-crop-opts" style="display:none">
          <label>裁边距</label><input type="number" id="crop-margin" value="10" min="0" max="200" style="min-width:64px"><span class="hint">pt</span>
        </span>
        </div>
        <div class="hint" id="misc-hint"></div>
      </div>
      ${fileCard("misc")}
      <button class="primary" id="go-misc">开始处理</button>
    </div>`;
  }

  function pageCompress() {
    return `<div class="page" id="page-compress">
      <h2>PDF 压缩</h2>
      <div class="card"><h3>压缩质量</h3>
        <div class="row"><select id="level-sel">
          <option value="screen">普通（72dpi，体积最小）</option>
          <option value="ebook" selected>均衡（150dpi，推荐）</option>
          <option value="printer">高质量（300dpi，轻微压缩）</option>
        </select></div>
        <div class="hint">压缩会降低图片精度以减小体积，文字清晰度不受影响。</div>
      </div>
      ${fileCard("compress")}
      <button class="primary" id="go-compress">开始压缩</button>
    </div>`;
  }

  function pagePdf2Img() {
    return `<div class="page" id="page-pdf2img">
      <h2>PDF 转图片</h2>
      <div class="card"><h3>选项</h3>
        <div class="row"><label>分辨率 DPI</label>
        <input type="number" id="dpi-inp" value="150" min="72" max="600" step="1">
        <select id="fmt-sel"><option value="png">PNG（无损）</option><option value="jpg">JPG（体积小）</option></select></div>
        <div class="hint">150dpi 足够屏幕查看；300dpi 适合打印。页数多时输出文件也较多。</div>
      </div>
      ${fileCard("pdf2img")}
      <button class="primary" id="go-pdf2img">开始转换</button>
    </div>`;
  }

  function pageImg2Pdf() {
    return `<div class="page" id="page-img2pdf">
      <h2>图片转 PDF</h2>
      <div class="card"><h3>图片</h3>
        <div class="hint">可一张图一页合成一个 PDF。当前按所选文件顺序合并，如需排序请逐张生成后使用 PDF 合并。</div>
      </div>
      ${fileCard("img2pdf")}
      <button class="primary" id="go-img2pdf">开始合成</button>
    </div>`;
  }

  function pageImgCompress() {
    return `<div class="page" id="page-imgcompress">
      <h2>图片压缩</h2>
      <div class="card"><h3>选项</h3>
        <div class="row"><label>压缩质量</label><select id="ic-mode">
          <option value="q30" selected>强力（质量 30，体积最小）</option>
          <option value="q60">均衡（质量 60，推荐）</option>
          <option value="q85">轻度（质量 85，接近原画质）</option></select>
        <label>缩放</label><select id="ic-scale">
          <option value="0" selected>不缩放</option>
          <option value="100">100%（不缩放）</option>
          <option value="75">75%</option><option value="50">50%</option><option value="25">25%</option></select></div>
        <div class="hint">JPG 按质量重编码；PNG 无损格式仅在缩放时重编码（不缩放时直接输出）。
          处理后输出「原名-压缩.jpg/png」到源文件同目录。</div>
      </div>
      ${fileCard("imgcompress")}
      <button class="primary" id="go-imgcompress">开始压缩</button>
    </div>`;
  }

  function pageOcr() {
    return `<div class="page" id="page-ocr">
      <h2>OCR 文字识别</h2>
      <div class="card"><h3>输出</h3>
        <div class="row"><label>输出类型</label><select id="ocr-mode">
          <option value="txt">TXT 文本</option><option value="searchable">可搜索 PDF</option></select>
        <label>识别精度 DPI</label><select id="ocr-dpi">
          <option value="150">150（快）</option><option value="300">300（准，较慢）</option></select></div>
        <div class="hint">支持中文简体+英文。扫描件识别效果取决于原件清晰度。</div>
      </div>
      ${fileCard("ocr")}
      <button class="primary" id="go-ocr">开始识别</button>
    </div>`;
  }

  function pageSecurity() {
    return `<div class="page" id="page-security">
      <h2>加密与水印</h2>
      <div class="subtabs">
        <span class="active" data-sub="u-enc">加密</span>
        <span data-sub="u-dec">解密</span>
        <span data-sub="u-wm">文字水印</span>
      </div>
      <div class="subpage active" id="u-enc">
        <div class="card"><h3>设置密码</h3>
          <div class="row"><label>打开密码</label><input type="password" id="enc-pw" placeholder="至少 4 位"></div>
          <div class="row"><label>权限密码（可选）</label><input type="password" id="enc-opw" placeholder="默认同打开密码"></div>
        </div>
        ${fileCard("u-enc")}
        <button class="primary" id="go-enc">开始加密（AES-256）</button>
      </div>
      <div class="subpage" id="u-dec">
        <div class="card"><h3>输入密码</h3>
          <div class="row"><label>文件密码</label><input type="password" id="dec-pw"></div>
        </div>
        ${fileCard("u-dec")}
        <button class="primary" id="go-dec">开始解密</button>
      </div>
      <div class="subpage" id="u-wm">
        <div class="card"><h3>水印</h3>
          <div class="row"><label>文字</label><input type="text" id="wm-text" value="内部资料" style="min-width:200px">
          <label>透明度</label><input type="range" id="wm-opacity" min="0.05" max="0.5" step="0.05" value="0.15">
          <span id="wm-opv">15%</span></div>
          <div class="row"><label>倾斜角度</label><select id="wm-angle">
            <option value="0">0°（水平）</option><option value="30">30°</option>
            <option value="45" selected>45°（默认）</option><option value="60">60°</option></select>
          <label>颜色</label><select id="wm-color">
            <option value="gray" selected>灰色</option><option value="red">红色</option>
            <option value="blue">蓝色</option></select>
          <label><input type="checkbox" id="wm-tile" checked> 整页平铺</label></div>
        </div>
        ${fileCard("u-wm")}
        <button class="primary" id="go-wm">开始加水印</button>
      </div>
    </div>`;
  }

  function pageSettings() {
    return `<div class="page" id="page-settings">
      <h2>设置</h2>
      <div class="card"><h3>输出目录</h3>
        <div class="row"><label><input type="radio" name="outmode" value="same" checked> 与源文件相同</label>
        <label><input type="radio" name="outmode" value="fixed"> 固定目录</label>
        <input type="text" id="set-fixed" placeholder="选择目录" readonly>
        <button id="set-browse">浏览…</button></div>
      </div>
      <div class="card"><h3>默认参数</h3>
        <div class="row"><label>PNG/JPG DPI</label><input type="number" id="set-dpi" value="150" min="72" max="600"></div>
        <div class="row"><label>压缩质量</label><select id="set-level">
          <option value="screen">普通</option><option value="ebook" selected>均衡</option><option value="printer">高质量</option>
        </select></div>
        <div class="row"><label>OCR 语言</label><select id="set-lang">
          <option value="chi_sim+eng" selected>中文+英文</option><option value="eng">英文</option>
        </select></div>
        <div class="row"><label>水印文字</label><input type="text" id="set-wmtext" value="内部资料"></div>
        <div class="row"><label>水印透明度</label><input type="range" id="set-wmop" min="0.05" max="0.5" step="0.05" value="0.15">
        <span id="set-wmopv">15%</span></div>
      </div>
      <div class="card"><h3>维护</h3>
        <div class="row"><button id="set-openlog">打开日志目录</button>
        <button id="set-reset" class="danger">恢复默认设置</button>
        <span class="hint">排障时请把最新日志发给维护人员</span></div>
      <div class="hint">版本 1.4.0 · 完全离线运行 · 安装包约 800MB（含 LibreOffice/Ghostscript/Tesseract/Python 引擎）</div>
      <div class="hint">开源许可：GPL-3.0-or-later，第三方声明见安装目录 <code>licenses\THIRD-PARTY-NOTICES.md</code></div></div>
    </div>`;
  }

  /* ---------- 初始化 ---------- */
  function buildPages() {
    $("#pages").innerHTML =
      pageConvert() + pageAmount() + pageTime() + pageTodo() + pagePages() + pageToc() + pageMisc() + pageCompress() + pagePdf2Img() +
      pageImg2Pdf() + pageImgCompress() + pageOcr() + pageSecurity() + pageSettings() + `
      <div class="card" id="task-card">
        <h3>任务记录 <span id="task-summary"></span>
        <button class="primary" id="btn-cancel" style="display:none;margin-left:auto;padding:4px 14px;font-size:13px">取消任务</button>
        <button class="link" id="btn-open-out" style="display:none">打开输出目录</button></h3>
        <div class="progress"><div class="progress-bar" id="task-progress"></div></div>
        <div class="tip" id="tip-first" style="display:none">
          ${svg("convert")}<div>支持拖拽多个文件批量处理，任务进行中可随时取消。</div>
          <span class="tip-x" id="tip-x">×</span>
        </div>
        <table id="task-table"><thead><tr>
        <th>#</th><th>文件</th><th>状态</th><th>信息</th><th>操作</th></tr></thead><tbody id="task-body">
        <tr><td colspan="5">暂无任务</td></tr></tbody></table>
        <div class="pager" id="task-pager"></div>
      </div>`;

    bindCommon();
    bindConvert(); bindAmount(); bindTime(); bindTodo();
    bindPages(); bindToc(); bindMisc(); bindCompress(); bindPdf2Img();
    bindImg2Pdf(); bindImgCompress(); bindOcr(); bindSecurity(); bindSettings();
  }

  function bindCommon() {
    // 拖拽区：当前页 drop 绑到 state（文件选择对该页生效）
    $$(".drop").forEach((d) => {
      d.addEventListener("click", async () => {
        // 点击/选择前先锁定当前列表宿主与文件类型（每页一份列表，id 唯一）
        activeList = suffixOf(d);
        emptyHint = EMPTY_HINTS[activeList] || emptyHint;
        const files = await window.kit.selectFiles(emptyHint.kind || null);
        if (files && files.length) setFiles(state.files.concat(files));
      });
      d.addEventListener("dragover", (e) => { e.preventDefault(); d.classList.add("over"); });
      d.addEventListener("dragleave", () => d.classList.remove("over"));
      d.addEventListener("drop", (e) => {
        e.preventDefault(); d.classList.remove("over");
        activeList = suffixOf(d);
        emptyHint = EMPTY_HINTS[activeList] || emptyHint;
        // File.path 是正斜杠混合路径，norm 成反斜杠（否则 sidecar/stat/open 全出错）
        const files = Array.from(e.dataTransfer.files).map((f) => norm(f.path));
        if (files.length) setFiles(state.files.concat(files));
      });
    });
    if (window.kit && window.kit.onUpdate) {
      try { window.kit.onUpdate(onUpdate); } catch (e) { console.error("事件监听失败:", e); }
    }
    $("#btn-open-out").addEventListener("click", () => {
      const last = (taskRows.get(currentTask) || []).filter((r) => r.out).pop();
      if (last && last.out) window.kit.openOut(last.out);
    });
    $("#btn-cancel").addEventListener("click", () => {
      if (!currentTask) return;
      window.kit.cancelTask(currentTask);
      taskActive = false;
      stopElapsedTimer();
      const rows = taskRows.get(currentTask) || [];
      rows.forEach((r) => { if (r.status === "queued" || r.status === "running") r.status = "cancelled"; });
      taskElapsed = elapsedText();
      renderTaskPanel();
    });
    const tip = $("#tip-first");
    if (tip && !settings.seen) tip.style.display = "";
    $("#tip-x").addEventListener("click", () => {
      tip.style.display = "none";
      settings.seen = 1;
      window.kit.setSettings({ ...settings });
    });
  }

  function bindSubtabs() {
    $$(".subtabs").forEach((st) => {
      $$("span", st).forEach((sp) => sp.addEventListener("click", () => {
        $$("span", st).forEach((x) => x.classList.remove("active"));
        sp.classList.add("active");
        $$(".subpage").forEach((p) => p.classList.remove("active"));
        $("#" + sp.dataset.sub).classList.add("active");
        // 子页切换后文件列表宿主跟着切（每子页一份列表）
        activeList = sp.dataset.sub;
        emptyHint = EMPTY_HINTS[sp.dataset.sub] || emptyHint;
        renderFileList();
      }));
    });
  }

  function hintPages() {
    const v = $("#op-sel").value;
    const show = (pages, rot) => { $("#op-pages").style.display = pages ? "" : "none"; $("#op-rotate").style.display = rot ? "" : "none"; };
    $("#op-hint").textContent = {
      merge: "按住 Ctrl 多选（或拖入多个文件），按所选顺序合成一个 PDF。每个文件可在下方列表中填页码（如 1,3-5），留空=全部页。",
      split: "按下方列表中每个文件填的页码拆成单页 PDF（如填 2,5 只出 _p2/_p5），留空=每页都拆。",
      extract: "按下方列表中每个文件填的页码提取为新 PDF（每个文件独立，各输出 原名-提取.pdf），留空=只取第 1 页。",
      delete: "按下方列表中每个文件填的页码删除页面（每个文件独立），留空=不删页（输出与原文件一致）。",
      rotate: "全部页面或指定页码旋转。",
    }[v] || "";
    // 全局页码框只剩 rotate 用；merge/split/delete/extract 全走行内每文件输入
    const perFile = v === "merge" || v === "split" || v === "delete" || v === "extract";
    show(!perFile, v === "rotate");
    // 每文件页码输入框：merge/split/delete/extract 显示，四个 op 均为每文件独立
    $("#file-list-pages").classList.toggle("show-spec", perFile);
  }

  function bindConvert() {
    bindSubtabs();
    $("#go-office").addEventListener("click", () => submit("office2pdf", {}));
    $("#go-p2w").addEventListener("click", () => submit("pdf2word", {}));
    $("#go-ofmt").addEventListener("click", () => submit("office_convert", { target: $("#ofmt-target").value }));
  }

  function bindPages() {
    hintPages();
    $("#op-sel").addEventListener("change", hintPages);
    $("#go-pages").addEventListener("click", () => {
      const op = $("#op-sel").value;
      const opts = { pages: $("#op-pages").value.trim(), rotate: $("#op-rotate").value };
      // merge/split/delete/extract：每文件页码串按下标对齐（留空语义见各 op 提示）
      if (op === "merge" || op === "split" || op === "delete" || op === "extract") {
        opts.pageSpecs = state.files.map((f) => fileSpecs.get(f) || "");
      }
      submit("pdf_" + (op === "merge" ? "merge" : op), opts);
    });
  }

  /* ---------- 金额大写 / 时间计算 / 待办：纯前端工具，不走任务队列 ---------- */
  function bindAmount() {
    const show = () => {
      const v = $("#amt-in").value;
      if (!v.trim()) { $("#amt-out").textContent = "—"; return; }
      const cn = amountToCn(v);
      $("#amt-out").textContent = cn === null ? "无法识别：请输入数字（如 1234.56）" : cn;
    };
    $("#amt-in").addEventListener("input", show);
    $$("#amt-quick [data-amt]").forEach((b) => b.addEventListener("click", () => {
      $("#amt-in").value = b.dataset.amt.replace(/,/g, "");
      show();
    }));
  }

  function bindTime() {
    const span = (a, b) => {
      const total = daysBetween(a, b);
      const years = a.getFullYear() === b.getFullYear()
        ? 0 : b.getFullYear() - a.getFullYear();
      const months = (b.getFullYear() - a.getFullYear()) * 12
        + (b.getMonth() - a.getMonth()) - (b.getDate() < a.getDate() ? 1 : 0);
      const wd = workdaysBetween(a, b) - 1;   // 间隔内工作日（不含首日）
      return `共 <b>${total}</b> 天 = ${(total / 7).toFixed(1)} 周 ≈ ${Math.floor(total / 30)} 个月`
        + `；折合 ${months} 个整月 ${years} 年；工作日 <b>${Math.max(0, wd)}</b> 天`;
    };
    const calc = () => {
      const a = parseDateStr($("#dt-a").value), b = parseDateStr($("#dt-b").value);
      const box = $("#dt-diff");
      if (!a || !b) { box.innerHTML = '<span class="hint">请输入两个有效日期（YYYY-MM-DD）</span>'; return; }
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      box.innerHTML = `<span>${fmtDate(lo)} → ${fmtDate(hi)}：${span(lo, hi)}</span>`
        + (a > b ? ' <span class="hint">（已自动交换，结束早于开始）</span>' : "");
    };
    $("#dt-calc").addEventListener("click", calc);
    $("#dt-a").addEventListener("keydown", (e) => { if (e.key === "Enter") calc(); });
    $("#dt-b").addEventListener("keydown", (e) => { if (e.key === "Enter") calc(); });

    const wd = () => {
      const a = parseDateStr($("#wd-start").value);
      const n = Number($("#wd-days").value) || 0;
      const box = $("#wd-out");
      if (!a || n < 1) { box.innerHTML = '<span class="hint">请输入有效起始日与天数（≥1）</span>'; return; }
      let left = n, d = a, weekends = 0;
      while (left > 0) {
        d = addDays(d, 1);
        const w = d.getDay();
        if (w === 0 || w === 6) weekends++;
        else left--;
      }
      box.innerHTML = `<span>${fmtDate(a)} 后第 <b>${n}</b> 个工作日 → <b>${fmtDate(d)}</b>`
        + `（跨 ${weekends} 个周末日）</span>`;
    };
    $("#wd-calc").addEventListener("click", wd);
    $("#wd-start").addEventListener("keydown", (e) => { if (e.key === "Enter") wd(); });

    const ad = () => {
      const a = parseDateStr($("#ad-start").value);
      const n = Number($("#ad-days").value) || 0;
      const box = $("#ad-out");
      if (!a) { box.innerHTML = '<span class="hint">请输入有效起始日</span>'; return; }
      const w = new Date(a.getFullYear(), a.getMonth(), a.getDate() + n).getDay();
      const names = ["日", "一", "二", "三", "四", "五", "六"];
      box.innerHTML = `<span>${fmtDate(a)} ${n >= 0 ? "+" : ""}${n} 天 = <b>${fmtDate(addDays(a, n))}</b>`
        + `（周${names[w]}）</span>`;
    };
    $("#ad-calc").addEventListener("click", ad);
    $("#ad-start").addEventListener("keydown", (e) => { if (e.key === "Enter") ad(); });
  }

  /* 待办：item {id, text, done}，主进程 JSON 文件持久化（APP_DIR/todos.json） */
  let todos = [];
  function renderTodos() {
    const hide = $("#todo-hide-done").checked;
    const list = hide ? todos.filter((t) => !t.done) : todos;
    $("#todo-count").textContent = todos.length
      ? `共 ${todos.length} 项，完成 ${todos.filter((t) => t.done).length} 项` : "";
    $("#todo-list").innerHTML = list.length ? list.map((t) => `
      <div class="todo-item${t.done ? " done" : ""}" data-id="${t.id}">
        <input type="checkbox" data-tg="${t.id}" ${t.done ? "checked" : ""}>
        <span class="tt">${esc(t.text)}</span>
        <button class="link" data-td="${t.id}">删除</button>
      </div>`).join("") : '<div class="hint" style="padding:12px;text-align:center">暂无待办，输入内容后回车添加</div>';
    $$("[data-tg]").forEach((cb) => cb.addEventListener("change", () => {
      const it = todos.find((x) => x.id === cb.dataset.tg);
      if (it) { it.done = cb.checked; saveTodos(); }
    }));
    $$("[data-td]").forEach((b) => b.addEventListener("click", () => {
      todos = todos.filter((x) => x.id !== b.dataset.td);
      saveTodos();
    }));
  }
  async function saveTodos() {
    renderTodos();
    try { await window.kit.todoSave(todos); } catch (e) { console.error("待办保存失败", e); }
  }
  function bindTodo() {
    $("#todo-add").addEventListener("click", addTodo);
    $("#todo-in").addEventListener("keydown", (e) => { if (e.key === "Enter") addTodo(); });
    $("#todo-hide-done").addEventListener("change", renderTodos);
    $("#todo-clear-done").addEventListener("click", () => {
      todos = todos.filter((t) => !t.done);
      saveTodos();
    });
    window.kit.todoLoad().then((list) => { todos = Array.isArray(list) ? list : []; renderTodos(); })
      .catch(() => { todos = []; renderTodos(); });
  }
  function addTodo() {
    const v = $("#todo-in").value.trim();
    if (!v) return;
    todos.push({ id: "t" + Date.now() + Math.random().toString(36).slice(2, 6), text: v, done: false });
    $("#todo-in").value = "";
    saveTodos();
  }

  /* PDF 整理页：op 切换显隐对应参数行 */
  function hintMisc() {
    const v = $("#misc-sel").value;
    $("#misc-num-opts").style.display = v === "number" ? "" : "none";
    $("#misc-reorder-opts").style.display = v === "reorder" ? "" : "none";
    $("#misc-crop-opts").style.display = v === "crop" ? "" : "none";
    $("#misc-hint").textContent = {
      number: "在页脚/页眉写入页码，可按下方列表逐个文件处理。",
      metadata: "清除标题/作者/主题/关键字/制作工具等元数据，防外发泄露。输出 原名-清除元数据.pdf。",
      reorder: "填写新页序（如 3,1-2,5，须覆盖全部页且不重复），按新顺序重排输出。",
      crop: "四边同裁指定 pt（20pt≈0.7cm），只改显示边框不影响内容。",
    }[v] || "";
  }

  function bindToc() {
    $("#toc-load").addEventListener("click", async () => {
      const f = state.files[0];
      if (!f) { alert("请先选择文件"); return; }
      const btn = $("#toc-load");
      btn.disabled = true;
      try {
        const r = await window.kit.tocGet(f);
        if (r && r.error) { alert(r.error); return; }
        const items = (r && r.toc) || [];
        $("#toc-items").value = items.map(([l, t, p]) => `${l}|${t}|${p}`).join("\n");
        if (!items.length) alert("该文件没有书签，可用上方阈值自动生成");
      } catch (e) {
        alert(String((e && e.message) || e));
      } finally {
        btn.disabled = false;
      }
    });
    $("#go-toc").addEventListener("click", () => {
      const raw = $("#toc-items").value.trim();
      const opts = { minSize: Number($("#toc-minsize").value) || 14 };
      if (raw) {
        const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        const items = [];
        for (let i = 0; i < lines.length; i++) {
          const parts = lines[i].split("|").map((s) => s.trim());
          if (parts.length !== 3 || !Number(parts[0]) || !Number(parts[2])) {
            alert(`第 ${i + 1} 行格式应为 层级|标题|页码`);
            return;
          }
          items.push([Number(parts[0]), parts[1], Number(parts[2])]);
        }
        opts.mode = "set";
        opts.items = items;
      } else {
        opts.mode = "auto";
      }
      submit("toc", opts);
    });
  }

  function bindMisc() {
    hintMisc();
    $("#misc-sel").addEventListener("change", hintMisc);
    $("#go-misc").addEventListener("click", () => {
      const op = $("#misc-sel").value;
      if (op === "number") {
        submit("number", {
          start: Number($("#num-start").value) || 1,
          pos: $("#num-pos").value, fmt: $("#num-fmt").value, color: $("#num-color").value,
        });
      } else if (op === "metadata") {
        submit("metadata", { mode: "clear" });
      } else if (op === "reorder") {
        const order = $("#reorder-order").value.trim();
        if (!order) { alert("请填写新页序，如 3,1-2,5"); return; }
        submit("reorder", { order });
      } else {
        submit("crop", { margin: Number($("#crop-margin").value) || 0 });
      }
    });
  }

  function bindCompress() {
    $("#go-compress").addEventListener("click", () => submit("pdf_compress", {}));
  }

  function bindPdf2Img() {
    $("#go-pdf2img").addEventListener("click", () => submit("pdf2img", {
      fmt: $("#fmt-sel").value, dpi: Number($("#dpi-inp").value) || 150,
    }));
  }

  function bindImg2Pdf() {
    $("#go-img2pdf").addEventListener("click", () => submit("img2pdf", {}));
  }

  function bindImgCompress() {
    $("#go-imgcompress").addEventListener("click", () => {
      const m = $("#ic-mode").value;
      submit("imgcompress", {
        quality: Number(m.slice(1)) || 60,
        scale: Number($("#ic-scale").value) || 0,
      });
    });
  }

  function bindOcr() {
    $("#go-ocr").addEventListener("click", () => submit("ocr", {
      mode: $("#ocr-mode").value, dpi: Number($("#ocr-dpi").value) || 150,
    }));
  }

  function bindSecurity() {
    bindSubtabs();
    $("#go-enc").addEventListener("click", () => submit("encrypt", {
      user_pw: $("#enc-pw").value, owner_pw: $("#enc-opw").value,
    }));
    $("#go-dec").addEventListener("click", () => submit("decrypt", { password: $("#dec-pw").value }));
    $("#go-wm").addEventListener("click", () => submit("watermark", {
      text: $("#wm-text").value.trim() || "内部资料",
      opacity: Number($("#wm-opacity").value),
      rotate: Number($("#wm-angle").value),
      color: $("#wm-color").value,
      tile: $("#wm-tile").checked,
    }));
    const sync = () => { $("#wm-opv").textContent = Math.round($("#wm-opacity").value * 100) + "%"; };
    $("#wm-opacity").addEventListener("input", sync); sync();
  }

  async function refreshSettingsForm() {
    settings = await window.kit.getSettings();
    $$("input[name=outmode]").forEach((r) => { r.checked = r.value === settings.outDirMode; });
    $("#set-fixed").value = settings.fixedOutDir || "";
    $("#set-dpi").value = settings.pdfDpi;
    $("#set-level").value = settings.compressLevel;
    $("#set-lang").value = settings.ocrLang;
    $("#set-wmtext").value = settings.watermarkText;
    $("#set-wmop").value = settings.watermarkOpacity;
    $("#set-wmopv").textContent = Math.round(settings.watermarkOpacity * 100) + "%";
  }

  function bindSettings() {
    const save = async () => {
      const mode = $("input[name=outmode]:checked").value;
      await window.kit.setSettings({
        ...settings, outDirMode: mode,
        fixedOutDir: $("#set-fixed").value,
        pdfDpi: Number($("#set-dpi").value) || 150,
        compressLevel: $("#set-level").value, ocrLang: $("#set-lang").value,
        watermarkText: $("#set-wmtext").value,
        watermarkOpacity: Number($("#set-wmop").value),
      });
    };
    $$("input[name=outmode], #set-dpi, #set-level, #set-lang, #set-wmtext, #set-wmop")
      .forEach((el) => el.addEventListener("change", save));
    $("#set-wmop").addEventListener("input", () => {
      $("#set-wmopv").textContent = Math.round($("#set-wmop").value * 100) + "%";
    });
    $("#set-browse").addEventListener("click", async () => {
      const dir = await window.kit.pickOutDir();
      if (dir) { $("#set-fixed").value = dir; save(); }
    });
    $("#set-openlog").addEventListener("click", () => window.kit.openLogDir());
    $("#set-reset").addEventListener("click", async () => {
      await window.kit.setSettings({});
      await refreshSettingsForm();
    });
  }

  /* ---------- 启动 ---------- */
  window.addEventListener("DOMContentLoaded", async () => {
    try { settings = await window.kit.getSettings(); }
    catch (e) { console.error("读取设置失败，使用默认值:", e); settings = {}; }
    settings = { pdfDpi: 150, compressLevel: "ebook", ocrLang: "chi_sim+eng",
                 watermarkText: "内部资料", watermarkOpacity: 0.15, watermarkTile: true,
                 outDirMode: "same", fixedOutDir: "", ...settings };
    buildPages();   // 先建页面，否则 showPage 找不到 .page 节点
    buildNav();     // buildNav 内会 showPage("convert") 激活首屏
    renderFileList();
    renderTaskPanel();
    // 预加载桥缺失时兜底：提交任务给出明确提示而不是静默失败
    if (!window.kit) {
      document.body.insertAdjacentHTML("beforeend",
        '<div style="position:fixed;left:0;right:0;bottom:0;background:#d0392b;color:#fff;padding:8px 14px;font-size:13px">' +
        '窗口初始化异常（preload 未注入）。请重启应用；若持续出现请重装。</div>');
    }
  });
})();
