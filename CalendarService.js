/**
 * Teacher-managed school calendar for official school days and holidays.
 */

var SCHOOL_CALENDAR_SHEET = 'ปฏิทินวันเรียน';
var SCHOOL_CALENDAR_ENTRY_EXECUTION_MEMO_ = {};
var SCHOOL_CALENDAR_COL = {
  ID: 1,
  DATE: 2,
  TYPE: 3,
  LABEL: 4
};

function getSchoolCalendar(auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_school_calendar',
    rate_limit_limit: 120,
    rate_limit_window_sec: 60
  }, function() {
    var semester = getActiveSemesterRangeSafe_();
    var range = semester ? { from: semester.from, to: semester.to } : null;
    var entries = getSchoolCalendarEntriesForRange_(range);
    return {
      entries: entries,
      summary: summarizeSchoolCalendarEntries_(entries),
      active_semester: semester
    };
  });
}

function getSchoolCalendarConfirmedAttendanceConflictForDates_(dates, sourceInfo) {
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  var confirmedDateMap = getConfirmedAttendanceDateMap_(sourceInfo);
  var seen = {};
  var conflictDates = [];

  (dates || []).forEach(function(date) {
    date = String(date || '').slice(0, 10);
    if (!date || seen[date]) return;
    seen[date] = true;
    if (confirmedDateMap[date]) conflictDates.push(date);
  });

  if (!conflictDates.length) return null;
  conflictDates.sort();
  return {
    count: conflictDates.length,
    first_date: conflictDates[0],
    last_date: conflictDates[conflictDates.length - 1],
    dates: conflictDates
  };
}

function getSchoolCalendarConfirmedAttendanceConflictForRange_(from, to, sourceInfo) {
  from = String(from || '').slice(0, 10);
  to = String(to || '').slice(0, 10);
  if (!from || !to || to < from) return null;

  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  var confirmedDateMap = getConfirmedAttendanceDateMap_(sourceInfo);
  var conflictDates = Object.keys(confirmedDateMap).filter(function(date) {
    return date >= from && date <= to;
  }).sort();

  if (!conflictDates.length) return null;
  return {
    count: conflictDates.length,
    first_date: conflictDates[0],
    last_date: conflictDates[conflictDates.length - 1],
    dates: conflictDates
  };
}

/**
 * ควรกันการแก้ปฏิทินของวันนี้หรือไม่
 *
 * สองทิศทางนี้อันตรายไม่เท่ากัน จึงกันแค่ทิศเดียว
 *   ตั้งเป็นวันหยุด  → ข้อมูลที่ยืนยันแล้วหลุดออกจากรายงาน ต้องกัน
 *   ตั้งเป็นวันเรียน → ข้อมูลถูกนับเข้ามา ไม่มีอะไรหาย จึงปล่อยผ่าน
 * ถ้ากันทั้งสองทิศ ครูที่เผลอเช็คชื่อในวันนอกปฏิทินจะแก้กลับไม่ได้เลย
 *
 * แยกออกมาเป็นฟังก์ชันเพราะเป็นกติกาที่ทำข้อมูลหายได้ถ้าเขียนผิด
 * และทดสอบผ่านหน้าจอไม่จบ (dropdown ใน iframe ข้ามโดเมนสั่งด้วยคีย์บอร์ดไม่ได้)
 */
function shouldBlockSchoolCalendarChange_(existing, type, date, sourceInfo) {
  var changesSchedule = !existing || String(existing.type || '') !== type;
  if (!changesSchedule) return false;
  if (type !== 'holiday') return false;
  return !!getSchoolCalendarConfirmedAttendanceConflictForDates_([date], sourceInfo);
}

