# 办公助手

完全离线的 Windows 办公工具合集：Word/Office 转 PDF、PDF 转 Word、PDF 页面处理、压缩、PDF↔图片、OCR 识别、PDF 加密解密与水印。基于 Electron + LibreOffice + Ghostscript + Tesseract + Python(PyMuPDF/pdf2docx)，**所有引擎已随安装包捆绑，运行时零网络访问**。

## 支持系统

| 安装包 | 适用系统 |
|---|---|
| `办公助手-Setup-x86.exe`（32 位包） | Windows 7 SP1 32/64 位、Windows 10 32/64 位 |
| `办公助手-Setup-x64.exe`（64 位包） | Windows 7 SP1 64 位、Windows 10 64 位 |

> 按需选择：32 位系统或内存 ≤4GB 的老机器装 x86 包；64 位系统装 x64 包。**两个包均同时兼容 Win7 和 Win10**，无需按系统选包。安装包体积：x64 约 620MB，x86 约 280MB（含 LibreOffice/Ghostscript/Python 引擎；x64 另含 Tesseract OCR）。

## 安装

1. 双击安装包。用户级安装（per-user），**不需要管理员权限、不弹 UAC**。
2. 可选择安装目录。桌面/开始菜单会自动创建快捷方式。
3. 安装后占用约 1.1 GB（含 LibreOffice 约 700MB 引擎）。

## 功能

| 模块 | 输入 | 输出 |
|---|---|---|
| Office → PDF | doc/docx/xls/xlsx/ppt/pptx/rtf/odt/txt/ods/odp | PDF |
| PDF → Word | 文字版 PDF | docx（原名.docx） |
| PDF 页面工具 | 多 PDF | 合并（可每文件指定页码，如 1,3-5）/ 每页拆分 / 提取页码 / 删除页码 / 旋转 |
| PDF 压缩 | PDF | 三档质量：普通(72dpi)/均衡(150dpi)/高质量(300dpi) |
| PDF 转图片 | PDF | PNG 或 JPG（默认 150dpi，每页一张） |
| 图片转 PDF | 多张图片 | 一个 PDF（列表可上移/下移调序） |
| 图片压缩 | JPG/PNG 等 | 三档质量（30/60/85）+ 可选缩放（25%–100%），输出「原名-压缩」 |
| OCR 识别 | 图片或扫描 PDF | TXT 或可搜索 PDF（中文+英文，可选 150/300dpi） |
| 加密/解密 | PDF | AES-256 加密 PDF / 去除密码的副本 |
| 文字水印 | PDF | 平铺/居中水印 PDF，可选角度(0-60°)、颜色(灰/红/蓝) |

输出默认与源文件同目录，重名自动追加 `-1`。可在设置页改成固定目录。

## Windows 7 前置补丁（重要）

Electron 22 在 **Win7 SP1** 上需要平台更新，否则可能出现黑屏或启动即退：

1. 先安装 **KB2670838**（平台更新，Win7 SP1 必需）。
2. 如 GPU 异常/黑屏，再安装 **KB2533623**（安全更新，影响 DLL 加载）。
3. 若仍黑屏：重启后先手工升级一次 Windows Update 的"平台更新"组件，再运行。

32 位的 VC++ 运行时应尽量随安装包捆绑；构建机上 `C:\Windows\SysWOW64` 缺 `vcruntime140_1.dll` 且官方 redist 的 layout 解包拿不到该文件时脚本只告警不中断——实测 numpy/opencv/PyMuPDF 在缺该 DLL 的 32 位环境下仍可正常 import。**若目标 Win7/32 位机启动侧车报"找不到 vcruntime140_1.dll"，在该机装一次 VC++ 2015-2022 Redistributable (x86) 即可**。

## OCR 功能说明

- **64 位安装包**：OCR 功能完整（中文+英文，图片或扫描 PDF → TXT / 可搜索 PDF）。
- **32 位安装包**：不含 OCR 引擎（Tesseract 上游已停止提供 32 位安装包），选择 OCR 功能会给出中文提示，其余功能不受影响。需要 OCR 请改用 64 位安装包。

## 常见问题

- **转换超时**：多为文件损坏、含复杂宏/嵌入对象或超大文档。换 x64 包再试仍失败则文件本身异常。
- **内存不足提示**：x86 包（32 位进程）地址空间有限，超大 PDF 请换 64 位包或拆分后处理。
- **PDF 转 Word 出来是空的/排版乱**：输入是扫描件（无文字层），应改用 OCR 识别。文字版 PDF 才能转换。
- **OCR 识别不准**：内网包用的是 `tessdata_fast`（体积小、速度快、精度中等）。扫描件建议 ≥200dpi、页面方正；较模糊的原件识别率会下降。
- **PDF 已加密无法处理**：先用「加密与水印 → 解密」输入原密码解除，再走其他流程。
- **日志在哪**：设置页 → 打开日志目录（`%APPDATA%\办公助手\logs\`）。排障时把最新日志发给维护人员。

## 性能实测（构建机 Win10 x64，无 GPU）

样本：50 页中文 PDF（1.7MB）。引擎进程峰值 = tasklist 每 250ms 采样。

| 功能 | 耗时 | 引擎进程峰值 | 备注 |
|---|---|---|---|
| pdf2word（PDF→Word） | 2.9s | 102MB | 峰值最高项 |
| PDF 合并（50+50 页） | 2.8s | 123MB | — |
| PDF 拆分（100 页） | 27.7s | 135MB | 逐页 open/save，慢在循环次数 |
| 文字水印（50 页） | 11.9s | 133MB | 每页一次 TextWriter |
| PDF→图片（150dpi） | 2.9s | 137MB | 每页一张 PNG |
| OCR（chi+eng，50 页） | 148s | 137MB | 每页起一次 tesseract |
| Word→PDF（docx） | 15.6s | 7MB（soffice 独立进程） | 含 LibreOffice 冷启动 |
| PDF 压缩（gs /ebook） | 0.4s | 8MB | — |

**内存特征**：
- Electron 主进程空闲约 150–200MB；侧车 Python 常驻约 20–60MB，pdf2word/水印后峰值 60–130MB。
- 侧车**空闲 120 秒自动退出**，处理大文件后立即回收内存。
- 32 位包同操作峰值比 64 位低约 20%（实测 85MB vs 125MB），但超大文件（500 页以上）建议用 64 位包。

**老机调优**：
- 引擎线程数默认限制为 2（`OMP_NUM_THREADS=2`），可用环境变量 `OFFICEKIT_CPUS=1|2|4` 调整；设 1 可让别的程序更流畅。
- 无 GPU 环境已启用 SwiftShader 软件渲染 + in-process-gpu；启动日志里的 GPU/cache 报错可忽略，不影响功能。
- 慢功能（拆分/OCR）为逐页循环所致，任务可随时取消。

## 离线分发

- 安装包本体 ~800MB/个。U 盘拷贝安装即可，也可放内网共享目录/文件服务器。
- 运行期不请求任何网络；如需换图标/改名，联系维护人员改包。

## 开源许可（摘要）

- Electron：MIT
- LibreOffice：MPL-2.0
- Ghostscript：AGPL-3.0
- Tesseract：Apache-2.0
- PyMuPDF：AGPL-3.0
- pdf2docx 0.5.8：GPLv3
- opencv：Apache-2.0；numpy：BSD

**内部自用不分发**，上述义务不触发。如未来对单位外分发，先联系维护人员评估 AGPL/GPL 对应义务。
