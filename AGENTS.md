# 电子发票批量打印工具 — Agent 指南

## 项目概览

- **版本**: v2.0.2
- **技术栈**: Tauri 2.x (Rust) + 原生 HTML/CSS/JS（无框架）
- **前端**: `src/{index.html, styles.css, ocr.js, layout.js, print.js, app.js}`
- **后端**: `src-tauri/src/{main.rs, lib.rs, pdf_engine.rs, pdfium_print.rs}`
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

### IPC 异步化 (async + spawn_blocking)

所有 CPU 密集型后端命令必须用 `async fn` + `spawn_blocking` 包装，防止 IPC 消息泵饥饿导致 `ERR_CONNECTION_REFUSED`。

- `render_pdf_pages` / `render_pdf_pages_pdfium` / `extract_pdf_text` / `extract_pdf_texts` 均已异步化
- `spawn_blocking` 将计算移到线程池，IPC 线程可继续处理消息
- 非 `async fn` 的同步命令会阻塞 IPC 线程

---

## 架构要点

### PDF 生成双管道

首选 **lopdf 直通管道**（矢量无损）→ 失败时自动回退 **printpdf 渲染管道**

- `generate_pdf_from_layout()` 入口
- lopdf 直通: `can_passthrough_pdf()` 判断 → `extract_page_as_form_xobject()` → JPEG DCTDecode 嵌入
- 打印四模式: PDF阅读器模式(默认) / 弹窗确认 / 静默打印PDFium(推荐) / 静默打印SumatraPDF
- **PDF阅读器模式已知限制**: 通过 `ShellExecuteW` 委托系统默认 PDF 阅读器打印，`printto` 动词能否指定打印机取决于阅读器实现（Edge/Chrome 内置查看器不支持），多数情况下 fallback 到 `print` 动词使用默认打印机，**无法可靠控制打印机选择**

### PDF 渲染双引擎 (v1.9.10+)

首选 **WinRT PDF**（系统组件）→ 失败时自动回退 **PDFium 渲染**

- 启动检测: `check_winrt_pdf_available()` 创建临时 PDF 测试 WinRT `PdfDocument` API
- WinRT 渲染: `render_pdf_pages()` — `windows::Data::Pdf::PdfDocument` + `StorageFile`
- PDFium 渲染: `render_pdf_pages_pdfium()` — `FPDF_LoadMemDocument` + `FPDF_RenderPageBitmap` → PNG
- 前端 fallback 链: `_winrtPdfAvailable` 标志 → WinRT 失败自动切换 PDFium
- PDFium 位图渲染: `pdfium_print::render_pdf_to_images()` — BGRA→RGBA 转换 + PNG 编码

### 预览与打印 DPI 分离 (v1.10.5)

预览和打印使用不同的 DPI 和图片格式，兼顾速度与质量：

- **预览 DPI**: `PDF_PREVIEW_DPI = 150`（屏幕显示足够清晰，是打印 DPI 的一半）
- **打印/保存 DPI**: `PDF_RENDER_DPI = 300`（高质量输出，不变）
- **预览格式**: JPEG（quality 80%），文件体积比 PNG 小 60-80%
- **打印格式**: PDF 直通管道输出矢量 PDF，不受预览分辨率影响
- `RenderedPage.format` 字段：前端据此判断图片格式（`"png"` 或 `"jpeg"`）
- **移除预览时的自适应 DPI 缩放**：自适应缩放仅用于打印质量输出

### 发票字段提取

**路径优先级**: PDF文字层 > OFD XML > OCR

- **发票类型检测**: `_detectInvoiceType()` — nontax(优先级最高) > vat > ticket > ride > unknown
- **金额三阶段**: 含税价 → 数学验证配对 → 区域解析
- **中文大写兜底**: `parseChineseNumeral()` — 阿拉伯金额因字体/编码丢失时的 fallback
- **OCR 跳过条件**: `_pdfTextExtracted && sellerName && amountTax > 0`

### PDF 文字层提取 (v1.9.4+ / 批量 v1.10.5)

Rust `extract_pdf_text()` 解析 lopdf content stream，前端 `applyPdfTextResult()` 复用 `extractByCoordinates()`。

**批量提取 (v1.10.5)**:
- `extract_pdf_texts(pdf_path, page_indices)` — 一次打开 PDF，rayon 并行提取多页文字
- 前端 `applyPdfTextToResults(results, pdfPath)` — 按 PDF 路径分组，多 PDF 文件独立批量调用
- 批量失败时自动回退到单页 `extract_pdf_text()`
- `extract_pdf_text_from_doc()` — 内部共享函数，单页/批量共用同一实现

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
- **缓存复用**: 智能缓存 `deepEqual` + `canUseCachedPdf` 统一三个打印渠道（PDFium / SumatraPDF / PDF阅读器）
- **DLL 位置**: `{exe}/tools/pdfium.dll`（与 SumatraPDF.exe 同目录）
- **下载源**: `bblanchon/pdfium-binaries` via `gh-proxy.com` 加速

