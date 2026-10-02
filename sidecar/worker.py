# -*- coding: utf-8 -*-
"""办公助手 Python 侧车：JSONL 协议 + PDF 功能实现 + 自检。

协议：stdin 每行一个 JSON {"id":N,"cmd":"...","args":{...}}，
stdout 每行回一个 JSON {"id":N,"ok":true,"data":{...}} / {"id":N,"ok":false,"error":"中文消息"}。
--selftest：跑全套自检（verify-sidecar.mjs 调用）。

许可证：GNU General Public License v3.0 or later（见仓库根目录 LICENSE.md）。
本文件与 PyMuPDF(AGPL-3.0)、pdf2docx(GPL-3.0) 结合分发，依 GPL-3.0 §13
以 GPL-3.0-or-later 发布。第三方组件声明见 THIRD-PARTY-NOTICES.md。
"""
import os
import sys
import io
import json
import time
import struct
import shutil
import tempfile
import subprocess

# --- PyMuPDF 1.23.7 通过 fitz 名暴露 ---
import fitz


def _err(msg):
    return {"ok": False, "error": msg}


def parse_pages(spec, npages):
    """'1,3-5' -> 0 基索引列表；越界抛 ValueError。"""
    out = []
    for part in str(spec).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            start = int(a) if a.strip() else 1
            end = int(b) if b.strip() else npages
        else:
            start = end = int(part)
        if start < 1 or end > npages or start > end:
            raise ValueError("页码超出范围")
        out.extend(range(start - 1, end))
    return out


def _open_pdf(path):
    if not os.path.isfile(path):
        raise FileNotFoundError("文件不存在")
    doc = fitz.open(path)
    if doc.needs_pass:
        raise ValueError("文件已加密，请先使用解密功能")
    return doc
def cmd_pdf2word(args):
    from pdf2docx import Converter
    src, dst = args["in"], args["out"]
    if not os.path.isfile(src):
        return _err("文件不存在")
    if not src.lower().endswith(".pdf"):
        return _err("仅支持 PDF 文件")
    try:
        cv = Converter(src)
        cv.convert(dst)
        cv.close()
    except Exception as e:
        name = type(e).__name__
        if name == "FileDataError" or "PDF" in str(e):
            return _err("无法读取 PDF（可能已损坏或加密）")
        raise
    if not os.path.isfile(dst):
        return _err("转换失败：未生成输出文件")
    return {"ok": True, "data": {"out": dst, "bytes": os.path.getsize(dst)}}


def cmd_pdf_pages(args):
    op = args["op"]
    if op == "merge":
        files = args.get("files") or []
        if len(files) < 2:
            return _err("合并至少需要 2 个文件")
        # pages：与 files 按下标对齐的页码串；缺省/空串 = 该文件全部页
        specs = args.get("pages") or []
        out = fitz.open()
        for i, f in enumerate(files):
            try:
                d = _open_pdf(f)
                spec = str(specs[i]).strip() if i < len(specs) else ""
                if spec:
                    # parse_pages 抛 ValueError("页码超出范围") → 中文报错
                    for p in parse_pages(spec, d.page_count):
                        out.insert_pdf(d, from_page=p, to_page=p)  # 保留用户书写顺序
                else:
                    out.insert_pdf(d)
                d.close()
            except FileNotFoundError:
                return _err("文件不存在：" + f)
            except ValueError as e:
                return _err(str(e))
        return {"ok": True, "data": _save(out, args["out"], "pages", len(out))}

    src = args["in"]
    try:
        doc = _open_pdf(src)
    except ValueError as e:
        return _err(str(e))
    n = doc.page_count

    if op == "split":
        base = os.path.splitext(os.path.basename(src))[0]
        outdir = args.get("out_dir") or os.path.dirname(src)
        os.makedirs(outdir, exist_ok=True)  # 输出目录可能不存在（UI 允许自定义）
        # pages 缺省/空串 = 全拆；给了页码串则只拆指定页（如 2,5 只出 _p2/_p5）
        try:
            idx = parse_pages(args.get("pages"), n) if (args.get("pages") or "").strip() \
                else list(range(n))
        except ValueError as e:
            return _err(str(e))
        outs = []
        for i in idx:
            part = fitz.open()
            part.insert_pdf(doc, from_page=i, to_page=i)
            p = os.path.join(outdir, "%s_p%d.pdf" % (base, i + 1))
            res = _save(part, p, "page", 1)
            res["page"] = i + 1
            outs.append(res)
        first = outs[0]
        first["extra_outputs"] = [o["out"] for o in outs[1:]]
        first["total_pages"] = n
        return {"ok": True, "data": first}

    if op in ("extract", "delete"):
        spec = (args.get("pages") or "").strip()
        # extract 留空 = 取第 1 页（doc.select([]) 会产出 0 页 PDF，不可用）
        # delete 留空 = 不删页
        try:
            idx = parse_pages(spec, n) if spec else ([0] if op == "extract" else [])
        except ValueError as e:
            return _err(str(e))
        if op == "extract":
            doc.select(idx)
        else:
            doc.delete_pages(idx)
        return {"ok": True, "data": _save(doc, args["out"], "pages", doc.page_count)}

    if op == "rotate":
        pages = args.get("pages")
        angle = int(args.get("rotate", 90))
        if angle not in (0, 90, 180, 270):
            return _err("旋转角度仅支持 90/180/270")
        try:
            idx = parse_pages(pages, n) if pages else list(range(n))
        except ValueError as e:
            return _err(str(e))
        for i in idx:
            doc[i].set_rotation((doc[i].rotation + angle) % 360)
        return {"ok": True, "data": _save(doc, args["out"], "rotated", n)}

    return _err("未知操作")


def _subset_and_deflate(doc):
    """字体子集化 + 压缩参数，全工具统一生效。subset_fonts 失败不阻塞（功能优先于体积）。"""
    try:
        doc.subset_fonts()
    except Exception:
        pass
    return dict(garbage=4, deflate=True, clean=True)


def _save(doc, path, what, count):
    if os.path.isdir(path):
        path = os.path.join(path, "output.pdf")
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)  # 输出目录可能不存在（用户自定义目录/被清理）
    tmp = path + ".tmp"
    doc.save(tmp, **_subset_and_deflate(doc))
    doc.close()
    os.replace(tmp, path)
    return {"out": path, what: count, "bytes": os.path.getsize(path)}


def cmd_encrypt(args):
    try:
        doc = _open_pdf(args["in"])
    except ValueError as e:
        return _err(str(e))
    pwd = args.get("user_pw") or ""
    if len(pwd) < 4:
        return _err("打开密码至少 4 位")
    owner = args.get("owner_pw") or pwd
    out = args["out"]
    d = os.path.dirname(out)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)
    try:
        try:
            doc.subset_fonts()
        except Exception:
            pass
        doc.save(out, encryption=fitz.PDF_ENCRYPT_AES_256, user_pw=pwd, owner_pw=owner)
    except Exception as e:
        doc.close()
        return _err("加密失败：" + str(e))
    doc.close()
    chk = fitz.open(out)
    ok = chk.needs_pass and chk.authenticate(pwd) > 0
    chk.close()
    if not ok:
        return _err("加密结果校验失败")
    return {"ok": True, "data": {"out": out, "bytes": os.path.getsize(out)}}


def cmd_decrypt(args):
    src, pwd = args["in"], args.get("password", "")
    if not os.path.isfile(src):
        return _err("文件不存在")
    doc = fitz.open(src)
    if not doc.needs_pass:
        doc.close()
        return _err("文件未加密")
    if not doc.authenticate(pwd):
        doc.close()
        return _err("密码错误")
    out = args["out"]
    try:
        doc.save(out, encryption=fitz.PDF_ENCRYPT_NONE)
    except Exception as e:
        doc.close()
        return _err("解密失败：" + str(e))
    n = doc.page_count
    doc.close()
    return {"ok": True, "data": {"out": out, "pages": n, "bytes": os.path.getsize(out)}}


