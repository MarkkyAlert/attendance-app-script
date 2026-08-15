/**
 * Teacher-managed semester ranges.
 */

var SEMESTER_SHEET = 'ภาคเรียน';
var SEMESTER_COL = { ID: 1, NAME: 2, START: 3, END: 4, ACTIVE: 5 };

function getActiveSemester(auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_active_semester',
    rate_limit_limit: 120,
    rate_limit_window_sec: 60
  }, function() {
    return getActiveSemesterRow_();
  });
}

function getSemesterList(auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_semester_list',
    rate_limit_limit: 120,
    rate_limit_window_sec: 60
  }, function() {
    return getSemesterRows_();
  });
}

function withSemesterMutationLock_(callback) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function createSemester(payload, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'create_semester'
  }, function() {
    payload = payload || {};

    var name = '';
    try {
      name = normalizeLimitedText_(payload.name, 40, 'ชื่อภาคเรียน');
    } catch (e) {
      return { success: false, message: e.message };
    }
    var startDate = payload.start_date ? normalizeDateStringStrict_(payload.start_date, 'วันเริ่มต้น') : '';
    var endDate = payload.end_date ? normalizeDateStringStrict_(payload.end_date, 'วันสิ้นสุด') : '';
    var setActive = payload.set_active !== false;

    if (!name) return { success: false, message: 'กรุณากรอกชื่อภาคเรียน' };
    if (!startDate || !endDate) return { success: false, message: 'กรุณากรอกวันเริ่มต้นและสิ้นสุด' };
    if (startDate > endDate) return { success: false, message: 'วันเริ่มต้นต้องก่อนวันสิ้นสุด' };

    return withSemesterMutationLock_(function() {
      var existing = getSemesterRows_();
      for (var i = 0; i < existing.length; i++) {
        if (existing[i].name === name) {
          return { success: false, message: 'ภาคเรียน "' + name + '" มีอยู่แล้ว' };
        }
      }
      var overlap = findSemesterRangeOverlap_(existing, startDate, endDate, 0);
      if (overlap) {
        return { success: false, message: 'ช่วงวันที่ซ้อนกับภาคเรียน "' + overlap.name + '"' };
      }

      var sheet = getOrCreateSemesterSheet_();
      if (setActive) deactivateAllSemesters_(sheet);

      var semesterId = getNextSemesterId_(existing);
      sheet.appendRow([semesterId, name, startDate, endDate, setActive]);
      invalidateSemesterCaches_();

      return {
        success: true,
        message: 'สร้างภาคเรียน ' + name + ' สำเร็จ',
        data: {
          id: semesterId,
          name: name,
          start_date: startDate,
          end_date: endDate,
          is_active: setActive
        }
      };
    });
  });
}

function switchSemester(identifier, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'switch_semester'
  }, function() {
    return withSemesterMutationLock_(function() {
      var match = findSemesterByIdentifier_(identifier);
      if (!match.success) return { success: false, message: match.message };

      var sheet = getOrCreateSemesterSheet_();
      deactivateAllSemesters_(sheet);
      sheet.getRange(match.semester.row_index, SEMESTER_COL.ACTIVE).setValue(true);
      invalidateSemesterCaches_();

      return { success: true, message: 'เปลี่ยนเป็นภาคเรียน ' + match.semester.name + ' แล้ว' };
    });
  });
}

