# 电子发票批量打印工具 — Agent 指南

## 项目概览

- **版本**: v1.10.2
- **技术栈**: Tauri 2.x (Rust) + 原生 HTML/CSS/JS（无框架）
- **前端**: `src/{index.html, styles.css, ocr.js, layout.js, print.js, app.js}`
- **后端**: `src-tauri/src/{lib.rs, pdf_engine.rs, pdfium_print.rs}`
- **OFD 解析**: `src-tauri/ofd-engine/` — 独立 crate
- **双版本**: 轻量版 / OCR版（含 PP-OCRv5）

## 常用命令

```bash
npm run dev             # 轻量版开发
npm run dev:ocr         # OCR 版开发
npm run build           # 轻量版构建
npm run build:ocr       # OCR 版构建
npm run build:all       # 全量构建，产物输出到 dist/
npm run bump <版本号>    # 同步版本号到 Cargo.toml + tauri.conf.json
```

- **版本号数据源**: `package.json` 是唯一数据源
- **编译缓存**: 只改 HTML/JS/CSS 不会触发重编译，需改 Rust 文件才会完整重编译
- **CI/CD**: GitHub Actions，push tag `v*` 触发

---

## 架构要点

### PDF 生成双管道

首选 **lopdf 直通管道**（矢量无损）→ 失败时自动回退 **printpdf 渲染管道**

- `generate_pdf_from_layout()` 入口
- lopdf 直通: `can_passthrough_pdf()` 判断 → `extract_page_as_form_xobject()` → JPEG DCTDecode 嵌入
- 打印四模式: PDF阅读器模式(默认) / 弹窗确认 / 静默打印PDFium(推荐) / 静默打印SumatraPDF

### PDF 渲染双引擎 (v1.9.10+)

首选 **WinRT PDF**（系统组件）→ 失败时自动回退 **PDFium 渲染**

- 启动检测: `check_winrt_pdf_available()` 创建临时 PDF 测试 WinRT `PdfDocument` API
- WinRT 渲染: `render_pdf_pages()` — `windows::Data::Pdf::PdfDocument` + `StorageFile`
- PDFium 渲染: `render_pdf_pages_pdfium()` — `FPDF_LoadMemDocument` + `FPDF_RenderPageBitmap` → PNG
- 前端 fallback 链: `_winrtPdfAvailable` 标志 → WinRT 失败自动切换 PDFium
- PDFium 位图渲染: `pdfium_print::render_pdf_to_images()` — BGRA→RGBA 转换 + PNG 编码

### 发票字段提取

**路径优先级**: PDF文字层 > OFD XML > OCR

- **发票类型检测**: `_detectInvoiceType()` — nontax(优先级最高) > vat > ticket > ride > unknown
- **金额三阶段**: 含税价 → 数学验证配对 → 区域解析
- **中文大写兜底**: `parseChineseNumeral()` — 阿拉伯金额因字体/编码丢失时的 fallback
- **OCR 跳过条件**: `_pdfTextExtracted && sellerName && amountTax > 0`

### PDF 文字层提取 (v1.9.4+)

Rust `extract_pdf_text()` 解析 lopdf content stream，前端 `applyPdfTextResult()` 复用 `extractByCoordinates()`。

**关键坑**:
- Form XObject 内嵌字体需展开（`/Subtype /Form`）
- GBK-EUC-H 编码需 `encoding_rs::GBK.decode()` 兜底
- `Content::encode()` 最后无换行，追加字节前必须加 `\n`
- 内容流顺序 ≠ 视觉顺序，金额取**最大** ¥ 金额

### 页脚与分割线

- **页脚边距模型**: footerMargin 是纸张底部额外独立空间，不影响 slot 边距
- **分割线**: JS 端 top-down 坐标，Rust 端 bottom-up 坐标（PDF 标准），⚠️ 不要做坐标转换

### PDFium 矢量打印 (v1.9.8+)

`pdfium_print.rs` — Chromium PDFium 引擎直打打印机 DC，无需 EMF 中间层