def cmd_watermark(args):
    try:
        doc = _open_pdf(args["in"])
    except ValueError as e:
        return _err(str(e))
    text = (args.get("text") or "").strip()
    if not text:
        return _err("水印文字不能为空")
    opacity = float(args.get("opacity", 0.15))
    # TextWriter morph 用旋转矩阵，任意角度均可（非数值才回落 45）
    try:
        angle = int(args.get("rotate", 45))
    except (TypeError, ValueError):
        angle = 45
    tile = bool(args.get("tile", False))
    # 颜色名 → RGB；未知值回落灰（保持旧默认行为）
    COLORS = {"gray": (0.5, 0.5, 0.5), "red": (0.9, 0.2, 0.2), "blue": (0.2, 0.4, 0.9)}
    color = COLORS.get(str(args.get("color") or "gray"), COLORS["gray"])
    # helv 无中文字形（中文水印会变方框/空白）；cjk 为 PyMuPDF 内置 CJK 字体。
    # 本机探针确认 fitz.Font("cjk") 可用且含中文 glyph（1.23.7）。
    try:
        font = fitz.Font("cjk")
    except Exception:
        font = fitz.Font("helv")
    for page in doc:
        r = page.rect
        if tile:
            fsize = min(20.0, r.height / 28)
            step_x = max(fitz.get_text_length(text, fontname="helv", fontsize=fsize) + 40, 150.0)
            step_y = max(fsize * 2.4, 80.0)
            # 每页只建一个 TextWriter：append 承载所有网格位置，write_text 只执行一次
            # （旧实现每个网格点 write_text 一次 → 每次全量嵌 CJK 字体，1 页 3.5MB）。
            # morph 以页面中心为旋转中心，平铺位置由 append 的 pos 决定。
            tw = fitz.TextWriter(r)
            y = -step_y
            while y < r.height + step_y:
                x = -step_x
                while x < r.width + step_x:
                    tw.append((x, y), text, font=font, fontsize=fsize)
                    x += step_x
                y += step_y
            tw.write_text(page,
                          morph=(fitz.Point(r.width / 2, r.height / 2), fitz.Matrix(angle)),
                          color=color, opacity=opacity)
        else:
            fsize = min(72.0, r.height / 12)
            tw = fitz.TextWriter(r)
            tw.append((r.width / 2, r.height / 2), text, font=font, fontsize=fsize)
            tw.write_text(page,
                          morph=(fitz.Point(r.width / 2, r.height / 2), fitz.Matrix(angle)),
                          color=color, opacity=opacity)
    return {"ok": True, "data": _save(doc, args["out"], "watermarked", doc.page_count)}


def cmd_pdf2img(args):
    try:
        doc = _open_pdf(args["in"])
    except ValueError as e:
        return _err(str(e))
    dpi = int(args.get("dpi", 150) or 150)
    fmt = (args.get("fmt") or "png").lower()
    if fmt not in ("png", "jpg", "jpeg"):
        fmt = "png"
    ext = "png" if fmt == "png" else "jpg"
    outdir = args.get("out_dir") or os.path.dirname(args["in"])
    os.makedirs(outdir, exist_ok=True)  # 输出目录可能不存在（自定义目录/bench 直传）
    base = os.path.splitext(os.path.basename(args["in"]))[0]
    outs, fallback = [], False
    for i, page in enumerate(doc):
        pm = page.get_pixmap(dpi=dpi)
        try:
            data = pm.tobytes(ext, jpg_quality=90) if ext == "png" else pm.tobytes("jpg", jpg_quality=90)
        except Exception:
            data, fallback = pm.tobytes("png"), True
            ext = "png"
        p = os.path.join(outdir, "%s_p%d.%s" % (base, i + 1, ext))
        with open(p, "wb") as f:
            f.write(data)
        outs.append(p)
    doc.close()
    d = {"out": outs[0], "count": len(outs)}
    if len(outs) > 1:
        d["extra_outputs"] = outs[1:]
    if fallback:
        d["fallback_png"] = True
    return {"ok": True, "data": d}


def _save_img(data, path):
    """原子写图片（tmp + replace），返回字节数。"""
    d = os.path.dirname(path)
    if d and not os.path.isdir(d):
        os.makedirs(d, exist_ok=True)  # 输出目录可能不存在（UI 允许自定义）
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    return os.path.getsize(path)


def _img_px_size(path):
    """读 JPEG/PNG 文件头的原始像素宽高（不依赖 PyMuPDF 页面语义）。
    读不到返回 None（调用方回落页面渲染尺寸）。"""
    try:
        with open(path, "rb") as fh:
            head = fh.read(64 * 1024)
    except OSError:
        return None
    if head[:8] == b"\x89PNG\r\n\x1a\n" and len(head) >= 24:
        w = int.from_bytes(head[16:20], "big")
        h = int.from_bytes(head[20:24], "big")
        return (w, h) if w and h else None
    if head[:2] == b"\xff\xd8":  # JPEG：扫 SOF0-SOF15
        i = 2
        n = len(head)
        while i + 9 < n:
            if head[i] != 0xFF:
                i += 1
                continue
            marker = head[i + 1]
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7 or marker == 0x01:
                i += 2
                continue
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                h = int.from_bytes(head[i + 5:i + 7], "big")
                w = int.from_bytes(head[i + 7:i + 9], "big")
                return (w, h) if w and h else None
            seglen = int.from_bytes(head[i + 2:i + 4], "big")
            if seglen < 2:
                return None
            i += 2 + seglen
    return None


def cmd_imgcompress(args):
    """图片压缩：质量档 + 可选缩放，逐张输出到 out_dir。

    JPG/JPEG 走质量重编码；PNG 仅在缩放时重栅格化（PyMuPDF 无 PNG 质量控制，
    不缩放直接改缩放以外不做无谓重编码——重编码只会变大）。BMP/WebP 等统一
    转成 PNG 输出。
    """
    files = args.get("files")
    if not files:
        files = [args["in"]]
    outdir = args.get("out_dir") or os.path.dirname(files[0])
    os.makedirs(outdir, exist_ok=True)
    try:
        quality = int(args.get("quality") or 80)
    except (TypeError, ValueError):
        quality = 80
    quality = max(10, min(95, quality))
    # 缩放：0-100（百分比）；<=0 或缺省 = 不缩放
    try:
        scale = float(args.get("scale") or 0)
    except (TypeError, ValueError):
        scale = 0.0
    scale = scale / 100.0 if scale > 1 else scale  # 容忍传 80 / 0.8
    if scale and not (0.05 <= scale <= 1.0):
        return _err("缩放比例需在 5%–100% 之间")

    outs, total_in, total_out = [], 0, 0
    for f in files:
        if not os.path.isfile(f):
            return _err("文件不存在：" + f)
        base = os.path.splitext(os.path.basename(f))[0]
        ext = os.path.splitext(f)[1].lower()
        # fitz.open 对坏图不立即抛错（延迟到 load_page），故统一包住解码阶段
        try:
            doc = fitz.open(f)
            page = doc[0]
            images = page.get_images(full=True)
            xref = images[0][0] if images else None
            pix = fitz.Pixmap(doc, xref) if xref else None
            if pix is None or pix.alpha or pix.n > 4:
                # 取不到内嵌图或带透明/CMYK：栅格化页面（RGB，透明底变白）
                pix = page.get_pixmap(alpha=False)
            if pix.n > 3:  # CMYK 等 → 转 RGB（否则 JPEG 编码失败）
                pix = fitz.Pixmap(fitz.csRGB, pix)
        except Exception:
            doc.close()
            return _err("无法读取图片（格式不支持或已损坏）：" + f)
        try:
            if scale:
                # 目标像素 = 原图像素 × scale。page.get_pixmap(dpi=) 的 px = 页面pt × dpi/72，
                # 原图嵌入 dpi 未知，故先从文件头取真实像素（JPEG SOF / PNG IHDR）反算 dpi。
                rect = page.rect
                hdr = _img_px_size(f)
                if hdr and rect.width:
                    base_dpi = hdr[0] * 72.0 / rect.width
                else:  # 头读不到（WebP/BMP 等）→ 按 96dpi 常见嵌入值兜底
                    base_dpi = 96.0
                pix = page.get_pixmap(dpi=max(1, int(round(base_dpi * scale))), alpha=False)
            if ext in (".jpg", ".jpeg"):
                out_ext = ".jpg"
                data = pix.tobytes("jpg", jpg_quality=quality)
            elif ext == ".png" and not scale:
                # PNG 不缩放 → 直接透传，避免无谓重编码导致体积反增
                out_ext = ".png"
                with open(f, "rb") as src:
                    data = src.read()
            else:
                out_ext = ".png"
                if scale:
                    data = pix.tobytes("png")
                else:
                    with open(f, "rb") as src:
                        data = src.read()
            out_path = os.path.join(outdir, base + "-压缩" + out_ext)
            total_in += os.path.getsize(f)
            total_out += _save_img(data, out_path)
            outs.append(out_path)
        finally:
            doc.close()
    if not outs:
        return _err("未生成任何输出")
    d = {"out": outs[0], "count": len(outs), "in_bytes": total_in, "out_bytes": total_out}
    if len(outs) > 1:
        d["extra_outputs"] = outs[1:]
    return {"ok": True, "data": d}


