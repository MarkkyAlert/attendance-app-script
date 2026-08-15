/**
 * ═══════════════════════════════════════════════════
 * SheetDB.gs — Google Sheets as Database
 * ═══════════════════════════════════════════════════
 */

// ─── Sheet Names ─────────────────────────────────

var SHEET = {
  STUDENTS: 'นักเรียน',
  ATTENDANCE: 'เช็คชื่อ',
  ATTENDANCE_DAYS: 'สถานะวัน',
  CHANGE_LOG: 'ประวัติแก้ไข',
  SETTINGS: 'ตั้งค่า'
};

// ─── Column Definitions ──────────────────────────

var COL = {
  STUDENTS: {
    ID: 1,                // A: auto-increment ID
    STUDENT_NUMBER: 2,    // B: เลขที่
    FULL_NAME: 3,         // C: ชื่อ-สกุล
    NICKNAME: 4,          // D: ชื่อเล่น
    GENDER: 5,            // E: เพศ (M/F)
    GROUP_NAME: 6,        // F: กลุ่ม
    IS_FLAGGED: 7,        // G: จับตา (TRUE/FALSE)
    IS_ACTIVE: 8,         // H: ใช้งาน (TRUE/FALSE)
    CREATED_AT: 9,        // I: วันที่สร้าง
    PARENT_EMAIL: 10,     // J: อีเมลผู้ปกครอง
    ENROLLED_FROM: 11,    // K: วันที่เริ่มอยู่ในห้อง
    INACTIVE_AT: 12       // L: วันที่พ้นจากห้อง (exclusive)
  },
  ATTENDANCE: {
    ID: 1,                // A: auto-increment ID
    STUDENT_NUMBER: 2,    // B: เลขที่
    DATE: 3,              // C: วันที่ (yyyy-MM-dd)
    STATUS_CODE: 4,       // D: สถานะ
    NOTE: 5,              // E: หมายเหตุ
    BATCH_ID: 6,          // F: bulk batch ID
    CREATED_AT: 7,        // G: วันที่บันทึก
    UPDATED_AT: 8,        // H: วันที่แก้ไข
    STUDENT_ID: 9         // I: อ้างอิงนักเรียนแบบ immutable
  },
  ATT_DAYS: {
    DATE: 1,              // A: วันที่
    STATUS: 2,            // B: draft/confirmed
    CONFIRMED_AT: 3       // C: วันที่ยืนยัน
  },
  LOG: {
    ID: 1,
    STUDENT_NUMBER: 2,
    DATE: 3,
    OLD_STATUS: 4,
    NEW_STATUS: 5,
    OLD_NOTE: 6,
    NEW_NOTE: 7,
    ACTION: 8,
    CHANGED_AT: 9,
    STUDENT_ID: 10
  }
};

// ─── Attendance Statuses ─────────────────────────

var STATUSES = [
  { id: 1, code: 'present',        label: 'มาเรียน',  icon: '✅', color: 'green' },
  { id: 2, code: 'late',           label: 'สาย',      icon: '⏰', color: 'amber' },
  { id: 3, code: 'absent',         label: 'ขาด',      icon: '❌', color: 'red' },
  { id: 4, code: 'sick_leave',     label: 'ลาป่วย',   icon: '🏥', color: 'blue' },
  { id: 5, code: 'personal_leave', label: 'ลากิจ',    icon: '📋', color: 'indigo' }
];

var STATUS_MAP = {};
STATUSES.forEach(function(s) { STATUS_MAP[s.code] = s; });

// ─── Get Spreadsheet & Sheet ─────────────────────

function getSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet_(name) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    throw new Error('ไม่พบ Sheet: ' + name + ' — กรุณารัน setupSystem() ก่อน');
  }
  return sheet;
}

function getSheetByNameOrNull_(name) {
  var ss = getSpreadsheet_();
  return ss.getSheetByName(String(name || '').trim()) || null;
}

// ─── Generic Sheet CRUD ──────────────────────────

/**
 * Get next auto-increment ID for a sheet
 */