function editSemester(payload, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'edit_semester'
  }, function() {
    payload = payload || {};

    var identifier = payload.id !== undefined && payload.id !== null && payload.id !== ''
      ? payload.id
      : payload.original_name;
    var name = '';
    try {
      name = normalizeLimitedText_(payload.name, 40, 'ชื่อภาคเรียน');
    } catch (e) {
      return { success: false, message: e.message };
    }
    var startDate = payload.start_date ? normalizeDateStringStrict_(payload.start_date, 'วันเริ่มต้น') : '';
    var endDate = payload.end_date ? normalizeDateStringStrict_(payload.end_date, 'วันสิ้นสุด') : '';

    if (!identifier || !name) return { success: false, message: 'ข้อมูลไม่ครบ' };
    if (!startDate || !endDate) return { success: false, message: 'กรุณากรอกวันเริ่มต้นและสิ้นสุด' };
    if (startDate > endDate) return { success: false, message: 'วันเริ่มต้นต้องก่อนวันสิ้นสุด' };

    return withSemesterMutationLock_(function() {
      var match = findSemesterByIdentifier_(identifier);
      if (!match.success) return { success: false, message: match.message };

      var existing = getSemesterRows_();
      for (var i = 0; i < existing.length; i++) {
        if (existing[i].id === match.semester.id) continue;
        if (existing[i].name === name) {
          return { success: false, message: 'ภาคเรียน "' + name + '" มีอยู่แล้ว' };
        }
      }
      var overlap = findSemesterRangeOverlap_(existing, startDate, endDate, match.semester.id);
      if (overlap) {
        return { success: false, message: 'ช่วงวันที่ซ้อนกับภาคเรียน "' + overlap.name + '"' };
      }

      var rangeConflict = getSemesterAttendanceRangeConflict_(match.semester, startDate, endDate);
      if (rangeConflict) {
        return {
          success: false,
          message: 'แก้ช่วงภาคเรียนไม่ได้ เพราะมีข้อมูลเช็คชื่ออยู่ระหว่าง ' + rangeConflict.min_date + ' ถึง ' + rangeConflict.max_date + ' กรุณาขยายช่วงให้ครอบคลุมข้อมูลเดิม หรือแก้เฉพาะชื่อภาคเรียน'
        };
      }

      var sheet = getOrCreateSemesterSheet_();
      sheet.getRange(match.semester.row_index, SEMESTER_COL.NAME).setValue(name);
      sheet.getRange(match.semester.row_index, SEMESTER_COL.START).setValue(startDate);
      sheet.getRange(match.semester.row_index, SEMESTER_COL.END).setValue(endDate);
      invalidateSemesterCaches_();
      return { success: true, message: 'แก้ไขภาคเรียนสำเร็จ' };
    });
  });
}

function deleteSemester(identifier, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'delete_semester'
  }, function() {
    return withSemesterMutationLock_(function() {
      var match = findSemesterByIdentifier_(identifier);
      if (!match.success) return { success: false, message: match.message };
      if (match.semester.is_active) {
        return { success: false, message: 'ไม่สามารถลบภาคเรียนที่ใช้งานอยู่ได้' };
      }
      if (hasSemesterAttendanceData_(match.semester)) {
        return { success: false, message: 'ลบภาคเรียนนี้ไม่ได้ เพราะยังมีข้อมูลเช็คชื่ออยู่ กรุณาเก็บข้อมูลภาคเรียนนี้ไว้สำหรับดูย้อนหลัง' };
      }

      var sheet = getOrCreateSemesterSheet_();
      sheet.deleteRow(match.semester.row_index);
      invalidateSemesterCaches_();
      return { success: true, message: 'ลบภาคเรียน "' + match.semester.name + '" แล้ว' };
    });
  });
}

function archiveSemesterAttendance(identifier, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'archive_semester_attendance'
  }, function() {
    var match = findSemesterByIdentifier_(identifier);
    if (!match.success) return { success: false, message: match.message };
    if (match.semester.is_active) {
      return { success: false, message: 'ยังไม่สามารถเก็บข้อมูลของภาคเรียนที่ใช้งานอยู่ได้' };
    }

    return withAttendanceMutationLock_(function() {
      var semester = match.semester;
      var attendanceSheet = getSheet_(SHEET.ATTENDANCE);
      var dayStatusSheet = getSheet_(SHEET.ATTENDANCE_DAYS);
      var attendanceRows = getSemesterAttendanceRowsFromSheet_(attendanceSheet, semester);
      var dayRows = getSemesterAttendanceDayRowsFromSheet_(dayStatusSheet, semester);
      var archiveSheet = getOrCreateAttendanceArchiveSheet_(semester);
      var archiveDaySheet = getOrCreateAttendanceArchiveDaySheet_(semester);

      if (!attendanceRows.rows.length && !dayRows.rows.length) {
        if (isSemesterAttendanceArchived_(semester)) {
          return {
            success: true,
            message: 'ข้อมูลเช็คชื่อของภาคเรียน "' + semester.name + '" ถูกเก็บไว้แล้ว',
            data: {
              moved_records: 0,
              moved_day_statuses: 0,
              archive_sheet_name: archiveSheet.getName(),
              archive_day_sheet_name: archiveDaySheet.getName()
            }
          };
        }
        return { success: false, message: 'ไม่พบข้อมูลเช็คชื่อของภาคเรียนนี้ให้เก็บ' };
      }

      var movedRecords = appendArchiveAttendanceRowsIfMissing_(archiveSheet, attendanceRows.rows);
      var movedDayStatuses = appendArchiveDayRowsIfMissing_(archiveDaySheet, dayRows.rows);

      deleteSheetRowsByIndexes_(attendanceSheet, attendanceRows.row_indexes);
      deleteSheetRowsByIndexes_(dayStatusSheet, dayRows.row_indexes);
      invalidateSemesterCaches_();

      return {
        success: true,
        message: 'เก็บข้อมูลเช็คชื่อของภาคเรียน "' + semester.name + '" แล้ว',
        data: {
          moved_records: movedRecords,
          moved_day_statuses: movedDayStatuses,
          archive_sheet_name: archiveSheet.getName(),
          archive_day_sheet_name: archiveDaySheet.getName()
        }
      };
    });
  });
}