def cmd_img2pdf(args):
    files = args.get("files") or []
    if not files:
        return _err("未选择图片")
    doc = fitz.open()
    for f in files:
        if not os.path.isfile(f):
            return _err("文件不存在：" + f)
        try:
            im = fitz.open(f)
            rect = im[0].rect
            page = doc.new_page(width=rect.width, height=rect.height)
            page.insert_image(rect, filename=f)
            im.close()
        except Exception:
            return _err("无法读取图片（格式不支持或已损坏）：" + f)
    if doc.page_count == 0:
        doc.close()
        return _err("未生成任何页面")
    return {"ok": True, "data": _save(doc, args["out"], "images", doc.page_count)}


def _find_tesseract():
    cand = os.environ.get("TESSERACT_CMD")
    if cand and os.path.isfile(cand):
        return os.path.normpath(cand)
    # 开发态：engines/tesseract-<arch>/tesseract/tesseract.exe（按进程架构优先）
    # 打包态：<resources>/tesseract/tesseract/tesseract.exe（extraResources to: tesseract）
    arch = _arch_pref()
    order = [arch, "x64" if arch == "ia32" else "ia32"]
    for base in _repo_roots():
        for a in order:
            p = os.path.join(base, "engines", f"tesseract-{a}", "tesseract", "tesseract.exe")
            if os.path.isfile(p):
                # 仅同架构可用：ia32 进程加载 x64 exe 会直接退出（打包态单架构本就无跨架构问题）
                if a != arch:
                    continue
                return os.path.normpath(p)
    for base in _repo_roots():
        for a in order:
            p = os.path.join(base, "tesseract", "tesseract", "tesseract.exe")
            if os.path.isfile(p):
                if a != arch:
                    continue
                return os.path.normpath(p)
    return "tesseract.exe"


def _tess_env():
    # 无 GPU 老机器：tesseract 内部 OpenMP 默认按全部核心起线程，限到 2 降抖动
    env = {**os.environ,
           "OMP_NUM_THREADS": os.environ.get("OMP_NUM_THREADS", "2"),
           "OMP_THREAD_LIMIT": os.environ.get("OMP_THREAD_LIMIT", "2"),
           "TESSDATA_PREFIX": os.environ.get(
               "TESSDATA_PREFIX",
               os.path.join(os.path.dirname(_find_tesseract()), "tessdata"))}
    return env


def cmd_ocr(args):
    """单文件 OCR：图片直接跑；PDF 逐页渲染后跑。mode=txt|searchable。"""
    tess = _find_tesseract()
    if not (os.path.isfile(tess) or tess == "tesseract.exe"):
        return _err("缺少 Tesseract 引擎，请先运行 npm run fetch:engines")
    src = args["in"]
    if not os.path.isfile(src):
        return _err("文件不存在")
    mode = args.get("mode") or "txt"
    if mode not in ("txt", "searchable"):
        mode = "txt"
    lang = args.get("lang") or "chi_sim+eng"
    outdir = args.get("out_dir") or os.path.dirname(src)
    os.makedirs(outdir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(src))[0]
    env = _tess_env()

    tmpd = tempfile.mkdtemp(prefix="officekit-ocr-")
    try:
        if src.lower().endswith(".pdf"):
            try:
                doc = _open_pdf(src)
            except ValueError as e:
                return _err(str(e))
            if doc.is_encrypted and not doc.needs_pass:
                pass
            npages = doc.page_count
            dpi = int(args.get("dpi", 150) or 150)
            pages = npages
        else:
            pages = 1

        outs, texts = [], []
        for i in range(pages):
            if pages == 1 and not src.lower().endswith(".pdf"):
                img = src
            else:
                pm = doc[i].get_pixmap(dpi=dpi)
                img = os.path.join(tmpd, f"p{i+1}.png")
                pm.save(img)
            base = os.path.join(tmpd, f"o{i+1}")
            argv = [tess, img, base, "-l", lang] + (["pdf"] if mode == "searchable" else [])
            try:
                subprocess.run(argv, capture_output=True, timeout=600, env=env)
            except subprocess.TimeoutExpired:
                return _err(f"OCR 超时：第 {i+1} 页识别超过 10 分钟")
            if mode == "txt":
                t = base + ".txt"
                if os.path.isfile(t):
                    texts.append(open(t, encoding="utf-8", errors="replace").read())
            else:
                t = base + ".pdf"
                if os.path.isfile(t):
                    outs.append(t)

        if mode == "txt":
            out = os.path.join(outdir, f"{stem}-识别.txt")
            joined = ("\n\n".join(texts)).strip()
            with open(out, "w", encoding="utf-8") as f:
                f.write(joined)
            if not joined:
                return _err("未识别到文本：可能是图片为空/扫描质量过低，或语言包与内容不匹配"
                            "（识别中文请选「中文+英文」）")
        else:
            out = os.path.join(outdir, f"{stem}-可搜索.pdf")
            if not outs:
                return _err("OCR 未产出可搜索 PDF")
            d = fitz.open()
            for t in outs:
                s = fitz.open(t)
                d.insert_pdf(s)
                s.close()
            res = _save(d, out, "ocr", d.page_count)
            return {"ok": True, "data": res}
        return {"ok": True, "data": {"out": out, "bytes": os.path.getsize(out),
                                     "pages": pages, "chars": len("".join(texts))}}
    finally:
        shutil.rmtree(tmpd, ignore_errors=True)


def cmd_toc(args):
    """args: {"in": pdf, "out": pdf, "mode": "get"|"set"|"auto",
       "items": [[level, title, page], ...]  # set 用
       "min_size": 14.0                       # auto 用，标题字号阈值，缺省 14
    }"""
    try:
        doc = _open_pdf(args["in"])
    except ValueError as e:
        return _err(str(e))
    mode = args.get("mode", "get")
    if mode == "get":
        toc = doc.get_toc()
        return {"ok": True, "data": {"toc": toc, "pages": doc.page_count}}
    if mode == "set":
        items = args.get("items") or []
        try:
            doc.set_toc([[int(l), str(t), int(p)] for l, t, p in items])
        except Exception:
            return _err("书签格式不合法（层级/标题/页码）")
        return {"ok": True, "data": _save(doc, args["out"], "toc", len(items))}
    if mode == "auto":
        # 标题 = 字号 >= min_size 的行，按页序生成一级书签（不推断层级，一级够用）
        min_size = float(args.get("min_size") or 14.0)
        items = []
        for pi, pg in enumerate(doc):
            for b in pg.get_text("dict")["blocks"]:
                for l in b.get("lines", []):
                    for s in l["spans"]:
                        if s["size"] >= min_size and s["text"].strip():
                            items.append([1, s["text"].strip(), pi + 1])
        if not items:
            return _err("未检测到标题（可调小字号阈值）")
        doc.set_toc(items)
        return {"ok": True, "data": _save(doc, args["out"], "toc", len(items))}
    return _err("未知模式")


