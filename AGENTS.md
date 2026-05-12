# 电子发票批量打印工具 — Agent 指南

## 项目概览
- **技术栈**: Tauri 2.x (Rust) + 原生 HTML/CSS/JS（无框架）
- **前端入口**: `src/{index.html, app.js, ocr.js, layout.js, print.js}`
- **后端入口**: `src-tauri/src/{lib.rs, pdf_engine.rs}`
- **OFD 解析**: `src-tauri/ofd-engine/src/lib.rs` — 独立 crate，SVG 渲染 + XML 字段直提
- **双版本构建**: 轻量版（无 OCR，~3.5MB）vs OCR 版（PP-OCRv5，~24MB）

## 构建命令
```bash
npm run dev          # 轻量版开发
npm run dev:ocr      # OCR 版开发
npm run build        # 轻量版构建
npm run build:ocr    # OCR 版构建
npm run build:all    # 全量构建，4 产物输出到 dist/
npm run bump 1.9.6   # 同步 package.json → Cargo.toml → tauri.conf.json 版本号
```
- **版本号**: `package.json` 是唯一数据源，`bump` 脚本同步到其他文件
- **编译缓存**: 只改 HTML/JS/CSS 不会重新嵌入 Rust 代码，需改 Rust 才触发完整重编译

## 架构要点

### PDF 文字层提取（轻量版也能用）
- Rust `extract_pdf_text()` → 解析 lopdf content stream Tm+Tj/TJ，带坐标
- 前端 `applyPdfTextResult()` 复用 `extractByCoordinates()` 逻辑
- 合并优先级: 结构化提取 > OCR，OCR 仅在文字层不完整时兜底

### 发票字段提取架构
- **双重架构**: 文本优先 → 坐标回退
- **三种路径**: PDF 文字层提取 / OFD XML 直提 / OCR 识别
- **金额三阶段**: 含税价 → 数学验证配对 → 区域解析
- **中文大写兜底**: `parseChineseNumeral()` 将"捌仟捌佰壹拾玖圆陆角整"转为 8819.60
- **字段**: amountTax, amountNoTax, taxAmount, sellerName, sellerCreditCode, invoiceNo, invoiceDate, buyerName, buyerCreditCode

### PDF 生成（JPEG 直通）
- `generate_pdf_passthrough()` 使用 lopdf Form XObject + JPEG DCTDecode
- CropBox 优先，可能颠倒(y1>y2)需规范化；必须处理 /Rotate
- `build_cutline_ops_lopdf()` 在内容流绘制虚线切割线（bottom-up 坐标）
- 页脚边距模型: footerMargin 是纸张底部独立空间，不影响 slot 边距

### OFD
- `parse_ofd` → `{svg, invoice_info, page_width, page_height}`
- 不同厂商 OFD 格式差异: 税务原版、iloveofd、dzcp 等
- ImageMask 遮罩: 二值图合成主图 alpha 通道
- 跨 Layer DrawParam 继承隔离，每个 Layer 独立
- 自闭合标签不能用 `read_element_text()`

### 单票独立调整
- 数据模型: `fileObj.{slotScale, slotOffsetX, slotOffsetY}`
- PDF Y 轴与 JS 相反 → offset_y 取反

## 关键踩坑

### Tauri 2.x
- `<input>.click()` 无效 → 使用 `plugin:dialog|open`
- 顶层 JS 用 `var` 避免与 Tauri 注入脚本冲突
- `async fn` 后端命令必须用 `spawn_blocking` 包装同步 CPU 密集操作

### PDF
- lopdf `Content::encode()` 最后操作后无换行，追加字节前必须加 `\n`
- Form XObject 内嵌字体: 页面内容流只有 `q /Fr1 Do Q`，需展开 XObject 内容流
- GBK/EUC-H 编码: `encoding_rs::GBK.decode()` 兜底，避免 Latin-1 乱码
- 内容流顺序 ≠ 视觉顺序，金额提取取最大 ¥ 金额（而非最后）

### OFD
- ImageObject CTM 是像素→mm 映射；DeltaX 是绝对间距
- 字体名归一化处理 PREFIX+ 格式子集名

### EXIF
- `image` crate 不自动应用 EXIF 方向: 6=90°CW, 8=90°CCW, 3=180°

## 发票类型
- `vat`: 增值税发票，关键词"增值税"
- `nontax`: 非税票据，关键词"非税收入/票据号码/票据代码/交款人"
- `ticket`: 火车票，关键词"电子客票/铁路电子客票"
- `ride`: 旅客运输，关键词"旅客运输"
- 其他 → `unknown`

## CI/CD
- GitHub Actions: push tag `v*` 触发构建
- 构建脚本 `build-all.js` 依次编译轻量版、OCR 版，产出 4 个产物

## Git 工作流

**用 `git stash` 暂存，不直接 commit**
- 一个 bug 可能跨多轮对话才修好，逐轮 commit 会污染历史
- 每次对话结束前 `git stash push -m "简短描述"`，修完验证后再 commit

**适合直接 commit 的时机：**
- 一个功能/bug 修复完整完成并验证通过
- 文档、配置、依赖更新等独立改动

## 前端模块职责