function getSemesterRows_() {
  return getSemesterRowsBase_().map(function(semester) {
    var enriched = Object.assign({}, semester);
    enriched.is_archived = isSemesterAttendanceArchived_(semester);
    return enriched;
  });
}

function getSemesterSheetForRead_() {
  return getSheetByNameOrNull_(SEMESTER_SHEET);
}

function getSemesterRowsBase_() {
  var cache = CacheService.getScriptCache();
  var cached = '';
  try {
    cached = cache.get('semester_rows_base') || '';
  } catch (e) {}
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e2) {}
  }

  var sheet = getSemesterSheetForRead_();
  if (!sheet) return [];
  if (sheet.getLastColumn() < SEMESTER_COL.ACTIVE) return [];

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  var data = sheet.getRange(2, 1, lastRow - 1, SEMESTER_COL.ACTIVE).getValues();
  var rows = data.map(function(row, index) {
    var startDate = row[SEMESTER_COL.START - 1] instanceof Date ? formatDate_(row[SEMESTER_COL.START - 1]) : String(row[SEMESTER_COL.START - 1] || '');
    var endDate = row[SEMESTER_COL.END - 1] instanceof Date ? formatDate_(row[SEMESTER_COL.END - 1]) : String(row[SEMESTER_COL.END - 1] || '');
    return {
      id: parseInt(row[SEMESTER_COL.ID - 1], 10) || 0,
      name: row[SEMESTER_COL.NAME - 1] instanceof Date
        ? ((row[SEMESTER_COL.NAME - 1].getMonth() + 1) + '/' + row[SEMESTER_COL.NAME - 1].getFullYear())
        : String(row[SEMESTER_COL.NAME - 1] || '').trim(),
      start_date: startDate,
      end_date: endDate,
      start_date_th: startDate ? thaiDate(startDate, 'short', false) : '',
      end_date_th: endDate ? thaiDate(endDate, 'short', false) : '',
      is_active: row[SEMESTER_COL.ACTIVE - 1] === true || String(row[SEMESTER_COL.ACTIVE - 1]).toUpperCase() === 'TRUE',
      row_index: index + 2
    };
  }).filter(function(row) {
    return !!row.name;
  });

  try { cache.put('semester_rows_base', JSON.stringify(rows), 300); } catch (e3) {}
  return rows;
}

function hasSemesterAttendanceData_(semester) {
  if (!semester || !semester.start_date || !semester.end_date) return false;
  if (isSemesterAttendanceArchived_(semester)) return true;
  var attendanceRows = getSemesterAttendanceRowsFromSheet_(getSheet_(SHEET.ATTENDANCE), semester);
  if (attendanceRows.rows.length) return true;
  var dayRows = getSemesterAttendanceDayRowsFromSheet_(getSheet_(SHEET.ATTENDANCE_DAYS), semester);
  return dayRows.rows.length > 0;
}