def cmd_metadata(args):
    """args: {"in": pdf, "out": pdf, "mode": "get"|"clear",
       "fields": {"title": "...", ...}  # clear 时清除后回填
    }
    get 只读不写文件。clear 输出到 out。"""
    try:
        doc = _open_pdf(args["in"])
    except ValueError as e:
        return _err(str(e))
    mode = args.get("mode", "get")
    if mode == "get":
        m = {k: doc.metadata.get(k, "") for k in
             ("title", "author", "subject", "keywords", "creator", "producer",
              "creationDate", "modDate")}
        return {"ok": True, "data": {"metadata": m, "pages": doc.page_count}}
    if mode == "clear":
        # 实测 set_metadata({}) 即全清；fields 的非空键在清除后回填（保留用户想署名的字段）
        blank = {k: "" for k in ("title", "author", "subject", "keywords",
                                 "creator", "producer")}
        doc.set_metadata(blank)
        for k, v in (args.get("fields") or {}).items():
            if k in blank and v:
                doc.set_metadata({k: str(v)})
        return {"ok": True, "data": _save(doc, args["out"], "cleared", 1)}
    return _err("未知模式")


def cmd_number(args):
    """args: {"in": pdf, "out": pdf, "start": 1, "pos": "bottom-center",
       "size": 9, "fmt": "第{n}页", "pages": "1-5"（可选）,
       "color": "gray"|"black"|"red"|"blue", "margin": 24}
    fmt 占位符 {n}=当前编号、{total}=总页数。"""
    try:
        doc = _open_pdf(args["in"])
    except ValueError as e:
        return _err(str(e))
    n = doc.page_count
    spec = (args.get("pages") or "").strip()
    try:
        idx = parse_pages(spec, n) if spec else list(range(n))
    except ValueError as e:
        return _err(str(e))
    start = int(args.get("start") or 1)
    fmt = str(args.get("fmt") or "第{n}页")
    size = float(args.get("size") or 9)
    margin = float(args.get("margin") or 24)
    pos = str(args.get("pos") or "bottom-center")
    color_map = {"black": (0, 0, 0), "gray": (0.45, 0.45, 0.45),
                 "red": (0.9, 0.1, 0.1), "blue": (0.1, 0.2, 0.8)}
    rgb = color_map.get(str(args.get("color") or "gray"), (0.45, 0.45, 0.45))
    font = fitz.Font("china-s")   # 中英数字全覆盖（实测 has_glyph 均 True）
    numbered = 0
    for rank, i in enumerate(idx):
        pg = doc[i]
        try:
            text = fmt.format(n=start + rank, total=n)
        except (KeyError, IndexError, ValueError):
            return _err("格式串不合法（仅支持 {n} 与 {total}）")
        w = font.text_length(text, size)   # Font 对象测量与写入字形一致
        r = pg.rect
        y = margin + size if pos.startswith("top") else r.height - margin
        if pos.endswith("left"):
            x = margin
        elif pos.endswith("right"):
            x = r.width - margin - w
        else:
            x = (r.width - w) / 2
        tw = fitz.TextWriter(r)
        tw.append(fitz.Point(x, y), text, font=font, fontsize=size)
        tw.write_text(pg, color=rgb)
        numbered += 1
    return {"ok": True, "data": _save(doc, args["out"], "numbered", numbered)}


def cmd_reorder(args):
    """args: {"in": pdf, "out": pdf, "order": "3,1-2,5"}  # 新顺序的 1 基页码串"""
    try:
        doc = _open_pdf(args["in"])
    except ValueError as e:
        return _err(str(e))
    try:
        idx = parse_pages(str(args.get("order") or ""), doc.page_count)
    except ValueError as e:
        return _err(str(e))
    # 重排语义 = 全部页面的新顺序；子集选择是 extract 的职责
    if sorted(idx) != list(range(doc.page_count)):
        return _err("页码需覆盖全部页且不重复")
    doc.select(idx)   # 实测 select([2,0,3]) 输出页序 p3,p1,p4
    return {"ok": True, "data": _save(doc, args["out"], "pages", doc.page_count)}


def cmd_crop(args):
    """args: {"in": pdf, "out": pdf, "margin": 10}  # 四边同裁 pt 数"""
    try:
        doc = _open_pdf(args["in"])
    except ValueError as e:
        return _err(str(e))
    try:
        m = float(args.get("margin") or 0)
    except ValueError:
        return _err("边距必须是数字")
    if m < 0 or m > 200:
        return _err("边距需在 0-200pt 之间")
    for pg in doc:
        r = pg.mediabox
        pg.set_cropbox(fitz.Rect(r.x0 + m, r.y0 + m, r.x1 - m, r.y1 - m))
    return {"ok": True, "data": _save(doc, args["out"], "cropped", doc.page_count)}


COMMANDS = {
    "pdf2word": cmd_pdf2word,
    "ocr": cmd_ocr,
    "pdf_pages": cmd_pdf_pages,
    "encrypt": cmd_encrypt,
    "decrypt": cmd_decrypt,
    "watermark": cmd_watermark,
    "pdf2img": cmd_pdf2img,
    "img2pdf": cmd_img2pdf,
    "imgcompress": cmd_imgcompress,
    "toc": cmd_toc,
    "metadata": cmd_metadata,
    "number": cmd_number,
    "reorder": cmd_reorder,
    "crop": cmd_crop,
}


def handle(line):
    try:
        msg = json.loads(line)
    except Exception:
        return {"id": 0, "ok": False, "error": "JSON 解析失败"}
    mid, cmd, args = msg.get("id", 0), msg.get("cmd"), msg.get("args") or {}
    fn = COMMANDS.get(cmd)
    if not fn:
        return {"id": mid, "ok": False, "error": "未知命令"}
    try:
        r = fn(args)
    except MemoryError:
        return {"id": mid, "ok": False,
                "error": "内存不足：文件过大，请使用 64 位版本或拆分文件"}
    except fitz.FileDataError:
        return {"id": mid, "ok": False, "error": "无法读取 PDF（可能已损坏或加密）"}
    except ValueError as e:
        return {"id": mid, "ok": False, "error": str(e)}
    except Exception as e:
        return {"id": mid, "ok": False, "error": "%s: %s" % (type(e).__name__, e)}
    r["id"] = mid
    return r


def serve():
    inp = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", errors="replace")
    out = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    for line in inp:
        line = line.strip()
        if not line:
            continue
        resp = handle(line)
        out.write(json.dumps(resp, ensure_ascii=False) + "\n")
        out.flush()
        if resp.get("data", {}).get("bye"):
            break


# ---------------------------------------------------------------------------
# 性能/内存自检工具
# ---------------------------------------------------------------------------
def mem_mb(peak=False):
    """当前进程内存工作集（MB）；peak=True 取历史峰值。不可用返回 0.0。"""
    if os.name != "nt":
        return 0.0
    # psapi.GetProcessMemoryInfo（WinXP+）
    try:
        import ctypes
        import ctypes.wintypes as wt

        class PMC(ctypes.Structure):
            _fields_ = [("cb", wt.DWORD), ("PageFaultCount", wt.DWORD),
                        ("PeakWorkingSetSize", ctypes.c_size_t),
                        ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t),
                        ("PeakPagefileUsage", ctypes.c_size_t)]

        if not hasattr(mem_mb, "_psapi"):
            psapi = ctypes.WinDLL("psapi")
            k32 = ctypes.WinDLL("kernel32")
            # 注意：第2参必须声明为 c_void_p（POINTER(PMC) 会让默认 int 转换截断句柄）
            psapi.GetProcessMemoryInfo.argtypes = [wt.HANDLE, ctypes.c_void_p, wt.DWORD]
            psapi.GetProcessMemoryInfo.restype = wt.BOOL
            mem_mb._psapi = (psapi, k32)
        psapi, k32 = mem_mb._psapi
        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        h = k32.OpenProcess(0x1000 | 0x0400, False, k32.GetCurrentProcessId())
        try:
            ok = psapi.GetProcessMemoryInfo(h, ctypes.byref(pmc), pmc.cb)
        finally:
            k32.CloseHandle(h)
        if ok:
            v = pmc.PeakWorkingSetSize if peak else pmc.WorkingSetSize
            return v / 1048576.0
    except Exception:
        pass
    return 0.0


