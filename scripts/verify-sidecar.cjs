#!/usr/bin/env node
/**
 * 侧车端到端自检：对双架构 staging/sidecar-ia32|zu x64 各执行 worker.py --selftest。
 * 依次：造 PDF → 加密/解密 roundtrip → 合并/拆分 → pdf2word → pdf2img → tesseract OCR。
 * 输出双 SELFTEST OK 才算通过。
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ARCHES = ["ia32", "x64"];

/* 关键：先把改过的 sidecar/worker.py 同步进 staging，防止"改了源码忘同步"导致自检跑旧代码 */
for (const a of ARCHES) {
  const dst = path.join(ROOT, "staging", `sidecar-${a}`, "worker.py");
  if (fs.existsSync(path.dirname(dst))) {
    fs.copyFileSync(path.join(ROOT, "sidecar", "worker.py"), dst);
    console.log(`已同步 worker.py → staging/sidecar-${a}`);
  }
}

for (const arch of ARCHES) {
  const dir = path.join(ROOT, "staging", `sidecar-${arch}`);
  const py = path.join(dir, "python.exe");
  if (!fs.existsSync(py)) { console.error(`缺少 ${py}，请先 npm run build:sidecar`); process.exit(1); }
  console.log(`--- selftest ${arch} ---`);
  const r = spawnSync(py, [path.join(dir, "worker.py"), "--selftest"], {
    stdio: "inherit",
    env: {
      ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1",
      TESSDATA_PREFIX: path.join(ROOT, "engines", `tesseract-${arch}`, "tesseract", "tessdata"),
    },
  });
  if (r.status !== 0) { console.error(`${arch} selftest 失败`); process.exit(1); }
}
console.log("\n全部通过");