function getSemesterAttendanceDateBounds_(semester) {
  if (!semester || !semester.start_date || !semester.end_date) return null;

  var sourceInfos = [buildDefaultAttendanceSourceInfo_()];
  var archiveSourceInfo = getAttendanceSourceInfoForSemester_(semester);
  if (archiveSourceInfo && archiveSourceInfo.is_archived) {
    sourceInfos.push(archiveSourceInfo);
  }
  var minDate = '';
  var maxDate = '';

  function trackDate_(date) {
    if (!date) return;
    if (!minDate || date < minDate) minDate = date;
    if (!maxDate || date > maxDate) maxDate = date;
  }

  sourceInfos.forEach(function(sourceInfo) {
    var attendanceRows = getSemesterAttendanceRowsFromSheet_(getAttendanceSourceSheet_(sourceInfo), semester).rows;
    var dayRows = getSemesterAttendanceDayRowsFromSheet_(getAttendanceDaySourceSheet_(sourceInfo), semester).rows;

    attendanceRows.forEach(function(row) {
      try {
        trackDate_(normalizeDateStringStrict_(row[COL.ATTENDANCE.DATE - 1], 'วันที่'));
      } catch (e) {}
    });

    dayRows.forEach(function(row) {
      try {
        trackDate_(normalizeDateStringStrict_(row[0], 'วันที่'));
      } catch (e) {}
    });
  });

  return minDate && maxDate ? { min_date: minDate, max_date: maxDate } : null;
}

function getSemesterAttendanceRangeConflict_(semester, nextStartDate, nextEndDate) {
  if (!semester || !nextStartDate || !nextEndDate) return null;
  var bounds = getSemesterAttendanceDateBounds_(semester);
  if (!bounds) return null;
  if (bounds.min_date < nextStartDate || bounds.max_date > nextEndDate) {
    return bounds;
  }
  return null;
}

function getSemesterAttendanceRowsFromSheet_(sheet, semester) {
  if (!sheet || !semester || !semester.start_date || !semester.end_date) {
    return { rows: [], row_indexes: [] };
  }
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { rows: [], row_indexes: [] };

  var data = sheet.getRange(2, 1, lastRow - 1, COL.ATTENDANCE.STUDENT_ID).getValues();
  var rows = [];
  var rowIndexes = [];

  data.forEach(function(row, index) {
    var date = row[COL.ATTENDANCE.DATE - 1];
    try {
      date = normalizeDateStringStrict_(date, 'วันที่');
    } catch (e) {
      return;
    }
    if (date < semester.start_date || date > semester.end_date) return;
    rows.push(row);
    rowIndexes.push(index + 2);
  });

  return { rows: rows, row_indexes: rowIndexes };
}

function getSemesterAttendanceDayRowsFromSheet_(sheet, semester) {
  if (!sheet || !semester || !semester.start_date || !semester.end_date) {
    return { rows: [], row_indexes: [] };
  }
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return { rows: [], row_indexes: [] };

  var data = sheet.getRange(2, 1, lastRow - 1, COL.ATT_DAYS.CONFIRMED_AT).getValues();
  var rows = [];
  var rowIndexes = [];

  data.forEach(function(row, index) {
    var date = row[COL.ATT_DAYS.DATE - 1];
    try {
      date = normalizeDateStringStrict_(date, 'วันที่');
    } catch (e) {
      return;
    }
    if (date < semester.start_date || date > semester.end_date) return;
    rows.push([date, String(row[COL.ATT_DAYS.STATUS - 1] || ''), String(row[COL.ATT_DAYS.CONFIRMED_AT - 1] || '')]);
    rowIndexes.push(index + 2);
  });

  return { rows: rows, row_indexes: rowIndexes };
}

function appendArchiveAttendanceRowsIfMissing_(sheet, rows) {
  rows = Array.isArray(rows) ? rows : [];
  if (!sheet || !rows.length) return 0;

  var existingIds = {};
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach(function(row) {
      var id = parseInt(row[0], 10) || 0;
      if (id > 0) existingIds[id] = true;
    });
  }

  var pending = rows.filter(function(row) {
    var id = parseInt(row[0], 10) || 0;
    if (id > 0 && existingIds[id]) return false;
    if (id > 0) existingIds[id] = true;
    return true;
  });
  if (!pending.length) return 0;

  sheet.getRange(sheet.getLastRow() + 1, 1, pending.length, COL.ATTENDANCE.STUDENT_ID).setValues(pending);
  return pending.length;
}