def _make_docx(path):
    """用 python-docx 造一个中英混排 10 段的 docx 测试素材。"""
    from docx import Document
    from docx.shared import Pt
    doc = Document()
    doc.add_heading("办公助手性能测试文档", 0)
    for i in range(10):
        para = doc.add_paragraph()
        run = para.add_run(f"第 {i + 1} 段：这是中文测试内容，用于验证 Word 转 PDF 的转换质量。")
        run.font.size = Pt(12)
        doc.add_paragraph(f"Paragraph {i + 1}: mixed English content for conversion check.")
    doc.save(path)
    return path


def _soffice_convert(inpath, outdir):
    """走产品同款 soffice headless 转换（--convert-to pdf）。"""
    soffice = _find_soffice()
    if not soffice:
        return None
    profile = tempfile.mkdtemp(prefix="lokit-")
    profile_url = "file:///" + profile.replace("\\", "/")
    try:
        subprocess.run([
            soffice, "--headless", "--norestore", "--invisible", "--nodefault", "--nolockcheck",
            f"-env:UserInstallation={profile_url}",
            "--convert-to", "pdf", "--outdir", outdir, inpath,
        ], capture_output=True, timeout=180)
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    out = os.path.join(outdir, os.path.splitext(os.path.basename(inpath))[0] + ".pdf")
    return out if os.path.isfile(out) else None


def _repo_roots():
    """仓库根候选集合（含 engines/ 的目录）。按优先级：环境变量 > 脚本各级父目录 > cwd。"""
    roots = set()
    env = os.environ.get("OFFICEKIT_ROOT")
    if env:
        roots.add(env)
    try:
        p = os.path.abspath(__file__)
        # worker.py 可能在仓库根、staging/sidecar-<arch>/、打包 resources/ 下
        for _ in range(4):
            p = os.path.dirname(p)
            roots.add(p)
    except Exception:
        pass
    try:
        roots.add(os.path.dirname(os.path.dirname(os.path.abspath(sys.argv[0]))))
    except Exception:
        pass
    roots.add(os.getcwd())
    return {r for r in roots if r}


def _arch_pref():
    """当前进程位宽：x64 包优先 x64 引擎，ia32 包优先 ia32 引擎。"""
    return "x64" if struct.calcsize("P") == 8 else "ia32"


def _find_soffice():
    """按当前架构优先查 engines/lo-<arch>/program/soffice.exe，再退回另一架构；
    打包态查 <root>/lo/program/。"""
    arch = _arch_pref()
    order = [arch, "x64" if arch == "ia32" else "ia32"]
    for base in _repo_roots():
        for a in order:
            p = os.path.join(base, "engines", f"lo-{a}", "program", "soffice.exe")
            if os.path.isfile(p):
                return os.path.normpath(p)
    for base in _repo_roots():
        p = os.path.join(base, "lo", "program", "soffice.exe")
        if os.path.isfile(p):
            return os.path.normpath(p)
    return None


class _CaseRunner:
    """真实用例执行器：统一走 handle() JSONL 协议，逐用例打印耗时与内存增量。"""

    def __init__(self):
        self.id = 0
        self.start_mem = mem_mb()
        self.peak_mem = mem_mb(peak=True)
        self.fail = []

    def call(self, cmd, args):
        self.id += 1
        t0 = time.time()
        r = handle(json.dumps({"id": self.id, "cmd": cmd, "args": args}))
        self.t0 = time.time() - t0
        return r

    def check(self, name, cmd, args, verify=None, mem_assert_peak=None):
        """verify(data)->错误消息或None；mem_assert_peak: 该用例运行后进程内存峰值上限MB。"""
        peak_before = mem_mb(peak=True)
        try:
            r = self.call(cmd, args)
        except Exception as e:
            self.fail.append(f"{name}: 异常 {type(e).__name__}: {e}")
            print(f"  [FAIL] {name:<22} 异常 {type(e).__name__}")
            return None
        peak_after = mem_mb(peak=True)
        err = None
        if not r.get("ok"):
            err = "返回错误: " + str(r.get("error"))
        elif verify:
            err = verify(r.get("data") or {})
        tag = "OK" if err is None else "FAIL"
        if err:
            self.fail.append(f"{name}: {err}")
        # 峰值是单调累计的，只报"本次是否刷新了历史峰值"
        new_peak = peak_after - peak_before
        print(f"  [{tag}] {name:<22} {self.t0:6.2f}s  "
              f"{'峰值+' + format(new_peak, '.1f') + 'MB' if new_peak > 0.5 else ''} "
              f"(进程峰值 {peak_after:.0f}MB)")
        if err:
            print(f"        {err}")
        if err is None and mem_assert_peak is not None and peak_after > mem_assert_peak:
            self.fail.append(f"{name}: 进程峰值 {peak_after:.1f}MB 超上限 {mem_assert_peak}MB")
            print(f"        [MEM] 进程峰值 {peak_after:.1f}MB 超上限 {mem_assert_peak}MB")
        return r