### PDFium 打印 SEH 保护 (v1.10.3)

部分打印机驱动的 GDI 实现有 bug，`FPDF_RenderPage` 直打 DC 时可能触发原生访问违例（ACCESS_VIOLATION），Rust 无法捕获导致直接闪退。

- **SEH 包装器**：`seh_wrapper.c` C 文件，用 `__try/__except` 捕获原生崩溃
- **矢量优先 + 位图 fallback**：始终先尝试矢量直打 DC（零质量损失），仅在 SEH 捕获异常时自动 fallback 到 `FPDF_RenderPageBitmap` + `StretchDIBits` 位图渲染
- **编译**: `cc` build-dependency 将 C 文件编译为静态库链接

### DEVMODE 完整缓冲区 (v1.10.3)

`get_printer_default_devmode()` 必须保留驱动私有数据，否则 `CreateDCW` 访问违例。

- 原先用 `std::ptr::read` 只复制 `sizeof(DEVMODEW)` 字节，丢弃 `dmDriverExtra` 字节
- 现改为返回完整 `Vec<u8>` 缓冲区，保留全部驱动配置（纸盒选择、纸张来源等）

### 打印流程解耦 (v1.10.4)

各打印模式独立调用对应命令，不再经 `generate_pdf_from_layout` 隐式降级。

- SumatraPDF / PDFium / PDF 阅读器模式直接调用各自的打印命令
- 此前 SumatraPDF 模式重新生成时会 fallback 到 `shell_execute_print`，PDF 阅读器模式会经 SumatraPDF 路径 → 现已修正

### 设置持久化 (v1.10.1)

关闭软件后自动记住用户设置，下次打开自动恢复。

- **统一入口**: `saveSettings()` / `loadSettings()` — `fapiao-settings` JSON 存储
- **覆盖范围**: 排版布局、纸张、边距、缩放、旋转、份数、颜色、打印模式、辅助开关、水印、页脚、下边距
- **防抖保存**: `updatePreview()` 500ms 防抖自动触发 `saveSettings()`
- **恢复默认**: 清除所有持久化数据

### 金额校验可视化 (v1.10.4)

OCR 和 PDF 文字提取金额求和校验失败时可视化提示。

- 发票卡片金额徽章显示 ⚠ 警告标识
- hover 警告徽章可查看含税/不含税/税额/验证计算详情
- 汇总栏新增校验异常发票计数提示

### 排版份数批量设置 (v1.10.4)

文件列表新增 ② 按钮，支持批量设置选中发票排版份数（×1/×2/×3）。

- **区分概念**: 「排版份数」= 每张发票在版面中重复几次 / 「打印份数」= 整版打印几份
- 模态框和设置面板分别标注，避免混淆

### 单票独立调整增强 (v2.0.1+v2.0.2)

每张发票可独立缩放/偏移，CSS transform 预览 + Rust `SlotSpec` 参数 PDF 裁剪输出。

**v2.0.1 — UI 完善**:
- **快速对齐九宫格**：一键贴边/居中，9 种对齐方向（↖↑↗←⊙→↙↓↘）
- **鼠标滚轮增减**：所有数字输入框和滑块支持滚轮微调
- **拖动修复**：CSS transform 应用到 wrapper div（与渲染一致），消除拖动错位
- **偏移范围扩展**：±50→±150mm，覆盖 A3/A4 所有布局
- **调整记忆**：可选的单票调整配置持久化（按文件名匹配，跨会话恢复）

**v2.0.2 — 交互优化**:
- **放大上限 3x**：slotScale 上限从 2.0 放宽到 3.0，解决地铁行程单等窄长发票放大不够的问题
- **拖拽约束动态化**：根据发票实际显示尺寸（兼容 contain/fill/original/custom 四种适配模式）动态计算可拖范围
- **滚轮缩放单票**：单击选中槽位后，鼠标滚轮直接调节该票缩放比例（5%/步），无需去侧边面板
- **编辑态溢出可见**：选中或拖拽中的发票临时显示超出 slot 的内容，方便判断调整方向；非编辑态保持 overflow:hidden

**数据模型**: `fileObj.{slotScale, slotOffsetX, slotOffsetY}` — 独立于全局排版参数
**持久化**: `perFileAdjustments` Map 按文件名匹配，可选开启/关闭，重启后恢复

### 预览加载优化 (v1.10.5)

大幅提升 PDF 文件预览加载速度（2-3 倍）。