function getNextId_(sheetName) {
  var sheet = getSheet_(sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 1;
  
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var maxId = 0;
  ids.forEach(function(row) {
    var id = parseInt(row[0], 10);
    if (!isNaN(id) && id > maxId) maxId = id;
  });
  return maxId + 1;
}

function getNextIdForSheet_(sheet) {
  if (!sheet) throw new Error('Sheet is required');
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 1;

  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var maxId = 0;
  ids.forEach(function(row) {
    var id = parseInt(row[0], 10);
    if (!isNaN(id) && id > maxId) maxId = id;
  });
  return maxId + 1;
}

/**
 * Append a row to sheet
 */
function appendRow_(sheetName, rowArray) {
  var sheet = getSheet_(sheetName);
  sheet.appendRow(rowArray);
  return rowArray;
}

/**
 * Update specific cells in a row
 */
function updateCells_(sheetName, rowIndex, updates) {
  var sheet = getSheet_(sheetName);
  updates.forEach(function(u) {
    if (u.col) {
      sheet.getRange(rowIndex, u.col).setValue(u.value);
    }
  });
}

/**
 * Delete rows by 1-based row index. Header row (1) is never deleted.
 * Contiguous rows are deleted as one block, bottom-up, so the remaining
 * indexes stay valid while deleting.
 * @returns {number} จำนวนแถวที่ลบจริง
 */
function deleteSheetRowsByIndexes_(sheet, rowIndexes) {
  if (!sheet) return 0;

  var uniqueRows = {};
  (rowIndexes || []).forEach(function(rowIndex) {
    rowIndex = parseInt(rowIndex, 10) || 0;
    if (rowIndex > 1) uniqueRows[rowIndex] = true;
  });

  var rows = Object.keys(uniqueRows).map(function(rowIndex) {
    return parseInt(rowIndex, 10);
  }).sort(function(a, b) {
    return b - a;
  });
  if (!rows.length) return 0;

  var deleted = 0;
  var blockEnd = rows[0];
  var blockStart = rows[0];

  for (var i = 1; i < rows.length; i++) {
    if (rows[i] === blockStart - 1) {
      blockStart = rows[i];
      continue;
    }
    sheet.deleteRows(blockStart, blockEnd - blockStart + 1);
    deleted += blockEnd - blockStart + 1;
    blockStart = rows[i];
    blockEnd = rows[i];
  }

  sheet.deleteRows(blockStart, blockEnd - blockStart + 1);
  deleted += blockEnd - blockStart + 1;
  return deleted;
}

// ─── Settings Helpers ────────────────────────────

function getSettings_() {
  var sheet;
  try {
    sheet = getSheet_(SHEET.SETTINGS);
  } catch (e) {
    return { teacher_name: '', school_name: '', class_name: '', absence_alert_days: 3, attention_threshold_days: 3 };
  }
  
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { teacher_name: '', school_name: '', class_name: '', absence_alert_days: 3, attention_threshold_days: 3 };
  
  var data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  var settings = {};
  data.forEach(function(row) {
    if (row[0]) settings[String(row[0])] = row[1];
  });
  
  settings.absence_alert_days = normalizeAbsenceAlertDays_(settings.absence_alert_days);
  settings.attention_threshold_days = normalizeAttentionThresholdDays_(settings.attention_threshold_days);
  return settings;
}

function saveSetting_(key, value) {
  var sheet = getSheet_(SHEET.SETTINGS);
  var lastRow = sheet.getLastRow();
  
  // Find existing key
  if (lastRow > 1) {
    var data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][0]) === String(key)) {
        sheet.getRange(i + 2, 2).setValue(value);
        try { CacheService.getScriptCache().remove('st'); } catch (e) {}
        return;
      }
    }
  }
  
  // Key not found, append
  sheet.appendRow([key, value]);
  try { CacheService.getScriptCache().remove('st'); } catch (e) {}
}

function removeSetting_(key) {
  var sheet;
  try {
    sheet = getSheet_(SHEET.SETTINGS);
  } catch (e) {
    return;
  }

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  var data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = data.length - 1; i >= 0; i--) {
    if (String(data[i][0]) === String(key)) {
      sheet.deleteRow(i + 2);
    }
  }
  try { CacheService.getScriptCache().remove('st'); } catch (e) {}
}

// ─── UUID Generator ──────────────────────────────