function appendArchiveDayRowsIfMissing_(sheet, rows) {
  rows = Array.isArray(rows) ? rows : [];
  if (!sheet || !rows.length) return 0;

  var existingDates = {};
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach(function(row) {
      try {
        existingDates[normalizeDateStringStrict_(row[0], 'วันที่')] = true;
      } catch (e) {}
    });
  }

  var pending = rows.filter(function(row) {
    var date = '';
    try {
      date = normalizeDateStringStrict_(row[0], 'วันที่');
    } catch (e) {
      return false;
    }
    if (existingDates[date]) return false;
    existingDates[date] = true;
    return true;
  });
  if (!pending.length) return 0;

  sheet.getRange(sheet.getLastRow() + 1, 1, pending.length, COL.ATT_DAYS.CONFIRMED_AT).setValues(pending);
  return pending.length;
}

function findSemesterRangeOverlap_(rows, startDate, endDate, excludeId) {
  var semesters = rows || [];
  var ignoredId = parseInt(excludeId, 10) || 0;
  for (var i = 0; i < semesters.length; i++) {
    var semester = semesters[i] || {};
    if ((parseInt(semester.id, 10) || 0) === ignoredId) continue;
    if (!semester.start_date || !semester.end_date) continue;
    if (startDate <= semester.end_date && endDate >= semester.start_date) {
      return semester;
    }
  }
  return null;
}

function getOrCreateSemesterSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SEMESTER_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SEMESTER_SHEET);
    sheet.appendRow(['id', 'ชื่อภาคเรียน', 'วันเริ่มต้น', 'วันสิ้นสุด', 'ใช้งาน']);
    var header = sheet.getRange(1, 1, 1, SEMESTER_COL.ACTIVE);
    header.setFontWeight('bold');
    header.setBackground('#f5f0eb');
    sheet.setFrozenRows(1);
    sheet.getRange('A:A').setNumberFormat('0');
    sheet.getRange('B:B').setNumberFormat('@');
    sheet.setColumnWidth(1, 70);
    sheet.setColumnWidth(2, 120);
    sheet.setColumnWidth(3, 120);
    sheet.setColumnWidth(4, 120);
    sheet.setColumnWidth(5, 60);
  }
  ensureSemesterSchema_(sheet);
  return sheet;
}

function getActiveSemesterRow_() {
  var rows = getSemesterRowsBase_();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].is_active) return rows[i];
  }
  return null;
}

function ensureDateInActiveSemester_(date, label) {
  var normalizedDate = normalizeDateStringStrict_(date, label || 'วันที่');
  var semester = getActiveSemesterRangeSafe_();
  if (!semester) {
    throw new Error('กรุณาสร้างและเปิดใช้งานภาคเรียนก่อนใช้งาน');
  }
  if (normalizedDate < semester.from || normalizedDate > semester.to) {
    throw new Error((label || 'วันที่') + ' อยู่นอกภาคเรียนที่เปิดใช้งานอยู่ (' + semester.start_date + ' - ' + semester.end_date + ')');
  }
  return semester;
}

