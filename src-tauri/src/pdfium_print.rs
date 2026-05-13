#![allow(non_camel_case_types)]

use std::ffi::c_void;
use std::ptr;
use std::sync::atomic::Ordering;
use std::sync::LazyLock;

use windows::core::PCWSTR;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::Storage::Xps::*;

type FPDF_DOCUMENT = *mut c_void;
type FPDF_PAGE = *mut c_void;

type FnInitLibrary = unsafe fn();
type FnDestroyLibrary = unsafe fn();
type FnLoadMemDocument = unsafe fn(*const c_void, i32, *const u8) -> FPDF_DOCUMENT;
type FnGetPageCount = unsafe fn(FPDF_DOCUMENT) -> i32;
type FnGetPageWidthF = unsafe fn(FPDF_PAGE) -> f32;
type FnGetPageHeightF = unsafe fn(FPDF_PAGE) -> f32;
type FnLoadPage = unsafe fn(FPDF_DOCUMENT, i32) -> FPDF_PAGE;
type FnRenderPage = unsafe fn(*mut c_void, FPDF_PAGE, i32, i32, i32, i32, i32, i32);
type FnClosePage = unsafe fn(FPDF_PAGE);
type FnCloseDocument = unsafe fn(FPDF_DOCUMENT);
type FnGetLastError = unsafe fn() -> i32;

const FPDF_ANNOT: i32 = 0x01;
const FPDF_PRINTING: i32 = 0x800;

const FPDF_ERR_SUCCESS: i32 = 0;
const FPDF_ERR_UNKNOWN: i32 = 1;
const FPDF_ERR_FILE: i32 = 2;
const FPDF_ERR_FORMAT: i32 = 3;
const FPDF_ERR_PASSWORD: i32 = 4;
const FPDF_ERR_SECURITY: i32 = 5;
const FPDF_ERR_PAGE: i32 = 6;

struct PdfiumFuncs {
    init_library: FnInitLibrary,
    _destroy_library: FnDestroyLibrary,
    load_mem_document: FnLoadMemDocument,
    get_page_count: FnGetPageCount,
    _get_page_width_f: FnGetPageWidthF,
    _get_page_height_f: FnGetPageHeightF,
    load_page: FnLoadPage,
    render_page: FnRenderPage,
    close_page: FnClosePage,
    close_document: FnCloseDocument,
    get_last_error: FnGetLastError,
}

struct PdfiumState {
    _lib: libloading::Library,
    funcs: PdfiumFuncs,
}

static PDFIUM: LazyLock<std::sync::Mutex<Option<PdfiumState>>> =
    LazyLock::new(|| std::sync::Mutex::new(None));

fn with_pdfium<F, R>(f: F) -> Result<R, String>
where
    F: FnOnce(&PdfiumFuncs) -> Result<R, String>,
{
    let mut guard = PDFIUM.lock().unwrap();
    if guard.is_none() {
        let lib = load_pdfium_dll()?;
        let funcs = get_pdfium_funcs(&lib)?;
        unsafe { (funcs.init_library)() };
        log::info!("PDFium library initialized");
        *guard = Some(PdfiumState { _lib: lib, funcs });
    }
    let state = guard.as_ref().unwrap();
    f(&state.funcs)
}

fn load_pdfium_dll() -> Result<libloading::Library, String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let dll_path = parent.join("tools").join("pdfium.dll");
            if dll_path.exists() {
                log::info!("Loading pdfium.dll from: {}", dll_path.display());
                return unsafe {
                    libloading::Library::new(&dll_path)
                        .map_err(|e| format!("加载 pdfium.dll 失败: {}", e))
                };
            }
        }
    }
    unsafe {
        libloading::Library::new("pdfium.dll")
            .map_err(|e| format!("未找到 pdfium.dll，请将 pdfium.dll 放到 tools 目录下: {}", e))
    }
}

fn get_pdfium_funcs(lib: &libloading::Library) -> Result<PdfiumFuncs, String> {
    macro_rules! get_fn {
        ($name:expr, $ty:ty) => {
            unsafe {
                lib.get::<$ty>($name)
                    .map(|f| *f)
                    .map_err(|e| format!("无法获取函数 {}: {}", String::from_utf8_lossy($name), e))
            }
        };
    }
    Ok(PdfiumFuncs {
        init_library: get_fn!(b"FPDF_InitLibrary\0", FnInitLibrary)?,
        _destroy_library: get_fn!(b"FPDF_DestroyLibrary\0", FnDestroyLibrary)?,
        load_mem_document: get_fn!(b"FPDF_LoadMemDocument\0", FnLoadMemDocument)?,
        get_page_count: get_fn!(b"FPDF_GetPageCount\0", FnGetPageCount)?,
        _get_page_width_f: get_fn!(b"FPDF_GetPageWidthF\0", FnGetPageWidthF)?,
        _get_page_height_f: get_fn!(b"FPDF_GetPageHeightF\0", FnGetPageHeightF)?,
        load_page: get_fn!(b"FPDF_LoadPage\0", FnLoadPage)?,
        render_page: get_fn!(b"FPDF_RenderPage\0", FnRenderPage)
            .map_err(|e| format!("FPDF_RenderPage 不可用 (需要 Windows 版 PDFium): {}", e))?,
        close_page: get_fn!(b"FPDF_ClosePage\0", FnClosePage)?,
        close_document: get_fn!(b"FPDF_CloseDocument\0", FnCloseDocument)?,
        get_last_error: get_fn!(b"FPDF_GetLastError\0", FnGetLastError)?,
    })
}

