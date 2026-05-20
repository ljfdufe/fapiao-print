# PDF 加载失败分析计划

## 一、Git 同步状态

当前环境未安装 Git，无法直接检查本地与远程同步状态。

**版本号一致性检查**（通过文件内容确认）：
| 文件 | 版本号 |
|------|--------|
| `package.json` | 1.9.10 |
| `tauri.conf.json` | 1.9.10 |
| `Cargo.toml` | 1.9.10 |

三个文件的版本号一致（1.9.10），但 **AGENTS.md 记录的版本是 v1.9.9**，说明 AGENTS.md 未更新。需要用户在有 Git 的环境确认远程是否为最新。

---

## 二、PDF 加载失败根因分析

### 核心发现：PDF 与图片加载路径完全不同

| 阶段 | 图片 (jpg/png/...) | PDF |
|------|---------------------|-----|
| 1. `read_invoice_files()` | Rust 端直接读取→解码→生成缩略图→base64 dataUrl | 仅返回空 dataUrl + 文件路径 |
| 2. 前端 `loadFileFromDataUrlFast()` | `new Image()` 直接加载 dataUrl → 完成 | 需额外调用 `render_pdf_pages` IPC |
| 3. Rust `render_pdf_pages()` | 不涉及 | 依赖 **WinRT `windows::Data::Pdf::PdfDocument`** API |

**图片加载不依赖任何系统组件**（纯 Rust `image` crate 解码），而 **PDF 渲染完全依赖 Windows WinRT PDF 组件**。这是"图片能加载但 PDF 失败"的根本原因。

---

### 可能原因（按概率排序）

#### 1. 🔴 WinRT PDF 组件缺失/损坏（最高概率）

`render_pdf_pages()` 使用 `windows::Data::Pdf::PdfDocument` API，这是 Windows 10 1703+ 内置的 WinRT 组件。以下情况会导致该组件不可用：

- **Windows LTSC/Enterprise 精简版**：部分企业定制镜像移除了"Windows PDF 阅读器"组件
- **组策略禁用**：企业环境可能通过 GPO 禁用了 Windows PDF 功能
- **系统组件损坏**：`sfc /scannow` 可修复
- **Windows 7/8**：不支持 WinRT PDF API（但应用已有 Build 17134 最低版本检查）

**错误表现**：`StorageFile::GetFileFromPathAsync` 或 `PdfDocument::LoadFromFileAsync` 抛出 COM 异常 → 前端收到 "PDF 渲染失败" 或 "加载文件失败"

#### 2. 🟡 COM 线程模型冲突

`render_pdf_pages()` 是同步 Tauri command（非 `async`），在 IPC 线程上运行。每次调用都执行：
```rust
let _com = ComGuard::init();  // CoInitializeEx(COINIT_APARTMENTTHREADED)
```

如果 Tauri 的 IPC 线程已经以 `COINIT_MULTITHREADED` 初始化了 COM，则 `CoInitializeEx(STA)` 会返回 `RPC_E_CHANGED_MODE`（0x80010106）。虽然代码忽略了返回值，但 **STA 模式实际上未生效**，而 WinRT 的 `PdfDocument` 等 async 操作在 MTA 线程上调用 `.get()` 可能死锁或失败。

**对比**：图片加载不涉及 COM，所以不受影响。

#### 3. 🟡 文件路径问题

`StorageFile::GetFileFromPathAsync` 对路径有严格要求：
- 超长路径（>260 字符）
- UNC 路径（`\\server\share\...`）
- 含特殊字符的中文路径
- 文件被其他进程锁定

而图片加载用的是 `std::fs::read()`，对路径更宽容。

#### 4. 🟢 PDF 文件本身问题

- 密码保护的 PDF → `PdfDocument::LoadFromFileAsync` 失败（错误消息已提示）
- 损坏的 PDF → 同上
- 使用了 WinRT PDF 引擎不支持的 PDF 特性

#### 5. 🟢 无 fallback 机制

当前代码在 PDF 渲染失败时**没有 fallback**：
```javascript
// app.js L1090-1093
.catch(function(err) {
    console.error('[PDF] WinRT rendering failed:', err);
    toast('PDF 渲染失败: ' + name);
    resolve(null);  // 直接返回 null，文件被丢弃
});
```

对比 OFD 有 fallback（`parse_ofd` 失败 → 回退 `open_ofd_images`），PDF 完全没有。

---

### 三、修复方案

#### 方案 A：添加 lopdf fallback 渲染管道（推荐）

当 WinRT `render_pdf_pages` 失败时，使用已有的 `lopdf` 解析 PDF + `image` crate 渲染为图片：

1. 在 `pdf_engine.rs` 中新增 `render_pdf_pages_fallback()` 函数
2. 使用 `lopdf::Document::load()` 解析 PDF
3. 提取每页的图片资源（XObject Image）或文字内容
4. 如果页面有嵌入图片，直接提取；如果是纯文字页面，用 `printpdf` 或 `ab_glyph` 光栅化
5. 前端在 `render_pdf_pages` 的 `.catch()` 中调用 fallback

**优点**：不依赖系统组件，纯 Rust 实现
**缺点**：lopdf 渲染能力有限（复杂 PDF 可能渲染不完整），需要较多开发工作

#### 方案 B：添加 PDFium fallback 渲染管道

项目已有 PDFium 集成（`pdfium_print.rs`），可以复用：

1. 在 `pdf_engine.rs` 中新增 `render_pdf_pages_pdfium()` 函数
2. 使用 PDFium 的 `FPDF_LoadMemDocument` + `FPDF_RenderPage` 渲染为位图
3. 前端在 `render_pdf_pages` 的 `.catch()` 中调用 PDFium fallback

**优点**：PDFium 渲染质量高，与 Chrome 相同引擎
**缺点**：需要 pdfium.dll 存在（当前仅在打印场景下载），首次使用需下载 ~15MB DLL

#### 方案 C：改进错误提示 + 诊断信息（最小改动）

1. 在 `render_pdf_pages` 失败时，返回更详细的错误信息（区分"组件缺失"和"文件损坏"）
2. 应用启动时检测 WinRT PDF 组件是否可用，不可用时提前提示
3. 在设置页面添加"PDF 渲染引擎"选项，允许用户手动切换

**优点**：改动最小，用户体验改善
**缺点**：不解决根本问题

#### 方案 D：组合方案（A + C 或 B + C）

1. 先实现方案 C（改进错误提示）
2. 再实现方案 B（PDFium fallback，已有基础设施）
3. 渲染优先级：WinRT → PDFium → lopdf

---

### 四、实施步骤（以方案 D 为例）

1. **改进错误提示**：`render_pdf_pages` 返回结构化错误，前端区分展示
2. **添加启动检测**：检查 WinRT PDF 组件可用性，记录到全局状态
3. **实现 PDFium 渲染 fallback**：复用 `pdfium_print.rs` 的 DLL 加载逻辑
4. **前端 fallback 链**：`render_pdf_pages` 失败 → 调用 `render_pdf_pages_pdfium`
5. **更新 AGENTS.md 版本号**：1.9.9 → 1.9.10

---

### 五、待确认事项

1. 用户报错的完整错误消息是什么？（"加载文件失败" vs "PDF 渲染失败" vs "文件加载失败"）
2. 出问题的电脑是什么 Windows 版本？（LTSC？企业精简版？）
3. 是否需要实现 fallback，还是仅改进错误提示即可？
4. 是否需要更新 AGENTS.md 版本号？
