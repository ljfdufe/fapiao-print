// =====================================================
// OCR & Invoice Info Extraction
// =====================================================
// Dependencies (global): invoke, isTauri, dataUrlToUint8Array

/**
 * Parse amount string to number (2 decimal places)
 */
function parseAmt(s) {
  if (!s) return 0;
  var n = parseFloat(s.replace(/,/g, ''));
  return (!isNaN(n) && n > 0) ? Math.round(n * 100) / 100 : 0;
}

/**
 * Parse Chinese financial numeral (大写金额) to number.
 * Examples:
 *   "捌仟捌佰壹拾玖圆陆角整" → 8819.60
 *   "壹万贰仟叁佰肆拾伍圆陆角柒分" → 12345.67
 *   "壹佰元整" → 100.00
 *   "零元整" → 0
 * Returns 0 if parsing fails.
 */
function parseChineseNumeral(str) {
  if (!str) return 0;
  var s = str.replace(/\s/g, '');
  // Remove trailing 整/正
  s = s.replace(/[整正]$/, '');
  if (!s) return 0;

  // Digit map
  var digitMap = { '零': 0, '壹': 1, '贰': 2, '叁': 3, '肆': 4, '伍': 5, '陆': 6, '柒': 7, '捌': 8, '玖': 9 };
  // Also support simplified variants commonly found in OCR
  var digitMapSimple = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9 };

  function toDigit(ch) {
    if (digitMap[ch] !== undefined) return digitMap[ch];
    if (digitMapSimple[ch] !== undefined) return digitMapSimple[ch];
    return -1;
  }

  // Split into integer part (before 圆/元) and decimal part (角/分)
  var integerPart = '';
  var decimalPart = '';
  var yuanIdx = s.search(/[圆元]/);
  if (yuanIdx >= 0) {
    integerPart = s.substring(0, yuanIdx);
    decimalPart = s.substring(yuanIdx + 1);
  } else if (s.search(/[角分]/) >= 0) {
    // No 圆/元 but has 角/分 — entire string is decimal (e.g., "玖角捌分" = 0.98)
    integerPart = '';
    decimalPart = s;
  } else {
    integerPart = s;
  }

  var result = 0;

  // --- Parse integer part ---
  // Two-level accumulator: total (亿-level) + sectionValue (万-level within 亿)
  // When 亿 is hit: flush sectionValue+currentValue into total, multiply by 1e8
  // When 万 is hit: flush currentValue into sectionValue, multiply by 1e4
  // 拾佰仟: add currentValue × multiplier to sectionValue
  if (integerPart) {
    var total = 0;           // 亿-level accumulator
    var sectionValue = 0;    // 万-level accumulator (within current 亿 section)
    var currentValue = 0;    // current digit
    var hasDigit = false;

    for (var i = 0; i < integerPart.length; i++) {
      var ch = integerPart[i];
      var d = toDigit(ch);

      if (d >= 0) {
        currentValue = d;
        hasDigit = true;
      } else if (ch === '拾' || ch === '十') {
        if (!hasDigit) currentValue = 1;
        sectionValue += currentValue * 10;
        currentValue = 0;
        hasDigit = false;
      } else if (ch === '佰' || ch === '百') {
        if (!hasDigit) currentValue = 1;
        sectionValue += currentValue * 100;
        currentValue = 0;
        hasDigit = false;
      } else if (ch === '仟' || ch === '千') {
        if (!hasDigit) currentValue = 1;
        sectionValue += currentValue * 1000;
        currentValue = 0;
        hasDigit = false;
      } else if (ch === '万' || ch === '萬') {
        if (!hasDigit && sectionValue === 0) currentValue = 1; // implicit 一万
        sectionValue = (sectionValue + currentValue) * 10000;
        currentValue = 0;
        hasDigit = false;
      } else if (ch === '亿' || ch === '億') {
        if (!hasDigit && sectionValue === 0 && currentValue === 0) currentValue = 1;
        // Flush current section into total at 亿 level
        total += (sectionValue + currentValue) * 100000000;
        sectionValue = 0;
        currentValue = 0;
        hasDigit = false;
      }
    }
    result = total + sectionValue + currentValue;
  }

  // --- Parse decimal part (角/分) ---
  if (decimalPart) {
    var jiaoIdx = decimalPart.search(/[角]/);
    var fenIdx = decimalPart.search(/[分]/);

    if (jiaoIdx >= 0) {
      // Find the digit before 角
      var jiaoDigit = 0;
      for (var j = jiaoIdx - 1; j >= 0; j--) {
        var jd = toDigit(decimalPart[j]);
        if (jd >= 0) { jiaoDigit = jd; break; }
      }
      result += jiaoDigit * 0.1;
    }

    if (fenIdx >= 0) {
      // Find the digit before 分
      var fenDigit = 0;
      for (var f = fenIdx - 1; f >= 0; f--) {
        var fd = toDigit(decimalPart[f]);
        if (fd >= 0) { fenDigit = fd; break; }
      }
      result += fenDigit * 0.01;
    }
  }

  return Math.round(result * 100) / 100;
}

/**
 * Detect if text is a train/ride ticket (no seller info needed)
 */
function isTicketText(text) {
  var t = text.substring(0, 500);
  return /(?:车\s*次|票\s*价|座\s*位|席\s*别|检\s*票|站\s*台|进\s*站|出\s*站|铁\s*路|乘\s*车|二\s*等|一\s*等|动\s*车|高\s*铁|硬\s*座|软\s*座|卧\s*铺|铺\s*位|出\s*租|打\s*车|网\s*约|滴\s*滴)/.test(t);
}

/**
 * Get a descriptive label for ticket type (shown as sellerName for tickets)
 */
function getTicketTypeLabel(text) {
  var t = text.substring(0, 500);
  if (/(?:铁\s*路|动\s*车|高\s*铁|火\s*车|车\s*次|座\s*位|席\s*别|检\s*票|进\s*站|出\s*站|硬\s*座|软\s*座|卧\s*铺|铺\s*位)/.test(t)) return '铁路电子客票';
  if (/(?:出\s*租|打\s*车|的\s*士)/.test(t)) return '出租车票';
  if (/(?:网\s*约|滴\s*滴|专\s*车|快\s*车)/.test(t)) return '网约车票';
  return '车票';
}

/**
 * Normalize OCR currency symbol artifacts.
 * OCR commonly misreads digits and ¥ symbols because they look similar:
 *   - "1" as "¥" → "¥¥72.68" should be "¥172.68" (second ¥ is misread "1")
 *   - "¥" as "1" → "1317.00" should be "¥317.00" (handled by keyword-based rule)
 *   - Mixed full-width ￥ and half-width ¥
 */
function normalizeOcrCurrency(s) {
  if (!s) return s;
  // Double ¥ before a digit: the second ¥ is a misread "1" digit
  // "¥¥72.68" → "¥172.68", "￥¥07.00" → "¥107.00"
  s = s.replace(/[¥￥]¥(\d)/g, '¥1$1');
  // Apply again in case of triple ¥ (very rare): "¥¥¥07" → "¥1¥07" → "¥117.07"
  s = s.replace(/¥¥(\d)/g, '¥1$1');
  // "1¥" pattern before a digit: ¥ was misread as "1" and "1" as "¥" (swap)
  // "1¥72.68" → "¥172.68". Only apply when preceded by non-digit (avoid breaking real numbers)
  s = s.replace(/(\D)1¥(\d)/g, '$1¥1$2');
  // Also handle "1¥" at the start of the string
  s = s.replace(/^1¥(\d)/, '¥1$1');
  // Normalize remaining full-width ￥ to half-width ¥ for consistency
  s = s.replace(/￥/g, '¥');
  return s;
}

// =====================================================
// Coordinate-aware region analysis
// =====================================================

/**
 * Classify a word's region based on its position on the invoice.
 * Invoice layout (typical):
 *   Top-left:   购买方 (buyer)
 *   Top-right:  销售方 (seller)
 *   Bottom:     金额/合计 (amounts)
 *   Far bottom: 备注 (remarks)
 *
 * Returns: 'buyer' | 'seller' | 'amount' | 'remark' | 'unknown'
 */
function classifyRegion(wx, wy, ww, wh, imgW, imgH) {
  if (!imgW || !imgH) return 'unknown';
  var nx = wx / imgW;   // normalized 0~1
  var ny = wy / imgH;

  // Vertical zones
  // Top 55%: buyer/seller area
  // 55%~75%: amount area
  // Below 75%: remarks
  if (ny < 0.55) {
    // Top section: split left/right
    return nx < 0.5 ? 'buyer' : 'seller';
  } else if (ny < 0.75) {
    return 'amount';
  } else {
    return 'remark';
  }
}

/**
 * Build a region-annotated word list from OCR coordinates.
 * Each entry: { text, x, y, w, h, region, lineIdx, wordIdx, confidence }
 */
function buildWordMap(ocrLines, imgW, imgH) {
  if (!ocrLines || !ocrLines.length) return [];
  var map = [];
  for (var li = 0; li < ocrLines.length; li++) {
    var line = ocrLines[li];
    if (!line.words || !line.words.length) continue;
    var lineConfidence = line.confidence || 0;
    for (var wi = 0; wi < line.words.length; wi++) {
      var word = line.words[wi];
      map.push({
        text: normalizeOcrCurrency(word.text),
        x: word.x,
        y: word.y,
        w: word.w,
        h: word.h,
        region: classifyRegion(word.x, word.y, word.w, word.h, imgW, imgH),
        lineIdx: li,
        wordIdx: wi,
        confidence: lineConfidence
      });
    }
  }
  return map;
}

/**
 * Get text for a specific region from the word map.
 * Joins words in reading order (top-to-bottom, left-to-right within same line).
 */
function getRegionText(wordMap, region) {
  var words = wordMap.filter(function(w) { return w.region === region; });
  if (!words.length) return '';
  // Group by line, then join
  var byLine = {};
  words.forEach(function(w) {
    if (!byLine[w.lineIdx]) byLine[w.lineIdx] = [];
    byLine[w.lineIdx].push(w);
  });
  var lines = Object.keys(byLine).map(function(k) {
    // Sort words within line by x position
    byLine[k].sort(function(a, b) { return a.x - b.x; });
    return byLine[k].map(function(w) { return w.text; }).join('');
  });
  // Sort lines by y position (first word's y)
  var sortedKeys = Object.keys(byLine).sort(function(a, b) {
    return byLine[a][0].y - byLine[b][0].y;
  });
  return sortedKeys.map(function(k) {
    byLine[k].sort(function(a, b) { return a.x - b.x; });
    return byLine[k].map(function(w) { return w.text; }).join('');
  }).join('\n');
}

/**
 * Clean an OCR amount string: strip ¥/￥ prefix, handle "1" misread of "¥".
 * OCR often misreads "¥317.00" as "1317.00" (¥→1). We detect this by checking
 * if a leading "1" could be a misread ¥ symbol: the number after removing "1"
 * must have exactly 2 decimal places and be a reasonable amount.
 * Returns the cleaned numeric string.
 */
function cleanOcrAmtStr(raw) {
  var hadYenPrefix = /^[¥￥-]/.test(raw);
  var s = raw.replace(/^[¥￥-]+/, '').replace(/[,，]/g, '');
  // ¥→1 misread detection:
  // Only strip leading "1" if the original did NOT have a ¥/negative prefix,
  // AND the number has 4+ digits before decimal (1 + 3+ digits).
  // When ¥ is present (e.g., "¥172.68"), the "1" is a legitimate digit,
  // not a misread ¥. Without ¥ prefix (e.g., "1317.00"), the "1" is likely
  // a misread "¥" symbol (they look very similar in OCR).
  // 4+ digit check prevents stripping "1" from 3-digit amounts like "172.68"
  // which are common and legitimate (stripping would give wrong "72.68").
  // e.g., "1317.00" (4 digits, no ¥) → "317.00" ✓
  // e.g., "¥172.68" (has ¥) → keep "172.68" ✓ (NOT "72.68")
  // e.g., "172.68" (3 digits, no ¥) → keep "172.68" ✓ (NOT "72.68")
  // e.g., "1299.06" (4 digits, no ¥) → "299.06" ✓
  if (!hadYenPrefix && /^1\d{3,}\.\d{2}$/.test(s)) {
    var stripped = s.substring(1);
    var strippedVal = parseFloat(stripped);
    if (strippedVal > 0) {
      s = stripped;
    }
  }
  return s;
}

/**
 * Check if a numeric value looks like a year or date.
 * OCR can produce "2025.01" or "2025.00" from dates like "2025年01月" or "2025/01/15".
 * These should NOT be treated as monetary amounts.
 * Returns true if the value looks like a year/date, false otherwise.
 */
function isLikelyYearOrDate(val, rawText) {
  // Integer part in year range (1900-2099) and value < 2100 → almost certainly a year
  if (val >= 1900 && val < 2100) return true;
  // Check raw text for year-like pattern: "20XX.XX" where XX could be month
  if (rawText && /^-?¥?(20\d{2})\.\d{2}$/.test(rawText)) return true;
  return false;
}

/**
 * Collect all amount-like numbers from wordMap, optionally filtered by
 * region and/or normalized position ranges (0~1).
 * Returns array of { value, x, y, text, word } sorted by value descending.
 * Excludes values that look like years/dates.
 */
function collectAmountWords(wordMap, imgW, imgH, regionFilter, nxMin, nxMax, nyMin, nyMax) {
  var results = [];
  wordMap.forEach(function(w) {
    if (regionFilter && w.region !== regionFilter && regionFilter !== 'any') return;
    // Skip low-confidence OCR results (< 0.3) — likely garbage
    if (w.confidence !== undefined && w.confidence < 0.3) return;
    if (imgW > 0 && imgH > 0) {
      var nx = (w.x + w.w / 2) / imgW;
      var ny = (w.y + w.h / 2) / imgH;
      if (nxMin !== undefined && nx < nxMin) return;
      if (nxMax !== undefined && nx > nxMax) return;
      if (nyMin !== undefined && ny < nyMin) return;
      if (nyMax !== undefined && ny > nyMax) return;
    }
    var t = w.text.replace(/[,，]/g, '');
    // Match ¥-prefixed or bare amounts with exactly 2 decimal places
    var m = t.match(/^-?¥?(\d+\.\d{2})$/);
    if (m) {
      var val = parseFloat(cleanOcrAmtStr(t));
      if (val > 0 && val < 1000000 && !isLikelyYearOrDate(val, t)) {
        results.push({ value: val, x: w.x, y: w.y, text: w.text, word: w });
      }
    }
  });
  results.sort(function(a, b) { return b.value - a.value; });
  return results;
}

/**
 * Find words matching a regex in a specific region, return the matching word
 * plus nearby words (within same line or adjacent lines).
 */
function findWordsNear(wordMap, regex, region, contextWords) {
  contextWords = contextWords || 5;
  var matches = [];
  wordMap.forEach(function(w) {
    if (w.region !== region && region !== 'any') return;
    if (regex.test(w.text)) matches.push(w);
  });
  return matches;
}

// [REMOVED] extractInvoiceInfo() — legacy regex-based extraction (~1100 lines).
// Disabled since v1.7.0 in favor of coordinate-first extractByCoordinates().
// If re-enabling is needed, restore from git history (commit before this change).


/**
 * Apply an already-parsed OCR result to a file object.
 * Extracts invoice info (amounts, seller) from OCR text/coordinates.
 * Used by both applyOcr() (image files) and render_and_ocr_pdf (PDF one-pass).
 * Modifies fileObj in place.
 * @param {Object} fileObj - The file object to update
 * @param {Object} ocrResult - Parsed OCR result from Rust (with lines, imgW, imgH, text)
 */
function applyOcrResult(fileObj, ocrResult) {
  if (!ocrResult) return;
  try {
    var info = null;
    if (ocrResult.lines && ocrResult.imgW > 0 && ocrResult.imgH > 0) {
      info = extractByCoordinates(ocrResult);
    }

    if (!info) { fileObj._ocrText = ocrResult.text || ''; return; }

    // Always set _ocrText for display — this is the main purpose of running OCR on all pages
    fileObj._ocrText = info._ocrText || ocrResult.text || '';
    fileObj._isTicket = info.isTicket || false;

    // If amounts already set by PDF text extraction, skip OCR amount validation
    // to avoid duplicate warning logs
    if (fileObj.amountTax > 0 || fileObj.amountNoTax > 0) {
      // Only fill in missing taxAmount from OCR
      if (!fileObj.taxAmount && info.taxAmount > 0) {
        fileObj.taxAmount = info.taxAmount;
      }
      if (info.sellerName && !fileObj.sellerName) fileObj.sellerName = info.sellerName;
      if (!info.isTicket && info.sellerCreditCode && !fileObj.sellerCreditCode) fileObj.sellerCreditCode = info.sellerCreditCode;
      if (info.invoiceNo && !fileObj.invoiceNo) fileObj.invoiceNo = info.invoiceNo;
      if (info.invoiceDate && !fileObj.invoiceDate) fileObj.invoiceDate = info.invoiceDate;
      if (info.buyerName && !fileObj.buyerName) fileObj.buyerName = info.buyerName;
      if (info.buyerCreditCode && !fileObj.buyerCreditCode) fileObj.buyerCreditCode = info.buyerCreditCode;
      return;
    }

    // --- 后置校验：金额求和验证（含税价 ≈ 不含税 + 税额）---
    if (info.amountTax > 0 && info.amountNoTax > 0) {
      var _sum = Math.round((info.amountNoTax + info.taxAmount) * 100) / 100;
      if (Math.abs(_sum - info.amountTax) > 0.02) {
        console.warn('[验证] 金额求和校验失败: 含税=' + info.amountTax +
          ', 不含税=' + info.amountNoTax + ', 税额=' + info.taxAmount +
          ', 验证=' + info.amountNoTax + '+' + info.taxAmount + '=' + _sum);
        var VALID_RATES = [0, 0.01, 0.03, 0.05, 0.06, 0.09, 0.13];
        if (info.taxAmount > 0 && info.taxAmount < info.amountTax) {
          var _recalc = Math.round((info.amountTax - info.taxAmount) * 100) / 100;
          if (_recalc > info.taxAmount) {
            var _rate = Math.round(info.taxAmount / _recalc * 10000) / 10000;
            if (VALID_RATES.some(function(r) { return Math.abs(_rate - r) < 0.005; })) {
              info.amountNoTax = _recalc;
              console.log('[验证] 已通过含税价-税额反算修正不含税价:', _recalc);
            }
          }
        }
        if (Math.abs(Math.round((info.amountNoTax + info.taxAmount) * 100) / 100 - info.amountTax) > 0.02) {
          info.amountTax = 0; info.amountNoTax = 0; info.taxAmount = 0;
        }
      }
    }

    var effAmt = info.amountTax > 0 ? info.amountTax : info.amountNoTax;
    if (effAmt > 0) {
      fileObj.amount = effAmt;
      fileObj.amountTax = info.amountTax;
      fileObj.amountNoTax = info.amountNoTax;
      fileObj.taxAmount = info.taxAmount || 0;
    } else if (info.taxAmount > 0) {
      fileObj.taxAmount = info.taxAmount;
    }
    if (info.sellerName && !fileObj.sellerName) fileObj.sellerName = info.sellerName;
    if (!info.isTicket) {
      if (info.sellerCreditCode && !fileObj.sellerCreditCode) fileObj.sellerCreditCode = info.sellerCreditCode;
    }
    if (info.invoiceNo && !fileObj.invoiceNo) fileObj.invoiceNo = info.invoiceNo;
    if (info.invoiceDate && !fileObj.invoiceDate) fileObj.invoiceDate = info.invoiceDate;
    if (info.buyerName && !fileObj.buyerName) fileObj.buyerName = info.buyerName;
    if (info.buyerCreditCode && !fileObj.buyerCreditCode) fileObj.buyerCreditCode = info.buyerCreditCode;
  } catch(e) {
    console.warn('[OCR] 结果应用失败:', e);
  }
}