fn pdfium_err_desc(code: i32) -> &'static str {
    match code {
        FPDF_ERR_SUCCESS => "成功",
        FPDF_ERR_UNKNOWN => "未知错误",
        FPDF_ERR_FILE => "文件不存在或无法读取",
        FPDF_ERR_FORMAT => "PDF格式错误",
        FPDF_ERR_PASSWORD => "需要密码",
        FPDF_ERR_SECURITY => "安全限制",
        FPDF_ERR_PAGE => "页面错误",
        _ => "未知错误码",
    }
}

pub fn find_pdfium_dll() -> Option<std::path::PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let dll_path = parent.join("tools").join("pdfium.dll");
            if dll_path.exists() {
                return Some(dll_path);
            }
        }
    }
    None
}

pub fn pdfium_vector_print(
    pdf_bytes: &[u8],
    printer_name: &str,
    copies: u32,
    duplex: bool,
    color_mode: &str,
    paper_w_mm: f32,
    paper_h_mm: f32,
    progress_cb: Option<&dyn Fn(u32, u32)>,
) -> Result<crate::pdf_engine::PdfResult, String> {
    if crate::pdf_engine::SHUTTING_DOWN.load(Ordering::SeqCst) {
        return Err("应用正在关闭".to_string());
    }

    let pdf_len = pdf_bytes.len();
    if pdf_len > i32::MAX as usize {
        return Err(format!("PDF 文件过大 ({} bytes)，PDFium 不支持超过 2GB", pdf_len));
    }

    let (doc, page_count) = with_pdfium(|funcs| {
        let doc = unsafe {
            (funcs.load_mem_document)(
                pdf_bytes.as_ptr() as *const c_void,
                pdf_len as i32,
                ptr::null(),
            )
        };
        if doc.is_null() {
            let err = unsafe { (funcs.get_last_error)() };
            return Err(format!("PDFium 无法加载 PDF 文档 (错误: {})", pdfium_err_desc(err)));
        }
        let pc = unsafe { (funcs.get_page_count)(doc) };
        if pc <= 0 {
            let err = unsafe { (funcs.get_last_error)() };
            unsafe { (funcs.close_document)(doc) };
            return Err(format!("PDF 文档没有页面 (错误: {})", pdfium_err_desc(err)));
        }
        log::info!("PDFium loaded PDF: {} pages, {} bytes", pc, pdf_len);
        Ok((doc, pc))
    })?;

    let printer_name_w: Vec<u16> = printer_name.encode_utf16().chain(std::iter::once(0)).collect();
    let dev_mode = build_dev_mode(copies, duplex, color_mode, paper_w_mm, paper_h_mm)?;

    let hdc = unsafe {
        CreateDCW(
            None,
            PCWSTR(printer_name_w.as_ptr()),
            None,
            Some(&dev_mode as *const DEVMODEW),
        )
    };

    if hdc.is_invalid() {
        with_pdfium(|funcs| { unsafe { (funcs.close_document)(doc); } Ok(()) })?;
        return Err(format!("无法打开打印机 DC: {}", printer_name));
    }

    let print_dc = hdc;

    unsafe { SetGraphicsMode(print_dc, GM_ADVANCED); }

    let printer_w = unsafe { GetDeviceCaps(print_dc, HORZRES) };
    let printer_h = unsafe { GetDeviceCaps(print_dc, VERTRES) };
    let printer_dpi = unsafe { GetDeviceCaps(print_dc, LOGPIXELSX) };
    log::info!("Printer DC: {}x{} px, {} DPI", printer_w, printer_h, printer_dpi);

    let doc_name_w: Vec<u16> = "发票打印".encode_utf16().chain(std::iter::once(0)).collect();
    let doc_info = DOCINFOW {
        cbSize: std::mem::size_of::<DOCINFOW>() as i32,
        lpszDocName: PCWSTR(doc_name_w.as_ptr()),
        lpszOutput: PCWSTR::null(),
        lpszDatatype: PCWSTR::null(),
        fwType: 0,
    };

    let job_id = unsafe { StartDocW(print_dc, &doc_info) };
    if job_id <= 0 {
        unsafe { let _ = DeleteDC(print_dc); }
        with_pdfium(|funcs| { unsafe { (funcs.close_document)(doc); } Ok(()) })?;
        return Err("StartDoc 失败".to_string());
    }

    let mut pages_printed = 0u32;
    let mut last_error = String::new();
    let mut aborted = false;

    for page_idx in 0..page_count {
        if crate::pdf_engine::SHUTTING_DOWN.load(Ordering::SeqCst) {
            aborted = true;
            last_error = "打印被中止".to_string();
            break;
        }

        if let Some(ref cb) = progress_cb {
            cb(page_idx as u32, page_count as u32);
        }

        let start_page_result = unsafe { StartPage(print_dc) };
        if start_page_result <= 0 {
            last_error = format!("StartPage 失败 (page {})", page_idx + 1);
            continue;
        }

        let render_result = with_pdfium(|funcs| {
            let page = unsafe { (funcs.load_page)(doc, page_idx) };
            if page.is_null() {
                let err = unsafe { (funcs.get_last_error)() };
                return Err(format!("无法加载第 {} 页 (错误: {})", page_idx + 1, pdfium_err_desc(err)));
            }

            unsafe {
                (funcs.render_page)(
                    print_dc.0 as *mut c_void,
                    page,
                    0, 0, printer_w, printer_h,
                    0,
                    FPDF_ANNOT | FPDF_PRINTING,
                );
            }

            unsafe { (funcs.close_page)(page); }
            Ok(())
        });

        match render_result {
            Ok(()) => pages_printed += 1,
            Err(e) => last_error = e,
        }

        unsafe { let _ = EndPage(print_dc); }
    }

    if aborted {
        unsafe { let _ = AbortDoc(print_dc); }
    } else {
        unsafe { let _ = EndDoc(print_dc); }
    }
    unsafe { let _ = DeleteDC(print_dc); }

    with_pdfium(|funcs| { unsafe { (funcs.close_document)(doc); } Ok(()) })?;

    if let Some(ref cb) = progress_cb {
        cb(page_count as u32, page_count as u32);
    }

    if pages_printed == 0 && !last_error.is_empty() {
        return Err(format!("打印失败: {}", last_error));
    }

    let mut msg = format!(
        "PDFium打印完成: {} 页 → {}",
        pages_printed, printer_name
    );
    if !last_error.is_empty() {
        msg.push_str(&format!(" (部分警告: {})", last_error));
    }

    Ok(crate::pdf_engine::PdfResult {
        success: true,
        message: msg,
        pdf_path: None,
        warnings: if last_error.is_empty() { None } else { Some(last_error) },
    })
}