function saveSchoolCalendarEntry(payload, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'save_school_calendar_entry'
  }, function() {
    payload = payload || {};
    var date = normalizeDateStringStrict_(payload.date, 'วันที่');
    ensureDateInActiveSemester_(date, 'วันที่');

    var type = normalizeSchoolCalendarType_(payload.type);
    var label = normalizeLimitedText_(payload.label, 120, 'รายละเอียดวัน');

    var lock = LockService.getDocumentLock();
    lock.waitLock(30000);
    try {
      var sourceInfo = getCurrentAttendanceSourceInfo_();
      var sheet = getOrCreateSchoolCalendarSheet_();
      var existing = getSchoolCalendarRowByDate_(date);
      if (shouldBlockSchoolCalendarChange_(existing, type, date, sourceInfo)) {
        return {
          success: false,
          message: 'ตั้งวันที่ ' + date + ' เป็นวันหยุดไม่ได้ เพราะมีข้อมูลเช็คชื่อที่ยืนยันแล้วในวันนั้น'
            + ' ถ้าต้องการให้เป็นวันหยุดจริง ให้ล้างข้อมูลเช็คชื่อของวันนั้นก่อน'
        };
      }
      if (existing) {
        sheet.getRange(existing.row_index, SCHOOL_CALENDAR_COL.TYPE, 1, 2).setValues([[type, sanitizeSheetText_(label)]]);
      } else {
        sheet.appendRow([getNextSchoolCalendarId_(sheet), date, type, sanitizeSheetText_(label)]);
      }
      sortSchoolCalendarSheet_(sheet);
      invalidateSchoolCalendarCaches_();
      return {
        success: true,
        message: 'บันทึกปฏิทินวันเรียนเรียบร้อย',
        data: {
          entries: getSchoolCalendarEntriesForRange_({
            from: getActiveSemesterRangeSafe_().from,
            to: getActiveSemesterRangeSafe_().to
          })
        }
      };
    } finally {
      lock.releaseLock();
    }
  });
}

function deleteSchoolCalendarEntry(date, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'delete_school_calendar_entry'
  }, function() {
    date = normalizeDateStringStrict_(date, 'วันที่');

    var lock = LockService.getDocumentLock();
    lock.waitLock(30000);
    try {
      var sourceInfo = getCurrentAttendanceSourceInfo_();
      var existing = getSchoolCalendarRowByDate_(date);
      if (!existing) return { success: false, message: 'ไม่พบวันที่ในปฏิทินวันเรียน' };
      if (getSchoolCalendarConfirmedAttendanceConflictForDates_([date], sourceInfo)) {
        return {
          success: false,
          message: 'ลบรายการปฏิทินย้อนหลังไม่ได้ เพราะวันที่ ' + date + ' มีข้อมูลเช็คชื่อที่ยืนยันแล้ว'
        };
      }
      getOrCreateSchoolCalendarSheet_().deleteRow(existing.row_index);
      invalidateSchoolCalendarCaches_();
      return { success: true, message: 'ลบรายการปฏิทินวันเรียนแล้ว' };
    } finally {
      lock.releaseLock();
    }
  });
}

function generateSchoolCalendarForActiveSemester(auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'generate_school_calendar'
  }, function() {
    var semester = getActiveSemesterRangeSafe_();
    if (!semester) return { success: false, message: 'กรุณาสร้างและเปิดใช้งานภาคเรียนก่อน' };

    var lock = LockService.getDocumentLock();
    lock.waitLock(30000);
    try {
      var sourceInfo = getCurrentAttendanceSourceInfo_();
      var conflict = getSchoolCalendarConfirmedAttendanceConflictForRange_(semester.from, semester.to, sourceInfo);
      if (conflict) {
        return {
          success: false,
          message: 'สร้างปฏิทินวันเรียนใหม่ไม่ได้ เพราะมีข้อมูลเช็คชื่อที่ยืนยันแล้วระหว่าง ' + conflict.first_date + ' ถึง ' + conflict.last_date + ' กรุณาแก้เฉพาะวันที่ยังไม่มีข้อมูลยืนยัน'
        };
      }
      var sheet = getOrCreateSchoolCalendarSheet_();
      removeSchoolCalendarEntriesInRange_(semester.from, semester.to, sheet);

      // คำนวณ id ตั้งต้นครั้งเดียวนอกลูป ถ้าเรียกในลูปจะอ่านทั้งคอลัมน์และเขียน schema ใหม่ทุกวัน
      var nextId = getNextSchoolCalendarId_(sheet);
      var rows = [];
      var cursor = semester.from;
      while (cursor <= semester.to) {
        var weekday = getIsoWeekday_(cursor);
        if (weekday >= 1 && weekday <= 5) {
          rows.push([nextId + rows.length, cursor, 'school_day', 'วันเรียน']);
        }
        cursor = shiftDate_(cursor, 1);
      }

      if (rows.length) {
        sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, SCHOOL_CALENDAR_COL.LABEL).setValues(rows);
      }
      sortSchoolCalendarSheet_(sheet);
      invalidateSchoolCalendarCaches_();

      var entries = getSchoolCalendarEntriesForRange_(semester);
      return {
        success: true,
        message: 'สร้างปฏิทินวันเรียนตามวันจันทร์-ศุกร์ของภาคเรียนแล้ว',
        data: {
          entries: entries,
          summary: summarizeSchoolCalendarEntries_(entries)
        }
      };
    } finally {
      lock.releaseLock();
    }
  });
}

