# 第三方组件许可声明（THIRD-PARTY NOTICES）

本文件列出「办公助手」安装包与源代码仓库中包含引用的第三方组件、其许可证，
以及获取完整对应源代码（Complete Corresponding Source）的方式。

本产品整体以 **GNU General Public License v3.0 or later** 发布，见仓库根目录
[`LICENSE.md`](LICENSE.md)。

> 法务提示：本文件为技术整合方（维护人员）的善意合规记录，不构成法律意见。
> 若组件版本或本产品结构发生重大变化，请重新核对。

---

## 1. 强 Copyleft 组件（AGPL / GPL）

这些组件的许可证要求：以它们的许可证发布衍生作品，并提供对应源码。

### PyMuPDF 1.23.7（含 PyMuPDFb 1.23.7）
- **许可证**：GNU AGPL v3.0
- **用途**：PDF 渲染、文本/水印/页码、子集化、加密解密（`sidecar/worker.py` 的核心
  依赖，本产品以 `import fitz` 直接链接 Python 模块）
- **Copyright**：Artifex Software, Inc.
- **对应源码**：<https://github.com/pymupdf/PyMuPDF>（v1.23.7 标签）
  上游同时提供 prebuilt wheel；本产品分发的是未修改的官方 wheel，
  其 `dist-info/COPYING` 即 AGPL-3.0 原文，源码以上游 tag 为对应版本。
- **注意事项**：由于本产品将其作为进程内库使用（`worker.py` 直接 `import fitz`），
  按主流解释该结合构成基于 PyMuPDF 的衍生作品，因此本项目整体采用 GPL-3.0-or-later
  （GPL-3.0 §13 允许与 AGPL 作品合并的兼容发布方式）。

### pdf2docx 0.5.8
- **许可证**：GNU GPL v3.0
- **用途**：PDF 转 Word（`cmd_pdf2word` 调用其 `Converter`）
- **Copyright**：Artifex Software, Inc.
- **对应源码**：<https://github.com/ArtifexSoftware/pdf2docx>
- **附带依赖**：`fire 0.7.1`（Apache-2.0，间接依赖）

### Ghostscript 9.56.1
- **许可证**：GNU AGPL v3.0（安装包内 `doc/COPYING` 即 AGPL v3 全文）
- **用途**：PDF 压缩（`ebook`/`screen` 等档位调用 `gswin{32,64}c.exe`）
- **Copyright**：Artifex Software, Inc.
- **对应源码**：<https://github.com/ArtifexSoftware/ghostpdl-downloads>（
  9.56.1 发布页），源码主库 <https://git.ghostscript.com/ghostpdl.git>
- **说明**：本产品以独立可执行文件方式子进程调用，不修改、不链接其库。

---

## 2. 弱 Copyleft / 文件级 Copyleft

### LibreOffice 7.6.7.2
- **许可证**：Mozilla Public License 2.0
- **用途**：Office → PDF、Office 文档互转
- **Copyright**：The Document Foundation
- **对应源码**：<https://downloadarchive.documentfoundation.org/libreoffice/old/7.6.7.2/>
- **许可全文**：见安装包内 `lo/license.txt` 与本仓库 [`licenses/MPL-2.0.txt`](licenses/MPL-2.0.txt)
- **合规状态**：未修改其源文件；仅整目录重新分发二进制，MPL-2.0 允许。
- **可验证**：`npm run verify:engines` 会把随包二进制与官方 MSI 重新解包的结果做
  全量 SHA-256 比对，双架构均应为 `UNMODIFIED(逐字节)`。
  （记录：`lo-ia32` 曾误留 7.3.7.2，已在 v1.4.0 修正为 7.6.7.2 并加入本校验。）

---

## 3. 宽松许可证（Permissive）

保留版权声明与许可声明即可随二进制分发；以下是本安装包实际包含的版本。

| 组件 | 版本 | 许可证 | 用途 | 源码 / 许可地址 |
|---|---|---|---|---|
| Electron | 22.3.27 | MIT | 应用外壳（Chromium + Node） | <https://github.com/electron/electron> |
| Tesseract OCR | 5.4.0.20240606 | Apache-2.0 | OCR 识别（x64 包） | <https://github.com/UB-Mannheim/tesseract> |
| tessdata_fast | 4.0.0 | Apache-2.0 | OCR 语言数据（chi_sim / eng） | <https://github.com/tesseract-ocr/tessdata_fast> |
| opencv-python-headless | 4.8.1.78 | Apache-2.0 | PDF 页转图片 | <https://github.com/opencv/opencv-python> |
| numpy | 1.24.4 | BSD-3-Clause | 数值运算（opencv/pdf2docx 依赖） | <https://github.com/numpy/numpy> |
| lxml | 6.1.3 | BSD-3-Clause | OOXML 解析（pdf2docx 依赖） | <https://github.com/lxml/lxml> |
| fonttools | 4.47.2 | MIT | 字体子集化相关 | <https://github.com/fonttools/fonttools> |
| python-docx | 1.1.2 | MIT | docx 生成（自检测试用例） | <https://github.com/python-openxml/python-docx> |
| CPython (embeddable) | 3.8.10 | PSF License Agreement | 侧车运行时 | <https://www.python.org/downloads/release/python-3810/> |
| fire | 0.7.1 | Apache-2.0 | pdf2docx CLI 依赖 | <https://github.com/google/python-fire> |

> Electron 内置的 Chromium / Node.js 组件为 BSD/MIT/Apache-2.0 系，
> Electron 仓库 `LICENSE` 与安装包内 `electron/dist` 下保留其归属声明。

---

## 4. 本产品自带代码

| 目录 | 许可证 | Copyright |
|---|---|---|
| 整个仓库（`electron/`、`renderer/`、`sidecar/`、`scripts/`） | GPL-3.0-or-later | 见 [`LICENSE.md`](LICENSE.md) 尾部 |

`sidecar/worker.py` 与上表 AGPL/GPL 组件在同一进程中结合，故以 GPL-3.0-or-later 发布。
任何人可依据 GPL-3.0 获取、修改、再分发本仓库全部源代码。

---

## 5. 如何获取本产品的完整对应源码
GPL-3.0 / AGPL-3.0 要求的 「Corresponding Source」包括构建与运行所需的
脚本与数据，本项目均已公开：

| 内容 | 位置 |
|---|---|
| 应用源码 | 本 GitHub 仓库全部文件 |
| 构建脚本与依赖清单 | `sidecar/requirements.txt`、`scripts/fetch-engines.cjs`、`scripts/build-sidecar.cjs` |
| **引擎来源可审计性** | `npm run verify:engines`（CI 中同步执行）：LibreOffice 双架构逐字节比对官方 MSI，Ghostscript/Tesseract 校验 installer 结构与来源痕迹 |

上游组件（PyMuPDF、pdf2docx、Ghostscript 等）的源码按其各自条目中的链接获取。
安装包中未对上游组件做修改，故上游源码即为其对应版本。

---

## 6. 历史版本的合规缺口（如实记录）

v1.3.0 及更早的 GitHub Release 发布时，仓库尚无 LICENSE 文件与本声明文件；
该缺口由本版本（v1.4.0）起修正。下个版本发布时应保证：

- [ ] Release Notes / 安装包内包含指向本文件的说明
- [ ] `THIRD-PARTY-NOTICES.md` 随源码仓库一同发布（本文件已达成）
- [ ] 若再替换引擎或升级大版本，重新核对本文件（尤其 PyMuPDF 的 AGPL 条款）