/**
 * Apply PDF text layer extraction result to a file object.
 * Called BEFORE OCR — structured extraction (PDF text / OFD XML) takes priority.
 * The PdfTextResult has the same structure as OcrResult (text + lines + imgW/imgH),
 * so we reuse extractByCoordinates() for field extraction.
 *
 * Modifies fileObj in place. Only fills empty fields (never overwrites).
 * @param {Object} fileObj - The file object to update
 * @param {Object} pdfTextResult - Result from Rust extract_pdf_text command
 */
function applyPdfTextResult(fileObj, pdfTextResult) {
  if (!pdfTextResult || !pdfTextResult.lines || pdfTextResult.lines.length === 0) return;
  try {
    // PdfTextResult lines use {words: [{text,x,y,w,h}], confidence: 1.0}
    // This is compatible with OcrLine structure expected by extractByCoordinates

    // 调试：查看原始文本内容
    console.log('[PDF文字提取] 原始文本内容:', pdfTextResult.text);
    var allWords = [];
    var amountWords = [];
    pdfTextResult.lines.forEach(function(line, lineIdx) {
      if (line.words && line.words.length > 0) {
        line.words.forEach(function(word, wordIdx) {
          allWords.push(word.text);
          if (/\d+\.\d/.test(word.text) || /¥/.test(word.text)) {
            amountWords.push({ text: word.text, x: Math.round(word.x), y: Math.round(word.y), w: Math.round(word.w), h: Math.round(word.h) });
          }
        });
      }
    });
    console.log('[PDF文字提取] 词列表:', allWords);
    console.log('[PDF文字提取] 金额词:', amountWords);

    var info = extractByCoordinates(pdfTextResult);

    console.log('[PDF文字提取] 字段:', {
      invoiceNo: info.invoiceNo || '(空)',
      invoiceDate: info.invoiceDate || '(空)',
      buyerName: info.buyerName || '(空)',
      sellerName: info.sellerName || '(空)',
      amountTax: info.amountTax || 0
    });

    // --- 后置校验：金额求和验证（含税价 ≈ 不含税 + 税额）---
    if (info.amountTax > 0 && info.amountNoTax > 0) {
      var _sum = Math.round((info.amountNoTax + info.taxAmount) * 100) / 100;
      if (Math.abs(_sum - info.amountTax) > 0.02) {
        console.warn('[PDF文字提取] 金额求和校验失败: 含税=' + info.amountTax +
          ', 不含税=' + info.amountNoTax + ', 税额=' + info.taxAmount +
          ', 验证=' + info.amountNoTax + '+' + info.taxAmount + '=' + _sum);
        var VALID_RATES2 = [0, 0.01, 0.03, 0.05, 0.06, 0.09, 0.13];
        if (info.taxAmount > 0 && info.taxAmount < info.amountTax) {
          var _recalc2 = Math.round((info.amountTax - info.taxAmount) * 100) / 100;
          if (_recalc2 > info.taxAmount) {
            var _rate2 = Math.round(info.taxAmount / _recalc2 * 10000) / 10000;
            if (VALID_RATES2.some(function(r) { return Math.abs(_rate2 - r) < 0.005; })) {
              info.amountNoTax = _recalc2;
              console.log('[PDF文字提取] 已通过含税价-税额反算修正不含税价:', _recalc2);
            }
          }
        }
        if (Math.abs(Math.round((info.amountNoTax + info.taxAmount) * 100) / 100 - info.amountTax) > 0.02) {
          info.amountTax = 0; info.amountNoTax = 0; info.taxAmount = 0;
        }
      }
    }

    // Set _ocrText and _isTicket for display
    fileObj._ocrText = info._ocrText || pdfTextResult.text || '';
    fileObj._isTicket = info.isTicket || false;

    // Only fill empty fields — structured extraction priority
    if (info.invoiceNo && !fileObj.invoiceNo) fileObj.invoiceNo = info.invoiceNo;
    if (info.invoiceDate && !fileObj.invoiceDate) fileObj.invoiceDate = info.invoiceDate;
    if (info.buyerName && !fileObj.buyerName) fileObj.buyerName = info.buyerName;
    if (info.buyerCreditCode && !fileObj.buyerCreditCode) fileObj.buyerCreditCode = info.buyerCreditCode;
    if (info.sellerName && !fileObj.sellerName) fileObj.sellerName = info.sellerName;
    if (!info.isTicket) {
      if (info.sellerCreditCode && !fileObj.sellerCreditCode) fileObj.sellerCreditCode = info.sellerCreditCode;
    }

    // Amounts — same guard logic as applyOcrResult
    var effAmt = info.amountTax > 0 ? info.amountTax : info.amountNoTax;
    if (effAmt > 0 && !fileObj.amountTax && !fileObj.amountNoTax) {
      fileObj.amount = effAmt;
      fileObj.amountTax = info.amountTax;
      fileObj.amountNoTax = info.amountNoTax;
      fileObj.taxAmount = info.taxAmount || 0;
    } else if (effAmt > 0 && fileObj.amountTax > 0) {
      if (!fileObj.taxAmount && info.taxAmount > 0) {
        fileObj.taxAmount = info.taxAmount;
      }
    } else if (info.taxAmount > 0 && !fileObj.taxAmount) {
      fileObj.taxAmount = info.taxAmount;
    }

    fileObj._pdfTextExtracted = true;
  } catch(e) {
    console.warn('[PDF文字提取] 结果应用失败:', e);
  }
}

/**
 * Apply OCR to a file object — calls Rust OCR then applies result.
 * Used for image files (non-PDF). PDF files use render_and_ocr_pdf one-pass instead.
 * Modifies fileObj in place, adding amount/seller info if detected.
 * @param {Object} fileObj - The file object to update
 * @param {string} dataUrl - Base64 data URL of the image to OCR (fallback)
 * @param {string} [filePath] - Disk path to the image file (preferred — skips base64)
 */
async function applyOcr(fileObj, dataUrl, filePath) {
  if (!hasOcr || !isTauri || !invoke) return;
  try {
    var ocrResult = await invoke('ocr_image', {
      dataUrl: dataUrl || '',
      filePath: filePath || fileObj._filePath || null,
      ocrPrecision: S.ocrPrecision || 'standard'
    });
    if (!ocrResult) return;
    applyOcrResult(fileObj, ocrResult);
  } catch(e) {
    console.warn('[OCR] 识别失败:', e);
  }
}

/**
 * OCR a PDF page via ocr_pdf_page command — zero IPC round-trip.
 * Rust renders the page AND runs OCR internally, then returns just the OcrResult.
 * This avoids: Rust render → base64 → IPC → frontend downsample → base64 → IPC → Rust decode → OCR.
 * Instead: Rust render → decode in memory → OCR → return result directly.
 */
async function applyOcrPdfPage(fileObj) {
  if (!hasOcr || !isTauri || !invoke) return;
  try {
    var ocrResult = await invoke('ocr_pdf_page', {
      pdfPath: fileObj._pdfPath,
      pageIndex: fileObj._pdfPageIdx,
      ocrPrecision: S.ocrPrecision || 'standard'
    });
    if (!ocrResult) return;
    applyOcrResult(fileObj, ocrResult);
  } catch(e) {
    console.warn('[OCR] PDF页识别失败:', e);
  }
}


// =====================================================
// v1.7.0 — Coordinate-first invoice extraction
// =====================================================
// Designed for PP-OCRv5's high-accuracy bbox output.
// Strategy: Use real OCR coordinates to locate fields directly,
// then fall back to simple regex only when coordinates can't resolve.
//
// Invoice layout (normalized 0~1 coordinates, Y-axis: top=0, bottom=1):
//
//   VAT invoice (增值税发票):
//     ny 0.00~0.15:  标题 "电子发票(普通发票)" + 发票号码 + 开票日期
//     ny 0.15~0.35:  购买方信息 (nx 0~0.5) | 销售方信息 (nx 0.5~1.0)
//     ny 0.35~0.45:  明细表头 (项目名称/金额/税率/税额)
//     ny 0.45~0.60:  明细行
//     ny 0.60~0.70:  合计行 (不含税金额合计 + 税额合计)
//     ny 0.70~0.80:  价税合计 (大写)(小写)¥XXX.XX
//     ny 0.80~1.00:  备注 + 开票人
//
//   Train ticket (铁路电子客票):
//     ny 0.00~0.15:  标题 + 发票号码 + 开票日期
//     ny 0.15~0.35:  出发站/到达站/车次
//     ny 0.35~0.55:  票价 + 座位/等级
//     ny 0.55~0.75:  身份证号/姓名
//     ny 0.75~1.00:  客票号 + 购买方信息

/**
 * Normalize a word's text for matching (fullwidth→halfwidth, collapse CJK spaces).
 */