- **预览 DPI**: 300 → 150，渲染像素减少 75%
- **图片格式**: PNG → JPEG（quality 80%），文件体积减少 60-80%
- **打印不受影响**: 打印/保存走独立矢量流程（lopdf 直通），直接从原始 PDF 读取
- `render_pdf_pages` / `render_pdf_pages_pdfium` 新增 `use_jpeg` 参数
- `RenderedPage` 新增 `format` 字段（`"png"` / `"jpeg"`）
- `PDF_PREVIEW_DPI = 150` 常量独立于 `PDF_RENDER_DPI = 300`

### 智能 PDF 缓存 (v1.10.5)

用深度对象比较替代 dirty flag，精确判断缓存的 PDF 是否可复用。

- `deepEqual(a, b)` — 递归深度比较，比较整个 `LayoutRenderRequest`
- `canUseCachedPdf(currentRequest)` — 只要排版参数没变，任何打印模式/H5导出都复用
- `updatePdfCache(request, pdfPath)` — 更新缓存引用
- 替代了旧的 `_pdfDirty` / `_lastPdfPath` 简单标记方案
- **保存 PDF 复用**: `savePdf` 先生成到临时目录作为缓存，再 `copy_file` 复制到用户路径，后续布局不变时直接复制缓存文件

### PDFium 打印自动降级

PDFium 打印失败时自动 fallback 到 SumatraPDF，提升容错性。

- `doPdfiumPrint` 中异常/失败时不再报错退出，自动调用 `doSumatraPrint(files, s)`
- 用户无感知降级，打印始终有兜底

### 批量文件加载优化 (v1.10.5)

重构 `processFilesIncremental`，显著减少 IPC 往返次数和加载等待时间。

- **一次批量 IPC**: `open_invoice_files({paths: paths})` 一次性读取所有文件，替代逐文件调用
- **并行渲染**: `Promise.all` 并发渲染所有文件，增量替换骨架屏
- **定时刷新 UI**: `setInterval` 按时间间隔批量更新 DOM，避免每个文件都触发重绘
- **Toast 防抖**: toast 更新间隔从每文件变为 100ms 最低间隔

### copy_file 命令 (v1.10.5)

新增 Rust 端文件复制命令，用于缓存 PDF 复用到保存路径。

---

## 前端模块

| 文件 | 职责 |
|------|------|
| `app.js` | 主入口、状态管理(S)、文件加载（批量IPC+并行渲染）、Tauri IPC、设置持久化、批量文字提取分发 |
| `ocr.js` | 发票字段提取、金额解析、中文大写解析、类型检测、金额校验 |
| `layout.js` | 布局计算、预览渲染、单票调整拖拽、slot 交互 |
| `print.js` | 打印/导出、构建 LayoutRenderRequest、智能 PDF 缓存（deepEqual）、四种打印模式分发、PDFium→SumatraPDF 自动降级 |

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
- **同步命令阻塞 IPC 线程**：非 `async fn` 的命令在 Tauri 2.x 中会阻塞 IPC 消息泵，导致 `ERR_CONNECTION_REFUSED`。所有 CPU 密集型命令必须 `async fn` + `spawn_blocking`

### 智能 PDF 缓存
- `deepEqual` 比较整个 `LayoutRenderRequest` 对象，任何字段变化都触发重新生成
- 保存 PDF 时先生成到临时目录 → `updatePdfCache(req, tempPath)` → `copy_file` 到用户路径
- `copy_file` 是 Rust 端命令（`std::fs::copy`），避免 JS 端文件系统操作限制

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
- **SEH 保护**: 打印机驱动 GDI bug 导致 `FPDF_RenderPage` 原生崩溃 → `seh_wrapper.c` 用 `__try/__except` 捕获，fallback 到位图渲染
- **DEVMODE 截断**: `std::ptr::read` 只复制 `sizeof(DEVMODEW)` 丢弃驱动私有数据 → 返回完整 `Vec<u8>` 缓冲区

### 预览与打印分离
- 预览 DPI (150) 和打印 DPI (300) 独立管理，`PDF_PREVIEW_DPI` ≠ `PDF_RENDER_DPI`
- 预览用 JPEG 编码减小传输体积，打印走矢量直通管道不受影响
- `loadFileFromDataUrlFast()` 中 PDF 渲染调用必须传递 `useJpeg: true`, `dpi: PDF_PREVIEW_DPI`

### 批量文字提取
- 多 PDF 文件场景下必须按 `pdfPath` 分组调用 `extract_pdf_texts`，不能用跨 PDF 的 pageIdx 请求
- `extract_pdf_texts` 返回 `HashMap<u32, PdfTextResult>` keyed by pageIdx，前端按 `r._pdfPageIdx` 取对应结果
- 批量失败时自动回退单页 `extract_pdf_text`，再失败则回退 OCR

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
