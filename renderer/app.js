/* 办公助手 renderer：原生 JS，无框架。
 * 左侧导航 7 项 + 右侧页面。文件列表分页（50/页）。任务面板增量更新。
 */
(function () {
  "use strict";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------- 页面定义 ---------- */
  const PAGES = [
    { id: "convert", name: "格式转换" },
    { id: "pages", name: "PDF 页面工具" },
    { id: "compress", name: "PDF 压缩" },
    { id: "pdf2img", name: "PDF 转图片" },
    { id: "img2pdf", name: "图片转 PDF" },
    { id: "ocr", name: "OCR 识别" },
    { id: "security", name: "加密与水印" },
    { id: "settings", name: "设置" },
  ];

  let settings = {};
  let currentTask = null;         // 当前任务 id
  const taskRows = new Map();     // taskId -> [{file, status, message, out}]
  let filePage = 0;
  const PAGE_SIZE = 50;

  const state = { files: [] };    // 当前页选择的文件

  /* ---------- 导航 ---------- */
  function buildNav() {
    const ul = $("#nav-list");
    ul.innerHTML = PAGES.map((p) =>
      `<li data-page="${p.id}"><span class="ico">▪</span>${p.name}</li>`).join("");
    $$("li", ul).forEach((li) => li.addEventListener("click", () => showPage(li.dataset.page)));
    showPage("convert");
  }

  function showPage(id) {
    $$("#nav-list li").forEach((li) => li.classList.toggle("active", li.dataset.page === id));
    $$(".page").forEach((p) => p.classList.toggle("active", p.id === "page-" + id));
    if (id === "settings") refreshSettingsForm();
  }

  /* ---------- 通用文件选择 ---------- */
  function setFiles(files) {
    state.files = files;
    filePage = 0;
    renderFileList();
  }

  function addDrop(dropEl, inpEl, multi) {
    const pick = async () => {
      const files = await window.kit.selectFiles();
      if (files && files.length) setFiles(multi ? state.files.concat(files) : files);
    };
    dropEl.addEventListener("click", pick);
    dropEl.addEventListener("dragover", (e) => { e.preventDefault(); dropEl.classList.add("over"); });
    dropEl.addEventListener("dragleave", () => dropEl.classList.remove("over"));
    dropEl.addEventListener("drop", (e) => {
      e.preventDefault(); dropEl.classList.remove("over");
      const files = Array.from(e.dataTransfer.files).map((f) => f.path);
      if (files.length) setFiles(multi ? state.files.concat(files) : files);
    });
  }

  function renderFileList() {
    const el = $("#file-list");
    if (!el) return;
    if (!state.files.length) {
      el.innerHTML = '<div class="empty">尚未选择文件</div>';
      $("#pager").innerHTML = "";
      return;
    }
    const start = filePage * PAGE_SIZE;
    const slice = state.files.slice(start, start + PAGE_SIZE);
    el.innerHTML = slice.map((f, i) => `
      <div class="fi"><span class="nm">${esc(f)}</span>
      <button class="small" data-rm="${start + i}">移除</button></div>`).join("");
    $$("[data-rm]", el).forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      state.files.splice(Number(b.dataset.rm), 1);
      renderFileList();
    }));
    const pages = Math.max(1, Math.ceil(state.files.length / PAGE_SIZE));
    $("#pager").innerHTML = state.files.length > PAGE_SIZE ? `
      <span>共 ${state.files.length} 个</span>
      <button class="small" id="pg-prev" ${filePage === 0 ? "disabled" : ""}>上一页</button>
      <span>${filePage + 1}/${pages}</span>
      <button class="small" id="pg-next" ${filePage >= pages - 1 ? "disabled" : ""}>下一页</button>` : "";
    const pp = $("#pg-prev"), pn = $("#pg-next");
    if (pp) pp.addEventListener("click", () => { filePage--; renderFileList(); });
    if (pn) pn.addEventListener("click", () => { filePage++; renderFileList(); });
  }

  /* ---------- 任务面板 ---------- */
  function submit(tool, options) {
    if (!state.files.length) { alert("请先选择文件"); return; }
    currentTask = "t" + Date.now();
    taskRows.set(currentTask, state.files.map((f) => ({ file: f, status: "queued", message: "" })));
    renderTaskPanel();
    window.kit.submitTask(tool, state.files.slice(), options);
  }

  function renderTaskPanel() {
    const tbody = $("#task-body");
    if (!tbody) return;
    const rows = taskRows.get(currentTask) || [];
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="4">暂无任务</td></tr>'; return; }
    const start = filePage * PAGE_SIZE;
    const slice = rows.slice(start, start + PAGE_SIZE);
    const STATUS = { queued: "等待", running: "处理中", done: "完成", error: "失败",
      cancelled: "已取消", finished: "结束" };
    tbody.innerHTML = slice.map((r, i) => `
      <tr><td>${start + i + 1}</td><td class="file">${esc(r.file)}</td>
      <td class="st st-${r.status}">${STATUS[r.status] || r.status}</td>
      <td>${esc(r.message || "")}</td></tr>`).join("");
    const done = rows.filter((r) => r.status === "done" || r.status === "error").length;
    $("#task-summary").textContent = `任务 ${currentTask}：共 ${rows.length} 个，已完成 ${done}`;
    $("#btn-open-out").style.display = done === rows.length && rows.length ? "" : "none";
  }

  function onUpdate(p) {
    if (p.taskId !== currentTask) return;
    const rows = taskRows.get(currentTask);
    if (!rows) return;
    if (p.status === "finished" || p.status === "cancelled" && p.fileIndex === 0) return;
    if (typeof p.fileIndex === "number" && rows[p.fileIndex]) {
      rows[p.fileIndex].status = p.status;
      rows[p.fileIndex].message = p.message || "";
      rows[p.fileIndex].out = p.out;
    }
    if (p.status === "finished") {
      rows.forEach((r) => { if (r.status === "queued") r.status = "cancelled"; });
    }
    renderTaskPanel();
  }

  /* ---------- 各页构建 ---------- */
  function fileCard(multi) {
    return `<div class="card">
      <div class="drop" id="drop">点击选择文件，或把文件拖到这里</div>
      <div class="file-list" id="file-list" style="margin-top:8px"></div>
      <div class="pager" id="pager"></div>
    </div>`;
  }

  function pageConvert() {
    return `<div class="page" id="page-convert">
      <h2>格式转换</h2>
      <div class="subtabs">
        <span class="active" data-sub="s-office">Office → PDF</span>
        <span data-sub="s-p2w">PDF → Word</span>
      </div>
      <div class="subpage active" id="s-office">
        ${fileCard(true)}
        <button class="primary" id="go-office">开始转换为 PDF</button>
        <div class="hint">支持 doc / docx / xls / xlsx / ppt / pptx / rtf / odt / txt / ods / odp，
          输出与源文件同目录。复杂排版的 Word 与 Office 真实效果可能略有差异。</div>
      </div>
      <div class="subpage" id="s-p2w">
        ${fileCard(true)}
        <button class="primary" id="go-p2w">开始转换为 Word</button>
        <div class="hint">仅支持文字版 PDF（扫描件请先用 OCR 识别）。输出名固定为 原名.docx。</div>
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
      ${fileCard(true)}
      <button class="primary" id="go-pages">开始处理</button>
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
      ${fileCard(true)}
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
      ${fileCard(true)}
      <button class="primary" id="go-pdf2img">开始转换</button>
    </div>`;
  }

  function pageImg2Pdf() {
    return `<div class="page" id="page-img2pdf">
      <h2>图片转 PDF</h2>
      <div class="card"><h3>图片</h3>
        <div class="hint">可一张图一页合成一个 PDF。当前按所选文件顺序合并，如需排序请逐张生成后使用 PDF 合并。</div>
      </div>
      ${fileCard(true)}
      <button class="primary" id="go-img2pdf">开始合成</button>
    </div>`;
  }

  function pageOcr() {
    return `<div class="page" id="page-ocr">
      <h2>OCR 文字识别</h2>
      <div class="card"><h3>输出</h3>
        <div class="row"><label>输出类型</label><select id="ocr-mode">
          <option value="txt">TXT 文本</option><option value="searchable">可搜索 PDF</option></select></div>
        <div class="hint">支持中文简体+英文。扫描件识别效果取决于原件清晰度。</div>
      </div>
      ${fileCard(true)}
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
        ${fileCard(true)}
        <button class="primary" id="go-enc">开始加密（AES-256）</button>
      </div>
      <div class="subpage" id="u-dec">
        <div class="card"><h3>输入密码</h3>
          <div class="row"><label>文件密码</label><input type="password" id="dec-pw"></div>
        </div>
        ${fileCard(true)}
        <button class="primary" id="go-dec">开始解密</button>
      </div>
      <div class="subpage" id="u-wm">
        <div class="card"><h3>水印</h3>
          <div class="row"><label>文字</label><input type="text" id="wm-text" value="内部资料" style="min-width:260px">
          <label>透明度</label><input type="range" id="wm-opacity" min="0.05" max="0.5" step="0.05" value="0.15">
          <span id="wm-opv">15%</span>
          <label><input type="checkbox" id="wm-tile" checked> 整页平铺</label></div>
        </div>
        ${fileCard(true)}
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
        <span class="hint">排障时请把最新日志发给维护人员</span></div>
      <div class="hint">版本 1.0.0 · 完全离线运行 · 安装包约 800MB（含 LibreOffice/Ghostscript/Tesseract/Python 引擎）</div></div>
    </div>`;
  }

  /* ---------- 初始化 ---------- */
  function buildPages() {
    $("#pages").innerHTML =
      pageConvert() + pagePages() + pageCompress() + pagePdf2Img() +
      pageImg2Pdf() + pageOcr() + pageSecurity() + pageSettings() + `
      <div class="card" id="task-card">
        <h3>任务 <span id="task-summary"></span>
        <button class="link" id="btn-open-out" style="display:none">打开输出目录</button></h3>
        <table id="task-table"><thead><tr>
        <th>#</th><th>文件</th><th>状态</th><th>信息</th></tr></thead><tbody id="task-body">
        <tr><td colspan="4">暂无任务</td></tr></tbody></table>
        <div class="pager" id="task-pager"></div>
      </div>`;

    bindCommon();
    bindConvert(); bindPages(); bindCompress(); bindPdf2Img();
    bindImg2Pdf(); bindOcr(); bindSecurity(); bindSettings();
  }

  function bindCommon() {
    // 拖拽区：当前页 drop 绑到 state（文件选择对该页生效）
    $$(".drop").forEach((d) => {
      d.addEventListener("click", async () => {
        const files = await window.kit.selectFiles();
        if (files && files.length) setFiles(state.files.concat(files));
      });
      d.addEventListener("dragover", (e) => { e.preventDefault(); d.classList.add("over"); });
      d.addEventListener("dragleave", () => d.classList.remove("over"));
      d.addEventListener("drop", (e) => {
        e.preventDefault(); d.classList.remove("over");
        const files = Array.from(e.dataTransfer.files).map((f) => f.path);
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
  }

  function bindSubtabs() {
    $$(".subtabs").forEach((st) => {
      $$("span", st).forEach((sp) => sp.addEventListener("click", () => {
        $$("span", st).forEach((x) => x.classList.remove("active"));
        sp.classList.add("active");
        $$(".subpage").forEach((p) => p.classList.remove("active"));
        $("#" + sp.dataset.sub).classList.add("active");
      }));
    });
  }

  function hintPages() {
    const v = $("#op-sel").value;
    const show = (pages, rot) => { $("#op-pages").style.display = pages ? "" : "none"; $("#op-rotate").style.display = rot ? "" : "none"; };
    $("#op-hint").textContent = {
      merge: "按住 Ctrl 多选（或拖入多个文件），按所选顺序合成一个 PDF。",
      split: "单文件 → 每页输出一个 原名_pN.pdf。",
      extract: "提取指定页码为新 PDF，如 1,3-5。",
      delete: "删除指定页码，输出为剩余页。",
      rotate: "全部页面或指定页码旋转。",
    }[v] || "";
    show(v === "extract" || v === "delete", v === "rotate");
    if (v !== "merge") $("#op-pages").style.display = (v === "rotate" ? "" : "");
  }

  function bindConvert() {
    bindSubtabs();
    $("#go-office").addEventListener("click", () => submit("office2pdf", {}));
    $("#go-p2w").addEventListener("click", () => submit("pdf2word", {}));
  }

  function bindPages() {
    hintPages();
    $("#op-sel").addEventListener("change", hintPages);
    $("#go-pages").addEventListener("click", () => {
      const op = $("#op-sel").value;
      const opts = { pages: $("#op-pages").value.trim(), rotate: $("#op-rotate").value };
      submit("pdf_" + (op === "merge" ? "merge" : op), opts);
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

  function bindOcr() {
    $("#go-ocr").addEventListener("click", () => submit("ocr", { mode: $("#ocr-mode").value }));
  }

  function bindSecurity() {
    bindSubtabs();
    $("#go-enc").addEventListener("click", () => submit("encrypt", {
      user_pw: $("#enc-pw").value, owner_pw: $("#enc-opw").value,
    }));
    $("#go-dec").addEventListener("click", () => submit("decrypt", { password: $("#dec-pw").value }));
    $("#go-wm").addEventListener("click", () => submit("watermark", {}));
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