function _normText(s) {
  if (!s) return '';
  s = s.replace(/[０-９]/g, function(c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
  s = s.replace(/[Ａ-Ｚａ-ｚ]/g, function(c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
  s = s.replace(/％/g, '%').replace(/．/g, '.').replace(/，/g, ',').replace(/：/g, ':');
  s = s.replace(/￥/g, '¥');
  // Collapse spaces between CJK chars
  s = s.replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, '$1$2');
  return s;
}

/**
 * Normalize OCR text for structured extraction.
 * Like _normText() but preserves newlines (critical for line-based regex matching).
 * The regular normText collapses CJK newlines, which merges separate "名称:" entries
 * into one line and breaks line-by-line extraction.
 */
function _normTextForExtract(text) {
  if (!text) return '';
  // Full-width → half-width
  text = text.replace(/[０-９]/g, function(c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
  text = text.replace(/[Ａ-Ｚａ-ｚ]/g, function(c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
  text = text.replace(/％/g, '%').replace(/．/g, '.').replace(/，/g, ',').replace(/：/g, ':');
  text = text.replace(/￥/g, '¥');
  // Collapse spaces between CJK chars ON THE SAME LINE only (preserve newlines)
  for (var _cj = 0; _cj < 5; _cj++) {
    var _cjPrev = '';
    while (_cjPrev !== text) { _cjPrev = text; text = text.replace(/([\u4e00-\u9fff])[ \t]+([\u4e00-\u9fff])/g, '$1$2'); }
  }
  // Collapse spaces between digits on the same line
  for (var _i = 0; _i < 3; _i++) {
    var _prev = '';
    while (_prev !== text) { _prev = text; text = text.replace(/(\d)[ \t]+(\d)/g, '$1$2'); }
  }
  text = text.replace(/(\d)[ \t]+\./g, '$1.');
  text = text.replace(/¥[ \t]+(\d)/g, '¥$1');
  text = text.replace(/([\u4e00-\u9fff])\s+¥/g, '$1¥');

  // Normalize OCR ¥↔1 misread artifacts (critical for amount accuracy)
  // Step 1: ¥¥ patterns — OCR misreads "1" as "¥" producing "¥¥72.68" → "¥172.68"
  text = normalizeOcrCurrency(text);

  // Step 2: Keyword-based ¥→1 misread correction (restored from v1.6.7)
  // OCR often misreads "¥" as "1" (they look very similar). After amount keywords,
  // "1XXX.XX" (4+ digits before decimal) should be "¥XXX.XX".
  // e.g., "价税合计1317.00" → "价税合计¥317.00"
  // Only apply after amount keywords to avoid corrupting legitimate numbers.
  // \d{3,} requires 3+ digits after "1" (4+ total) to avoid stripping "1" from
  // legitimate 3-digit amounts like "金额172.68" (should stay 172.68).
  text = text.replace(/(价\s*税\s*合\s*计|金\s*额|税\s*额|合\s*计|票\s*价|总\s*计|不\s*含\s*税|含\s*税|实\s*付|应\s*付|开\s*票\s*金\s*额|发\s*票\s*金\s*额|全\s*价|优\s*惠\s*价|小\s*写)([^\d¥￥]*?)1(\d{3,}\.\d{2})/g, '$1$2¥$3');

  return text;
}

/**
 * Clean a captured name string for structured extraction.
 * Removes trailing labels, punctuation, and validates format.
 */
function _cleanName(raw) {
  if (!raw) return '';
  var name = raw.trim();
  // Strip trailing credit code patterns (18-char alphanumeric appended to company name)
  // e.g., "无锡天鹏菜篮子工程有限公司91320200796148368W" → "无锡天鹏菜篮子工程有限公司"
  name = name.replace(/[A-Z0-9]{15,20}$/, '');
  // Trim at next label keyword (when OCR merges multiple labels into one line)
  name = name.replace(/名\s*称[:：].*$/, '');
  name = name.replace(/统一社会(?:信用代码)?.*$/, '');
  name = name.replace(/纳税人识别号.*$/, '');
  name = name.replace(/开户银行.*$/, '');
  name = name.replace(/银行账号.*$/, '');
  name = name.replace(/地址电话.*$/, '');
  // Strip metadata/watermark annotations (download count, verification count, etc.)
  name = name.replace(/(?:下载|查验|开具|打印)次数[：:]*\d*/g, '');
  // Remove trailing punctuation and whitespace
  name = name.replace(/[，,。.、：:；;！!？?\s]+$/, '');
  // Remove leading whitespace/colons
  name = name.replace(/^[\s:：]+/, '');
  // Skip if it's a label itself or non-company text
  if (/^(?:购买方信息|销售方信息|购买方|销售方|名称|信息|纳税人|地址|电话|开户行|账号|项目名称|规格型号)$/.test(name)) return '';
  // Skip table header terms and section labels
  if (/^(?:单价|数量|金额|税率|税额|合\s*计|大\s*写|小\s*写|备\s*注|出行人|证件号|出行日期|出发地|到达地|等\s*级|交通工具|开票人|收款人|复核人|价税合计)$/.test(name)) return '';
  // Skip metadata/watermark annotations (download count, verification count, etc.)
  if (/^(?:下载|查验|开具|打印)次数/.test(name)) return '';
  // Skip concatenated table headers (e.g., "单价数量", "金额税率", "项目名称单价")
  if (/^(?:单价|数量|金额|税率|税额|项目名称|规格型号|合\s*计|备\s*注|价税合计)/.test(name) && name.length <= 8) return '';
  // Skip invoice type labels — these are NOT company names
  if (/^(?:电子发票|增值税专用发票|普通发票|增值税电子普通发票|增值税电子专用发票|价税合计|小写|大写)$/.test(name)) return '';
  if (/^电子发票[（(]/.test(name)) return '';
  if (/电子发票.*增值税专用发票/.test(name)) return '';
  if (/电子发票.*普通发票/.test(name)) return '';
  if (/价税合计.*大写/.test(name)) return '';
  // Must contain CJK and be at least 2 chars
  if (name.length < 2 || !/[\u4e00-\u9fff]/.test(name)) return '';
  return name;
}

/**
 * Extract buyer/seller names when label and value are on separate lines.
 * This handles PDFs where text extraction puts labels and values in different blocks.
 * Strategy: Find "名称：" labels, then look at the NEXT non-empty line for the actual value.
 * Use credit code positions to determine which name belongs to buyer vs seller.
 */
function _extractNamesCrossLine(text, result) {
  var lines = text.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l; });

  // Find all "名称：" positions (standalone label) and inline "名称:公司名"
  var nameLabels = [];
  var inlineNames = [];
  for (var i = 0; i < lines.length; i++) {
    if (/^名\s*称[:：]?$/.test(lines[i])) {
      nameLabels.push(i);
    } else {
      // Inline format: "名称:公司名" or "名称：公司名"
      var inlineMatch = lines[i].match(/^名\s*称[:：]\s*(.+)$/);
      if (inlineMatch) {
        var inlineName = _cleanName(inlineMatch[1]);
        if (inlineName) {
          inlineNames.push({ line: i, name: inlineName });
        }
      }
    }
  }

  // If inline names were found, use them directly (first = buyer, second = seller)
  if (inlineNames.length >= 2) {
    if (!result.buyerName) result.buyerName = inlineNames[0].name;
    if (!result.sellerName) result.sellerName = inlineNames[1].name;
    return;
  }
  if (inlineNames.length === 1) {
    // Single inline name — likely buyer (first "名称" in the document)
    if (!result.buyerName) result.buyerName = inlineNames[0].name;
  }

  // Find all potential company names (Chinese strings of reasonable length)
  var potentialNames = [];
  var companyNameRegex = /^[\u4e00-\u9fa5][\u4e00-\u9fa50-9a-zA-Z（）()·\-\.]{2,50}$/;
  for (var i = 0; i < lines.length; i++) {
    if (companyNameRegex.test(lines[i])) {
      var cleaned = _cleanName(lines[i]);
      if (cleaned) {
        potentialNames.push({ line: i, name: cleaned });
      }
    }
  }

  // Strategy 1: Label and value on adjacent lines (original logic)
  var nameEntries = [];
  for (var i = 0; i < nameLabels.length; i++) {
    var labelLine = nameLabels[i];
    if (labelLine + 1 < lines.length) {
      var nextLine = lines[labelLine + 1];
      if (nextLine && !/^名\s*称[:：]?$/.test(nextLine) && !/^[\s:：]*$/.test(nextLine)) {
        var cleaned = _cleanName(nextLine);
        if (cleaned) {
          nameEntries.push({ labelLine: labelLine, valueLine: labelLine + 1, name: cleaned });
        }
      }
    }
  }

  // Strategy 2: If no adjacent matches, match labels with potential names by position
  // Labels are usually at the top, names are usually after labels
  if (nameEntries.length === 0 && nameLabels.length > 0 && potentialNames.length > 0) {
    // Sort potential names by line number (top to bottom)
    potentialNames.sort(function(a, b) { return a.line - b.line; });
    
    // Match labels to names (first label -> first name, second label -> second name)
    for (var i = 0; i < Math.min(nameLabels.length, potentialNames.length); i++) {
      nameEntries.push({ 
        labelLine: nameLabels[i], 
        valueLine: potentialNames[i].line, 
        name: potentialNames[i].name 
      });
    }
  }

  if (nameEntries.length === 0) return;

  // Find credit code positions to anchor buyer/seller determination
  var ccRegex = /(?:统一社会信用代码|纳税人识别号)[^A-Z0-9]{0,30}([A-Z0-9]{15,20})/gi;
  var codes = [];
  var cm;
  while ((cm = ccRegex.exec(text)) !== null) {
    var code = cm[1].toUpperCase();
    // Guard: skip pure-digit codes (likely invoice numbers, not credit codes)
    if (!/[A-Z]/.test(code)) continue;
    if (codes.indexOf(code) < 0) codes.push(code);
  }

  // Assign names based on position relative to credit codes
  // Standard layout: buyer info first (top), seller info second (bottom)
  if (nameEntries.length >= 2 && codes.length >= 2) {
    // Two names and two codes: first name = buyer, second name = seller
    if (!result.buyerName) result.buyerName = nameEntries[0].name;
    if (!result.sellerName) result.sellerName = nameEntries[1].name;
  } else if (nameEntries.length >= 2) {
    // Two names but unknown codes: assume first = buyer, second = seller
    if (!result.buyerName) result.buyerName = nameEntries[0].name;
    if (!result.sellerName) result.sellerName = nameEntries[1].name;
  } else if (nameEntries.length === 1) {
    // Only one name found: could be seller if we already have buyer credit code
    // or buyer if we have no other info
    if (!result.buyerName && !result.sellerName) {
      // No names yet: assign as buyer (conservative)
      result.buyerName = nameEntries[0].name;
    } else if (!result.sellerName) {
      // Have buyer but no seller: assign as seller
      result.sellerName = nameEntries[0].name;
    }
  }
}

/**
 * Find a value word near a label word using coordinates.
 * Strategy: Look for valuePattern-matching words that are:
 *   1. To the right of the label (horizontal layout), or
 *   2. Below the label (vertical layout, within reasonable distance)
 * Returns the matched text or empty string.
 */
function _findValueByLabelCoords(words, labelPattern, valuePattern) {
  if (!words || words.length === 0) return '';

  // Find all label words - match partial text too (for multi-character labels that may be split)
  var labelWords = words.filter(function(w) {
    return labelPattern.test(w.text) || labelPattern.test(w.normText);
  });
  if (labelWords.length === 0) return '';

  // For each label, find nearby value words
  for (var li = 0; li < labelWords.length; li++) {
    var label = labelWords[li];
    var candidates = [];

    for (var wi = 0; wi < words.length; wi++) {
      var w = words[wi];
      if (w === label) continue;
      // Match both original text and normalized text
      if (!valuePattern.test(w.text) && !valuePattern.test(w.normText)) continue;

      var dx = w.cx - label.cx;
      var dy = w.cy - label.cy;
      var adx = Math.abs(dx);
      var ady = Math.abs(dy);

      // Horizontal layout: value is to the right, on same line or adjacent line
      // Relaxed y threshold (20px) to handle PDFs where label and value are
      // in separate text blocks with slight vertical offset (e.g., 8.6px)
      var isHorizontal = dx > 0 && adx < 350 && ady < 20;
      // Vertical layout: value is below, within reasonable distance
      var isVertical = dy > 0 && dy < 100 && adx < 80;

      if (isHorizontal || isVertical) {
        // Score by distance (prefer closer)
        var score = Math.sqrt(adx * adx + ady * ady);
        candidates.push({ word: w, score: score });
      }
    }

    if (candidates.length > 0) {
      candidates.sort(function(a, b) { return a.score - b.score; });
      return candidates[0].word.text;
    }
  }

  return '';
}

/**
 * Collect words in a rectangular region defined by normalized coordinates.
 * Returns words sorted by y (top-to-bottom), then x (left-to-right).
 */
function _collectWordsInRegion(words, nxMin, nxMax, nyMin, nyMax) {
  var found = [];
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (w.nx >= nxMin && w.nx <= nxMax && w.ny >= nyMin && w.ny <= nyMax) {
      found.push(w);
    }
  }
  found.sort(function(a, b) {
    var yDiff = a.y - b.y;
    if (Math.abs(yDiff) > (a.h + b.h) * 0.3) return yDiff < 0 ? -1 : 1;
    return a.x - b.x;
  });
  return found;
}

/**
 * Join words into a text string, grouping by line proximity.
 * Words on the same y-band are joined without separator;
 * words on different y-bands are joined with newline.
 */
function _joinWordsByLine(words) {
  if (words.length === 0) return '';
  var lines = [];
  var curLine = [words[0]];
  var curY = words[0].y;
  var curH = words[0].h;
  for (var i = 1; i < words.length; i++) {
    var w = words[i];
    if (Math.abs(w.y - curY) <= curH * 0.6) {
      curLine.push(w);
    } else {
      curLine.sort(function(a, b) { return a.x - b.x; });
      lines.push(curLine.map(function(w) { return w.text; }).join(''));
      curLine = [w];
      curY = w.y;
      curH = w.h;
    }
  }
  if (curLine.length > 0) {
    curLine.sort(function(a, b) { return a.x - b.x; });
    lines.push(curLine.map(function(w) { return w.text; }).join(''));
  }
  return lines.join('');
}

/**
 * Extract buyer/seller names using coordinate-based region matching.
 * Strategy: Find "名称" label positions, then collect all words in the
 * region to the right of each label (and slightly below for multi-line names).
 * Use "统一社会信用代码" label as a boundary to avoid over-collection.
 * No company keyword filtering — relies purely on spatial positioning.
 */
function _extractNamesByCoords(words, result) {
  if (!words || words.length === 0) return;

  var nameLabels = words.filter(function(w) {
    return /^名\s*称[:：]/.test(w.text) || /^名\s*称[:：]/.test(w.normText);
  });
  if (nameLabels.length === 0) return;

  // Extract inline name values from fused "名称:公司名" words
  // Some PDF text layers produce "名称:无锡天鹏菜篮子工程有限公司" as a single word
  var inlineNameResults = [];
  for (var _ilni = 0; _ilni < nameLabels.length; _ilni++) {
    var _ilnWord = nameLabels[_ilni];
    var _ilnText = _ilnWord.text || _ilnWord.normText;
    var _ilnMatch = _ilnText.match(/^名\s*称[:：]\s*(.+)$/);
    if (_ilnMatch && _ilnMatch[1].trim()) {
      var _ilnName = _cleanName(_ilnMatch[1]);
      if (_ilnName) {
        var _ilnIsLeft = _ilnWord.nx < 0.5;
        inlineNameResults.push({ label: _ilnWord, name: _ilnName, ny: _ilnWord.ny, nx: _ilnWord.nx, wordIndex: words.indexOf(_ilnWord), isLeftSide: _ilnIsLeft });
      }
    }
  }

  var creditLabels = words.filter(function(w) {
    return /统一社会(?:信用代码)?|纳税人识别号/.test(w.text) || /统一社会(?:信用代码)?|纳税人识别号/.test(w.normText);
  });

  var foundNames = [];
  // Add inline name results first (from "名称:公司名" fused words)
  for (var _ilri = 0; _ilri < inlineNameResults.length; _ilri++) {
    foundNames.push(inlineNameResults[_ilri]);
  }
  for (var li = 0; li < nameLabels.length; li++) {
    var label = nameLabels[li];
    // Skip if this label already produced an inline name result
    var _alreadyInline = inlineNameResults.some(function(r) { return r.label === label; });
    if (_alreadyInline) continue;

    var labelBottom = label.y + label.h;
    var lineH = label.h;

    // Determine which side of the invoice this label belongs to.
    // Standard VAT layout: buyer info is left half (nx < 0.5), seller info is right half (nx >= 0.5).
    // This prevents words from the other side being included (the #1 cause of name concatenation).
    var isLeftSide = label.nx < 0.5;

    var regionWords = [];
    for (var wi = 0; wi < words.length; wi++) {
      var w = words[wi];
      if (w === label) continue;

      // ENFORCE REGION BOUNDARY: only collect words on the SAME SIDE as the label.
      // This is the critical fix — without it, "名称：" on the left half would also
      // collect the seller's company name from the right half, producing concatenated names.
      if (isLeftSide && w.nx >= 0.5) continue;  // left-side label → skip right-half words
      if (!isLeftSide && w.nx < 0.5) continue;   // right-side label → skip left-half words

      var isRightOfLabel = w.x >= label.x - lineH * 0.3;
      // For seller-side labels, also look slightly ABOVE (some ride invoices have
      // the company name above the "名称：" label when layout is compact)
      var isBelowOrSameLine = w.y >= label.y - lineH * 0.3 && w.y < labelBottom + lineH * 3;
      var isAboveLabel = w.y >= label.y - lineH * 5 && w.y < label.y - lineH * 0.3;
      // Only look above for right-side labels (seller) — buyer labels should only look below
      var includeAbove = !isLeftSide && isAboveLabel && w.x >= label.x - lineH * 2;
      var isInYRange = isBelowOrSameLine || includeAbove;
      var isNotLabel = !/^名\s*称[:：]/.test(w.text) && !/^名\s*称[:：]/.test(w.normText);
      var isNotCreditLabel = !/统一社会(?:信用代码)?|纳税人识别号/.test(w.text) && !/统一社会(?:信用代码)?|纳税人识别号/.test(w.normText);
      var isNotSectionLabel = !/^(?:购\s*买|销\s*售|购|销|买|售|信\s*息|方|项\s*目|项目名称|单\s*价|数\s*量|金\s*额|税\s*率|税\s*额|合\s*计|备\s*注|开\s*票|收\s*款|复\s*核|出\s*行|等\s*级|交\s*通)$/.test(w.text) && !/^(?:购\s*买|销\s*售|购|销|买|售|信\s*息|方|项\s*目|项目名称|单\s*价|数\s*量|金\s*额|税\s*率|税\s*额|合\s*计|备\s*注|开\s*票|收\s*款|复\s*核|出\s*行|等\s*级|交\s*通)$/.test(w.normText);
      // Filter out metadata/watermark words (download count, verification count, etc.)
      var isNotMetadata = !/^(?:下载|查验|开具|打印)次数/.test(w.text) && !/^(?:下载|查验|开具|打印)次数/.test(w.normText);
      // Filter out words that look like credit codes (18-char alphanumeric with letters)
      // These should be captured as credit codes, not as part of company names
      var _wCleaned = w.normText.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      var isNotCreditCodeWord = !(_wCleaned.length >= 15 && _wCleaned.length <= 20 && /^[0-9]/.test(_wCleaned) && /[A-Z]/.test(_wCleaned));

      if (isRightOfLabel && isInYRange && isNotLabel && isNotCreditLabel && isNotSectionLabel && isNotMetadata && isNotCreditCodeWord) {
        var blockedByCredit = false;
        for (var ci = 0; ci < creditLabels.length; ci++) {
          var cl = creditLabels[ci];
          // Only consider credit labels on the SAME SIDE as the name label
          var clIsLeft = cl.nx < 0.5;
          if (clIsLeft !== isLeftSide) continue;
          // Block words at or below the credit label's y position
          // Relaxed ny threshold (0.3) to handle ride invoices with compact layouts
          if (Math.abs(cl.ny - label.ny) < 0.3 && w.y >= cl.y - lineH * 0.3) {
            blockedByCredit = true;
            break;
          }
        }
        if (!blockedByCredit) {
          regionWords.push(w);
        }
      }
    }

    if (regionWords.length === 0) continue;

    var nameText = _joinWordsByLine(regionWords);
    var cleaned = _cleanName(nameText);
    if (cleaned) {
      foundNames.push({ label: label, name: cleaned, ny: label.ny, nx: label.nx, wordIndex: words.indexOf(label), isLeftSide: isLeftSide });
    }
  }

  if (foundNames.length === 0) return;

  // Assign names based on spatial position (not word order which is unreliable for PDF text)
  var leftNames = foundNames.filter(function(n) { return n.isLeftSide; });
  var rightNames = foundNames.filter(function(n) { return !n.isLeftSide; });

  // Left half = buyer, right half = seller
  if (!result.buyerName && leftNames.length > 0) {
    result.buyerName = leftNames[0].name;
  }
  if (!result.sellerName && rightNames.length > 0) {
    result.sellerName = rightNames[0].name;
  }

  // Fallback: if we found names but couldn't assign by side, use word order
  if ((!result.buyerName || !result.sellerName) && foundNames.length >= 2) {
    foundNames.sort(function(a, b) { return a.wordIndex - b.wordIndex; });
    if (!result.buyerName) result.buyerName = foundNames[0].name;
    if (!result.sellerName) result.sellerName = foundNames[1].name;
  } else if ((!result.buyerName || !result.sellerName) && foundNames.length === 1) {
    if (foundNames[0].isLeftSide) {
      if (!result.buyerName) result.buyerName = foundNames[0].name;
    } else {
      if (!result.sellerName) result.sellerName = foundNames[0].name;
    }
  }
}

/**
 * Text-based extraction from OCR text (preserving line structure).
 * PRIMARY extraction method for structured fields (invoice number, date,
 * buyer/seller names and credit codes). Coordinate-based extraction is the fallback.
 *
 * Key insight: OCR output is well-formatted with clear key-value pairs:
 *   发票号码：2532200000380892372
 *   开票日期：2025年08月19日
 *   名称：无锡市天鹏食品有限公司           ← 购买方 (1st)
 *   名称：无锡市志成生化工程装备有限公司    ← 销售方 (2nd)
 *   统一社会信用代码/纳税人识别号：913202001358946118  ← 购买方 (1st)
 *   统一社会信用代码/纳税人识别号：913202057431110944  ← 销售方 (2nd)
 *
 * NEW: Also supports coordinate-based extraction for PDFs where labels and values
 * are in separate text blocks but positioned adjacent to each other.
 *
 * @param {string} fullText - The full OCR text
 * @param {Array} [words] - Optional array of word objects with {text, x, y, w, h, nx, ny}
 * @returns {Object} { invoiceNo, invoiceDate, buyerName, sellerName, buyerCreditCode, sellerCreditCode }
 */
function _extractByText(fullText, words) {
  var result = {
    invoiceNo: '',
    invoiceDate: '',
    buyerName: '',
    sellerName: '',
    buyerCreditCode: '',
    sellerCreditCode: ''
  };
  if (!fullText) return result;

  var text = _normTextForExtract(fullText);

  // --- Invoice number ---
  // Pattern 1: Same line (standard format)
  var noMatch = text.match(/发\s*票\s*号\s*码[:\s]*(\d{8,20})/);
  if (noMatch) result.invoiceNo = noMatch[1];
  // Pattern 2: Cross-line (label and value on separate lines)
  // e.g., "发票号码：\n25322000000337005189"
  if (!result.invoiceNo) {
    var noCrossMatch = text.match(/发\s*票\s*号\s*码[:：\s]*\n\s*(\d{8,20})/);
    if (noCrossMatch) result.invoiceNo = noCrossMatch[1];
  }
  // Pattern 3: Loose cross-line (label and value separated by multiple lines)
  // e.g., "发票号码：\n...\n25322000000337005189"
  if (!result.invoiceNo) {
    var noLooseMatch = text.match(/发\s*票\s*号\s*码[:：][\s\S]*?(\d{8,20})/);
    if (noLooseMatch) result.invoiceNo = noLooseMatch[1];
  }
  // Pattern 4: Coordinate-based (for PDFs with label/value in separate blocks)
  if (!result.invoiceNo && words && words.length > 0) {
    result.invoiceNo = _findValueByLabelCoords(words, /发\s*票\s*号\s*码/, /\d{8,20}/);
  }

  // --- Invoice date ---
  // Pattern 1: Same line (standard format)
  var dateMatch = text.match(/开\s*票\s*日\s*期[:\s]*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (dateMatch) {
    result.invoiceDate = dateMatch[1] + '-' +
      dateMatch[2].padStart(2, '0') + '-' +
      dateMatch[3].padStart(2, '0');
  }
  // Pattern 2: Cross-line (label and value on separate lines)
  // e.g., "开票日期：\n2025年07月22日"
  if (!result.invoiceDate) {
    var dateCrossMatch = text.match(/开\s*票\s*日\s*期[:：\s]*\n\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (dateCrossMatch) {
      result.invoiceDate = dateCrossMatch[1] + '-' +
        dateCrossMatch[2].padStart(2, '0') + '-' +
        dateCrossMatch[3].padStart(2, '0');
    }
  }
  // Pattern 3: Coordinate-based (for PDFs with label/value in separate blocks)
  if (!result.invoiceDate && words && words.length > 0) {
    var dateStr = _findValueByLabelCoords(words, /开\s*票\s*日\s*期/, /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/);
    if (dateStr) {
      var dateParts = dateStr.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
      if (dateParts) {
        result.invoiceDate = dateParts[1] + '-' +
          dateParts[2].padStart(2, '0') + '-' +
          dateParts[3].padStart(2, '0');
      }
    }
  }
  // Pattern 4: Global word search — find date pattern anywhere in the word list.
  // Some PDF text extractions (especially ride invoices) have "开票日期：" and the
  // actual date far apart in coordinates, so coordinate-based search fails.
  // Only use this if "开票日期" label exists (confirms it's an invoice with a date).
  if (!result.invoiceDate && words && words.length > 0) {
    var hasDateLabel = words.some(function(w) {
      return /开\s*票\s*日\s*期/.test(w.text) || /开\s*票\s*日\s*期/.test(w.normText);
    });
    if (hasDateLabel) {
      for (var di = 0; di < words.length; di++) {
        var dw = words[di];
        var dateGlobalMatch = (dw.text || '').match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/) ||
                              (dw.normText || '').match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
        if (dateGlobalMatch) {
          var yr = parseInt(dateGlobalMatch[1], 10);
          if (yr >= 2020 && yr <= 2035) {
            result.invoiceDate = dateGlobalMatch[1] + '-' +
              dateGlobalMatch[2].padStart(2, '0') + '-' +
              dateGlobalMatch[3].padStart(2, '0');
            break;
          }
        }
      }
    }
  }

  // --- Buyer/Seller names ---
  // Priority 1: Explicit labels "购买方名称：" / "销售方名称：" (same line)
  var buyerLabelMatch = text.match(/购\s*买\s*方(?:信息)?名\s*称[:\s]*([^\n]+)/);
  if (buyerLabelMatch) {
    var bn = _cleanName(buyerLabelMatch[1]);
    if (bn) result.buyerName = bn;
  }
  var sellerLabelMatch = text.match(/销\s*售\s*方(?:信息)?名\s*称[:\s]*([^\n]+)/);
  if (sellerLabelMatch) {
    var sn = _cleanName(sellerLabelMatch[1]);
    if (sn) result.sellerName = sn;
  }
  // Priority 1b: Coordinate-based (for PDFs with label/value in separate blocks)
  // Run BEFORE cross-line because coordinate method is more reliable for PDF text
  if ((!result.buyerName || !result.sellerName) && words && words.length > 0) {
    _extractNamesByCoords(words, result);
  }
  // Priority 1c: Cross-line format (label and value on separate lines)
  // Only if coordinate method didn't find both names
  if (!result.buyerName || !result.sellerName) {
    _extractNamesCrossLine(text, result);
  }

  // --- Buyer/Seller credit codes ---
  // STRATEGY: Coordinate-based assignment is primary (more reliable than text order).
  // Credit code words in the left half (nx < 0.5) → buyer, right half (nx >= 0.5) → seller.
  // Text-order fallback only when coordinates are unavailable.

  // Method 1: Coordinate-based — find credit code words and assign by position
  if (words && words.length > 0) {
    var ccWordRe = /^[0-9][A-Z0-9]{17}$/i;  // 18-char unified social credit code
    var coordCodes = { buyer: '', seller: '' };
    words.forEach(function(w) {
      var cleaned = w.normText.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      // 18-char code: allow pure digits (统一社会信用代码 can be all digits per GB 32100-2015)
      // Non-18 pure-digit codes are more likely invoice numbers — skip them
      var _ccPureDigit = /^\d+$/.test(cleaned);
      if (cleaned.length >= 15 && cleaned.length <= 20 && /^[0-9]/.test(cleaned) &&
          (!_ccPureDigit || cleaned.length === 18)) {
        if (w.nx < 0.5) {
          if (!coordCodes.buyer) coordCodes.buyer = cleaned;
        } else {
          if (!coordCodes.seller) coordCodes.seller = cleaned;
        }
      }
    });
    if (coordCodes.buyer) result.buyerCreditCode = coordCodes.buyer;
    if (coordCodes.seller) result.sellerCreditCode = coordCodes.seller;
  }

  // Method 1.5: Label-tracing — when credit code is split into single-char words
  // Some PDFs (dzcp format) split "91320200796148368W" into '9','1','3',...
  // The label word contains "统一社会信用代码/纳税人识别号:9" (first digit fused).
  if ((!result.buyerCreditCode || !result.sellerCreditCode) && words && words.length > 0) {
    var ccLabelWords = words.filter(function(w) {
      return /统一社会(?:信用代码)?/.test(w.text) || /统一社会(?:信用代码)?/.test(w.normText);
    });
    var _tracedCodes = [];
    for (var _tci = 0; _tci < ccLabelWords.length; _tci++) {
      var _tcLabel = ccLabelWords[_tci];
      var _tcLabelText = _tcLabel.text || _tcLabel.normText;
      var _tcLabelDigits = _tcLabelText.replace(/[^A-Za-z0-9]/g, '');
      var _tcCode = _tcLabelDigits;
      // Collect single-char words on the same line and to the right of the label
      var _tcSameLineWords = words.filter(function(w) {
        if (w === _tcLabel) return false;
        if (Math.abs(w.cy - _tcLabel.cy) > _tcLabel.h * 2.5) return false;
        if (w.x < _tcLabel.x + _tcLabel.w - _tcLabel.h) return false;
        return true;
      });
      _tcSameLineWords.sort(function(a, b) { return a.x - b.x; });
      for (var _tswi = 0; _tswi < _tcSameLineWords.length; _tswi++) {
        var _tsw = _tcSameLineWords[_tswi];
        var _tswText = _tsw.normText || _tsw.text;
        if (/^[A-Za-z0-9]$/.test(_tswText)) {
          _tcCode += _tswText;
        } else if (/^[A-Za-z0-9]{2,4}$/.test(_tswText) && _tcCode.length + _tswText.length <= 18) {
          _tcCode += _tswText;
        }
        if (_tcCode.length >= 18) break;
      }
      _tcCode = _tcCode.toUpperCase();
      if (_tcCode.length === 18 && /^[0-9]/.test(_tcCode)) {
        _tracedCodes.push({ code: _tcCode, isLeft: _tcLabel.nx < 0.5 });
      }
    }
    for (var _tai = 0; _tai < _tracedCodes.length; _tai++) {
      if (_tracedCodes[_tai].isLeft && !result.buyerCreditCode) {
        result.buyerCreditCode = _tracedCodes[_tai].code;
      } else if (!_tracedCodes[_tai].isLeft && !result.sellerCreditCode) {
        result.sellerCreditCode = _tracedCodes[_tai].code;
      }
    }
    if (_tracedCodes.length >= 2 && (!result.buyerCreditCode || !result.sellerCreditCode)) {
      if (!result.buyerCreditCode) result.buyerCreditCode = _tracedCodes[0].code;
      if (!result.sellerCreditCode) result.sellerCreditCode = _tracedCodes[1].code;
    }
    if (_tracedCodes.length === 1 && !result.sellerCreditCode) {
      result.sellerCreditCode = _tracedCodes[0].code;
    }
  }

  // Method 2: Text regex fallback (only if coordinate method didn't find both codes)
  if (!result.buyerCreditCode || !result.sellerCreditCode) {
    var ccRegex = /(?:统一社会信用代码|纳税人识别号)[^A-Z0-9]{0,30}([A-Z0-9]{15,20})/gi;
    var codes = [];
    var ccPositions = [];
    var cm;
    while ((cm = ccRegex.exec(text)) !== null) {
      var code = cm[1].toUpperCase();
      // Guard: 18位纯数字也可能是信用代码；非18位纯数字则排除
      var _ccPureDigit2 = /^\d+$/.test(code);
      if (_ccPureDigit2 && code.length !== 18) continue;
      if (codes.indexOf(code) < 0) {
        codes.push(code);
        ccPositions.push(cm.index);
      }
    }
    if (codes.length >= 2) {
      if (!result.buyerCreditCode) result.buyerCreditCode = codes[0];
      if (!result.sellerCreditCode) result.sellerCreditCode = codes[1];
    } else if (codes.length === 1) {
      // Single credit code → belongs to seller (personal buyer has no credit code)
      if (!result.sellerCreditCode) result.sellerCreditCode = codes[0];
    }
  }

  // Priority 2: "销方名称" / "销方" abbreviated form (v1.6.7 strategy)
  if (!result.sellerName) {
    var shortSeller = text.match(/销\s*方(?:信息)?名\s*称[:\s]*([^\n]+)/);
    if (shortSeller) {
      var ssn = _cleanName(shortSeller[1]);
      if (ssn) result.sellerName = ssn;
    }
  }

  // Priority 3: Generic "名称：" — first = buyer, second = seller
  // Use credit code position as anchor: find "名称" before seller's credit code
  if (!result.buyerName || !result.sellerName) {
    var nameRegex = /名\s*称[:：]\s*([^\n]+)/g;
    var names = [];
    var namePositions = [];
    var nm;
    while ((nm = nameRegex.exec(text)) !== null) {
      var name = _cleanName(nm[1]);
      if (name && names.indexOf(name) < 0) {
        names.push(name);
        namePositions.push(nm.index);
      }
    }
    if (!result.buyerName && names.length >= 1) result.buyerName = names[0];
    if (!result.sellerName) {
      // Credit-code-anchored strategy (v1.6.7): find LAST "名称" before seller's credit code
      if (codes.length >= 2 && ccPositions.length >= 2) {
        var sellerCcPos = ccPositions[ccPositions.length - 1];
        var lastNameBeforeCc = '';
        for (var ni = 0; ni < namePositions.length; ni++) {
          if (namePositions[ni] < sellerCcPos) {
            var nc = _cleanName(names[ni]);
            if (nc && !/^(?:购买方|销售方|名称)/.test(nc)) {
              lastNameBeforeCc = nc;
            }
          }
        }
        if (lastNameBeforeCc) result.sellerName = lastNameBeforeCc;
      }
      // Fallback: 2nd "名称" match
      if (!result.sellerName && names.length >= 2) result.sellerName = names[1];
      // When only 1 "名称" match, don't duplicate it as sellerName —
      // a single "名称" is almost always the buyer, and the seller should be
      // determined by other means (e.g., ticket type label, ride invoice layout)
    }
  }

  // Priority 4: "收款单位" / "销货单位" / "开票方" (non-standard invoices)
  if (!result.sellerName) {
    var altSeller = text.match(/(?:收款单位|销货单位|开票方|销售单位)[^\n]{0,30}?[:：]?\s*([^\n]{2,60}?)(?=\s*(?:纳税人|统一社会|地址|开户行|电话|账号|[A-Z0-9]{15,20})|\n|$)/i);
    if (altSeller) {
      var altName = _cleanName(altSeller[1]);
      if (altName) result.sellerName = altName;
    }
  }

  // Priority 5: Company name near the last credit code (v1.6.7 Strategy 4)
  // Some OCR outputs have: "91440300xxxxxxxxx  深圳市某某科技有限公司"
  if (!result.sellerName && ccPositions.length > 0) {
    var csSuffix = '(?:公司|集团|商行|商店|厂|部|院|所|中心|店|馆|站|社|行|会|处|室|局|办|坊|铺|有限合伙|合伙企业|个体工商户|个体户|工作室|经营部|门市部|分公司|事业部|事务所|医院|学校|幼儿园|合作社|企业|商社|贸易行|服务部)';
    var lastCcPos = ccPositions[ccPositions.length - 1];
    var afterLastCc = text.substring(lastCcPos);
    var compNearCc = afterLastCc.match(new RegExp('[A-Z0-9]{15,20}\\s*[:：]?\\s*([\\u4e00-\\u9fff][\\u4e00-\\u9fff\\w（）()·\\-\\.]+' + csSuffix + ')'));
    if (compNearCc) {
      var compName = _cleanName(compNearCc[1]);
      if (compName) result.sellerName = compName;
    }
  }

  // Priority 6: Last company name with suffix in full text (v1.6.7 Strategy 6)
  if (!result.sellerName) {
    var csSuffix2 = '(?:公司|集团|商行|商店|厂|部|院|所|中心|店|馆|站|社|行|会|处|室|局|办|坊|铺|有限合伙|合伙企业|个体工商户|个体户|工作室|经营部|门市部|分公司|事业部|事务所|医院|学校|幼儿园|合作社|企业|商社|贸易行|服务部)';
    var allCompRe = new RegExp('([\\u4e00-\\u9fff][\\u4e00-\\u9fff\\w（）()·\\-\\.]{2,25}' + csSuffix2 + ')', 'g');
    var allCompMatches = [];
    var ccm;
    while ((ccm = allCompRe.exec(text)) !== null) {
      var cn = ccm[1].trim();
      if (cn.length > 3 && !/^(?:购买方|销售方|信息|名称|地址)/.test(cn)) {
        allCompMatches.push(cn);
      }
    }
    if (allCompMatches.length >= 2) {
      result.sellerName = allCompMatches[allCompMatches.length - 1];
    } else if (allCompMatches.length === 1 && !result.buyerName) {
      // Only one company found — could be seller if no buyer found either
      result.sellerName = allCompMatches[0];
    }
  }

  // Also try standalone credit codes (some OCR misses the label prefix)
  if (!result.buyerCreditCode || !result.sellerCreditCode) {
    var standaloneRe = /\b([0-9][A-Z0-9]{17})\b/g;
    var sm;
    var standaloneCodes = [];
    while ((sm = standaloneRe.exec(text)) !== null) {
      if (/\d{6,}/.test(sm[1]) && /[A-Z]/.test(sm[1])) {
        var sc = sm[1].toUpperCase();
        if (standaloneCodes.indexOf(sc) < 0) standaloneCodes.push(sc);
      }
    }
    // Same rule: 2+ codes → 1st=buyer, 2nd=seller; 1 code → seller only
    if (standaloneCodes.length >= 2) {
      if (!result.buyerCreditCode) result.buyerCreditCode = standaloneCodes[0];
      if (!result.sellerCreditCode) result.sellerCreditCode = standaloneCodes[1];
    } else if (standaloneCodes.length === 1) {
      if (!result.sellerCreditCode) result.sellerCreditCode = standaloneCodes[0];
    }
  }

  return result;
}

/**
 * Text-based amount extraction from OCR text.
 * PRIMARY method for extracting amountTax, amountNoTax, and taxAmount.
 *
 * Key insight: In the "合计" row of a VAT invoice, there are two amounts:
 *   - 不含税合计 (amountNoTax) — always the LARGER value (since 税率 < 100%)
 *   - 税额合计 (taxAmount) — always the SMALLER value
 * Because 税额 = 不含税金额 × 税率, and 税率 < 100%, so 税额 < 不含税.
 *
 * The "价税合计" row has one amount:
 *   - 含税总价 (amountTax) — the ¥ amount after "（小写）" or last after "价税合计"
 *
 * Returns: { amountTax, amountNoTax, taxAmount }
 */
function _extractAmountsByText(fullText) {
  var result = { amountTax: 0, amountNoTax: 0, taxAmount: 0 };
  if (!fullText) return result;

  var text = _normTextForExtract(fullText);

  // ========== Phase 1: Extract amountTax (含税总价) ==========

  // Pattern 1: "（小写）¥XXX.XX" — most specific indicator of 含税价
  // Enhanced: handle spaces between "小写）" and "¥" (PDF text often has "（小写） ¥ 4500.00")
  var xxMatch = text.match(/小\s*写[）\)]*[：:]*\s*¥?\s*(\d[\d,]*\.\d{2})/);
  if (xxMatch) {
    var v1 = parseAmt(xxMatch[1]);
    if (v1 > 10 && !isLikelyYearOrDate(v1, xxMatch[1])) {
      result.amountTax = v1;
      console.log('[Phase1] Pattern1匹配含税价:', xxMatch[1]);
    }
  }
  // Pattern 1b: "（小写）" and amount on the same line but separated
  // e.g., "小写）¥4500.00" with possible space between ¥ and digits
  if (!result.amountTax) {
    var xxBare = text.match(/小\s*写[）\)]*[：:]*\s*(\d[\d,]*\.\d{2})/);
    if (xxBare) {
      var v1b = parseAmt(xxBare[1]);
      if (v1b > 10 && !isLikelyYearOrDate(v1b, xxBare[1])) {
        result.amountTax = v1b;
        console.log('[Phase1] Pattern1b匹配含税价:', xxBare[1]);
      }
    }
  }
  // Pattern 2: Find last ¥ amount after "价税合计"
  if (!result.amountTax) {
    var jshjIdx = text.search(/价\s*税\s*合\s*计/);
    if (jshjIdx >= 0) {
      var afterJshj = text.substring(jshjIdx);
      var jshjAmtRe = /¥\s*(\d[\d,]*\.\d{2})/g;
      var jm, lastAmt = 0;
      while ((jm = jshjAmtRe.exec(afterJshj)) !== null) {
        var v2 = parseAmt(jm[1]);
        if (v2 > 0 && !isLikelyYearOrDate(v2, jm[1])) lastAmt = v2;
      }
      if (lastAmt > 0) {
        result.amountTax = lastAmt;
        console.log('[Phase1] Pattern2匹配含税价:', lastAmt);
      }
    } else {
      console.log('[Phase1] Pattern2未找到"价税合计"');
    }
  }
  // Pattern 2b: Bare amount after "价税合计" (no ¥, no 小写)
  if (!result.amountTax) {
    var jshjIdx2 = text.search(/价\s*税\s*合\s*计/);
    if (jshjIdx2 >= 0) {
      var afterJshj2 = text.substring(jshjIdx2);
      var bareJshj = afterJshj2.match(/[）\)][：:]*\s*(\d[\d,]*\.\d{2})/);
      if (bareJshj) {
        var v2b = parseAmt(bareJshj[1]);
        if (v2b > 10 && !isLikelyYearOrDate(v2b, bareJshj[1])) {
          result.amountTax = v2b;
          console.log('[Phase1] Pattern2b匹配含税价:', bareJshj[1]);
        }
      }
    }
  }
  if (!result.amountTax) {
    console.log('[Phase1] 所有Pattern均未匹配含税价, text长度:', text.length);
    var xiaoxiePos = text.indexOf('小写');
    if (xiaoxiePos >= 0) {
      console.log('[Phase1] "小写"位置:', xiaoxiePos, '上下文:', JSON.stringify(text.substring(Math.max(0, xiaoxiePos - 5), xiaoxiePos + 30)));
    }
    var jshjPos = text.indexOf('价税合计');
    if (jshjPos < 0) jshjPos = text.search(/价\s*税\s*合\s*计/);
    if (jshjPos >= 0) {
      console.log('[Phase1] "价税合计"位置:', jshjPos, '上下文:', JSON.stringify(text.substring(jshjPos, jshjPos + 50)));
    }
  }

  // Pattern 3: Chinese numeral (大写金额) — fallback when Arabic amount is garbled/missing in PDF text.
  // PDF text layer often fails to extract the Arabic amount (e.g., ¥8819.60) due to special
  // font encoding, but the Chinese numeral (e.g., "捌仟捌佰壹拾玖圆陆角整") is typically
  // rendered in standard fonts and extractable.
  if (!result.amountTax) {
    // Look for Chinese numeral characters after "价税合计（大写）" or standalone after "大写"
    var daxiePatterns = [
      // "价税合计（大写）捌仟捌佰壹拾玖圆陆角整"
      /价\s*税\s*合\s*计[（(]\s*大\s*写\s*[）)][：:]*\s*([零壹贰叁肆伍陆柒捌玖拾佰仟万亿萬億圆元角分整正一二三四五六七八九十]+)/,
      // "（大写）捌仟捌佰壹拾玖圆陆角整" (after 价税合计 on a different line)
      /[（(]\s*大\s*写\s*[）)][：:]*\s*([零壹贰叁肆伍陆柒捌玖拾佰仟万亿萬億圆元角分整正一二三四五六七八九十]+)/,
      // "大写：捌仟捌佰壹拾玖圆陆角整"
      /大\s*写[：:]*\s*([零壹贰叁肆伍陆柒捌玖拾佰仟万亿萬億圆元角分整正一二三四五六七八九十]+)/,
      // "捌仟捌佰壹拾玖圆陆角整（小写）" — numeral between 大写 and 小写 labels
      /([零壹贰叁肆伍陆柒捌玖拾佰仟万亿萬億圆元角分整正一二三四五六七八九十]+[圆元角分][整正]?)\s*[（(]\s*小\s*写/
    ];
    for (var dpi = 0; dpi < daxiePatterns.length && !result.amountTax; dpi++) {
      var daxieMatch = text.match(daxiePatterns[dpi]);
      if (daxieMatch) {
        var daxieVal = parseChineseNumeral(daxieMatch[1]);
        if (daxieVal > 10) {
          result.amountTax = daxieVal;
          console.log('[Phase1] Pattern3大写金额匹配含税价:', daxieMatch[1], '→', daxieVal);
        }
      }
    }
  }

  // ========== Phase 2: Extract taxAmount (税额) ==========
  // Strategy: find "税额" keyword, then grab the nearest amount.
  // Tax amount is usually small and has a clear "税额" label.

  // Pattern A: "税额" followed by ¥ amount
  var seIdx = text.search(/税\s*额/);
  if (seIdx >= 0) {
    var afterSe = text.substring(seIdx);
    var seYenMatch = afterSe.substring(0, 50).match(/¥\s*(\d[\d,]*\.\d{2})/);
    if (seYenMatch) {
      var seYenVal = parseAmt(seYenMatch[1]);
      if (seYenVal > 0 && (result.amountTax === 0 || seYenVal < result.amountTax)) {
        result.taxAmount = seYenVal;
      }
    }
    if (!result.taxAmount) {
      var seBareMatch = afterSe.substring(0, 50).match(/(\d[\d,]*\.\d{2})/);
      if (seBareMatch) {
        var seBareVal = parseAmt(seBareMatch[1]);
        if (seBareVal > 0 && (result.amountTax === 0 || seBareVal < result.amountTax)) {
          result.taxAmount = seBareVal;
        }
      }
    }
  }

  // Pattern B: If no "税额" keyword, try "税率" + amount pattern
  // Sometimes the tax amount appears near the tax rate in the 合计 row
  if (!result.taxAmount && result.amountTax > 0) {
    var allAmts = [];
    var amtSeen = {};
    var yenRe = /¥\s*(\d[\d,]*\.\d{2})/g;
    var ym;
    while ((ym = yenRe.exec(text)) !== null) {
      var yv = parseAmt(ym[1]);
      if (yv > 0 && !isLikelyYearOrDate(yv, ym[1]) && !amtSeen[yv]) {
        allAmts.push(yv);
        amtSeen[yv] = true;
      }
    }
    var numRe = /(\d[\d,]*\.\d{2})/g;
    var nm;
    while ((nm = numRe.exec(text)) !== null) {
      var nv = parseAmt(nm[1]);
      if (nv > 1 && !isLikelyYearOrDate(nv, nm[1]) && !amtSeen[nv]) {
        allAmts.push(nv);
        amtSeen[nv] = true;
      }
    }

    console.log('[数学验证] 所有金额:', allAmts, '目标含税价:', result.amountTax);

    // Find pair (a, b) where a + b ≈ amountTax
    var bestPair = null;
    for (var pi = 0; pi < allAmts.length; pi++) {
      for (var pj = pi + 1; pj < allAmts.length; pj++) {
        var pairSum = Math.round((allAmts[pi] + allAmts[pj]) * 100) / 100;
        if (Math.abs(pairSum - result.amountTax) < 0.02) {
          var pLarger = Math.max(allAmts[pi], allAmts[pj]);
          var pSmaller = Math.min(allAmts[pi], allAmts[pj]);
          if (pSmaller > 0 && pLarger < result.amountTax) {
            if (!bestPair || pLarger > bestPair.larger) {
              bestPair = { larger: pLarger, smaller: pSmaller };
            }
          }
        }
      }
    }

    if (bestPair) {
      result.amountNoTax = bestPair.larger;
      result.taxAmount = bestPair.smaller;
      console.log('[数学验证] 配对成功: 不含税=' + bestPair.larger + ', 税额=' + bestPair.smaller);
    } else {
      console.log('[数学验证] 未找到配对');
    }
  }

  // ========== Phase 3: Derive amountNoTax from amountTax and taxAmount ==========
  // Core insight: amountTax is usually accurate, and if taxAmount is also found,
  // we can reliably compute amountNoTax = amountTax - taxAmount.
  // Then validate with tax rate check.
  var VALID_TAX_RATES = [0, 0.01, 0.03, 0.05, 0.06, 0.09, 0.13];
  if (result.amountTax > 0 && result.taxAmount > 0 && !result.amountNoTax) {
    var derived = Math.round((result.amountTax - result.taxAmount) * 100) / 100;
    if (derived > 0 && derived > result.taxAmount) {
      var rate = derived > 0 ? Math.round(result.taxAmount / derived * 10000) / 10000 : 0;
      var rateMatch = VALID_TAX_RATES.some(function(r) { return Math.abs(rate - r) < 0.005; });
      if (rateMatch) {
        result.amountNoTax = derived;
        console.log('[反算] 不含税价=' + derived + ', 税率=' + (rate * 100).toFixed(0) + '%');
      } else {
        console.log('[反算] 税率异常: ' + (rate * 100).toFixed(2) + '%, 不在有效税率集合中');
      }
    }
  }

  // ========== Phase 4: Fallback — section-based 合计 parsing ==========
  if (!result.amountNoTax || !result.taxAmount) {
    var hejiStandaloneIdx = -1;
    var hejiRegex = /合\s*计/g;
    var hm;
    while ((hm = hejiRegex.exec(text)) !== null) {
      var before = text.substring(Math.max(0, hm.index - 3), hm.index);
      if (!/价|税/.test(before)) {
        hejiStandaloneIdx = hm.index;
        break;
      }
    }

    if (hejiStandaloneIdx >= 0) {
      var jshjSearchIdx = text.indexOf('价税合计', hejiStandaloneIdx);
      if (jshjSearchIdx < 0) {
        var jshjAfter = text.substring(hejiStandaloneIdx).search(/价\s*税\s*合\s*计/);
        jshjSearchIdx = jshjAfter >= 0 ? hejiStandaloneIdx + jshjAfter : text.length;
      }
      var section = text.substring(hejiStandaloneIdx, jshjSearchIdx);

      var amtRe = /¥\s*(\d[\d,]*\.\d{2})/g;
      var amts = [];
      var am;
      while ((am = amtRe.exec(section)) !== null) {
        var val = parseAmt(am[1]);
        if (val > 0 && !isLikelyYearOrDate(val, am[1])) {
          amts.push(val);
        }
      }

      if (amts.length < 2) {
        var bareRe = /(\d+\.\d{2})/g;
        var bm;
        var fallbackSeen = {};
        amts.forEach(function(v) { fallbackSeen[v] = true; });
        while ((bm = bareRe.exec(section)) !== null) {
          var bval = parseFloat(bm[1]);
          if (bval > 0 && bval < 1000000 && !isLikelyYearOrDate(bval, bm[1]) && !fallbackSeen[bval]) {
            amts.push(bval);
            fallbackSeen[bval] = true;
          }
        }
      }

      if (amts.length >= 2) {
        amts.sort(function(a, b) { return b - a; });
        if (!result.amountNoTax) result.amountNoTax = amts[0];
        if (!result.taxAmount) result.taxAmount = amts[1];
      } else if (amts.length === 1) {
        // Only one amount found in 合计 section — it's likely the 不含税合计
        // Do NOT assign it to both amountNoTax and taxAmount
        if (!result.amountNoTax && result.amountTax > 0 && amts[0] < result.amountTax) {
          result.amountNoTax = amts[0];
        }
      }
    }
  } // end Phase 4 fallback

  // ========== Phase 5: Final cross-derivation with tax rate validation ==========
  if (result.amountTax > 0 && result.amountNoTax > 0 && !result.taxAmount) {
    result.taxAmount = Math.round((result.amountTax - result.amountNoTax) * 100) / 100;
    if (result.taxAmount < 0) result.taxAmount = 0;
  }
  if (result.amountTax > 0 && result.taxAmount > 0 && !result.amountNoTax) {
    var derived2 = Math.round((result.amountTax - result.taxAmount) * 100) / 100;
    if (derived2 > 0 && derived2 > result.taxAmount) {
      result.amountNoTax = derived2;
    }
  }

  // Final validation: tax rate must be in valid set
  if (result.amountNoTax > 0 && result.taxAmount > 0) {
    var finalRate = Math.round(result.taxAmount / result.amountNoTax * 10000) / 10000;
    var rateValid = VALID_TAX_RATES.some(function(r) { return Math.abs(finalRate - r) < 0.005; });
    if (!rateValid && result.amountTax > 0) {
      console.log('[税率校验] 税率=' + (finalRate * 100).toFixed(2) + '% 异常, 尝试从含税价反算');

      // Option A: Assume taxAmount is correct, recalculate amountNoTax
      // (e.g., amountNoTax was mis-assigned from a similar-looking number)
      var recalcNoTax = Math.round((result.amountTax - result.taxAmount) * 100) / 100;
      if (recalcNoTax > 0 && recalcNoTax > result.taxAmount) {
        var recalcRate = Math.round(result.taxAmount / recalcNoTax * 10000) / 10000;
        var recalcValid = VALID_TAX_RATES.some(function(r) { return Math.abs(recalcRate - r) < 0.005; });
        if (recalcValid) {
          console.log('[税率校验] 反算成功(税额正确): 不含税=' + recalcNoTax + ', 税率=' + (recalcRate * 100).toFixed(0) + '%');
          result.amountNoTax = recalcNoTax;
          rateValid = true;
        }
      }

      // Option B: Assume amountNoTax is correct, recalculate taxAmount
      // (e.g., in ride invoices, "税额" column header causes ¥44.19 to be
      //  matched as taxAmount instead of the real ¥1.33)
      if (!rateValid) {
        var recalcTax = Math.round((result.amountTax - result.amountNoTax) * 100) / 100;
        if (recalcTax > 0 && recalcTax < result.amountNoTax) {
          var recalcRate2 = Math.round(recalcTax / result.amountNoTax * 10000) / 10000;
          var recalcValid2 = VALID_TAX_RATES.some(function(r) { return Math.abs(recalcRate2 - r) < 0.005; });
          if (recalcValid2) {
            console.log('[税率校验] 反算成功(不含税正确): 税额=' + recalcTax + ', 税率=' + (recalcRate2 * 100).toFixed(0) + '%');
            result.taxAmount = recalcTax;
            rateValid = true;
          }
        }
      }

      // Option C: Both might be wrong, do full math-based pair search
      // Collect all amounts from text and find best pair summing to amountTax with valid rate
      if (!rateValid) {
        var allAmts = [];
        var amtSeen2 = {};
        var yenRe2 = /¥\s*(\d[\d,]*\.\d{2})/g;
        var ym2;
        while ((ym2 = yenRe2.exec(text)) !== null) {
          var yv2 = parseAmt(ym2[1]);
          if (yv2 > 0 && !isLikelyYearOrDate(yv2, ym2[1]) && !amtSeen2[yv2]) {
            allAmts.push(yv2);
            amtSeen2[yv2] = true;
          }
        }
        var numRe2 = /(\d[\d,]*\.\d{2})/g;
        var nm2;
        while ((nm2 = numRe2.exec(text)) !== null) {
          var nv2 = parseAmt(nm2[1]);
          if (nv2 > 1 && !isLikelyYearOrDate(nv2, nm2[1]) && !amtSeen2[nv2]) {
            allAmts.push(nv2);
            amtSeen2[nv2] = true;
          }
        }
        var bestPair2 = null;
        for (var bpi = 0; bpi < allAmts.length; bpi++) {
          for (var bpj = bpi + 1; bpj < allAmts.length; bpj++) {
            var bpSum = Math.round((allAmts[bpi] + allAmts[bpj]) * 100) / 100;
            if (Math.abs(bpSum - result.amountTax) < 0.02) {
              var bpL = Math.max(allAmts[bpi], allAmts[bpj]);
              var bpS = Math.min(allAmts[bpi], allAmts[bpj]);
              if (bpS > 0 && bpL < result.amountTax) {
                var bpRate = Math.round(bpS / bpL * 10000) / 10000;
                var bpRateOk = VALID_TAX_RATES.some(function(r) { return Math.abs(bpRate - r) < 0.005; });
                if (bpRateOk && (!bestPair2 || bpL > bestPair2.larger)) {
                  bestPair2 = { larger: bpL, smaller: bpS };
                }
              }
            }
          }
        }
        if (bestPair2) {
          console.log('[税率校验] 全量配对成功: 不含税=' + bestPair2.larger + ', 税额=' + bestPair2.smaller);
          result.amountNoTax = bestPair2.larger;
          result.taxAmount = bestPair2.smaller;
        }
      }
    }
  }

  return result;
}

/**
 * Build a flat word array from OCR lines, with normalized positions.
 * Each word: { text, normText, x, y, w, h, cx, cy, nx, ny, lineIdx, wordIdx, confidence, points }
 * cx/cy = center of word; nx/ny = normalized center (0~1).
 */
function _buildWords(ocrLines, imgW, imgH) {
  var words = [];
  if (!ocrLines || !imgW || !imgH) return words;
  for (var li = 0; li < ocrLines.length; li++) {
    var line = ocrLines[li];
    if (!line.words || !line.words.length) continue;
    var lineConf = line.confidence || 0;
    for (var wi = 0; wi < line.words.length; wi++) {
      var w = line.words[wi];
      var cx = w.x + w.w / 2;
      var cy = w.y + w.h / 2;
      words.push({
        text: w.text,
        normText: _normText(w.text),
        x: w.x, y: w.y, w: w.w, h: w.h,
        cx: cx, cy: cy,
        nx: cx / imgW, ny: cy / imgH,
        lineIdx: li, wordIdx: wi,
        confidence: lineConf,
        points: line.points || null
      });
    }
  }
  return words;
}

/**
 * Find words whose normalized text matches a regex.
 * Optional: filter by normalized position ranges.
 */
function _findWords(words, regex, nxMin, nxMax, nyMin, nyMax) {
  return words.filter(function(w) {
    if (!regex.test(w.normText)) return false;
    if (nxMin !== undefined && w.nx < nxMin) return false;
    if (nxMax !== undefined && w.nx > nxMax) return false;
    if (nyMin !== undefined && w.ny < nyMin) return false;
    if (nyMax !== undefined && w.ny > nyMax) return false;
    return true;
  });
}

/**
 * Given a keyword word, find the nearest amount number.
 * Looks right on same line, then on next line below.
 * Returns { value, word } or null.
 */
function _findNearbyAmount(words, kw, opts) {
  opts = opts || {};
  var maxDx = opts.maxDx || 500;  // max horizontal distance (pixels)
  var maxDy = opts.maxDy || 60;   // max vertical distance (pixels) — same/near line
  var maxDyBelow = opts.maxDyBelow || 100; // max vertical distance for next line below
  var requireRight = opts.requireRight !== false; // default true: number must be to the right of keyword

  var candidates = [];
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (w === kw) continue;
    // Skip low-confidence
    if (w.confidence < 0.3) continue;

    var dx = w.cx - kw.cx;
    var dy = w.cy - kw.cy;
    var ady = Math.abs(dy);

    // Same line or near line
    if (ady <= maxDy) {
      if (requireRight && dx < -20) continue; // must be to the right
      if (Math.abs(dx) > maxDx) continue;
    }
    // Next line below
    else if (dy > 0 && dy <= maxDyBelow) {
      // For below: allow slightly left but not too far
      if (dx < -kw.w * 2) continue;
      if (dx > maxDx) continue;
    }
    // Too far
    else {
      continue;
    }

    // Parse amount
    var t = w.normText.replace(/[,，]/g, '');
    var m = t.match(/^-?¥?(\d+\.\d{2})$/);
    if (m) {
      var val = parseFloat(m[1]);
      if (val > 0 && val < 1000000 && !isLikelyYearOrDate(val, t)) {
        // Score: prefer same line, then closest
        var score = ady * 2 + Math.abs(dx) * 0.5;
        candidates.push({ value: val, word: w, score: score });
      }
    }
  }
  if (!candidates.length) return null;
  candidates.sort(function(a, b) { return a.score - b.score; });
  return candidates[0];
}

/**
 * Detect invoice type from word positions.
 * Returns: 'vat' | 'ticket' | 'ride' | 'unknown'
 */
function _detectInvoiceType(words, imgW, imgH) {
  // Build full text from all words (not just top 60%) for more reliable detection
  var allText = words.map(function(w) { return w.normText; }).join('');
  // Check for train ticket keywords — scan ALL words (not just top 60%)
  // because PDF text extraction may have different layout than OCR,
  // and ticket-specific keywords (票价, 车次, 二等座, etc.) can be anywhere.
  // Also check for "铁路电子客票" / "电子客票号" which are definitive ticket markers.
  if (/(?:车\s*次|票\s*价|座\s*位|席\s*别|检\s*票|进\s*站|出\s*站|铁\s*路|乘\s*车|二\s*等|一\s*等|动\s*车|高\s*铁|电\s*子\s*客\s*票\s*号|铁\s*路\s*电\s*子\s*客\s*票)/.test(allText)) {
    return 'ticket';
  }
  // Also check: has "购买方名称:" but no "销售方" — likely a ticket (not VAT)
  if (/购买方\s*名\s*称/.test(allText) && !/销售方/.test(allText)) {
    // Confirm with secondary ticket markers
    if (/(?:车次|票价|座|站|客票)/.test(allText)) {
      return 'ticket';
    }
  }
  // Check for ride-hailing keywords
  if (/(?:出\s*租|打\s*车|网\s*约|滴\s*滴|专\s*车|客\s*运\s*服\s*务)/.test(allText)) {
    return 'ride';
  }
  // Check for VAT invoice structure: "价税合计" or "购买方"+"销售方"
  var hasJiaShui = _findWords(words, /价\s*税\s*合\s*计/).length > 0;
  var hasBuyerSeller = _findWords(words, /购买方/).length > 0 && _findWords(words, /销售方/).length > 0;
  if (hasJiaShui || hasBuyerSeller) return 'vat';

  return 'unknown';
}

/**
 * Extract seller info using coordinates.
 * Strategy: find "销售方信息" or "名称:" in right half → grab name + credit code.
 */
function _extractSeller(words, imgW, imgH) {
  var sellerName = '', sellerCreditCode = '';

  // Right-half words (nx > 0.45) in top 40% (seller region)
  var sellerWords = words.filter(function(w) {
    return w.nx > 0.45 && w.ny > 0.15 && w.ny < 0.45;
  });
  var sellerText = sellerWords.map(function(w) { return w.normText; }).join('');

  // --- Credit code in seller region ---
  // Pattern 1: "纳税人识别号:" or "统一社会信用代码:" followed by code
  var ccRe = /(?:纳税人识别号|统一社会信用代码)[\/:：\s]*([A-Z0-9]{15,20})/gi;
  var ccM;
  while ((ccM = ccRe.exec(sellerText)) !== null) {
    sellerCreditCode = ccM[1].toUpperCase();
  }
  // Pattern 2: Standalone credit code (starts with digit, has letters and digits)
  if (!sellerCreditCode) {
    var sccRe = /\b([0-9][A-Z0-9]{17})\b/g;
    var sccM;
    while ((sccM = sccRe.exec(sellerText)) !== null) {
      if (/\d{6,}/.test(sccM[1]) && /[A-Z]/.test(sccM[1])) {
        sellerCreditCode = sccM[1].toUpperCase();
      }
    }
  }
  // Pattern 3: Coordinate proximity — find "纳税人识别号" label word, then find code nearby
  if (!sellerCreditCode) {
    var ccLabels = _findWords(sellerWords, /纳税人识别号|统一社会信用代码/);
    for (var ci = 0; ci < ccLabels.length && !sellerCreditCode; ci++) {
      var nearby = _findNearbyAmount(words, ccLabels[ci], { maxDx: 400, maxDy: 30, maxDyBelow: 60, requireRight: false });
      // Not an amount — look for code word
      var codeWords = words.filter(function(w) {
        if (w === ccLabels[ci]) return false;
        if (Math.abs(w.cy - ccLabels[ci].cy) > ccLabels[ci].h * 2.5) return false;
        return /^[0-9][A-Z0-9]{14,19}$/.test(w.normText.replace(/[^A-Z0-9]/g, ''));
      });
      if (codeWords.length > 0) {
        // Pick closest
        codeWords.sort(function(a, b) {
          return Math.abs(a.cx - ccLabels[ci].cx) - Math.abs(b.cx - ccLabels[ci].cx);
        });
        sellerCreditCode = codeWords[0].normText.replace(/[^A-Z0-9]/g, '').toUpperCase();
      }
    }
  }

  // --- Seller name ---
  // Pattern 1: "销售方名称:" or "销方名称:" label
  var snLabels = _findWords(sellerWords, /销售方(?:信息)?名\s*称|销\s*方(?:信息)?名\s*称/);
  if (snLabels.length > 0) {
    // Find company name near the label
    var nearbyNames = words.filter(function(w) {
      if (w === snLabels[0]) return false;
      if (Math.abs(w.cy - snLabels[0].cy) > snLabels[0].h * 2) return false;
      if (w.cx < snLabels[0].cx - 10) return false; // must be to the right
      return /[\u4e00-\u9fff]/.test(w.text); // must contain CJK
    });
    if (nearbyNames.length > 0) {
      // Concatenate adjacent name words on same line
      nearbyNames.sort(function(a, b) { return a.x - b.x; });
      var nameParts = [];
      var lastRight = 0;
      for (var ni = 0; ni < nearbyNames.length; ni++) {
        if (nearbyNames[ni].x > lastRight + nearbyNames[ni].h * 2) {
          break; // gap too big, stop
        }
        nameParts.push(nearbyNames[ni].text);
        lastRight = nearbyNames[ni].x + nearbyNames[ni].w;
      }
      if (nameParts.length > 0) {
        sellerName = nameParts.join('');
      }
    }
  }

  // Pattern 2: "名称:" in seller region (right half) — guaranteed seller
  if (!sellerName) {
    var nameLabels = _findWords(sellerWords, /^名\s*称[:：]?$/);
    // Also check for inline "名称:公司名" format
    var inlineNameLabels = _findWords(sellerWords, /^名\s*称[:：]/);
    // Merge both, preferring inline format
    var allNameLabels = inlineNameLabels.length > 0 ? inlineNameLabels : nameLabels;
    if (allNameLabels.length > 0) {
      // Pick rightmost label
      var rightNameLabel = allNameLabels[allNameLabels.length - 1];
      // Check if this is an inline "名称:公司名" word
      var rightNlText = rightNameLabel.text || rightNameLabel.normText;
      var rightNlInlineMatch = rightNlText.match(/^名\s*称[:：]\s*(.+)$/);
      if (rightNlInlineMatch) {
        var _snInline = _cleanName(rightNlInlineMatch[1]);
        if (_snInline) sellerName = _snInline;
      }
      if (!sellerName) {
        var nearbyNames2 = words.filter(function(w) {
          if (w === rightNameLabel) return false;
          if (Math.abs(w.cy - rightNameLabel.cy) > rightNameLabel.h * 2) return false;
          if (w.cx < rightNameLabel.cx - 10) return false;
          return /[\u4e00-\u9fff]/.test(w.text) && w.text.length > 1;
        });
        if (nearbyNames2.length > 0) {
          nearbyNames2.sort(function(a, b) { return a.x - b.x; });
          var nameParts2 = [];
          var lastRight2 = 0;
          for (var ni2 = 0; ni2 < nearbyNames2.length; ni2++) {
            if (nearbyNames2[ni2].x > lastRight2 + nearbyNames2[ni2].h * 2) break;
            nameParts2.push(nearbyNames2[ni2].text);
            lastRight2 = nearbyNames2[ni2].x + nearbyNames2[ni2].w;
          }
          if (nameParts2.length > 0) sellerName = nameParts2.join('');
        }
      }
    }
  }

  // Pattern 3: Company name with suffix in seller region
  if (!sellerName) {
    var csSuffix = '(?:公司|集团|商行|商店|厂|部|院|所|中心|店|馆|站|社|行|会|处|室|局|办|坊|铺|有限合伙|合伙企业|个体工商户|个体户|工作室|经营部|门市部|分公司|事业部|事务所|医院|学校|幼儿园|合作社|企业|商社|贸易行|服务部)';
    var companyRe = new RegExp('([\\u4e00-\\u9fff][\\u4e00-\\u9fff\\w（）()·\\-\\.]+' + csSuffix + ')');
    var companyMatch = sellerText.match(companyRe);
    if (companyMatch) sellerName = companyMatch[1].trim();
  }

  // Pattern 4: Company name with suffix in ALL words (fallback for compact layouts
  // where the seller company name might not be in the strict seller region)
  if (!sellerName && words && words.length > 0) {
    var csSuffix4 = '(?:公司|集团|商行|商店|厂|部|院|所|中心|店|馆|站|社|行|会|处|室|局|办|坊|铺|有限合伙|合伙企业|个体工商户|个体户|工作室|经营部|门市部|分公司|事业部|事务所|医院|学校|幼儿园|合作社|企业|商社|贸易行|服务部)';
    var companyRe4 = new RegExp('^([\\u4e00-\\u9fff][\\u4e00-\\u9fff\\w（）()·\\-\\.]+' + csSuffix4 + ')$');
    // Find company name words in the right half (nx >= 0.5) — seller side
    var sellerCompWords = words.filter(function(w) {
      if (w.nx < 0.4) return false;  // Must be in right portion of page
      return companyRe4.test(w.normText) || companyRe4.test(w.text);
    });
    if (sellerCompWords.length > 0) {
      sellerName = sellerCompWords[0].normText || sellerCompWords[0].text;
    }
  }

  // Cleanup
  if (sellerName) {
    sellerName = sellerName.replace(/^[\s:：]+/, '').replace(/[\s:：]+$/, '');
    sellerName = sellerName.replace(/[，,。.、：:；;！!？?]+$/, '');
    sellerName = sellerName.replace(/\d{6,}$/, '');
    sellerName = sellerName.replace(/\s+[A-Z0-9]{15,20}$/, '');
    sellerName = sellerName.replace(/[A-Z0-9]{15,20}$/, '');  // Strip trailing credit code
    if (/^(?:购买方信息|销售方信息|购买方|销售方|名称|信息|纳税人|地址|电话|开户行|账号)$/.test(sellerName)) {
      sellerName = '';
    }
    // Reject table header terms (单价, 数量, 金额, etc.)
    if (/^(?:单价|数量|金额|税率|税额|项目名称|规格型号|合\s*计|价税合计)$/.test(sellerName)) {
      sellerName = '';
    }
    if (sellerName.length < 2) sellerName = '';
  }

  return { sellerName: sellerName, sellerCreditCode: sellerCreditCode };
}

/**
 * v1.7.0 — Coordinate-first invoice info extraction.
 * Uses PP-OCRv5's accurate bbox to locate fields directly by position,
 * with simple regex fallback for edge cases.
 *
 * Input: { text, lines, imgW, imgH } — OCR result with coordinates
 * Output: { amountTax, amountNoTax, taxAmount, sellerName, sellerCreditCode,
 *           invoiceNo, invoiceDate, buyerName, buyerCreditCode, _ocrText, isTicket }
 */
function extractByCoordinates(ocrResult) {
  var fullText = ocrResult.text || '';
  var imgW = ocrResult.imgW || 0;
  var imgH = ocrResult.imgH || 0;
  var words = _buildWords(ocrResult.lines, imgW, imgH);

  // Normalize full text for regex fallback
  var normText = fullText;
  for (var _nrm = 0; _nrm < 5; _nrm++) {
    var _nrmPrev = '';
    while (_nrmPrev !== normText) { _nrmPrev = normText; normText = normText.replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])/g, '$1$2'); }
  }
  normText = normText.replace(/([\u4e00-\u9fff])\n([\u4e00-\u9fff])/g, '$1$2');
  normText = _normText(normText);
  // Collapse digit spaces
  for (var _ni = 0; _ni < 3; _ni++) {
    var _prev = '';
    while (_prev !== normText) { _prev = normText; normText = normText.replace(/(\d)\s+(\d)/g, '$1$2'); }
  }
  normText = normText.replace(/(\d)\s+\./g, '$1.');
  normText = normText.replace(/¥\s+(\d)/g, '¥$1');

  // --- Text-based extraction (PRIMARY for structured fields) ---
  // OCR text is well-formatted with clear key-value pairs — leverage this first
  // Pass words for coordinate-based fallback (handles PDFs with label/value in separate blocks)
  var textInfo = _extractByText(fullText, words);
  var invoiceNo = textInfo.invoiceNo;
  var invoiceDate = textInfo.invoiceDate;
  var buyerName = textInfo.buyerName;
  var buyerCreditCode = textInfo.buyerCreditCode;

  // Detect invoice type
  var invType = _detectInvoiceType(words, imgW, imgH);
  var isTicket = invType === 'ticket';
  var sellerName = textInfo.sellerName || '';
  var sellerCreditCode = textInfo.sellerCreditCode || '';
  var amountTax = 0, amountNoTax = 0, taxAmount = 0;

  console.log('[坐标提取] 发票类型:', invType, '字数:', fullText.length, '词数:', words.length,
    '文本提取:', { invoiceNo: invoiceNo || '(空)', invoiceDate: invoiceDate || '(空)',
    buyerName: buyerName || '(空)', sellerName: sellerName || '(空)' });

  // === Ticket extraction ===
  if (isTicket) {
    // Tickets don't have a traditional seller — override with ticket type label
    sellerName = getTicketTypeLabel(fullText);

    // Method 0: Text-based ticket price extraction (most reliable for PDF text layer)
    // Pattern: "票价:94.00" or "票价：¥94.00" — label and value may be on same line
    var normFullText = _normTextForExtract(fullText);
    var ticketPriceTextMatch = normFullText.match(/票\s*价[：:]*\s*¥?\s*(\d+\.\d{2})/);
    if (ticketPriceTextMatch) {
      var tpv = parseFloat(ticketPriceTextMatch[1]);
      if (tpv >= 1 && tpv <= 50000) {
        amountTax = tpv;
        console.log('[车票提取] 文本Pattern匹配票价:', tpv);
      }
    }

    // Method 1: "票价:" keyword → nearby amount or inline amount
    if (!amountTax) {
      var priceLabels = _findWords(words, /票\s*价/);
      for (var pi = 0; pi < priceLabels.length && !amountTax; pi++) {
        // Try inline amount first: "票价:￥41.00" or "票价：¥41.00" (keyword+amount in one word)
        var inlineMatch = priceLabels[pi].text.match(/票\s*价[：:]*\s*[￥¥]\s*(\d+\.\d{2})/);
        if (inlineMatch) {
          var inlineVal = parseFloat(inlineMatch[1]);
          if (inlineVal >= 1 && inlineVal <= 50000) {
            amountTax = inlineVal;
          }
        }
        // Fallback: nearby separate amount word — use larger search radius for PDF text
        if (!amountTax) {
          var amt = _findNearbyAmount(words, priceLabels[pi], { maxDx: 500, maxDy: 50, maxDyBelow: 120 });
          if (amt && amt.value >= 1 && amt.value <= 50000) {
            amountTax = amt.value;
          }
        }
      }
    }
    // "全价"/"优惠价"/"学生价"
    if (!amountTax) {
      var discountLabels = _findWords(words, /全\s*价|优\s*惠\s*价|学\s*生\s*价/);
      for (var di = 0; di < discountLabels.length && !amountTax; di++) {
        var amt2 = _findNearbyAmount(words, discountLabels[di], { maxDx: 500, maxDy: 50, maxDyBelow: 120 });
        if (amt2 && amt2.value >= 1 && amt2.value <= 50000) {
          amountTax = amt2.value;
        }
      }
    }
    // Method 2: Positional — amount near ticket price area
    // PDF text layout may differ from OCR — expand search area
    if (!amountTax) {
      var ticketAmounts = words.filter(function(w) {
        if (w.confidence < 0.3) return false;
        // Expand vertical range for PDF text: ny 0.2~0.8 (was 0.3~0.65)
        if (w.ny < 0.2 || w.ny > 0.8) return false;
        var t = w.normText.replace(/[,，]/g, '');
        var m = t.match(/^-?¥?(\d+\.\d{2})$/);
        if (!m) return false;
        var v = parseFloat(m[1]);
        return v >= 5 && v <= 50000 && !isLikelyYearOrDate(v, t);
      });
      if (ticketAmounts.length > 0) {
        // Take the largest
        ticketAmounts.sort(function(a, b) {
          var va = parseFloat(a.normText.replace(/[,，¥]/g, ''));
          var vb = parseFloat(b.normText.replace(/[,，¥]/g, ''));
          return vb - va;
        });
        amountTax = parseFloat(ticketAmounts[0].normText.replace(/[,，¥]/g, ''));
      }
      // Fallback: inline amount within keyword+value words (e.g., "票价:￥41.00")
      if (!amountTax) {
        for (var tai = 0; tai < words.length; tai++) {
          var tw = words[tai];
          var inlineTicketMatch = tw.text.match(/(?:票价|全价|优惠价|学生价)[：:]*\s*[￥¥]\s*(\d+\.\d{2})/);
          if (inlineTicketMatch) {
            var tv = parseFloat(inlineTicketMatch[1]);
            if (tv >= 1 && tv <= 50000) {
              amountTax = tv;
              break;
            }
          }
        }
      }
    }
    // Method 3: Last resort — find standalone price amount in full text
    // For tickets, the price is usually a simple number like "94.00"
    if (!amountTax) {
      var standalonePriceMatch = normFullText.match(/(\d+\.\d{2})/g);
      if (standalonePriceMatch) {
        // Filter to reasonable ticket prices (5~50000) and pick largest
        var priceCandidates = standalonePriceMatch
          .map(function(s) { return parseFloat(s); })
          .filter(function(v) { return v >= 5 && v <= 50000 && !isLikelyYearOrDate(v, v.toString()); });
        if (priceCandidates.length > 0) {
          priceCandidates.sort(function(a, b) { return b - a; });
          amountTax = priceCandidates[0];
          console.log('[车票提取] 最后兜底金额:', amountTax);
        }
      }
    }
    if (amountTax > 0) amountNoTax = amountTax;

    console.log('[坐标提取] 车票金额:', amountTax);
    // Fix: For tickets, the sole credit code belongs to buyer (not seller).
    // The coordinate-based assignment in _extractByText may assign it to seller
    // because ticket layout differs from VAT invoice.
    if (sellerCreditCode && !buyerCreditCode) {
      buyerCreditCode = sellerCreditCode;
      sellerCreditCode = '';
    }
    return { amountTax: amountTax, amountNoTax: amountNoTax, taxAmount: 0,
             sellerName: sellerName, sellerCreditCode: sellerCreditCode,
             invoiceNo: invoiceNo, invoiceDate: invoiceDate,
             buyerName: buyerName, buyerCreditCode: buyerCreditCode,
             _ocrText: fullText, isTicket: true };
  }

  // === VAT / Ride invoice extraction ===

  // --- Seller name quality check ---
  // If sellerName from text extraction looks like a table header or non-company text,
  // clear it so that coordinate-based fallback can find the real company name.
  if (sellerName) {
    var _badSellerPatterns = /^(?:单价|数量|金额|税率|税额|项目名称|规格型号|合\s*计|大\s*写|小\s*写|备\s*注|价税合计|出行人|开票人|收款人|复核人)/;
    if (_badSellerPatterns.test(sellerName) && sellerName.length <= 8) {
      console.log('[校验] sellerName疑似表头文本，已清除:', sellerName);
      sellerName = '';
    }
    // Also check: no company suffix and very short (likely a label, not a name)
    var _companySuffixRe = /(?:公司|集团|商行|商店|厂|部|院|所|中心|店|馆|站|社|行|会|处|室|局|办|坊|铺|企业|事务所|合作社|有限合伙|合伙企业)$/;
    if (sellerName.length <= 4 && !_companySuffixRe.test(sellerName) && !/[\u4e00-\u9fff]{2,}/.test(sellerName.replace(/[A-Z0-9]/g, ''))) {
      console.log('[校验] sellerName过短且无公司后缀，已清除:', sellerName);
      sellerName = '';
    }
    // Also check: sellerName is a fragment of "统一社会信用代码" label
    if (/^统一社会/.test(sellerName)) {
      console.log('[校验] sellerName疑似信用代码标签片段，已清除:', sellerName);
      sellerName = '';
    }
  }

  // --- Seller info (coordinate-based FALLBACK — text-based is primary) ---
  if (!sellerName || !sellerCreditCode) {
    var sellerInfo = _extractSeller(words, imgW, imgH);
    if (!sellerName) sellerName = sellerInfo.sellerName;
    if (!sellerCreditCode) sellerCreditCode = sellerInfo.sellerCreditCode;
  }

  // --- Text-based amount extraction (PRIMARY for VAT invoices) ---
  // OCR text has clear structure: "合计...¥金额...¥税额...价税合计...¥含税价"
  // This is more reliable than coordinate-based matching for the "合计" row
  // which has TWO amounts that coordinate methods can't easily distinguish.
  var textAmounts = _extractAmountsByText(fullText);
  var _amountTaxFromText = false;
  if (textAmounts.amountTax > 0) { amountTax = textAmounts.amountTax; _amountTaxFromText = true; }
  if (textAmounts.amountNoTax > 0) amountNoTax = textAmounts.amountNoTax;
  var _taxAmountResolved = false;
  if (textAmounts.taxAmount > 0) {
    taxAmount = textAmounts.taxAmount;
    _taxAmountResolved = true;
  } else if (textAmounts.amountNoTax > 0 && textAmounts.amountTax > 0 &&
             Math.abs(textAmounts.amountTax - textAmounts.amountNoTax) < 0.02) {
    taxAmount = 0;
    _taxAmountResolved = true;
  }
  console.log('[文本提取] 金额:', textAmounts);

  // --- Amount extraction (coordinate-based FALLBACK) ---
  // Only runs when text-based extraction didn't find the amounts.

  // Step 1: 价税合计（含税总价）— coordinate-based FALLBACK
  // Location: ny ≈ 0.20~0.30 (near bottom of invoice)
  // Keywords: "价税合计", "（小写）", or just ¥ at that position
  if (!amountTax) {
  var jshjLabels = _findWords(words, /价\s*税\s*合\s*计/);
  if (jshjLabels.length > 0) {
    // Use the LOWEST "价税合计" label (bottom of invoice = 含税价, not 不含税)
    jshjLabels.sort(function(a, b) { return b.ny - a.ny; });
    var amt3 = _findNearbyAmount(words, jshjLabels[0], { maxDx: 600, maxDy: 40, maxDyBelow: 120 });
    if (amt3) {
      amountTax = amt3.value;
      // Validate: if the matched amount is on the SAME line as another amount,
      // it might be the 不含税价 row (¥amount + ¥tax on same line).
      // The 含税价 is always BELOW that row. Find amounts with LARGER y (lower on page).
      var sameLineAmts = words.filter(function(w) {
        if (w.confidence < 0.3) return false;
        if (w === amt3.word) return false;
        var dy = Math.abs(w.cy - amt3.word.cy);
        if (dy > amt3.word.h * 1.5) return false; // same line
        var t = w.normText.replace(/[,，]/g, '');
        var m = t.match(/^-?¥?(\d+\.\d{2})$/);
        if (!m) return false;
        var v = parseFloat(m[1]);
        return v > 0 && v < 1000000 && !isLikelyYearOrDate(v, t);
      });
      if (sameLineAmts.length > 0) {
        // There are other amounts on the same line → this is the 不含税+税额 row
        // The 含税价 must be BELOW. Look for amounts with larger y below the keyword.
        var belowAmts = words.filter(function(w) {
          if (w.confidence < 0.3) return false;
          // Must be below the keyword (not just below the matched amount)
          var dy = w.cy - jshjLabels[0].cy;
          if (dy <= 0) return false; // must be strictly below
          if (dy > jshjLabels[0].h * 5) return false; // not too far below
          // Must NOT be on the same line as the current match (不含税+税额 row)
          if (Math.abs(w.cy - amt3.word.cy) <= amt3.word.h * 1.5) return false;
          var t = w.normText.replace(/[,，]/g, '');
          var m = t.match(/^-?¥?(\d+\.\d{2})$/);
          if (!m) return false;
          var v = parseFloat(m[1]);
          return v > 0 && v < 1000000 && !isLikelyYearOrDate(v, t);
        });
        if (belowAmts.length > 0) {
          // Take the amount with the largest y (lowest on page) = 含税价
          belowAmts.sort(function(a, b) { return b.cy - a.cy; });
          var belowVal = parseFloat(belowAmts[0].normText.replace(/[,，¥]/g, ''));
          // Sanity: 含税价 > 不含税价
          if (belowVal > amountTax) {
            amountTax = belowVal;
            console.log('[坐标提取] 价税合计同行有多个金额，已选择下方含税价:', amountTax);
          }
        }
      }
    }
  }
  } // end if (!amountTax) for Step 1

  // Step 1.5: "（小写）" keyword — very specific to 含税价
  // Key insight: 含税价 is BELOW the 不含税+税额 row, to the right of "（小写）".
  // We must prefer amounts that are BELOW "小写", not on the same line as it.
  if (!amountTax) {
    var xiaoxieLabels = _findWords(words, /小\s*写/);
    if (xiaoxieLabels.length > 0) {
      // Strategy: look for amounts strictly BELOW "小写" first
      // The 含税价 is on a line below "（小写）", not on the same line
      var xxLabel = xiaoxieLabels[0];
      var belowXx = words.filter(function(w) {
        if (w.confidence < 0.3) return false;
        var dy = w.cy - xxLabel.cy;
        // Must be below (dy > 0) and within reasonable distance
        if (dy <= xxLabel.h * 0.5 || dy > xxLabel.h * 5) return false;
        var dx = w.cx - xxLabel.cx;
        if (dx < -xxLabel.w * 2 || dx > 400) return false;
        var t = w.normText.replace(/[,，]/g, '');
        var m = t.match(/^-?¥?(\d+\.\d{2})$/);
        if (!m) return false;
        var v = parseFloat(m[1]);
        return v > 0 && v < 1000000 && !isLikelyYearOrDate(v, t);
      });
      if (belowXx.length > 0) {
        // Pick the one closest vertically (smallest dy), then horizontally
        belowXx.sort(function(a, b) {
          var da = a.cy - xxLabel.cy;
          var db = b.cy - xxLabel.cy;
          if (da !== db) return da - db;
          return Math.abs(a.cx - xxLabel.cx) - Math.abs(b.cx - xxLabel.cx);
        });
        amountTax = parseFloat(belowXx[0].normText.replace(/[,，¥]/g, ''));
        console.log('[坐标提取] 小写→下方含税价:', amountTax);
      }
      // Fallback: if no amount found below, try right side on same line
      if (!amountTax) {
        var amt4 = _findNearbyAmount(words, xxLabel, { maxDx: 400, maxDy: 30, maxDyBelow: 60 });
        if (amt4) {
          // Same validation: check if this amount shares a line with another amount
          var sameLine4 = words.filter(function(w) {
            if (w.confidence < 0.3) return false;
            if (w === amt4.word) return false;
            if (Math.abs(w.cy - amt4.word.cy) > amt4.word.h * 1.5) return false;
            var t = w.normText.replace(/[,，]/g, '');
            var m = t.match(/^-?¥?(\d+\.\d{2})$/);
            if (!m) return false;
            var v = parseFloat(m[1]);
            return v > 0 && v < 1000000 && !isLikelyYearOrDate(v, t);
          });
          if (sameLine4.length > 0) {
            // Multiple amounts on same line = 不含税+税额 row, skip this match
            console.log('[坐标提取] 小写→同行多金额(不含税行), 跳过:', amt4.value);
          } else {
            amountTax = amt4.value;
          }
        }
      }
    }
  }

  // Step 2: 不含税合计 + 税额合计 — "合计" row
  // The "合计" row typically has TWO amounts:
  //   - 不含税合计 (larger value) and 税额合计 (smaller value)
  // Since 税额 = 不含税 × 税率 and 税率 < 100%, the 不含税 is always larger.
  // We collect ALL amounts near "合计" and assign by value.
  // Must distinguish from "价税合计" — standalone "合计" without "价" to its left.
  if (!amountNoTax || !_taxAmountResolved) {
    var hejiLabels = _findWords(words, /合\s*计/);
    // Filter: standalone "合计" (no "价" or "税" nearby to the left)
    var standaloneHeji = hejiLabels.filter(function(hw) {
      if (/税/.test(hw.normText)) return false;
      var hasJiaLeft = words.some(function(w) {
        if (w === hw) return false;
        if (!/价/.test(w.normText)) return false;
        var dx = hw.cx - w.cx;
        var dy = Math.abs(w.cy - hw.cy);
        return dx >= -20 && dx < 300 && dy < 50;
      });
      return !hasJiaLeft;
    });

    for (var hi = 0; hi < standaloneHeji.length; hi++) {
      var hejiWord = standaloneHeji[hi];
      // Collect ALL amounts near "合计" (same line or slightly below)
      var rowAmts = [];
      for (var ri = 0; ri < words.length; ri++) {
        var w = words[ri];
        if (w.confidence < 0.3 || w === hejiWord) continue;
        var dy = Math.abs(w.cy - hejiWord.cy);
        if (dy > hejiWord.h * 4) continue;
        var dx = w.cx - hejiWord.cx;
        if (dx < -hejiWord.w) continue;
        var t = w.normText.replace(/[,，]/g, '');
        var m = t.match(/^-?¥?(\d+\.\d{2})$/);
        if (!m) continue;
        var v = parseFloat(m[1]);
        if (v > 0 && v < 1000000 && !isLikelyYearOrDate(v, t)) {
          rowAmts.push(v);
        }
      }

      if (rowAmts.length >= 2) {
        rowAmts.sort(function(a, b) { return b - a; });
        // 当amountTax已由文本提取确定时，不含税价不应超过含税价
        if (!amountNoTax && !(amountTax > 0 && rowAmts[0] > amountTax)) amountNoTax = rowAmts[0];
        if (!taxAmount && !(amountTax > 0 && rowAmts[rowAmts.length - 1] > amountTax)) taxAmount = rowAmts[rowAmts.length - 1];
        break;
      } else if (rowAmts.length === 1) {
        if (amountTax > 0 && rowAmts[0] > amountTax) continue;
        if (amountTax > 0 && Math.abs(rowAmts[0] - amountTax) < 0.01) continue;
        // Single amount near "合计" — could be either 不含税 or 税额
        // If we have amountTax, check if this is the 税额 (smaller)
        if (amountTax > 0 && !_taxAmountResolved && rowAmts[0] < amountTax * 0.3) {
          // Likely the 税额 (tax is usually < 30% of 含税价)
          if (!taxAmount) taxAmount = rowAmts[0];
        } else if (!amountNoTax) {
          amountNoTax = rowAmts[0];
        }
        break;
      }
    }
  }

  // Step 2.5: "金额" keyword in amount region (secondary for 不含税价)
  if (!amountNoTax) {
    // "金额" in the lower half (amount region)
    var amtLabels = _findWords(words, /金\s*额/, undefined, undefined, 0.45, 0.70);
    // Exclude "税额" and "合计金额"
    var validAmtLabels = amtLabels.filter(function(w) {
      return !/税/.test(w.normText) && !/合/.test(w.normText);
    });
    for (var ai = 0; ai < validAmtLabels.length && !amountNoTax; ai++) {
      var amt6 = _findNearbyAmount(words, validAmtLabels[ai], { maxDx: 400, maxDy: 30, maxDyBelow: 80 });
      if (amt6) {
        if (amountTax > 0 && amt6.value > amountTax) continue;
        if (amountTax > 0 && Math.abs(amt6.value - amountTax) < 0.01) continue;
        amountNoTax = amt6.value;
      }
    }
  }

  // Step 3: 税额 — "税额" keyword in amount region (coordinate-based FALLBACK)
  if (!_taxAmountResolved) {
  var seLabels = _findWords(words, /税\s*额/, undefined, undefined, 0.40, 0.75);
  if (seLabels.length > 0) {
    // Use the bottommost "税额" (in the 合计 row)
    seLabels.sort(function(a, b) { return b.ny - a.ny; });
    var amt7 = _findNearbyAmount(words, seLabels[0], { maxDx: 300, maxDy: 30, maxDyBelow: 60 });
    if (amt7) taxAmount = amt7.value;
  }
  } // end if (!taxAmount)

  // --- Cross-derivation with tax rate validation ---
  var VALID_TAX_RATES_COORD = [0, 0.01, 0.03, 0.05, 0.06, 0.09, 0.13];
  if (amountTax > 0 && amountNoTax > 0 && !_taxAmountResolved) {
    taxAmount = Math.round((amountTax - amountNoTax) * 100) / 100;
    if (taxAmount > 0) _taxAmountResolved = true;
  }
  if (amountTax > 0 && _taxAmountResolved && taxAmount > 0 && !amountNoTax && taxAmount < amountTax) {
    var derivedNoTax = Math.round((amountTax - taxAmount) * 100) / 100;
    if (derivedNoTax > taxAmount) {
      var derivedRate = Math.round(taxAmount / derivedNoTax * 10000) / 10000;
      if (VALID_TAX_RATES_COORD.some(function(r) { return Math.abs(derivedRate - r) < 0.005; })) {
        amountNoTax = derivedNoTax;
      }
    }
  }
  if (!amountTax && amountNoTax > 0 && _taxAmountResolved && taxAmount > 0) {
    amountTax = Math.round((amountNoTax + taxAmount) * 100) / 100;
  }

  // --- Chinese numeral fallback (大写金额) ---
  // When the Arabic amount is completely missing/garbled in PDF text layer,
  // look for the Chinese numeral in the word list. This is common for invoices
  // that use special fonts for digits but standard fonts for Chinese characters.
  if (!amountTax) {
    var _daxieWords = words.filter(function(w) {
      // Chinese numeral must contain financial digit(s) + a unit (圆/元/角/分)
      // Digits may be separated by unit characters (e.g., "捌仟捌佰壹拾玖圆陆角整")
      return /[零壹贰叁肆伍陆柒捌玖一二三四五六七八九]/.test(w.text) && /[圆元角分]/.test(w.text);
    });
    if (_daxieWords.length > 0) {
      // Use the word closest to "大写" or "价税合计" keyword
      var _daxieBest = null;
      var _daxieBestDist = Infinity;
      // Find "大写" label
      var _daxieLabels = _findWords(words, /大\s*写/);
      // Also check for "价税合计" as anchor
      var _jshjLabels = _findWords(words, /价\s*税\s*合\s*计/);
      var _anchors = _daxieLabels.concat(_jshjLabels);

      for (var _di = 0; _di < _daxieWords.length; _di++) {
        var _dw = _daxieWords[_di];
        var _dval = parseChineseNumeral(_dw.text);
        if (_dval <= 10) continue; // skip trivial amounts
        if (!_anchors.length) {
          // No anchor — use the largest Chinese numeral amount
          _daxieBest = { word: _dw, value: _dval };
          break;
        }
        // Find distance to nearest anchor
        for (var _ai = 0; _ai < _anchors.length; _ai++) {
          var _adx = Math.abs(_dw.cx - _anchors[_ai].cx);
          var _ady = Math.abs(_dw.cy - _anchors[_ai].cy);
          var _dist = _adx + _ady;
          if (_dist < _daxieBestDist) {
            _daxieBestDist = _dist;
            _daxieBest = { word: _dw, value: _dval };
          }
        }
      }
      if (_daxieBest && _daxieBest.value > 0) {
        amountTax = _daxieBest.value;
        console.log('[坐标提取] 大写金额兜底含税价:', _daxieBest.word.text, '→', amountTax);
      }
    }
  }

  // --- Positional fallback: largest ¥ in amount region ---
  if (!amountTax) {
    var regionAmounts = words.filter(function(w) {
      if (w.confidence < 0.3) return false;
      if (w.ny < 0.35 || w.ny > 0.85) return false;
      var t = w.normText.replace(/[,，]/g, '');
      var m = t.match(/^-?¥?(\d+\.\d{2})$/);
      if (!m) return false;
      var v = parseFloat(m[1]);
      return v > 0 && v < 1000000 && !isLikelyYearOrDate(v, t);
    });
    if (regionAmounts.length > 0) {
      regionAmounts.sort(function(a, b) {
        var va = parseFloat(a.normText.replace(/[,，¥]/g, ''));
        var vb = parseFloat(b.normText.replace(/[,，¥]/g, ''));
        return vb - va;
      });
      var largestVal = parseFloat(regionAmounts[0].normText.replace(/[,，¥]/g, ''));
      if (amountNoTax > 0 && largestVal < amountNoTax) {
        // skip
      } else {
        amountTax = largestVal;
      }
    }
  }

  // --- Simple regex fallback (only when coordinates couldn't resolve) ---
  if (!amountTax) {
    amountTax = _regexFindLast('价\\s*税\\s*合\\s*计', normText);
  }
  if (!amountNoTax && amountTax > 0) {
    var workText = normText.replace(/价\s*税\s*合\s*计[\s\S]*?\d+\.\d{2}/g, '');
    var hejiNum = _regexFindFirst('合\\s*计', workText);
    if (hejiNum > 0 && Math.abs(hejiNum - amountTax) > 0.01) amountNoTax = hejiNum;
  }
  if (!amountNoTax) {
    var amtNum = _regexFindFirst('金\\s*额', normText);
    if (amtNum > 0 && (amountTax === 0 || Math.abs(amtNum - amountTax) > 0.01)) amountNoTax = amtNum;
  }
  if (!_taxAmountResolved && amountTax > 0) {
    var _taxByRegex = _regexFindFirst('税\\s*额', normText);
    if (_taxByRegex > 0) { taxAmount = _taxByRegex; _taxAmountResolved = true; }
  }

  // --- Cross-derivation after fallback ---
  if (amountTax > 0 && amountNoTax > 0 && !_taxAmountResolved) {
    taxAmount = Math.round((amountTax - amountNoTax) * 100) / 100;
    if (taxAmount > 0) _taxAmountResolved = true;
  }
  if (amountTax > 0 && _taxAmountResolved && taxAmount > 0 && !amountNoTax && taxAmount < amountTax) {
    var derivedNoTax2 = Math.round((amountTax - taxAmount) * 100) / 100;
    if (derivedNoTax2 > taxAmount) {
      var derivedRate2 = Math.round(taxAmount / derivedNoTax2 * 10000) / 10000;
      if (VALID_TAX_RATES_COORD.some(function(r) { return Math.abs(derivedRate2 - r) < 0.005; })) {
        amountNoTax = derivedNoTax2;
      }
    }
  }
  if (!amountTax && amountNoTax > 0 && _taxAmountResolved && taxAmount > 0) {
    amountTax = Math.round((amountNoTax + taxAmount) * 100) / 100;
  }

  // --- Invariants ---
  // 交换前提：amountTax必须不是由文本提取确定的(文本提取的amountTax更可靠)
  // 且坐标amountNoTax超过amountTax时，更可能是坐标提取错误，不应交换
  if (amountTax > 0 && amountNoTax > 0 && amountTax < amountNoTax && !_amountTaxFromText) {
    var _tmp = amountTax; amountTax = amountNoTax; amountNoTax = _tmp;
  }
  // 当文本提取的amountTax可靠时，丢弃超过它的坐标amountNoTax
  if (_amountTaxFromText && amountNoTax > amountTax) {
    console.log('[不变量] 坐标amountNoTax(' + amountNoTax + ')超过文本amountTax(' + amountTax + ')，已清除');
    amountNoTax = 0;
  }
  if (amountNoTax > 0 && amountTax > 0 && Math.abs(amountNoTax - amountTax) < 0.01 && taxAmount > 0) {
    taxAmount = 0;
  }
  if (amountNoTax > 0 && !amountTax) {
    if (taxAmount > 0 && taxAmount < amountNoTax) {
      amountTax = Math.round((amountNoTax + taxAmount) * 100) / 100;
    } else {
      amountTax = amountNoTax;
    }
  }

  // --- Credit code fallback (from full text if both text-based and coordinates missed) ---
  // 18位纯数字也可能是统一社会信用代码(GB 32100-2015)，不再强制要求含字母
  if (!sellerCreditCode || !buyerCreditCode) {
    // Try coordinate-based first: find code words by position
    if (words && words.length > 0) {
      var ccWordRe2 = /^[0-9][A-Z0-9]{14,19}$/i;
      var coordFallback = { buyer: '', seller: '' };
      words.forEach(function(w) {
        var cleaned = w.normText.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        // 18位纯数字也可能是统一社会信用代码(GB 32100-2015)，不再强制要求含字母
        // 但排除15-17位和19-20位纯数字(更可能是发票号码)
        var _isPureDigit = /^\d+$/.test(cleaned);
        if (ccWordRe2.test(cleaned) && (!_isPureDigit || cleaned.length === 18)) {
          if (w.nx < 0.5 && !coordFallback.buyer) coordFallback.buyer = cleaned;
          else if (w.nx >= 0.5 && !coordFallback.seller) coordFallback.seller = cleaned;
        }
      });
      if (!buyerCreditCode && coordFallback.buyer) buyerCreditCode = coordFallback.buyer;
      if (!sellerCreditCode && coordFallback.seller) sellerCreditCode = coordFallback.seller;
    }

    // Method 1.5: Label-tracing strategy — when credit code is split into single-char words
    // Some PDFs (dzcp format) split "91320200796148368W" into individual chars: '9','1','3',...
    // The label word contains "统一社会信用代码/纳税人识别号:9" (first digit fused with label).
    // Strategy: find label words, extract the fused first digit, then collect adjacent single-char
    // words to reconstruct the full 18-char credit code.
    if ((!buyerCreditCode || !sellerCreditCode) && words && words.length > 0) {
      var ccLabelWords = words.filter(function(w) {
        return /统一社会(?:信用代码)?/.test(w.text) || /统一社会(?:信用代码)?/.test(w.normText);
      });
      var tracedCodes = [];
      for (var _tci = 0; _tci < ccLabelWords.length; _tci++) {
        var _tcLabel = ccLabelWords[_tci];
        // Extract fused digits from the label itself (e.g., ":9" → "9")
        var _tcLabelText = _tcLabel.text || _tcLabel.normText;
        var _tcLabelDigits = _tcLabelText.replace(/[^A-Za-z0-9]/g, '');
        var _tcCode = _tcLabelDigits; // start with any digits/letters fused into the label
        // Collect single-char words on the same line and to the right of the label
        var _tcSameLineWords = words.filter(function(w) {
          if (w === _tcLabel) return false;
          // Must be roughly on the same line (within 2x line height)
          if (Math.abs(w.cy - _tcLabel.cy) > _tcLabel.h * 2.5) return false;
          // Must be to the right of or very close to the label
          if (w.x < _tcLabel.x + _tcLabel.w - _tcLabel.h) return false;
          return true;
        });
        // Sort by x position (left to right) and collect single-char alphanumeric words
        _tcSameLineWords.sort(function(a, b) { return a.x - b.x; });
        for (var _tswi = 0; _tswi < _tcSameLineWords.length; _tswi++) {
          var _tsw = _tcSameLineWords[_tswi];
          var _tswText = _tsw.normText || _tsw.text;
          // Only accept single alphanumeric characters or short digit/letter sequences
          if (/^[A-Za-z0-9]$/.test(_tswText)) {
            _tcCode += _tswText;
          } else if (/^[A-Za-z0-9]{2,4}$/.test(_tswText) && _tcCode.length + _tswText.length <= 18) {
            // Short sequences that could be part of the code
            _tcCode += _tswText;
          }
          if (_tcCode.length >= 18) break;
        }
        // Validate: must be exactly 18 chars starting with a digit
        _tcCode = _tcCode.toUpperCase();
        if (_tcCode.length === 18 && /^[0-9]/.test(_tcCode)) {
          var _tcIsLeft = _tcLabel.nx < 0.5;
          tracedCodes.push({ code: _tcCode, isLeft: _tcIsLeft, nx: _tcLabel.nx });
        }
      }
      // Assign traced codes by position
      for (var _tai = 0; _tai < tracedCodes.length; _tai++) {
        if (tracedCodes[_tai].isLeft && !buyerCreditCode) {
          buyerCreditCode = tracedCodes[_tai].code;
        } else if (!tracedCodes[_tai].isLeft && !sellerCreditCode) {
          sellerCreditCode = tracedCodes[_tai].code;
        }
      }
      // Fallback: if position-based assignment didn't work, use order
      if (tracedCodes.length >= 2 && (!buyerCreditCode || !sellerCreditCode)) {
        if (!buyerCreditCode) buyerCreditCode = tracedCodes[0].code;
        if (!sellerCreditCode) sellerCreditCode = tracedCodes[1].code;
      }
      if (tracedCodes.length === 1 && !sellerCreditCode && !buyerCreditCode) {
        // Single code → likely seller
        sellerCreditCode = tracedCodes[0].code;
      }
      if (tracedCodes.length > 0) {
        console.log('[信用代码追踪] 从标签追踪拼接:', tracedCodes.map(function(c) { return c.code + (c.isLeft ? '(买)' : '(售)'); }));
      }
    }
    // Then try text regex
    if (!sellerCreditCode || !buyerCreditCode) {
      var ccRe = /(?:纳税人识别号|统一社会信用代码)[^A-Z0-9]{0,30}([A-Z0-9]{15,20})/gi;
      var ccM, allCc = [];
      while ((ccM = ccRe.exec(normText)) !== null) {
        var cc = ccM[1].toUpperCase();
        // Guard: 18位纯数字也可能是信用代码；非18位纯数字则排除
        var _ccPureDigit = /^\d+$/.test(cc);
        if (_ccPureDigit && cc.length !== 18) continue;
        if (allCc.indexOf(cc) < 0) allCc.push(cc);
      }
      if (allCc.length >= 2) {
        if (!buyerCreditCode) buyerCreditCode = allCc[0];
        if (!sellerCreditCode) sellerCreditCode = allCc[1];
      } else if (allCc.length === 1) {
        if (!sellerCreditCode) sellerCreditCode = allCc[0];
      }
    }
  }
  if (!sellerCreditCode) {
    var sccRe = /\b([0-9][A-Z0-9]{17})\b/g;
    var sccM, lastScc = '';
    while ((sccM = sccRe.exec(normText)) !== null) {
      // Guard: 18位纯数字也可能是信用代码(GB 32100-2015)，不再强制要求含字母
      if (/\d{6,}/.test(sccM[1])) lastScc = sccM[1];
    }
    if (lastScc) sellerCreditCode = lastScc.toUpperCase();
  }

  // ========== Cross-validation & sanity checks ==========
  // Fix common extraction errors that produce inconsistent results

  // Check 1: buyerName contains sellerName (or vice versa) — likely concatenation error
  if (buyerName && sellerName) {
    if (buyerName.indexOf(sellerName) >= 0 && sellerName.length > 2) {
      // buyerName has sellerName as suffix — extract just the buyer part
      var _idx = buyerName.indexOf(sellerName);
      var _prefix = buyerName.substring(0, _idx);
      if (_prefix.length >= 2 && /[\u4e00-\u9fff]/.test(_prefix)) {
        buyerName = _prefix.replace(/[，,。.、：:；;！!？?\s]+$/, '');
        console.log('[校验] buyerName包含sellerName，已截断为:', buyerName);
      }
    } else if (sellerName.indexOf(buyerName) >= 0 && buyerName.length > 2) {
      var _idx2 = sellerName.indexOf(buyerName);
      var _suffix = sellerName.substring(_idx2 + buyerName.length);
      if (_suffix.length >= 2 && /[\u4e00-\u9fff]/.test(_suffix)) {
        sellerName = _suffix.replace(/^[，,。.、：:；;！!？?\s]+/, '');
        console.log('[校验] sellerName包含buyerName，已截断为:', sellerName);
      }
    }
  }

  // Check 2: sellerCreditCode looks like an invoice number (all digits, long)
  // 统一社会信用代码(18位)可以是纯数字(GB 32100-2015)，不能一刀切清除
  // 只有长度!=18或校验位不通过的纯数字才视为发票号码
  function _isLikelyInvoiceNotCreditCode(code) {
    if (!/^\d+$/.test(code)) return false; // 含字母，不是纯数字发票号
    if (code.length === 18) return false; // 18位纯数字可能是信用代码，保留
    return true; // 15,16,17,19,20位纯数字→更可能是发票号码
  }
  if (sellerCreditCode && _isLikelyInvoiceNotCreditCode(sellerCreditCode)) {
    console.log('[校验] sellerCreditCode疑似发票号码(纯数字非18位)，已清除:', sellerCreditCode);
    sellerCreditCode = '';
  }
  if (buyerCreditCode && _isLikelyInvoiceNotCreditCode(buyerCreditCode)) {
    console.log('[校验] buyerCreditCode疑似发票号码(纯数字非18位)，已清除:', buyerCreditCode);
    buyerCreditCode = '';
  }

  // Check 3: credit codes are swapped (buyer's code is in the right half, seller's in left)
  // This can happen when invoice layout has seller info before buyer info
  if (buyerCreditCode && sellerCreditCode && words && words.length > 0) {
    var _buyerCodeWord = words.find(function(w) {
      return w.normText.replace(/[^A-Za-z0-9]/g, '').toUpperCase() === buyerCreditCode;
    });
    var _sellerCodeWord = words.find(function(w) {
      return w.normText.replace(/[^A-Za-z0-9]/g, '').toUpperCase() === sellerCreditCode;
    });
    if (_buyerCodeWord && _sellerCodeWord) {
      if (_buyerCodeWord.nx >= 0.5 && _sellerCodeWord.nx < 0.5) {
        // Buyer code is on the RIGHT, seller code is on the LEFT → swap them
        var _tmpCode = buyerCreditCode;
        buyerCreditCode = sellerCreditCode;
        sellerCreditCode = _tmpCode;
        console.log('[校验] 信用代码左右位置颠倒，已交换');
      }
    }
  }

  console.log('[坐标提取] 结果:', { amountTax: amountTax, amountNoTax: amountNoTax, taxAmount: taxAmount,
    sellerName: sellerName || '(空)', sellerCreditCode: sellerCreditCode || '(空)',
    invoiceNo: invoiceNo || '(空)', invoiceDate: invoiceDate || '(空)',
    buyerName: buyerName || '(空)', buyerCreditCode: buyerCreditCode || '(空)' });

  return { amountTax: amountTax, amountNoTax: amountNoTax, taxAmount: taxAmount,
           sellerName: sellerName, sellerCreditCode: sellerCreditCode,
           invoiceNo: invoiceNo, invoiceDate: invoiceDate,
           buyerName: buyerName, buyerCreditCode: buyerCreditCode,
           _ocrText: fullText, isTicket: false };
}

/**
 * Regex helper: find first number after keyword in text.
 */
function _regexFindFirst(keyword, text) {
  var re = new RegExp(keyword + '[\\s\\S]*?(\\d+(?:,\\d{3})*\\.\\d{2})');
  var m = text.match(re);
  if (!m) return 0;
  var v = parseAmt(m[1]);
  if (isLikelyYearOrDate(v, m[1])) return 0;
  return v;
}

/**
 * Regex helper: find LAST number after keyword in text.
 */
function _regexFindLast(keyword, text) {
  var re = new RegExp(keyword + '[\\s\\S]*?(\\d+(?:,\\d{3})*\\.\\d{2})', 'g');
  var m, lastVal = 0;
  while ((m = re.exec(text)) !== null) {
    var v = parseAmt(m[1]);
    if (v > 0 && !isLikelyYearOrDate(v, m[1])) lastVal = v;
  }
  return lastVal;
}