function getSchoolCalendarSheetForRead_() {
  return getSheetByNameOrNull_(SCHOOL_CALENDAR_SHEET);
}

function getSchoolCalendarEntriesForRange_(range) {
  var from = range && range.from ? String(range.from) : '';
  var to = range && range.to ? String(range.to) : '';
  return getOrBuildCachedJson_('school_calendar_entries', [from, to], 300, function() {
    var sheet = getSchoolCalendarSheetForRead_();
    if (!sheet) return [];
    if (sheet.getLastColumn() < SCHOOL_CALENDAR_COL.LABEL) return [];
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return [];

    var data = sheet.getRange(2, 1, lastRow - 1, SCHOOL_CALENDAR_COL.LABEL).getValues();
    var dedupedByDate = {};
    data.forEach(function(row, index) {
      var entry = buildSchoolCalendarEntry_(row, index + 2);
      if (!entry.date) return;
      if (from && entry.date < from) return;
      if (to && entry.date > to) return;
      var existing = dedupedByDate[entry.date];
      if (!existing || shouldReplaceSchoolCalendarEntry_(existing, entry)) {
        dedupedByDate[entry.date] = entry;
      }
    });

    return Object.keys(dedupedByDate).map(function(date) {
      return dedupedByDate[date];
    }).filter(function(entry) {
      if (!entry.date) return false;
      return true;
    }).sort(function(a, b) {
      return a.date.localeCompare(b.date);
    });
  });
}

function getSchoolCalendarEntryMap_(range) {
  var map = {};
  getSchoolCalendarEntriesForRange_(range).forEach(function(entry) {
    map[entry.date] = entry;
  });
  return map;
}

function primeSchoolCalendarEntriesForRange_(from, to) {
  from = String(from || '').slice(0, 10);
  to = String(to || '').slice(0, 10);
  if (!from || !to || to < from) return SCHOOL_CALENDAR_ENTRY_EXECUTION_MEMO_;

  try {
    from = normalizeDateStringStrict_(from, 'วันที่เริ่มต้น');
    to = normalizeDateStringStrict_(to, 'วันที่สิ้นสุด');
  } catch (e) {
    return SCHOOL_CALENDAR_ENTRY_EXECUTION_MEMO_;
  }

  var entryMap = getSchoolCalendarEntryMap_({ from: from, to: to });
  generateDateList_(from, to).forEach(function(date) {
    SCHOOL_CALENDAR_ENTRY_EXECUTION_MEMO_[date] = Object.prototype.hasOwnProperty.call(entryMap, date)
      ? entryMap[date]
      : null;
  });
  return SCHOOL_CALENDAR_ENTRY_EXECUTION_MEMO_;
}

function getSchoolCalendarSummaryForRange_(range) {
  return summarizeSchoolCalendarEntries_(getSchoolCalendarEntriesForRange_(range));
}