- **DLL 生命周期**: `LazyLock<Mutex<Option<PdfiumState>>>` 全局持有，`_lib` 字段防止 DLL 卸载
- **线程安全**: `with_pdfium()` 闭包模式，所有 PDFium 调用经 Mutex 串行化
- **渲染流程**: `FPDF_LoadMemDocument` → 逐页 `FPDF_RenderPage(printer_dc)` → 打印机原生 DPI
- **DEVMODEW**: `build_dev_mode()` + `infer_paper_size()` 标准纸映射，自定义纸用 `DMPAPER_USER`
- **下载机制**: `AtomicBool DOWNLOAD_CANCELLED` 全局取消标志，`cancel_download` 命令通知 Rust 端
- **缓存复用**: `_pdfDirty` + `_lastPdfPath` 统一三个打印渠道（PDFium / SumatraPDF / PDF阅读器）
- **DLL 位置**: `{exe}/tools/pdfium.dll`（与 SumatraPDF.exe 同目录）
- **下载源**: `bblanchon/pdfium-binaries` via `gh-proxy.com` 加速

---

## 前端模块

| 文件 | 职责 |
|------|------|
| `app.js` | 主入口、状态管理(S)、文件加载、Tauri IPC |
| `ocr.js` | 发票字段提取、金额解析、中文大写解析 |
| `layout.js` | 布局计算、预览渲染、单票调整拖拽 |
| `print.js` | 打印/导出、构建 LayoutRenderRequest |

- 全部用 `var` 声明顶层变量（避免与 Tauri 注入脚本冲突）
- 无模块打包，`index.html` 按顺序 `<script>` 加载

---

## Feature Flag

- Cargo.toml 定义 `ocr` feature，`lib.rs` 按 `#[cfg(feature = "ocr")]` 条件注册命令
- OCR 构建用 `tauri.ocr.conf.json` 叠加配置（仅追加 bundle.resources）

---

## 关键踩坑

### Tauri 2.x
- `<input>.click()` 无效 → 用 `plugin:dialog|open`
- `async fn` 后端命令必须用 `spawn_blocking` 包装

### OFD
- ImageMask 遮罩: 二值图合成主图 alpha 通道
- 自闭合标签不能用 `read_element_text()`
- CJK 拆字问题(dzcp格式): 需虚拟标签合成

### 进程生命周期
- 关闭时必须用 `TerminateProcess`，不能用 `process::exit(0)`（MNN/OCR 引擎死锁）

### PDFium 打印
- `libloading::Library` 不能在函数内创建，drop 时 DLL 卸载导致全局状态崩溃 → 用全局 `LazyLock<Mutex<Option<PdfiumState>>>` 持有
- PDFium 不是线程安全的 → `with_pdfium()` 闭包 + Mutex 串行化
- `CreateEnhMetaFileW` 的 `lpRect` 是 0.01mm 单位不是像素，但直接渲染到打印机 DC 时无需 EMF 中间层
- `DEVMODEW` 嵌套匿名结构: `dm.Anonymous1.Anonymous1.dmCopies`，`dmDuplex` 是 `DEVMODE_DUPLEX(i16)`
- `DOCINFOW`/`StartDocW`/`StartPage`/`EndPage` 在 `Win32::Storage::Xps` 模块（不是 Gdi）
- `windows` crate 0.58: `HENHMETAFILE` 是 CopyType，`DeleteEnhMetaFile(h)` 不需要 `&`

### EXIF
- `image` crate 不自动应用 EXIF；6=90°CW, 8=90°CCW, 3=180°

---

## Git 工作流

- 开发在 `dev` 分支，完成后合并到 `master`
- 小步提交，完成即 push
- 变动大时升版本打 tag 触发 CI
- 会话结束前确保无未提交变更

---

## 用户偏好

- 简洁直接，对 Bug 极度敏感，全面修复原则
- 不要主动编译（耗时），等明确指令
- 分析任务绝对不可修改代码，必须先确认方案

---

## Release 检查清单

每次 release 前必须完成以下文档更新：

1. **README.md**：更新功能描述、技术栈版本等，确保与当前版本一致
2. **CHANGELOG.md**：补充新版本更新日志，包含新功能/修复/优化/依赖变更等
3. **AGENTS.md**：更新版本号、架构要点（如有变更）
4. **其他文档**：如有新增配置/命令/架构变更，同步更新对应文档