fn build_dev_mode(
    copies: u32,
    duplex: bool,
    color_mode: &str,
    paper_w_mm: f32,
    paper_h_mm: f32,
) -> Result<DEVMODEW, String> {
    let mut dm = DEVMODEW::default();
    dm.dmSize = std::mem::size_of::<DEVMODEW>() as u16;

    if copies > 1 {
        dm.Anonymous1.Anonymous1.dmCopies = copies as i16;
        dm.dmFields |= DM_COPIES;
    }

    if duplex {
        dm.dmDuplex = DEVMODE_DUPLEX(DMDUP_VERTICAL.0);
        dm.dmFields |= DM_DUPLEX;
    }

    match color_mode {
        "grayscale" | "monochrome" | "bw" => {
            dm.dmColor = DEVMODE_COLOR(DMCOLOR_MONOCHROME.0);
            dm.dmFields |= DM_COLOR;
        }
        _ => {
            dm.dmColor = DEVMODE_COLOR(DMCOLOR_COLOR.0);
            dm.dmFields |= DM_COLOR;
        }
    }

    if let Some(paper) = infer_paper_size(paper_w_mm, paper_h_mm) {
        dm.Anonymous1.Anonymous1.dmPaperSize = paper as i16;
        dm.dmFields |= DM_PAPERSIZE;
    } else {
        dm.Anonymous1.Anonymous1.dmPaperSize = DMPAPER_USER as i16;
        dm.Anonymous1.Anonymous1.dmPaperWidth = (paper_w_mm * 10.0) as i16;
        dm.Anonymous1.Anonymous1.dmPaperLength = (paper_h_mm * 10.0) as i16;
        dm.dmFields |= DM_PAPERSIZE | DM_PAPERWIDTH | DM_PAPERLENGTH;
    }

    Ok(dm)
}

fn infer_paper_size(w: f32, h: f32) -> Option<u32> {
    let sizes: [(f32, f32, u32); 6] = [
        (210.0, 297.0, DMPAPER_A4),
        (148.0, 210.0, DMPAPER_A5),
        (105.0, 148.0, DMPAPER_A6),
        (297.0, 420.0, DMPAPER_A3),
        (216.0, 279.0, DMPAPER_LETTER),
        (216.0, 356.0, DMPAPER_LEGAL),
    ];
    for (sw, sh, paper) in &sizes {
        if (w - sw).abs() < 2.0 && (h - sh).abs() < 2.0 {
            return Some(*paper);
        }
        if (w - sh).abs() < 2.0 && (h - sw).abs() < 2.0 {
            return Some(*paper);
        }
    }
    None
}