def selftest():
    """真实用例套件 + 内存断言；失败返回非 0。全部走 handle() 协议。"""
    tmp = tempfile.mkdtemp(prefix="officekit-selftest-")
    t_start = time.time()
    mem0 = mem_mb()
    print(f"selftest: 起始内存 {mem0:.1f}MB (32bit={8 * struct.calcsize('P') == 32})")
    runner = _CaseRunner()
    try:
        # ===== 用例 1：Word(docx) → PDF（真实办公场景，中文文件名） =====
        docx = _make_docx(os.path.join(tmp, "内网文档A.docx"))
        assert os.path.isfile(docx), "docx 素材生成失败"
        outdir = os.path.join(tmp, "out")
        os.makedirs(outdir, exist_ok=True)
        soffice = _find_soffice()
        if soffice:
            b = mem_mb()
            pdf = _soffice_convert(docx, outdir)
            d = mem_mb() - b
            assert pdf, "soffice 转换未产出 PDF"
            assert os.path.getsize(pdf) > 30000, f"PDF 过小({os.path.getsize(pdf)})"
            chk = fitz.open(pdf)
            pc = chk.page_count
            chk.close()
            assert pc >= 1, "页数异常"
            print(f"  [OK] office2pdf (docx)     Δ{d:7.1f}MB  {pc}页/{os.path.getsize(pdf)}B")
        else:
            pdf = os.path.join(tmp, "内网文档A.pdf")
            d0 = fitz.open()
            for _ in range(3):
                d0.new_page(width=595, height=842).insert_text((50, 60), "办公助手 测试", fontsize=12)
            d0.save(pdf)
            d0.close()
            print("  [SKIP] office2pdf (soffice 未找到，用内置 PDF 替代)")

        # ===== 用例 2：PDF → Word =====
        docx_out = os.path.join(outdir, "内网文档A.docx")
        runner.check("pdf2word", "pdf2word",
                     {"in": pdf, "out": docx_out},
                     verify=lambda d: None if os.path.isfile(d.get("out", "")) and
                     os.path.getsize(d["out"]) > 4096 else "docx 缺失或过小",
                     mem_assert_peak=400)

        # ===== 用例 3（per-call 泄漏检测）：pdf2word 再跑一轮 =====
        docx_out2 = os.path.join(outdir, "内网文档A2.docx")
        runner.check("pdf2word(2nd)", "pdf2word",
                     {"in": pdf, "out": docx_out2},
                     verify=lambda d: None if os.path.isfile(d.get("out", "")) else "docx 缺失",
                     mem_assert_peak=450)

        # ===== 用例 4：merge / split =====
        # 用 5 页内部 PDF 做 merge 输入，保证断言确定性（docx 转出的 PDF 页数内容而定）
        five = os.path.join(tmp, "五页.pdf")
        d5 = fitz.open()
        for i in range(5):
            d5.new_page(width=595, height=842).insert_text(
                (50, 60), f"page {i + 1} merge split test", fontsize=12)
        d5.save(five)
        d5.close()
        merged = os.path.join(outdir, "合并.pdf")
        runner.check("pdf_merge", "pdf_pages",
                     {"files": [five, five], "out": merged, "op": "merge"},
                     verify=lambda d: None if d.get("pages") == 10 else f"页数={d.get('pages')} 期望10")

        # ===== 用例 4b：merge 带每文件页码（页数 + 页序） =====
        merged_p = os.path.join(outdir, "合并指定页.pdf")
        r = runner.check("pdf_merge(pages)", "pdf_pages",
                         {"files": [five, five], "pages": ["1-2", "4-5"],
                          "out": merged_p, "op": "merge"},
                         verify=lambda d: None if d.get("pages") == 4 else f"页数={d.get('pages')} 期望4")
        if r and r.get("ok") and not runner.fail:
            md = fitz.open(merged_p)
            t1, t3 = md[0].get_text(), md[2].get_text()
            md.close()
            ok_order = ("page 1 " in t1) and ("page 4 " in t3)
            if not ok_order:
                runner.fail.append("merge 指定页页序不符")
                print("        [FAIL] merge 页序 t1=%r t3=%r" % (t1[:20], t3[:20]))
            else:
                print("        [CHECK] merge 指定页页序 1,2 + 4,5")
        r = runner.call("pdf_pages", {"files": [five, five], "pages": ["99"],
                                      "out": merged_p, "op": "merge"})
        if r.get("ok") or "页码超出范围" not in str(r.get("error", "")):
            runner.fail.append(f"merge 越界页码未报中文错: {r}")
        else:
            print("  [OK] merge越界页码中文提示")
        splitdir = os.path.join(outdir, "拆分")
        runner.check("pdf_split", "pdf_pages",
                     {"in": merged, "op": "split", "out_dir": splitdir},
                     verify=lambda d: None if d.get("total_pages") == 10 else "split 页数异常",
                     mem_assert_peak=300)

        # ===== 用例 4c：split 指定页 + delete 越界中文错 =====
        splitdir2 = os.path.join(outdir, "拆分指定页")
        r = runner.check("pdf_split(pages)", "pdf_pages",
                         {"in": merged, "op": "split", "out_dir": splitdir2, "pages": "1,3-5"},
                         verify=lambda d: None if d.get("total_pages") == 10 else "split 页数异常")
        if r and r.get("ok") and not runner.fail:
            files_out = sorted(os.listdir(splitdir2))
            want = ["%s_p%d.pdf" % ("合并", i) for i in (1, 3, 4, 5)]
            if files_out != want:
                runner.fail.append(f"split 指定页文件名不符: {files_out}")
                print("        [FAIL] split 指定页 %s" % files_out)
            else:
                print("        [CHECK] split 指定页输出 _p1/_p3/_p4/_p5")
        r = runner.call("pdf_pages", {"in": merged, "out": merged_p, "op": "delete",
                                      "pages": "0"})
        if r.get("ok") or "页码超出范围" not in str(r.get("error", "")):
            runner.fail.append(f"delete 越界页码未报中文错: {r}")
        else:
            print("  [OK] delete越界页码中文提示")

        # ===== 用例 5：extract / delete / rotate =====
        ext = os.path.join(outdir, "提取.pdf")
        runner.check("pdf_extract", "pdf_pages",
                     {"in": merged, "out": ext, "op": "extract", "pages": "1,3-5"},
                     verify=lambda d: None if d.get("pages") == 4 else f"期望4页实得{d.get('pages')}")
        dele = os.path.join(outdir, "删页.pdf")
        runner.check("pdf_delete", "pdf_pages",
                     {"in": merged, "out": dele, "op": "delete", "pages": "1"},
                     verify=lambda d: None if d.get("pages") == 9 else f"期望9页实得{d.get('pages')}")
        # 留空语义：extract=第1页；delete=不删
        ext0 = os.path.join(outdir, "提取留空.pdf")
        runner.check("pdf_extract(empty)", "pdf_pages",
                     {"in": merged, "out": ext0, "op": "extract", "pages": ""},
                     verify=lambda d: None if d.get("pages") == 1 else f"期望1页实得{d.get('pages')}")
        dele0 = os.path.join(outdir, "删页留空.pdf")
        runner.check("pdf_delete(empty)", "pdf_pages",
                     {"in": merged, "out": dele0, "op": "delete", "pages": ""},
                     verify=lambda d: None if d.get("pages") == 10 else f"期望10页实得{d.get('pages')}")
        rot = os.path.join(outdir, "旋转.pdf")
        runner.check("pdf_rotate", "pdf_pages",
                     {"in": merged, "out": rot, "op": "rotate", "rotate": 90},
                     verify=lambda d: None if d.get("rotated") == 10 else "rotate 页数异常")

        # ===== 用例 6：watermark（体积 + 中文可提取） =====
        wm = os.path.join(outdir, "水印.pdf")
        r = runner.check("watermark(tile)", "watermark",
                         {"in": pdf, "out": wm, "text": "内部资料",
                          "opacity": 0.15, "tile": True})
        if r:
            wmr = fitz.open(wm)
            wt = wmr[0].get_text()
            pages = wmr.page_count
            wmr.close()
            ok_size = os.path.getsize(wm) <= 200 * 1024
            ok_text = "内部资料" in wt or "内部" in wt
            if not ok_size:
                runner.fail.append(f"watermark 体积 {os.path.getsize(wm)} 超 200KB")
                print(f"        [MEM/SIZE] {os.path.getsize(wm)}B 超 200KB")
            if not ok_text:
                runner.fail.append("watermark 中文不可提取（字体可能无中文字形）")
                print("        [FONT] 中文水印未生效")
            print(f"        [CHECK] watermark {pages}页 {os.path.getsize(wm)}B "
                  f"文本={ok_text}")

        # ===== 用例 7：watermark(非平铺) =====
        wm2 = os.path.join(outdir, "水印居中.pdf")
        runner.check("watermark(single)", "watermark",
                     {"in": pdf, "out": wm2, "text": "内部资料",
                      "opacity": 0.15, "tile": False},
                     verify=lambda d: None if os.path.getsize(d.get("out", "")) > 0 else "输出缺失")

        # ===== 用例 8：encrypt / decrypt roundtrip + 错密码中文报错 =====
        enc = os.path.join(outdir, "加密.pdf")
        runner.check("encrypt(AES)", "encrypt",
                     {"in": pdf, "out": enc, "user_pw": "test1234"},
                     verify=lambda d: None if d.get("bytes", 0) > 0 else "加密输出异常")
        dec = os.path.join(outdir, "解密.pdf")
        runner.check("decrypt", "decrypt",
                     {"in": enc, "out": dec, "password": "test1234"},
                     verify=lambda d: None if d.get("pages", 0) >= 1 else "页数异常")
        r = runner.call("decrypt", {"in": enc, "out": dec, "password": "wrong"})
        if r.get("ok") or "密码错误" not in str(r.get("error", "")):
            runner.fail.append(f"decrypt 错密码未返回中文报错: {r}")
            print("        [FAIL] decrypt 错密码报错异常")
        else:
            print("  [OK] decrypt错误密码中文提示")

        # ===== 用例 9：pdf2img / img2pdf =====
        img = runner.check("pdf2img", "pdf2img",
                           {"in": pdf, "out_dir": outdir, "dpi": 150, "fmt": "png"},
                           verify=lambda d: None if os.path.getsize(d.get("out", "")) > 1024 else "PNG 过小",
                           mem_assert_peak=150)
        if img:
            i2p = os.path.join(outdir, "图片合成.pdf")
            runner.check("img2pdf", "img2pdf",
                         {"files": [img["data"]["out"], img["data"]["out"]],
                          "out": i2p},
                         verify=lambda d: None if d.get("images") == 2 else f"期望2页实得{d.get('images')}")

        # ===== 用例 9b：imgcompress（质量 + 缩放） =====
        # 生成一张大图让压缩比可断言（注意：1.23.7 的 Pixmap(cs,w,h) 无 samples 构造会抛
        # "Illegal number of colorants"，必须显式给 samples + alpha 标志）
        big_jpg = os.path.join(tmp, "大图.jpg")
        bw, bh = 1400, 1000
        pm = fitz.Pixmap(fitz.csRGB, bw, bh,
                         bytes([250, 250, 250]) * (bw * bh), False)
        with open(big_jpg, "wb") as fh:
            fh.write(pm.tobytes("jpg", jpg_quality=95))
        big_sz_in = os.path.getsize(big_jpg)
        icdir = os.path.join(outdir, "图片压缩")
        r = runner.check("imgcompress(q60)", "imgcompress",
                         {"files": [big_jpg], "out_dir": icdir, "quality": 60, "scale": 0},
                         verify=lambda d: None if os.path.isfile(d.get("out", "")) else "输出缺失",
                         mem_assert_peak=200)
        if r:
            out_sz = os.path.getsize(r["data"]["out"])
            print(f"        [CHECK] imgcompress q60 {big_sz_in}B→{out_sz}B")
            if out_sz > big_sz_in * 0.7:
                runner.fail.append(f"imgcompress q60 压缩不足: {big_sz_in}→{out_sz}")
        r = runner.check("imgcompress(q30+50%)", "imgcompress",
                         {"files": [big_jpg], "out_dir": icdir, "quality": 30, "scale": 50},
                         verify=lambda d: None if d.get("out_bytes", 0) < d.get("in_bytes", 0)
                         else "缩放后未减小",
                         mem_assert_peak=200)
        if r:
            # 尺寸断言：缩 50% 后内嵌像素应为原图的 ~50%（防止矩阵按 pt 基准缩过头）
            od = fitz.open(r["data"]["out"])
            opm = od[0].get_pixmap(dpi=72)
            od.close()
            exp = (round(bw / 2), round(bh / 2))
            if not (exp[0] * 0.9 <= opm.width <= exp[0] * 1.1
                    and exp[1] * 0.9 <= opm.height <= exp[1] * 1.1):
                runner.fail.append(
                    f"imgcompress 缩放后尺寸异常: {opm.width}x{opm.height} 期望约{exp[0]}x{exp[1]}")
                print(f"        [FAIL] imgcompress 缩放尺寸 {opm.width}x{opm.height} 期望 {exp[0]}x{exp[1]}")
            else:
                print(f"        [CHECK] imgcompress 尺寸 {opm.width}x{opm.height}（原 {bw}x{bh}，50%）")
        # 错误分支：坏文件 → 中文提示
        badimg = os.path.join(tmp, "坏图.png")
        with open(badimg, "wb") as fh:
            fh.write(b"\x89PNG\r\n\x1a\n" + b"garbage" * 100)
        r = runner.call("imgcompress", {"in": badimg, "out_dir": icdir})
        if r.get("ok") or "无法读取图片" not in str(r.get("error", "")):
            runner.fail.append(f"imgcompress 坏图未返回中文报错: {r}")
        else:
            print("  [OK] imgcompress坏图中文提示")

        # ===== 用例 10：compress（gs） =====
        # 先生成一个大体积 PDF 再压（内嵌图），让压缩有可比性
        big = os.path.join(tmp, "大体积.pdf")
        d0 = fitz.open()
        for _ in range(6):
            pg = d0.new_page(width=595, height=842)
            pg.insert_text((50, 60), "办公助手压缩测试内容" * 30, fontsize=9)
            pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 400, 400))
            pix.set_rect(pix.irect, (200, 120, 90))
        d0.save(big)
        d0.close()
        cz = os.path.join(outdir, "压缩后.pdf")
        gs = _find_gs()
        if gs:
            b = mem_mb()
            t0 = time.time()
            subprocess.run([gs, "-sDEVICE=pdfwrite", "-dPDFSETTINGS=/ebook",
                            "-dNOPAUSE", "-dBATCH", "-dQUIET",
                            f"-sOutputFile={cz}", big], capture_output=True, timeout=180)
            d = mem_mb() - b
            if os.path.isfile(cz):
                sz_in, sz_out = os.path.getsize(big), os.path.getsize(cz)
                print(f"  [OK] compress(gs)          {time.time()-t0:6.2f}s  Δ{d:7.1f}MB  "
                      f"{sz_in}B→{sz_out}B")
            else:
                runner.fail.append("compress 未产出输出")
                print("  [FAIL] compress(gs) 未产出输出")
        else:
            print("  [SKIP] compress(gs 未找到)")

        # ===== 用例 11：OCR（仅 tesseract 存在） =====
        tess = _find_tesseract()
        if os.path.isfile(tess):
            ocr_pdf = os.path.join(tmp, "ocr样本.pdf")
            d0 = fitz.open()
            d0.new_page(width=595, height=200).insert_text((50, 80), "Hello OCR 123", fontsize=32)
            d0.save(ocr_pdf)
            d0.close()
            runner.check("ocr(pdf)", "ocr",
                         {"in": ocr_pdf, "out_dir": outdir, "lang": "eng",
                          "mode": "txt", "dpi": 150},
                         verify=lambda d: None if os.path.isfile(d.get("out", "")) and
                         os.path.getsize(d["out"]) > 0 else "OCR 输出缺失",
                         mem_assert_peak=500)
            txtf = os.path.join(outdir, "ocr样本-识别.txt")
            if os.path.isfile(txtf):
                t = open(txtf, encoding="utf-8", errors="replace").read()
                if "Hello" in t and "123" in t:
                    print("  [OK] ocr识别Hello/123")
                else:
                    runner.fail.append(f"OCR 文本不符: {t[:80]!r}")
                    print("  [FAIL] OCR 识别文本不符")
        else:
            print("  [SKIP] ocr (tesseract 未捆绑)")

        # ===== 用例 12：错误路径中文报错 =====
        r = runner.call("pdf2word", {"in": os.path.join(tmp, "不存在.pdf"),
                                     "out": os.path.join(outdir, "x.docx")})
        if not (not r.get("ok") and "文件不存在" in str(r.get("error", ""))):
            runner.fail.append(f"不存在文件未返回中文错误: {r}")
            print(f"  [FAIL] 文件不存在报错: {r}")
        else:
            print("  [OK] 文件不存在中文提示")

        # ===== 用例 13：toc / metadata / number / reorder / crop =====
        head = os.path.join(tmp, "标题.pdf")
        dh = fitz.open()
        hf = fitz.Font("china-s")
        for i in range(3):
            pg = dh.new_page(width=595, height=842)
            tw = fitz.TextWriter(pg.rect)
            tw.append((72, 100), "Chapter %d heading" % (i + 1), font=hf, fontsize=16)
            tw.append((72, 200), "body text %d" % (i + 1), font=hf, fontsize=10)
            tw.write_text(pg)
        dh.save(head)
        dh.close()

        toc_out = os.path.join(outdir, "书签.pdf")
        r = runner.check("toc(auto)", "toc",
                         {"in": head, "out": toc_out, "mode": "auto", "min_size": 14},
                         verify=lambda d: None if d.get("toc") == 3 else f"书签数={d.get('toc')} 期望3")
        if r and r.get("ok") and not runner.fail:
            chk = fitz.open(toc_out)
            got = chk.get_toc()
            chk.close()
            want_toc = [[1, "Chapter 1 heading", 1], [1, "Chapter 2 heading", 2],
                        [1, "Chapter 3 heading", 3]]
            if got != want_toc:
                runner.fail.append("toc(auto) 书签内容不符: %s" % got)
                print("        [FAIL] toc 内容 %s" % got)
            else:
                print("        [CHECK] toc(auto) 三章标题+页码正确")
        r = runner.call("toc", {"in": head, "mode": "get"})
        if not r.get("ok") or r.get("data", {}).get("pages") != 3:
            runner.fail.append(f"toc(get) 失败: {r}")
        else:
            print("  [OK] toc(get) 只读返回页数")
        toc_set = os.path.join(outdir, "书签手动.pdf")
        runner.check("toc(set)", "toc",
                     {"in": five, "out": toc_set, "mode": "set",
                      "items": [[1, "第一章", 1], [1, "第二章", 3]]},
                     verify=lambda d: None if d.get("toc") == 2 else f"书签数={d.get('toc')} 期望2")

        meta_out = os.path.join(outdir, "清元数据.pdf")
        runner.check("metadata(clear)", "metadata",
                     {"in": merged, "out": meta_out, "mode": "clear"},
                     verify=lambda d: None if d.get("cleared") == 1 else "clear 未返回成功")
        chk = fitz.open(meta_out)
        m = chk.metadata
        chk.close()
        # producer 由 PyMuPDF 保存器写入，不可清；断言用户字段
        if any(m.get(k) for k in ("title", "author", "subject", "keywords", "creator")):
            runner.fail.append("metadata(clear) 用户字段有残留: %s" % m)
        r = runner.call("metadata", {"in": merged, "mode": "get"})
        if not r.get("ok") or "metadata" not in r.get("data", {}):
            runner.fail.append(f"metadata(get) 失败: {r}")
        else:
            print("  [OK] metadata(get) 返回字段表")

        num_out = os.path.join(outdir, "加页码.pdf")
        runner.check("number", "number",
                     {"in": five, "out": num_out, "start": 1,
                      "fmt": "第{n}页/共{total}页", "pos": "bottom-center", "size": 9},
                     verify=lambda d: None if d.get("numbered") == 5 else f"编号页数={d.get('numbered')} 期望5")
        chk = fitz.open(num_out)
        last_text = chk[4].get_text()
        chk.close()
        if "第5页/共5页" not in last_text:
            runner.fail.append("number 末页文本不符: %r" % last_text[:60])
        r = runner.call("number", {"in": five, "out": num_out, "fmt": "第{x}页"})
        if r.get("ok") or "格式串不合法" not in str(r.get("error", "")):
            runner.fail.append(f"number 非法格式串未报中文错: {r}")

        re_out = os.path.join(outdir, "重排.pdf")
        runner.check("reorder", "reorder",
                     {"in": five, "out": re_out, "order": "3,1-2,5,4"},
                     verify=lambda d: None if d.get("pages") == 5 else "reorder 页数异常")
        chk = fitz.open(re_out)
        texts = [p.get_text().strip() for p in chk]
        chk.close()
        want = ["page 3 merge split test", "page 1 merge split test",
                "page 2 merge split test", "page 5 merge split test",
                "page 4 merge split test"]
        if texts != want:
            runner.fail.append("reorder 页序不符: %s" % texts)
        r = runner.call("reorder", {"in": five, "out": re_out, "order": "1,1,2,3,4"})
        if r.get("ok") or "页码需覆盖全部页且不重复" not in str(r.get("error", "")):
            runner.fail.append(f"reorder 重复页未报错: {r}")

        crop_out = os.path.join(outdir, "裁剪.pdf")
        runner.check("crop", "crop",
                     {"in": five, "out": crop_out, "margin": 20},
                     verify=lambda d: None if d.get("cropped") == 5 else "crop 页数异常")
        chk = fitz.open(crop_out)
        cb = chk[0].cropbox
        chk.close()
        if [round(v) for v in (cb.x0, cb.y0, cb.x1, cb.y1)] != [20, 20, 575, 822]:
            runner.fail.append("crop cropbox 不符: %s" % cb)
        r = runner.call("crop", {"in": five, "out": crop_out, "margin": 500})
        if r.get("ok") or "0-200pt" not in str(r.get("error", "")):
            runner.fail.append(f"crop 超范围未报中文错: {r}")

        # ===== 套件整体内存断言 =====
        mem1 = mem_mb()
        delta_total = mem1 - mem0
        print(f"套件总耗时 {time.time() - t_start:.1f}s；套件内存 Δ{delta_total:.1f}MB"
              f"（{mem0:.1f} → {mem1:.1f}）")
        if mem0 > 0 and mem1 > 0 and delta_total > 150:
            runner.fail.append(f"套件总内存增量 {delta_total:.1f}MB > 150MB")

        if runner.fail:
            print("SELFTEST FAIL:", file=sys.stderr)
            for f in runner.fail:
                print("  - " + f, file=sys.stderr)
            return 1
        print("SELFTEST OK")
        return 0
    except Exception as e:
        print("SELFTEST FAIL: %s: %s" % (type(e).__name__, e), file=sys.stderr)
        return 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _find_gs():
    """gs 双架构探测（gswin32c/gswin64c），按进程架构优先，目录层级不定向下找。"""
    arch = _arch_pref()
    queues = []
    for base in _repo_roots():
        for a in [arch, "x64" if arch == "ia32" else "ia32"]:
            d = os.path.join(base, "engines", f"gs-{a}")
            if os.path.isdir(d):
                queues.append((os.path.normpath(d), "gswin32c.exe" if a == "ia32" else "gswin64c.exe"))
        gd = os.path.join(base, "gs")
        if os.path.isdir(gd):
            queues.append((os.path.normpath(gd), "gswin32c.exe"))
            queues.append((os.path.normpath(gd), "gswin64c.exe"))
    for root_dir, exe in queues:
        stack = [root_dir]
        while stack:
            cur = stack.pop()
            try:
                for e in os.scandir(cur):
                    if e.is_file() and e.name.lower() == exe:
                        return e.path
                    if e.is_dir():
                        stack.append(e.path)
            except OSError:
                continue
    return None