function ensureSemesterSchema_(sheet) {
  sheet = sheet || getSheet_(SEMESTER_SHEET);

  var headerA = String(sheet.getRange(1, 1).getValue() || '').trim();
  var headerB = String(sheet.getRange(1, 2).getValue() || '').trim();
  if (headerA !== 'id' && headerB !== 'ชื่อภาคเรียน') {
    sheet.insertColumnBefore(1);
  }

  var maxColumns = sheet.getMaxColumns();
  if (maxColumns < SEMESTER_COL.ACTIVE) {
    sheet.insertColumnsAfter(maxColumns, SEMESTER_COL.ACTIVE - maxColumns);
  }

  sheet.getRange(1, 1, 1, SEMESTER_COL.ACTIVE).setValues([['id', 'ชื่อภาคเรียน', 'วันเริ่มต้น', 'วันสิ้นสุด', 'ใช้งาน']]);
  sheet.getRange(1, 1, 1, SEMESTER_COL.ACTIVE).setFontWeight('bold').setBackground('#f5f0eb');
  sheet.setFrozenRows(1);
  sheet.getRange('A:A').setNumberFormat('0');
  sheet.getRange('B:B').setNumberFormat('@');
  sheet.setColumnWidth(1, 70);
  sheet.setColumnWidth(2, 120);
  sheet.setColumnWidth(3, 120);
  sheet.setColumnWidth(4, 120);
  sheet.setColumnWidth(5, 60);

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  var data = sheet.getRange(2, 1, lastRow - 1, SEMESTER_COL.ACTIVE).getValues();
  var usedIds = {};
  var maxId = 0;

  for (var i = 0; i < data.length; i++) {
    var rawId = parseInt(data[i][SEMESTER_COL.ID - 1], 10) || 0;
    if (!rawId || usedIds[rawId]) continue;
    usedIds[rawId] = true;
    if (rawId > maxId) maxId = rawId;
  }

  var nextId = maxId + 1;
  var assignedIds = {};
  var idValues = [];
  var activeValues = [];
  var idsChanged = false;
  var activeChanged = false;
  var activeFound = false;

  for (var j = 0; j < data.length; j++) {
    var parsedId = parseInt(data[j][SEMESTER_COL.ID - 1], 10) || 0;
    if (!parsedId || assignedIds[parsedId]) {
      parsedId = nextId++;
      idsChanged = true;
    }
    assignedIds[parsedId] = true;
    idValues.push([parsedId]);

    var isActive = data[j][SEMESTER_COL.ACTIVE - 1] === true || String(data[j][SEMESTER_COL.ACTIVE - 1]).toUpperCase() === 'TRUE';
    if (isActive && !activeFound) {
      activeValues.push([true]);
      activeFound = true;
    } else {
      if (isActive) activeChanged = true;
      activeValues.push([false]);
    }
  }

  if (idsChanged) {
    sheet.getRange(2, SEMESTER_COL.ID, idValues.length, 1).setValues(idValues);
  }
  if (activeChanged) {
    sheet.getRange(2, SEMESTER_COL.ACTIVE, activeValues.length, 1).setValues(activeValues);
  }
}

function getNextSemesterId_(rows) {
  var maxId = 0;
  (rows || []).forEach(function(row) {
    var rowId = parseInt(row.id, 10) || 0;
    if (rowId > maxId) maxId = rowId;
  });
  return maxId + 1;
}

function findSemesterByIdentifier_(identifier) {
  var rows = getSemesterRows_();
  if (!rows.length) return { success: false, message: 'ไม่พบภาคเรียน' };

  var rawIdentifier = String(identifier || '').trim();
  var semesterId = (typeof identifier === 'number' || /^\d+$/.test(rawIdentifier))
    ? (parseInt(rawIdentifier, 10) || 0)
    : 0;
  if (semesterId > 0) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].id === semesterId) return { success: true, semester: rows[i] };
    }
    return { success: false, message: 'ไม่พบภาคเรียนที่เลือก' };
  }

  var name = '';
  try {
    name = normalizeLimitedText_(rawIdentifier, 40, 'ชื่อภาคเรียน');
  } catch (e) {
    return { success: false, message: e.message };
  }
  if (!name) return { success: false, message: 'กรุณาเลือกภาคเรียน' };

  var matches = rows.filter(function(row) {
    return row.name === name;
  });
  if (!matches.length) return { success: false, message: 'ไม่พบภาคเรียน "' + name + '"' };
  if (matches.length > 1) {
    return { success: false, message: 'พบชื่อภาคเรียนซ้ำ กรุณาแก้ชื่อภาคเรียนก่อนใช้งาน' };
  }
  return { success: true, semester: matches[0] };
}

function deactivateAllSemesters_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  var range = sheet.getRange(2, SEMESTER_COL.ACTIVE, lastRow - 1, 1);
  range.setValues(range.getValues().map(function() { return [false]; }));
}

function invalidateSemesterCaches_() {
  try {
    var cache = CacheService.getScriptCache();
    cache.remove('sl');
    cache.remove('st');
    cache.remove('semester_rows_base');
  } catch (e) {}
  bumpDerivedDataCacheVersion_();
}