function readSchoolCalendarEntryByDate_(date) {
  var sheet = getSchoolCalendarSheetForRead_();
  if (!sheet) return null;
  if (sheet.getLastColumn() < SCHOOL_CALENDAR_COL.LABEL) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return null;

  var matches = sheet.getRange(2, SCHOOL_CALENDAR_COL.DATE, lastRow - 1, 1)
    .createTextFinder(String(date || ''))
    .matchEntireCell(true)
    .findAll();
  if (!matches.length) return null;

  var selected = null;
  matches.forEach(function(range) {
    var rowIndex = range.getRow();
    var row = sheet.getRange(rowIndex, 1, 1, SCHOOL_CALENDAR_COL.LABEL).getValues()[0];
    var entry = buildSchoolCalendarEntry_(row, rowIndex);
    if (!entry.date || entry.date !== date) return;
    if (!selected || shouldReplaceSchoolCalendarEntry_(selected, entry)) {
      selected = entry;
    }
  });
  return selected;
}

/**
 * มีข้อมูลปฏิทินอยู่ในระบบแล้วหรือยัง
 *
 * ใช้ตัดสินว่าควรเตือนเรื่อง "เช็คชื่อในวันที่ไม่อยู่ในปฏิทิน" หรือไม่
 * ถ้าครูยังไม่ได้สร้างปฏิทินเลย รายงานจะใช้จำนวนวันที่ยืนยันแล้วเป็นค่าอ้างอิงแทน
 * ข้อมูลไม่หายไปไหน จึงไม่ควรไปเตือนให้ครูตกใจเปล่าๆ ทุกวัน
 */
function hasAnySchoolCalendarEntries_() {
  var cached = getOrBuildCachedJson_('school_calendar_has_entries', [], 300, function() {
    var sheet = getSchoolCalendarSheetForRead_();
    if (!sheet) return { has: false };
    if (sheet.getLastColumn() < SCHOOL_CALENDAR_COL.LABEL) return { has: false };
    return { has: sheet.getLastRow() > 1 };
  });
  return !!(cached && cached.has);
}

function getSchoolCalendarEntryByDate_(date) {
  date = String(date || '').slice(0, 10);
  if (!date) return null;
  if (Object.prototype.hasOwnProperty.call(SCHOOL_CALENDAR_ENTRY_EXECUTION_MEMO_, date)) {
    return SCHOOL_CALENDAR_ENTRY_EXECUTION_MEMO_[date];
  }
  var cachedEntry = getOrBuildCachedJson_('school_calendar_entry_by_date', [date], 300, function() {
    var entry = readSchoolCalendarEntryByDate_(date);
    return entry || { __missing: true };
  });
  var entry = cachedEntry && cachedEntry.__missing ? null : cachedEntry;
  SCHOOL_CALENDAR_ENTRY_EXECUTION_MEMO_[date] = entry;
  return entry;
}

function summarizeSchoolCalendarEntries_(entries) {
  var summary = {
    total_entries: 0,
    school_days: 0,
    holidays: 0
  };
  (entries || []).forEach(function(entry) {
    summary.total_entries++;
    if (entry.type === 'school_day') summary.school_days++;
    if (entry.type === 'holiday') summary.holidays++;
  });
  return summary;
}

function normalizeSchoolCalendarType_(value) {
  var raw = String(value || '').trim().toLowerCase();
  if (['holiday', 'วันหยุด', 'วันหยุด/งดเรียน', 'หยุด', 'งดเรียน'].indexOf(raw) >= 0) return 'holiday';
  if (['school_day', 'schoolday', 'วันเรียน', 'วันสอน', 'เรียน'].indexOf(raw) >= 0) return 'school_day';
  return 'school_day';
}

function getSchoolCalendarRowByDate_(date) {
  return getSchoolCalendarEntryByDate_(date);
}

/**
 * @param {Sheet=} sheet ส่งชีตเข้ามาเมื่อผู้เรียกมีอยู่แล้ว จะได้ไม่ต้องรัน ensureSchoolCalendarSchema_ ซ้ำ
 */