def bench_fixture(out_path, pages=50):
    """生成长样本 PDF（供 scripts/bench.cjs 使用）：每页 30 行中文短句，含少量图形。
    注意：insert_text 默认 helv 无中文字形（渲染成点阵、无法OCR），必须显式用 cjk 字体。"""
    d = fitz.open()
    try:
        font = fitz.Font("cjk")
    except Exception:
        font = None
    for i in range(pages):
        pg = d.new_page(width=595, height=842)
        if font is not None:
            # 每页只建一个 TextWriter：30 行一次性 append 后单次 write_text
            # （旧写法每行一次 write_text → 每行生成独立的字体/文本对象，merge/split 时复制代价巨大）
            tw = fitz.TextWriter(pg.rect)
            for line in range(30):
                tw.append((40, 40 + line * 25),
                          f"办公助手性能基准测试 第{i + 1}页 第{line + 1}行：文字排版引擎压力样本。",
                          font=font, fontsize=9)
            tw.write_text(pg)
        else:
            for line in range(30):
                pg.insert_text((40, 40 + line * 25),
                               f"办公助手性能基准测试 第{i + 1}页 第{line + 1}行。",
                               fontsize=9)
        pg.draw_rect(fitz.Rect(40, 780, 300, 800), color=(0.2, 0.4, 0.7), fill=(0.8, 0.9, 1))
    d.save(out_path, deflate=True, garbage=3)
    d.close()
    return out_path


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        sys.exit(selftest())
    if len(sys.argv) > 1 and sys.argv[1] == "--bench-fixture":
        # --bench-fixture <out.pdf> [pages]：生成大样本 PDF（bench.cjs 用）
        out = os.path.abspath(sys.argv[2])
        pages = int(sys.argv[3]) if len(sys.argv) > 3 else 50
        bench_fixture(out, pages)
        print(out, os.path.getsize(out))
        sys.exit(0)
    if len(sys.argv) > 1 and sys.argv[1] == "--check":
        # 依赖可用性快检（pymupdf/pdf2docx/opencv）
        import importlib
        for m in ("fitz", "pdf2docx", "cv2", "numpy", "docx"):
            importlib.import_module(m)
        print("DEPS OK")
        sys.exit(0)
    serve()
