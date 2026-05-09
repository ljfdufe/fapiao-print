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

## 长期记忆
历史踩坑、字段提取细节、金额解析逻辑等见 `.workbuddy/memory/MEMORY.md`