function getNextSchoolCalendarId_(sheet) {
  sheet = sheet || getOrCreateSchoolCalendarSheet_();
  var lastRow = sheet.getLastRow();
  var maxId = 0;
  if (lastRow > 1) {
    var ids = sheet.getRange(2, SCHOOL_CALENDAR_COL.ID, lastRow - 1, 1).getValues();
    ids.forEach(function(row) {
      var value = parseInt(row[0], 10) || 0;
      if (value > maxId) maxId = value;
    });
  }
  return maxId + 1;
}

function getOrCreateSchoolCalendarSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SCHOOL_CALENDAR_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SCHOOL_CALENDAR_SHEET);
  }
  ensureSchoolCalendarSchema_(sheet);
  return sheet;
}

function ensureSchoolCalendarSchema_(sheet) {
  sheet = sheet || getOrCreateSchoolCalendarSheet_();
  var maxColumns = sheet.getMaxColumns();
  if (maxColumns < SCHOOL_CALENDAR_COL.LABEL) {
    sheet.insertColumnsAfter(maxColumns, SCHOOL_CALENDAR_COL.LABEL - maxColumns);
  }
  sheet.getRange(1, 1, 1, SCHOOL_CALENDAR_COL.LABEL).setValues([['id', 'วันที่', 'ประเภท', 'รายละเอียด']]);
  sheet.getRange(1, 1, 1, SCHOOL_CALENDAR_COL.LABEL).setFontWeight('bold').setBackground('#f5f0eb');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 70);
  sheet.setColumnWidth(2, 120);
  sheet.setColumnWidth(3, 120);
  sheet.setColumnWidth(4, 220);
}

function sortSchoolCalendarSheet_(sheet) {
  sheet = sheet || getOrCreateSchoolCalendarSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 2) return;
  sheet.getRange(2, 1, lastRow - 1, SCHOOL_CALENDAR_COL.LABEL).sort([{ column: SCHOOL_CALENDAR_COL.DATE, ascending: true }]);
}

function removeSchoolCalendarEntriesInRange_(from, to, sheet) {
  sheet = sheet || getOrCreateSchoolCalendarSheet_();
  var entries = getSchoolCalendarEntriesForRange_({ from: from, to: to });
  deleteSheetRowsByIndexes_(sheet, entries.map(function(entry) {
    return entry.row_index;
  }));
}

function buildSchoolCalendarEntry_(row, rowIndex) {
  var date = row[SCHOOL_CALENDAR_COL.DATE - 1] instanceof Date
    ? formatDate_(row[SCHOOL_CALENDAR_COL.DATE - 1])
    : String(row[SCHOOL_CALENDAR_COL.DATE - 1] || '').slice(0, 10);
  return {
    id: parseInt(row[SCHOOL_CALENDAR_COL.ID - 1], 10) || 0,
    date: date,
    // ส่งวันที่แบบไทยไปด้วย ฝั่ง client จะได้ไม่ต้องแสดง 2025-11-03 ให้ครูอ่านเอง
    date_label: date ? thaiDate(date, 'short', true) : '',
    type: normalizeSchoolCalendarType_(row[SCHOOL_CALENDAR_COL.TYPE - 1] || 'school_day'),
    label: String(row[SCHOOL_CALENDAR_COL.LABEL - 1] || ''),
    row_index: rowIndex
  };
}

function shouldReplaceSchoolCalendarEntry_(currentEntry, nextEntry) {
  if (!currentEntry) return true;
  if (!nextEntry) return false;

  var currentRank = (parseInt(currentEntry.id, 10) || 0) * 10 + (currentEntry.type === 'holiday' ? 1 : 0);
  var nextRank = (parseInt(nextEntry.id, 10) || 0) * 10 + (nextEntry.type === 'holiday' ? 1 : 0);

  if (nextRank !== currentRank) return nextRank > currentRank;
  return (parseInt(nextEntry.row_index, 10) || 0) > (parseInt(currentEntry.row_index, 10) || 0);
}

function invalidateSchoolCalendarCaches_() {
  try {
    var cache = CacheService.getScriptCache();
    cache.remove('sl');
    cache.remove('st');
  } catch (e) {}
  SCHOOL_CALENDAR_ENTRY_EXECUTION_MEMO_ = {};
  bumpDerivedDataCacheVersion_();
}
