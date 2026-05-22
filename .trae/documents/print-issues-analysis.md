# 打印问题全面分析报告

## 问题概述

用户打印机型号：**HPlaserJet TankMFP2606sdw**（网络打印机 NPl2E40CE）
三个打印模式的问题：
1. **PDF阅读器模式** — 报错"错误码:31"
2. **PDFium/弹窗确认模式** — 打印机有声音但不进纸
3. **SumatraPDF模式** — 正常打印 ✅

---

## 问题一：PDF阅读器模式 — 错误码 31

### 代码路径分析

`doPdfReaderPrint()` → `invoke('print_pdf_file', { directPrint: true })` → Rust `print_pdf_file()` → `shell_execute_print()`

关键代码在 [lib.rs:931-982](file:///d:/test/fapiao/src-tauri/src/lib.rs#L931-L982)：

```rust
fn shell_execute_print(pdf_path, printer_name) {
    // Strategy 1: ShellExecuteW "printto" — 指定打印机静默打印
    let ret = ShellExecuteW(None, &verb, &file, params, PCWSTR::null(), SW_HIDE);
    if ret.0 as isize > 32 { return Ok(()); }

    // Strategy 2: ShellExecuteW "print" — 使用默认打印机
    let ret = ShellExecuteW(None, &verb, &file, PCWSTR::null(), PCWSTR::null(), SW_SHOW);
    if ret.0 as isize > 32 { return Ok(()); }

    return Err(format!("打印失败，错误码: {}。...", ret.0 as isize));
}
```

### 错误码 31 的含义

Windows `ShellExecuteW` 返回值 ≤ 32 表示失败。**错误码 31 = SE_ERR_NOASSOC**，含义是：

> **"没有与此文件关联的应用程序"**

即系统找不到能处理 `printto` / `print` 动词的 PDF 文件关联程序。

### 根因确认：问题真实存在 ✅

用户默认 PDF 阅读器是 **PDF-XChange Editor**。这个软件的问题在于：

1. **PDF-XChange Editor 不注册 `printto` 动词**：很多第三方 PDF 阅读器（包括 PDF-XChange Editor）在注册表中只注册了 `open` 动词，没有注册 `print` 和 `printto` 动词。只有 Adobe Reader/Acrobat 会完整注册这些动词。
2. **Strategy 1 (`printto`) 失败** → 回退 Strategy 2 (`print`) 也失败 → 返回错误码 31
3. 这不是打印机的问题，而是 **PDF 阅读器的 Shell 动词注册问题**

### 修复方向

- **方案 A**：在 `shell_execute_print` 中增加 Strategy 3 — 先 `ShellExecuteW("open")` 打开 PDF，让用户手动打印（即"打开PDF"模式）
- **方案 B**：检测默认 PDF 阅读器是否支持 `printto` 动词，不支持时自动切换到其他打印模式
- **方案 C**：在 `doPdfReaderPrint` 前端逻辑中，`print_pdf_file` 失败后自动 fallback 到 PDFium 或 SumatraPDF

---

## 问题二：PDFium/弹窗确认模式 — 打印机有声音但不进纸

### 代码路径分析

`doPdfiumPrint()` → `invoke('pdfium_vector_print')` → Rust `pdfium_vector_print()` → `pdfium_print::pdfium_vector_print()`

关键代码在 [pdfium_print.rs:321-485](file:///d:/test/fapiao/src-tauri/src/pdfium_print.rs#L321-L485)：

```rust
pub fn pdfium_vector_print(pdf_bytes, printer_name, copies, duplex, color_mode,
                           paper_w_mm, paper_h_mm, progress_cb) {
    // 1. 加载 PDF 文档
    let (doc, page_count) = with_pdfium(|funcs| { ... })?;

    // 2. 构建 DEVMODE
    let dev_mode = build_dev_mode(copies, duplex, color_mode, paper_w_mm, paper_h_mm)?;

    // 3. 创建打印机 DC
    let hdc = CreateDCW(None, PCWSTR(printer_name_w.as_ptr()), None, Some(&dev_mode))?;

    // 4. 获取打印机信息
    let printer_w = GetDeviceCaps(print_dc, HORZRES);
    let printer_h = GetDeviceCaps(print_dc, VERTRES);
    let printer_dpi = GetDeviceCaps(print_dc, LOGPIXELSX);

    // 5. 开始打印文档
    let job_id = StartDocW(print_dc, &doc_info);

    // 6. 逐页渲染
    for page_idx in 0..page_count {
        StartPage(print_dc);
        (funcs.render_page)(print_dc.0 as *mut c_void, page,
                           0, 0, printer_w, printer_h, 0, FPDF_ANNOT | FPDF_PRINTING);
        EndPage(print_dc);
    }

    // 7. 结束打印
    EndDoc(print_dc);
}
```

### 根因分析：问题真实存在 ✅

**核心问题：`build_dev_mode()` 构建的 DEVMODE 缺少打印机名称，导致打印机驱动无法正确匹配纸盒/纸张**

详细分析：

1. **DEVMODE 未设置打印机设备名**：`build_dev_mode()` 创建了一个全新的 `DEVMODEW::default()`，只设置了纸张大小、方向、份数等字段，**但没有设置 `dmDeviceName`**（打印机设备名）。对于 HP LaserJet 这类网络打印机，驱动需要通过设备名来匹配正确的打印配置（纸盒选择、纸张来源等）。

2. **缺少 `dmDefaultSource`（纸张来源）设置**：HP 打印机通常有多个纸盒（主纸盒/手动进纸），当 DEVMODE 没有指定纸张来源时，打印机可能默认选择"自动选择"，但某些驱动在收到不完整的 DEVMODE 时会尝试从错误的纸盒进纸，导致"有声音但不进纸"。

3. **`CreateDCW` 与 DEVMODE 的交互问题**：当传入自定义 DEVMODE 时，Windows 会将此 DEVMODE 与打印机驱动合并。如果 DEVMODE 中的设置与打印机实际配置冲突（例如纸张大小与纸盒不匹配），打印机驱动可能接受打印任务但不实际进纸。

4. **`FPDF_RenderPage` 渲染到打印机 DC 的坐标问题**：代码使用 `(0, 0, printer_w, printer_h)` 作为渲染区域，这是 `GetDeviceCaps(HORZRES/VERTRES)` 获取的可打印区域。但如果 DEVMODE 中的纸张设置与实际纸盒纸张不匹配，`HORZRES/VERTRES` 可能返回 0 或不正确的值，导致渲染内容为空（打印机收到空页）。

5. **对比 SumatraPDF 为什么能正常打印**：SumatraPDF 使用自己的打印管线，它会：
   - 调用 `EnumPrinters` 获取打印机默认 DEVMODE
   - 正确设置纸张来源和纸盒
   - 使用 GDI 打印 API 完整处理纸张匹配
   - 关键是 SumatraPDF 会**读取打印机驱动的默认配置**并在此基础上修改，而不是从零构建 DEVMODE

### 最可能的根因：DEVMODE 缺少打印机默认配置

`build_dev_mode()` 从 `DEVMODEW::default()` 开始构建，这是一个全零的结构体。正确做法应该是：

1. **先获取打印机的默认 DEVMODE**（通过 `DocumentPropertiesW` API 获取）
2. **在默认 DEVMODE 基础上修改**需要自定义的字段（纸张、份数、双面等）
3. 这样打印机驱动已有的纸盒配置、纸张来源等设置会被保留

### 修复方向

- **方案 A（推荐）**：在 `pdfium_vector_print` 中，先通过 `DocumentPropertiesW(NULL, hPrinter, printer_name, NULL, NULL, 0)` 获取打印机默认 DEVMODE，然后在默认 DEVMODE 基础上修改自定义字段
- **方案 B**：在 `build_dev_mode` 中增加 `dmDefaultSource` 设置（如 `DMBIN_AUTO` 或 `DMBIN_CASSETTE`）
- **方案 C**：增加 `GetDeviceCaps` 返回值的验证，如果 `printer_w` 或 `printer_h` 为 0，提前报错

---

## 问题三：SumatraPDF 模式 — 正常 ✅

SumatraPDF 使用完整的 GDI 打印管线，正确处理了 DEVMODE 和纸张匹配，所以能正常打印。这进一步印证了问题二的根因是 DEVMODE 构建不完整。

---

## 修复计划

### 修复 1：PDF 阅读器模式 — ShellExecute 错误码 31

**文件**：`src-tauri/src/lib.rs` — `shell_execute_print()` 函数

**改动**：在 Strategy 1 (`printto`) 和 Strategy 2 (`print`) 都失败后，增加 Strategy 3：使用 `ShellExecuteW("open")` 打开 PDF 文件，让用户在阅读器中手动打印。返回不同的消息提示用户手动操作。

```rust
// Strategy 3: Fallback — open the PDF and let user print manually
let verb: HSTRING = "open".into();
let ret = ShellExecuteW(None, &verb, &file, PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL);
if ret.0 as isize > 32 {
    return Ok(()); // 成功打开，但不是自动打印
}
```

同时修改返回值，让前端知道是"打开PDF"而不是"自动打印"，以便显示不同的提示信息。

### 修复 2：PDFium 打印 — DEVMODE 缺少打印机默认配置

**文件**：`src-tauri/src/pdfium_print.rs` — `pdfium_vector_print()` 和 `build_dev_mode()` 函数

**改动**：

1. 新增 `get_printer_default_devmode()` 函数，通过 `DocumentPropertiesW` API 获取打印机默认 DEVMODE
2. 修改 `pdfium_vector_print()` 流程：
   - 先获取打印机默认 DEVMODE
   - 在默认 DEVMODE 基础上调用 `build_dev_mode()` 修改自定义字段
   - 使用修改后的 DEVMODE 创建打印机 DC
3. 修改 `build_dev_mode()` 接受一个可选的 `base_devmode` 参数，在基础 DEVMODE 上修改而非从零构建

关键 API 调用：
```rust
// 获取打印机默认 DEVMODE
let dm_size = DocumentPropertiesW(None, hPrinter, printer_name, NULL, NULL, 0);
let mut dev_mode: DEVMODEW = allocate_buffer(dm_size);
DocumentPropertiesW(None, hPrinter, printer_name, &mut dev_mode, NULL, DM_OUT_BUFFER);
```

### 修复 3：增加 GetDeviceCaps 验证

在 `pdfium_vector_print` 中，创建 DC 后验证 `printer_w` 和 `printer_h` 是否有效：

```rust
if printer_w <= 0 || printer_h <= 0 || printer_dpi <= 0 {
    DeleteDC(print_dc);
    return Err("打印机DC返回无效尺寸，请检查打印机设置".to_string());
}
```

---

## 风险评估

| 修复项 | 风险 | 说明 |
|--------|------|------|
| 修复1：ShellExecute fallback | 低 | 仅增加 fallback 路径，不影响现有逻辑 |
| 修复2：DEVMODE 默认配置 | 中 | 需要正确处理 `DocumentPropertiesW` API，内存管理需谨慎 |
| 修复3：DC 验证 | 低 | 纯防御性检查，不影响正常流程 |

---

## 实施步骤

1. 在 `pdfium_print.rs` 中新增 `get_printer_default_devmode()` 函数
2. 修改 `build_dev_mode()` 接受基础 DEVMODE 参数
3. 修改 `pdfium_vector_print()` 使用打印机默认 DEVMODE
4. 增加 `GetDeviceCaps` 返回值验证
5. 在 `lib.rs` 中修改 `shell_execute_print()` 增加 Strategy 3 fallback
6. 测试验证