| 文件 | 职责 | 关键全局变量/函数 |
|------|------|------------------|
| `app.js` | 主入口、状态管理(S)、文件加载、Tauri IPC 调用、拖放处理 | `S`, `invoke`, `hasOcr`, `createFileObj()`, `getSettings()`, `getActiveFiles()` |
| `ocr.js` | 发票字段提取（三路径）、金额解析、中文大写解析 | `extractByCoordinates()`, `applyPdfTextResult()`, `parseChineseNumeral()` |
| `layout.js` | 布局计算（纯函数）、预览渲染、单票调整拖拽 | `calculateLayout()`, `renderPreview()`, `buildPages()` |
| `print.js` | 打印/导出、构建 LayoutRenderRequest 传给 Rust | `buildLayoutRequest()`, `doPrint()`, `doSavePdf()` |

- 全部用 `var` 声明顶层变量（避免与 Tauri 注入脚本冲突）
- 前端无模块打包，`index.html` 按顺序 `<script>` 加载，存在隐式依赖关系

## Feature Flag 与命令注册

- Cargo.toml 定义 `ocr` feature（`ocr = ["ocr-rs"]`）
- `lib.rs` 中 `invoke_handler` 按 `#[cfg(feature = "ocr")]` 条件注册不同命令集
- OCR 版额外命令: `render_and_ocr_pdf`, `ocr_image`, `ocr_pdf_page`
- 前端启动时调用 `check_ocr_available()` 决定是否显示 OCR UI
- OCR 构建使用 `tauri.ocr.conf.json` 叠加配置（仅追加 `bundle.resources` 模型文件），主配置始终是 `tauri.conf.json`

## 打印管道架构（三条路径）

```
前端 buildLayoutRequest() → Rust generate_pdf_from_layout()
                                    ↓
                    ┌─ lopdf 直通（generate_pdf_passthrough）
                    │   PDF 页 → Form XObject 矢量嵌入
                    │   图片/OFD → JPEG XObject 高质量嵌入
                    │   失败时自动回退 ↓
                    └─ printpdf 渲染管道（兜底）
                            ↓
                    生成 PDF 文件 → 打印/导出
```

**打印输出三模式**:
1. **PDF 阅读器模式**（默认）: 生成 PDF → `ShellExecuteW("open")` 打开系统默认 PDF 程序，用户手动打印。保持矢量质量，数据量最小（~1.4MB）。
2. **弹窗确认模式**: 显示打印确认弹窗 → 确认后通过 SumatraPDF 静默打印。
3. **静默打印模式**: 直接通过 SumatraPDF CLI 发送到打印机。注意：SumatraPDF 会将 PDF 光栅化为位图后打印，数据量可能从 1.4MB 增加到 60MB+（取决于打印机 DPI）。

**已知问题**: SumatraPDF 的 `-print-to` 实现是将每页渲染为位图后通过 GDI 发送给打印机，而非矢量直通。WPS/Adobe Reader 等程序打印时走矢量路径（~3MB）。在找到更好的静默打印方案前，默认使用 PDF 阅读器模式。

## IPC 数据流优化

- **磁盘路径直通**: 当文件有 `_filePath` 时，前端传路径而非 base64，Rust 直接读磁盘（省 ~30% 数据 + CPU）
- **PDF 页面零往返 OCR**: `ocr_pdf_page()` 在 Rust 端完成「渲染 + OCR」，避免 Rust→base64→IPC→前端→缩放→base64→IPC→Rust 的往返
- **批量渲染+OCR**: `render_and_ocr_pdf()` 一次 IPC 完成所有页面的渲染和 OCR
- **进度事件**: `generate_pdf_from_layout` 是 `async fn` + `spawn_blocking`，通过 `app.emit("pdf-progress")` 推送三阶段进度（decode / build / save）
- **PDF 脏标记**: 前端 `_pdfDirty` 标记布局/内容是否变化，未变化时 `print_pdf_file()` 复用上次生成的 PDF，跳过重新生成

## 进程生命周期

- **启动**: `"visible": false` → 前端加载完成后调用 `show_window()` → 避免白屏闪烁
- **Windows 版本检查**: 启动即检查 Build Number ≥ 17134 (Win10 1803)，不满足弹 MessageBox 后 exit
- **关闭机制**:
  1. `CloseRequested` → `api.prevent_close()` 阻止默认关闭
  2. 设置 `SHUTTING_DOWN = true`（所有长时操作检查此标志提前中止）
  3. 通知前端 `_tauriCleanup()` 清理 OCR 队列
  4. 300ms 后 `TerminateProcess`（不用 `ExitProcess`，避免 DLL_PROCESS_DETACH 死锁）
- **关闭时不可用 `process::exit(0)`**: MNN/OCR 引擎在 DLL_PROCESS_DETACH 可能死锁，必须用 `TerminateProcess` 强制终止

## PDF 生成双管道细节

**lopdf 直通管道**（首选，矢量无损）:
- `can_passthrough_pdf()` 判断 PDF 页面是否可直通
- `extract_page_as_form_xobject()` 将源 PDF 页面提取为 Form XObject
- `deep_copy_object()` + `remap_references()` 深拷贝资源并重映射 ObjectId
- 图片/OFD 源: 解码为 JPEG → DCTDecode 嵌入同一 lopdf Document
- 支持所有布局(N×M) + 旋转 + 单票偏移缩放

**printpdf 渲染管道**（兜底）:
- 所有源统一解码为 `DynamicImage` → `add_image()` 嵌入
- 当 lopdf 管道因任何错误失败时自动回退到此路径
- 日志: `lopdf直通失败，回退printpdf渲染管道: {error}`