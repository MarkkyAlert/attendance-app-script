/**
 * Attendance reads, writes, and derived day summaries.
 */

// เพดานของชีตประวัติแก้ไข ~50 คน/ห้อง เขียนวันละ 1 แถวต่อการแก้ 1 ครั้ง
// 5000 แถวจึงครอบคลุมย้อนหลังหลายเดือน โดยที่หน้าประวัติยังอ่านได้เร็ว
var CHANGE_LOG_MAX_ROWS = 5000;
var CHANGE_LOG_TRIM_SLACK_ROWS = 500;

var ATTENDANCE_ARCHIVE_SHEET_PREFIX = '_att_archive_';
var ATTENDANCE_DAY_ARCHIVE_SHEET_PREFIX = '_att_day_archive_';
var ATTENDANCE_DAY_STATUS_MAP_MEMO_ = {};
var ATTENDANCE_CONFIRMED_DATE_MAP_MEMO_ = {};
var CACHED_STUDENT_LIST_MEMO_ = null;
// ★ ชีต `ตั้งค่า` ถูกอ่านหลายรอบต่อ 1 คำขอ (session ครู · PIN · รายงาน · อีเมล)
// ล้างผ่าน `invalidateSettingsCache_` เสมอ ห้ามล้าง CacheService key 'st' เดี่ยวๆ ไม่งั้น memo จะค้าง
var CACHED_SETTINGS_MEMO_ = null;
// ★ ตอบแค่ "ต้องอ่านชีต archive ด้วยไหม" แต่มี call site 37 จุด และแต่ละครั้งเปิดชีต 2 ใบ + getLastRow 2 ครั้ง
// ล้างที่ `bumpDerivedDataCacheVersion_` จุดเดียว ซึ่งทุก mutation ผ่านอยู่แล้ว
var CACHED_ATTENDANCE_SOURCE_INFO_MEMO_ = null;

function withAttendanceMutationLock_(callback) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function attachAttendanceTimingDetail_(data, detail) {
  if (!data) return data;
  try {
    Object.defineProperty(data, '__timing_detail', {
      value: String(detail || ''),
      writable: true,
      configurable: true,
      enumerable: false
    });
  } catch (e) {
    data.__timing_detail = String(detail || '');
  }
  return data;
}

function buildAttendanceRosterContext_(students, date, existingContext) {
  existingContext = existingContext || {};
  var rosterStudents = Array.isArray(existingContext.students) ? existingContext.students : (students || []);
  var studentIndex = existingContext.student_index && existingContext.student_index.byId && existingContext.student_index.byNumber
    ? existingContext.student_index
    : buildStudentIdentityIndex_(rosterStudents);
  var preferredStudentByNumber = existingContext.preferred_student_by_number || null;
  if (!preferredStudentByNumber) {
    preferredStudentByNumber = {};
    Object.keys(studentIndex.byNumber || {}).forEach(function(studentNumberKey) {
      var candidates = studentIndex.byNumber[studentNumberKey] || [];
      if (!candidates.length) return;
      preferredStudentByNumber[studentNumberKey] = candidates.length === 1
        ? candidates[0]
        : pickBestStudentCandidate_(candidates, date);
    });
  }
  return {
    students: rosterStudents,
    student_index: studentIndex,
    preferred_student_by_number: preferredStudentByNumber
  };
}

function doesAttendanceRecordMatchStudent_(record, studentId, studentNumber, studentsOrIndex) {
  record = record || {};
  studentId = parseInt(studentId, 10) || 0;
  studentNumber = parseInt(studentNumber, 10) || 0;

  var recordStudentId = parseInt(record.student_id, 10) || 0;
  if (studentId > 0 && recordStudentId > 0) {
    return recordStudentId === studentId;
  }

  if (studentId > 0) {
    return getResolvedRecordStudentKey_(record, studentsOrIndex || (getCachedStudentList_().all_students || [])) === ('id:' + studentId);
  }

  return studentNumber > 0 && (parseInt(record.student_number, 10) || 0) === studentNumber;
}

function deleteAttendanceDuplicateRows_(sheet, rowIndexes) {
  return deleteSheetRowsByIndexes_(sheet, rowIndexes);
}

 function buildAttendanceDailyPayload_(date, options) {
  options = options || {};
  var stepTimings = {};
  var stepStartedAt = new Date().getTime();
  var sourceInfo = options.source_info || null;
  var activeSemester = options.active_semester || (sourceInfo && sourceInfo.semester) || null;
  ensureStudentIdentityMigration_();
  stepTimings.preflight_migration_ms = new Date().getTime() - stepStartedAt;

  // ★ แยกย่อย preflight เพราะวัดแล้วพบว่ากินเวลา ~845 ms ตอน cache เย็น
  // ซึ่งมากกว่าการสร้างรายงานรายวันทั้งภาคเรียน (~1,250 ms) อย่างไม่สมเหตุผล
  // แต่ยังไม่รู้ว่าไปอยู่ที่ขั้นไหน · คง `preflight_validate_ms` เป็นผลรวมไว้
  // เพื่อให้เทียบกับ `_timing_log` ที่เก็บไว้ก่อนหน้าได้
  var preflightStartedAt = new Date().getTime();

  stepStartedAt = new Date().getTime();
  date = normalizeAttendanceDate_(date, false);
  if (!date) throw new Error('วันที่ไม่ถูกต้อง');
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  stepTimings.pf_source_ms = new Date().getTime() - stepStartedAt;

  stepStartedAt = new Date().getTime();
  var settings = options.settings || getCachedSettings_();
  var threshold = normalizeAbsenceAlertDays_(options.alert_threshold !== undefined ? options.alert_threshold : settings.absence_alert_days);
  stepTimings.pf_settings_ms = new Date().getTime() - stepStartedAt;

  stepStartedAt = new Date().getTime();
  primeAttendanceDailyCalendarEntries_(date, threshold);
  stepTimings.pf_calendar_prime_ms = new Date().getTime() - stepStartedAt;

  stepStartedAt = new Date().getTime();
  ensureAttendanceActionDate_(date, 'วันที่เช็คชื่อ', {
    active_semester: activeSemester,
    source_info: sourceInfo
  });
  stepTimings.pf_guard_ms = new Date().getTime() - stepStartedAt;

  stepTimings.preflight_validate_ms = new Date().getTime() - preflightStartedAt;
  stepTimings.preflight_ms = stepTimings.preflight_migration_ms + stepTimings.preflight_validate_ms;

  stepStartedAt = new Date().getTime();
  var students = getStudentsForAttendanceDate_(date);
  stepTimings.students_ms = new Date().getTime() - stepStartedAt;

  stepStartedAt = new Date().getTime();
  var rosterContext = buildAttendanceRosterContext_(students, date, options.roster_context);
  var daySnapshot = getCachedAttendanceDailySnapshot_(date, sourceInfo, {
    students: students,
    roster_context: rosterContext,
    capture_timing_detail: true
  });
  stepTimings.records_snapshot_ms = new Date().getTime() - stepStartedAt;

  stepStartedAt = new Date().getTime();
  var recordMap = daySnapshot.record_map || {};
  var dayStatus = getDayStatus_(date, sourceInfo);
  stepTimings.records_day_status_ms = new Date().getTime() - stepStartedAt;
  var batchInfo = daySnapshot.batch_info || null;
  stepTimings.records_ms = stepTimings.records_snapshot_ms + stepTimings.records_day_status_ms;
  if (daySnapshot && daySnapshot.__timing_detail) {
    stepTimings.records_snapshot_detail = daySnapshot.__timing_detail;
  }

  stepStartedAt = new Date().getTime();
  var summary = { present: 0, late: 0, absent: 0, sick_leave: 0, personal_leave: 0, unchecked: 0, total: students.length };
  var groupSet = {};
  var studentRows = [];
  for (var studentIndex = 0; studentIndex < students.length; studentIndex++) {
    var student = students[studentIndex] || {};
    var studentKey = student && student.__student_key ? student.__student_key : getStudentKey_(student);
    var record = recordMap[studentKey];
    var statusCode = record ? record.status_code : null;
    var statusInfo = statusCode ? STATUS_MAP[statusCode] : null;
    var groupName = String(student.group_name || '');

    if (statusCode && summary.hasOwnProperty(statusCode)) summary[statusCode]++;
    else summary.unchecked++;
    if (groupName) groupSet[groupName] = true;

    studentRows.push({
      id: student && student.__student_id_num || 0,
      student_number: student.student_number,
      full_name: student.full_name,
      nickname: student.nickname,
      gender: student.gender,
      group_name: groupName,
      is_flagged: !!student.is_flagged,
      attendance: statusCode ? {
        status_code: statusCode,
        status_label: statusInfo ? statusInfo.label : statusCode,
        status_icon: statusInfo ? statusInfo.icon : '?',
        status_color: statusInfo ? statusInfo.color : 'stone',
        note: record ? (record.note || '') : ''
      } : null
    });
  }
  summary.checked = summary.total - summary.unchecked;
  var groups = Object.keys(groupSet).sort();
  stepTimings.rows_ms = new Date().getTime() - stepStartedAt;

  stepStartedAt = new Date().getTime();
  var alerts = getCachedAlerts_(students, date, threshold, sourceInfo, {
    roster_context: rosterContext
  });
  stepTimings.alerts_ms = new Date().getTime() - stepStartedAt;

  var detail = Object.keys(stepTimings).map(function(key) {
    return key + '=' + stepTimings[key];
  }).join(';');

  var payload = {
    date: date,
    date_th: thaiDate(date, 'long', true),
    summary: summary,
    statuses: STATUSES,
    students: studentRows,
    groups: groups,
    day_status: dayStatus,
    active_batch: batchInfo,
    alerts: alerts,
    alert_threshold: threshold,
    calendar_state: buildAttendanceCalendarState_(date)
  };

  return options.capture_timing_detail ? attachAttendanceTimingDetail_(payload, detail) : payload;
}

function getAttendanceDaily(date, auth, options) {
  options = options || {};
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_attendance_daily',
    rate_limit_limit: 120,
    rate_limit_window_sec: 60
  }, function() {
    var activeSemester = null;
    try { activeSemester = getActiveSemesterRow_(); } catch (eSemester) {}
    var timingContext = String(options.timing_context || '').trim();
    var sourceInfo = activeSemester ? getAttendanceSourceInfoForSemester_(activeSemester) : buildDefaultAttendanceSourceInfo_();
    var payloadOptions = Object.assign({}, options, {
      active_semester: activeSemester,
      source_info: sourceInfo
    });
    if (timingContext) payloadOptions.capture_timing_detail = true;
    var timingMeta = {
      page: 'attendance',
      fn_name: 'getAttendanceDaily',
      date: String(date || ''),
      semester_id: activeSemester ? String(activeSemester.id || '') : '',
      semester_name: activeSemester ? String(activeSemester.name || '') : ''
    };
    if (timingContext) timingMeta.detail = 'context=' + timingContext;
    return measureTiming_('attendance_load_ms', timingMeta, function() {
      var payload = buildAttendanceDailyPayload_(date, payloadOptions);
      if (payload && payload.__timing_detail) {
        timingMeta.detail = (timingContext ? ('context=' + timingContext + ';') : '') + payload.__timing_detail;
      }
      return payload;
    });
  });
}

function recordAttendance(payload, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'record_attendance'
  }, function() {
    ensureStudentIdentityMigration_();
    payload = payload || {};

    var requestedStudentId = parseInt(payload.student_id, 10) || 0;
    var studentNumber = parseInt(payload.student_number, 10);
    var date = normalizeAttendanceDate_(payload.date, false);
    if (!date) return { success: false, message: 'วันที่ไม่ถูกต้อง' };
    try {
      ensureAttendanceActionDate_(date, 'วันที่เช็คชื่อ');
    } catch (e) {
      return buildFailurePayload_(e);
    }
    var statusCode = String(payload.status_code || '').trim();
    var note = '';
    try {
      note = normalizeLimitedText_(payload.note, 300, 'หมายเหตุ');
    } catch (e) {
      return buildFailurePayload_(e);
    }
    var student = getStudentForAttendanceDate_(date, requestedStudentId, studentNumber);
    var studentId = parseInt(student && student.id, 10) || 0;
    studentNumber = parseInt(student && student.student_number, 10) || studentNumber;

    if (!studentNumber) return { success: false, message: 'ไม่พบเลขที่นักเรียน' };
    if (!student) return { success: false, message: 'ไม่พบนักเรียนในวันที่เลือก' };
    if (!STATUS_MAP[statusCode]) return { success: false, message: 'สถานะไม่ถูกต้อง' };
    if (['late', 'absent', 'sick_leave', 'personal_leave'].indexOf(statusCode) < 0) note = '';

    return withAttendanceMutationLock_(function() {
      if (isDayConfirmed_(date)) return { success: false, message: 'วันนี้ถูกยืนยันแล้ว แก้ไขไม่ได้' };

      var sourceInfo = getCurrentAttendanceSourceInfo_();
      var sheet = getAttendanceSourceSheet_(sourceInfo);
      var rowIndex = -1;
      var oldStatus = '';
      var oldNote = '';
      // กรองเหลือเฉพาะแถวในชีตหลัก เพราะข้างล่างเอา row_index ไปเขียนทับชีตหลัก
      var matches = filterMainAttendanceRecords_(getRecordsByDate_(date), sourceInfo).filter(function(record) {
        return doesAttendanceRecordMatchStudent_(record, studentId, studentNumber);
      });
      if (matches.length) {
        rowIndex = matches[matches.length - 1].row_index;
        oldStatus = String(matches[matches.length - 1].status_code || '');
        oldNote = String(matches[matches.length - 1].note || '');
        deleteAttendanceDuplicateRows_(sheet, matches.slice(0, -1).map(function(record) {
          return record.row_index;
        }));
        rowIndex -= Math.max(0, matches.length - 1);
      }

      var now = nowString_();
      if (rowIndex > 0) {
        sheet.getRange(rowIndex, COL.ATTENDANCE.STATUS_CODE, 1, 3).setValues([[statusCode, sanitizeSheetText_(note), '']]);
        sheet.getRange(rowIndex, COL.ATTENDANCE.UPDATED_AT).setValue(now);
        sheet.getRange(rowIndex, COL.ATTENDANCE.STUDENT_ID).setValue(studentId);
      } else {
        // ★ ต้อง sanitize เหมือนกิ่ง update ข้างบน — หมายเหตุที่ขึ้นต้นด้วย = + - @
        // จะกลายเป็นสูตรในชีตแล้วไปโผล่เป็น #ERROR! บนรายงานและเอกสาร ปพ.6
        sheet.appendRow([getNextIdForSheet_(sheet), studentNumber, date, statusCode, sanitizeSheetText_(note), '', now, now, studentId]);
      }

      invalidateAttendanceCaches_(date);
      logAsync_(studentNumber, studentId, date, oldStatus, statusCode, oldNote, note, rowIndex > 0 ? 'update' : 'create');

      var statusInfo = STATUS_MAP[statusCode];
      return {
        success: true,
        message: statusInfo.icon + ' ' + statusInfo.label,
        data: { action: rowIndex > 0 ? 'update' : 'create' }
      };
    });
  });
}

function undoAttendance(payload, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'undo_attendance'
  }, function() {
    ensureStudentIdentityMigration_();
    payload = payload || {};

    var requestedStudentId = parseInt(payload.student_id, 10) || 0;
    var studentNumber = parseInt(payload.student_number, 10);
    var date = normalizeAttendanceDate_(payload.date, false);
    if (!date) return { success: false, message: 'วันที่ไม่ถูกต้อง' };
    try {
      ensureAttendanceActionDate_(date, 'วันที่เช็คชื่อ');
    } catch (e) {
      return buildFailurePayload_(e);
    }
    var student = getStudentForAttendanceDate_(date, requestedStudentId, studentNumber);
    var studentId = parseInt(student && student.id, 10) || 0;
    studentNumber = parseInt(student && student.student_number, 10) || studentNumber;

    if (!studentNumber) return { success: false, message: 'ไม่พบเลขที่นักเรียน' };
    if (!student) return { success: false, message: 'ไม่พบนักเรียนในวันที่เลือก' };
    return withAttendanceMutationLock_(function() {
      if (isDayConfirmed_(date)) return { success: false, message: 'วันนี้ถูกยืนยันแล้ว' };

      var sourceInfo = getCurrentAttendanceSourceInfo_();
      var sheet = getAttendanceSourceSheet_(sourceInfo);
      var matches = filterMainAttendanceRecords_(getRecordsByDate_(date), sourceInfo).filter(function(record) {
        return doesAttendanceRecordMatchStudent_(record, studentId, studentNumber);
      });
      if (!matches.length) return { success: false, message: 'ไม่พบรายการ' };

      var latestMatch = matches[matches.length - 1];
      deleteAttendanceDuplicateRows_(sheet, matches.map(function(record) {
        return record.row_index;
      }));
      invalidateAttendanceCaches_(date);
      logAsync_(studentNumber, studentId, date, String(latestMatch.status_code || ''), '', String(latestMatch.note || ''), '', 'undo');
      return { success: true, message: 'ยกเลิกแล้ว' };
    });
  });
}

function bulkMarkPresent(date, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'bulk_present'
  }, function() {
    ensureStudentIdentityMigration_();
    date = normalizeAttendanceDate_(date, false);
    if (!date) return { success: false, message: 'วันที่ไม่ถูกต้อง' };
    try {
      ensureAttendanceActionDate_(date, 'วันที่เช็คชื่อ');
    } catch (e) {
      return buildFailurePayload_(e);
    }
    return withAttendanceMutationLock_(function() {
      if (isDayConfirmed_(date)) return { success: false, message: 'วันนี้ถูกยืนยันแล้ว' };

      var students = getStudentsForAttendanceDate_(date);
      if (!students.length) return { success: false, message: 'ไม่มีนักเรียนในวันที่เลือก' };

      var studentIndex = buildStudentIdentityIndex_(students);
      var dayMap = buildRecordMapForStudents_(getUniqueLatestRecordsByDate_(date), studentIndex, { records_are_unique: true });

      var unchecked = students.filter(function(student) {
        return !dayMap[getStudentKey_(student)];
      });
      if (!unchecked.length) return { success: false, message: 'เช็คครบแล้ว' };

      var sourceInfo = getCurrentAttendanceSourceInfo_();
      var sheet = getAttendanceSourceSheet_(sourceInfo);
      var now = nowString_();
      var batchId = 'bulk_' + Utilities.getUuid();
      var baseId = getNextIdForSheet_(sheet);

      var rows = unchecked.map(function(student, index) {
        return [baseId + index, student.student_number, date, 'present', '', batchId, now, now, parseInt(student.id, 10) || ''];
      });

      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, COL.ATTENDANCE.STUDENT_ID).setValues(rows);
      invalidateAttendanceCaches_(date);
      logDayEvent_(date, 'bulk_present', '', 'present', 'batch=' + batchId, 'count=' + rows.length);

      return {
        success: true,
        message: 'เช็คมาทั้งหมด ' + rows.length + ' คน',
        data: { batch_id: batchId, count: rows.length }
      };
    });
  });
}

function undoBulkPresent(date, batchId, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'undo_bulk_present'
  }, function() {
    date = normalizeAttendanceDate_(date, false);
    if (!date) return { success: false, message: 'วันที่ไม่ถูกต้อง' };
    batchId = String(batchId || '').trim();
    if (!batchId || batchId === '__all__') {
      return { success: false, message: 'ไม่พบรหัสชุดรายการที่ต้องการยกเลิก' };
    }
    try {
      ensureAttendanceActionDate_(date, 'วันที่เช็คชื่อ');
    } catch (e) {
      return buildFailurePayload_(e);
    }

    return withAttendanceMutationLock_(function() {
      if (isDayConfirmed_(date)) return { success: false, message: 'วันนี้ถูกยืนยันแล้ว' };

      var sourceInfo = getCurrentAttendanceSourceInfo_();
      var sheet = getAttendanceSourceSheet_(sourceInfo);
      var rowIndexes = filterMainAttendanceRecords_(getRecordsByDate_(date), sourceInfo).filter(function(record) {
        return String(record.batch_id || '').trim() === batchId;
      }).map(function(record) {
        return record.row_index;
      });
      var deleted = rowIndexes.length;

      deleteAttendanceDuplicateRows_(sheet, rowIndexes);

      if (!deleted) {
        return { success: false, message: 'ไม่พบรายการเช็คมาทั้งหมดที่ยกเลิกได้' };
      }
      invalidateAttendanceCaches_(date);
      logDayEvent_(date, 'undo_bulk_present', 'present', '', 'requested_batch=' + batchId, 'count=' + deleted);
      return { success: true, message: 'ยกเลิก ' + deleted + ' คน' };
    });
  });
}

function confirmDay(date, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'confirm_day'
  }, function() {
    ensureStudentIdentityMigration_();
    date = normalizeAttendanceDate_(date, false);
    if (!date) return { success: false, message: 'วันที่ไม่ถูกต้อง' };
    try {
      ensureAttendanceActionDate_(date, 'วันที่เช็คชื่อ');
    } catch (e) {
      return buildFailurePayload_(e);
    }
    return withAttendanceMutationLock_(function() {
      if (isDayConfirmed_(date)) return { success: false, message: 'วันนี้ถูกยืนยันแล้ว' };

      var students = getStudentsForAttendanceDate_(date);
      var dayRecords = getRecordsByDate_(date);
      if (!students.length) return { success: false, message: 'ยังไม่มีนักเรียนในวันที่เลือก' };
      if (!dayRecords.length) return { success: false, message: 'ยังไม่มีข้อมูลเช็คชื่อ' };

      var studentIndex = buildStudentIdentityIndex_(students);
      var recordMap = buildRecordMapForStudents_(getUniqueLatestRecordsByDate_(date), studentIndex, { records_are_unique: true });

      var invalidStudents = students.filter(function(student) {
        var record = recordMap[getStudentKey_(student)];
        return !record || !isValidAttendanceStatusCode_(record.status_code);
      });
      if (invalidStudents.length > 0) {
        return { success: false, message: 'ยังเช็คชื่อไม่ครบหรือมีสถานะไม่ถูกต้อง เหลือ ' + invalidStudents.length + ' คน' };
      }

      saveDayStatus_(date, 'confirmed', nowString_());
      invalidateAttendanceCaches_(date);
      // ★ เคยอุ่น cache ตรงนี้ (mode 'confirm') วัดได้ 5.9-12 วินาที **ในล็อก ขณะครูรอ** — ตัดออกแล้ว
      // เพราะ client ไม่ยิงคำขอใดๆ ต่อหลังยืนยันสำเร็จ แค่วาดจอใหม่ฝั่งตัวเอง การอุ่นจึงเป็นการเดาล้วนๆ
      // และ unconfirmDay (mode 'draft') ไม่เคยอุ่นอยู่แล้ว · ดู DECISIONS.md ข้อ 38
      logDayEvent_(date, 'confirm_day', 'draft', 'confirmed', '', '');
      return { success: true, message: 'ยืนยันแล้ว' };
    });
  });
}

function unconfirmDay(date, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'unconfirm_day'
  }, function() {
    ensureStudentIdentityMigration_();
    date = normalizeAttendanceDate_(date, false);
    if (!date) return { success: false, message: 'วันที่ไม่ถูกต้อง' };
    try {
      ensureAttendanceActionDate_(date, 'วันที่เช็คชื่อ');
    } catch (e) {
      return buildFailurePayload_(e);
    }
    return withAttendanceMutationLock_(function() {
      var dayStatus = getDayStatus_(date);
      if (hasDayNotificationActivity_(date)) return { success: false, message: 'วันนี้มีการแจ้งผู้ปกครองแล้ว จึงยกเลิกการยืนยันไม่ได้' };
      if (dayStatus.status !== 'confirmed') return { success: false, message: 'วันนี้ยังไม่ได้ยืนยัน' };
      saveDayStatus_(date, 'draft', '');
      invalidateAttendanceCaches_(date);
      logDayEvent_(date, 'unconfirm_day', 'confirmed', 'draft', '', '');
      return { success: true, message: 'เปิดแก้ไขได้แล้ว' };
    });
  });
}

function getAttendanceAuditTrail(date, auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_attendance_audit_trail',
    rate_limit_limit: 60,
    rate_limit_window_sec: 60
  }, function() {
    ensureStudentIdentityMigration_();
    date = normalizeAttendanceDate_(date, false);
    if (!date) return { success: false, message: 'วันที่ไม่ถูกต้อง' };
    return {
      success: true,
      date: date,
      date_th: thaiDate(date, 'long', true),
      entries: getAttendanceAuditTrailEntries_(date)
    };
  });
}

function repairParentEmailNotifications(date, mode, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'repair_parent_email_notifications',
    rate_limit_limit: 20,
    rate_limit_window_sec: 300
  }, function() {
    date = normalizeAttendanceDate_(date, false);
    if (!date) return { success: false, message: 'วันที่ไม่ถูกต้อง' };
    mode = String(mode || '').trim().toLowerCase();
    if (['migrate', 'reset'].indexOf(mode) < 0) return { success: false, message: 'รูปแบบการซ่อมข้อมูลไม่ถูกต้อง' };
    try {
      ensureAttendanceActionDate_(date, 'วันที่เช็คชื่อ', {
        allow_holiday: true
      });
    } catch (e) {
      return buildFailurePayload_(e);
    }

    var dayStatus = getDayStatus_(date);
    var sentStudentKeys = getDayNotifiedStudentKeys_(date);
    var eligibleStudentKeys = getEligibleParentNotificationStudentKeys_(date);
    var isLegacyFullyNotified = !!dayStatus.notified_at && sentStudentKeys.length === 0;

    if (mode === 'migrate') {
      if (!isLegacyFullyNotified) {
        return { success: false, message: 'วันนี้ไม่มีสถานะแจ้งผู้ปกครองแบบเก่าที่ต้องย้าย' };
      }
      if (!eligibleStudentKeys.length) {
        return { success: false, message: 'ไม่พบผู้ปกครองที่พร้อมรับอีเมลสำหรับย้ายสถานะเดิม' };
      }
      saveDayNotifiedStudentKeys_(date, eligibleStudentKeys);
      logDayEvent_(date, 'migrate_notifications', '', '', 'legacy_notified_at=' + String(dayStatus.notified_at || ''), 'migrated=' + eligibleStudentKeys.length);
      return {
        success: true,
        message: 'ย้ายสถานะแจ้งผู้ปกครองเดิมแล้ว ' + eligibleStudentKeys.length + ' ราย',
        data: {
          migrated_count: eligibleStudentKeys.length,
          legacy_fully_notified: false
        }
      };
    }

    if (!isLegacyFullyNotified && !sentStudentKeys.length && !dayStatus.notified_at) {
      return { success: false, message: 'วันนี้ยังไม่มีสถานะแจ้งผู้ปกครองให้รีเซ็ต' };
    }

    clearDayNotificationState_(date);
    logDayEvent_(date, 'reset_notifications', '', '', 'previous_sent=' + sentStudentKeys.length + ';legacy=' + (isLegacyFullyNotified ? '1' : '0'), 'reset');
    return {
      success: true,
      message: 'รีเซ็ตสถานะแจ้งผู้ปกครองของวันนี้แล้ว',
      data: {
        reset: true,
        eligible_count: eligibleStudentKeys.length
      }
    };
  });
}

function getCachedStudentList_() {
  if (CACHED_STUDENT_LIST_MEMO_) return CACHED_STUDENT_LIST_MEMO_;
  var cache = CacheService.getScriptCache();
  var cached = cache.get('sl');
  if (cached) {
    try {
      CACHED_STUDENT_LIST_MEMO_ = rehydrateStudentListRuntimeFields_(JSON.parse(cached));
      return CACHED_STUDENT_LIST_MEMO_;
    } catch (e) {}
  }

  var data = rehydrateStudentListRuntimeFields_(getStudentListData_());
  try { cache.put('sl', JSON.stringify(data), 300); } catch (e) {}
  CACHED_STUDENT_LIST_MEMO_ = data;
  return CACHED_STUDENT_LIST_MEMO_;
}

function invalidateStudentCache_() {
  CACHED_STUDENT_LIST_MEMO_ = null;
  if (typeof STUDENTS_FOR_ATTENDANCE_DATE_MEMO_ !== 'undefined') STUDENTS_FOR_ATTENDANCE_DATE_MEMO_ = {};
  try { CacheService.getScriptCache().remove('sl'); } catch (e) {}
  bumpDerivedDataCacheVersion_();
}

function getCachedSettings_() {
  if (CACHED_SETTINGS_MEMO_) return CACHED_SETTINGS_MEMO_;
  var cache = CacheService.getScriptCache();
  var cached = cache.get('st');
  if (cached) {
    try {
      CACHED_SETTINGS_MEMO_ = JSON.parse(cached);
      return CACHED_SETTINGS_MEMO_;
    } catch (e) {}
  }

  var data = getSettings_();
  try { cache.put('st', JSON.stringify(data), 300); } catch (e) {}
  CACHED_SETTINGS_MEMO_ = data;
  return CACHED_SETTINGS_MEMO_;
}

function invalidateSettingsCache_() {
  CACHED_SETTINGS_MEMO_ = null;
  try { CacheService.getScriptCache().remove('st'); } catch (e) {}
}

function getAttendanceArchiveSheetName_(semester) {
  var semesterId = parseInt(semester && semester.id, 10) || 0;
  if (!(semesterId > 0)) throw new Error('ไม่พบภาคเรียนสำหรับข้อมูลเช็คชื่อย้อนหลัง');
  return ATTENDANCE_ARCHIVE_SHEET_PREFIX + String(semesterId);
}

function getAttendanceArchiveDaySheetName_(semester) {
  var semesterId = parseInt(semester && semester.id, 10) || 0;
  if (!(semesterId > 0)) throw new Error('ไม่พบภาคเรียนสำหรับข้อมูลสถานะวันย้อนหลัง');
  return ATTENDANCE_DAY_ARCHIVE_SHEET_PREFIX + String(semesterId);
}

function ensureAttendanceArchiveSheetSchema_(sheet) {
  // ต้องใช้ getMaxColumns ไม่ใช่ getLastColumn เพราะชีตที่เพิ่งสร้างยังว่าง
  // getLastColumn จะคืน 0 แล้ว insertColumnsAfter(0, n) จะ throw
  var maxColumns = sheet.getMaxColumns();
  if (maxColumns < COL.ATTENDANCE.STUDENT_ID) {
    sheet.insertColumnsAfter(maxColumns, COL.ATTENDANCE.STUDENT_ID - maxColumns);
  }
  sheet.getRange(1, 1, 1, COL.ATTENDANCE.STUDENT_ID).setValues([[
    'ID', 'เลขที่', 'วันที่', 'สถานะ', 'หมายเหตุ', 'Batch ID', 'บันทึกเมื่อ', 'แก้ไขเมื่อ', 'student_id'
  ]]);
  sheet.getRange(1, 1, 1, COL.ATTENDANCE.STUDENT_ID).setFontWeight('bold').setBackground('#f5f0eb');
  sheet.setFrozenRows(1);
  try { sheet.hideSheet(); } catch (e) {}
  return sheet;
}

function ensureAttendanceArchiveDaySheetSchema_(sheet) {
  var maxColumns = sheet.getMaxColumns();
  if (maxColumns < COL.ATT_DAYS.CONFIRMED_AT) {
    sheet.insertColumnsAfter(maxColumns, COL.ATT_DAYS.CONFIRMED_AT - maxColumns);
  }
  sheet.getRange(1, 1, 1, COL.ATT_DAYS.CONFIRMED_AT).setValues([[
    'วันที่', 'สถานะ', 'ยืนยันเมื่อ'
  ]]);
  sheet.getRange(1, 1, 1, COL.ATT_DAYS.CONFIRMED_AT).setFontWeight('bold').setBackground('#f5f0eb');
  sheet.setFrozenRows(1);
  try { sheet.hideSheet(); } catch (e) {}
  return sheet;
}

function getOrCreateAttendanceArchiveSheet_(semester) {
  var name = getAttendanceArchiveSheetName_(semester);
  var sheet = getSheetByNameOrNull_(name);
  if (!sheet) sheet = getSpreadsheet_().insertSheet(name);
  return ensureAttendanceArchiveSheetSchema_(sheet);
}

function getOrCreateAttendanceArchiveDaySheet_(semester) {
  var name = getAttendanceArchiveDaySheetName_(semester);
  var sheet = getSheetByNameOrNull_(name);
  if (!sheet) sheet = getSpreadsheet_().insertSheet(name);
  return ensureAttendanceArchiveDaySheetSchema_(sheet);
}

/**
 * ★ ตอบคำถามเดียวคือ "ต้องอ่านชีต archive ด้วยไหม" — ใช้กับ routing และ guard ตอนลบภาคเรียน
 * **ห้ามเอาไปตอบว่า "เก็บถาวรเสร็จหรือยัง"** สำหรับหน้าจอ ให้ใช้
 * `isSemesterAttendanceFullyArchived_` [SemesterService.js] ซึ่งเช็คด้วยว่าชีตหลักหมดแล้วจริง
 */
function isSemesterAttendanceArchived_(semester) {
  if (!semester || !(parseInt(semester.id, 10) || 0)) return false;
  var archiveSheet = getSheetByNameOrNull_(getAttendanceArchiveSheetName_(semester));
  var archiveDaySheet = getSheetByNameOrNull_(getAttendanceArchiveDaySheetName_(semester));
  return !!((archiveSheet && archiveSheet.getLastRow() > 1) || (archiveDaySheet && archiveDaySheet.getLastRow() > 1));
}

function getAttendanceSourceInfoForSemester_(semester) {
  var semesterId = parseInt(semester && semester.id, 10) || 0;
  var startDate = String(semester && semester.start_date || '');
  var endDate = String(semester && semester.end_date || '');
  // เดิมเงื่อนไขนี้มี `!semester.is_active` อยู่ด้วย ซึ่งทำให้ route ไปชีต archive ไม่ได้เลย
  // เพราะทุกเส้นทางที่แสดงผลส่งภาคเรียนที่ active เข้ามาเสมอ (ผ่าน getCurrentAttendanceSourceInfo_)
  // ผลคือครูที่เก็บถาวรแล้วสลับกลับมาดู จะไม่เห็นข้อมูลเลย ทั้งที่กล่องยืนยันสัญญาว่าดูได้
  var isArchived = !!(semester && isSemesterAttendanceArchived_(semester));

  // แยกชีตสำหรับ "เขียน" กับ "อ่าน" ออกจากกัน
  // เขียน → ชีตหลักเสมอ เพื่อไม่ให้ข้อมูลใหม่ไหลลงชีตซ่อน และเพื่อให้ row_index
  //         ที่ผู้เขียนใช้อ้างอิงแถว ชี้ไปที่ชีตเดียวเสมอ
  // อ่าน  → รวมชีต archive เข้ามาด้วยถ้ามี (ดู getAttendanceReadSheets_)
  return {
    key: (isArchived ? 'live+archive|' : 'live|') + String(semesterId || 'current'),
    semester: semester || null,
    semester_id: semesterId,
    from: startDate,
    to: endDate,
    is_archived: isArchived,
    attendance_sheet_name: SHEET.ATTENDANCE,
    attendance_day_sheet_name: SHEET.ATTENDANCE_DAYS,
    attendance_archive_sheet_name: isArchived ? getAttendanceArchiveSheetName_(semester) : '',
    attendance_day_archive_sheet_name: isArchived ? getAttendanceArchiveDaySheetName_(semester) : ''
  };
}

function buildDefaultAttendanceSourceInfo_() {
  return {
    key: 'live',
    semester: null,
    semester_id: 0,
    from: '',
    to: '',
    is_archived: false,
    attendance_sheet_name: SHEET.ATTENDANCE,
    attendance_day_sheet_name: SHEET.ATTENDANCE_DAYS
  };
}

function getCurrentAttendanceSourceInfo_() {
  if (CACHED_ATTENDANCE_SOURCE_INFO_MEMO_) return CACHED_ATTENDANCE_SOURCE_INFO_MEMO_;
  var activeSemester = null;
  try { activeSemester = getActiveSemesterRow_(); } catch (e) {}
  CACHED_ATTENDANCE_SOURCE_INFO_MEMO_ = activeSemester
    ? getAttendanceSourceInfoForSemester_(activeSemester)
    : buildDefaultAttendanceSourceInfo_();
  return CACHED_ATTENDANCE_SOURCE_INFO_MEMO_;
}

function getAttendanceSourceSheet_(sourceInfo) {
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  return getSheet_(sourceInfo.attendance_sheet_name || SHEET.ATTENDANCE);
}

function getAttendanceDaySourceSheet_(sourceInfo) {
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  return getSheet_(sourceInfo.attendance_day_sheet_name || SHEET.ATTENDANCE_DAYS);
}

/**
 * ชีตทั้งหมดที่ต้องอ่านรวมกันสำหรับ sourceInfo นี้
 *
 * ★ ลำดับสำคัญ: ชีต archive มาก่อน ชีตหลักมาทีหลังเสมอ
 * เพราะ getUniqueLatestRecords_ ใช้กติกา "แถวที่พบทีหลังชนะ" เวลามีคีย์ซ้ำ
 * ถ้าเรียงสลับ แถวเก่าในชีต archive จะไปทับแถวใหม่ในชีตหลักแบบเงียบๆ
 *
 * ชีต archive อาจไม่มีอยู่จริง (ยังไม่เคยเก็บถาวร) จึงใช้ getSheetByNameOrNull_
 */
// ★★ แยกรายการชีตออกเป็น 2 ชุด เพื่อให้ cache ของ 2 ส่วนมีอายุคนละแบบ — ดู DECISIONS.md ข้อ 37
// ห้ามเอาไปใช้แทน getAttendanceReadSheets_ ในเส้นทางที่ต้องการ "ทุกชีตตามลำดับเดิม"
function getArchiveAttendanceReadSheets_(sourceInfo) {
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  var name = String(sourceInfo.attendance_archive_sheet_name || '').trim();
  if (!name) return [];
  var sheet = getSheetByNameOrNull_(name);
  return sheet ? [sheet] : [];
}

function getMainAttendanceReadSheets_(sourceInfo) {
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  var sheet = getSheetByNameOrNull_(String(sourceInfo.attendance_sheet_name || SHEET.ATTENDANCE));
  return sheet ? [sheet] : [];
}

function getAttendanceReadSheets_(sourceInfo) {
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  return collectAttendanceReadSheets_(
    sourceInfo.attendance_archive_sheet_name,
    sourceInfo.attendance_sheet_name || SHEET.ATTENDANCE
  );
}

function getAttendanceDayReadSheets_(sourceInfo) {
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  return collectAttendanceReadSheets_(
    sourceInfo.attendance_day_archive_sheet_name,
    sourceInfo.attendance_day_sheet_name || SHEET.ATTENDANCE_DAYS
  );
}

function collectAttendanceReadSheets_(archiveName, mainName) {
  var sheets = [];
  archiveName = String(archiveName || '').trim();
  if (archiveName) {
    var archiveSheet = getSheetByNameOrNull_(archiveName);
    if (archiveSheet) sheets.push(archiveSheet);
  }
  var mainSheet = getSheetByNameOrNull_(String(mainName || ''));
  if (mainSheet) sheets.push(mainSheet);
  return sheets;
}

function isDateWithinAttendanceSource_(date, sourceInfo) {
  date = String(date || '').slice(0, 10);
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  if (!date) return false;
  if (sourceInfo.from && date < sourceInfo.from) return false;
  if (sourceInfo.to && date > sourceInfo.to) return false;
  return true;
}

function getCachedAttendanceDateBuckets_(sourceInfo) {
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  return getOrBuildLargeCachedJson_('attendance_date_buckets', [String(sourceInfo.key || 'live')], 180, function() {
    var buckets = {};
    getAllAttendanceRecords_(sourceInfo).forEach(function(record) {
      var date = String(record && record.date || '').slice(0, 10);
      if (!date) return;
      if (!buckets[date]) buckets[date] = [];
      buckets[date].push(record);
    });
    return buckets;
  });
}

 function primeAttendanceDailyCalendarEntries_(date, threshold) {
  date = String(date || '').slice(0, 10);
  if (!date) return;
  var thresholdDays = Math.max(1, parseInt(threshold, 10) || 0);
  var calendarDaysToPrime = Math.max(35, thresholdDays * 3);
  primeSchoolCalendarEntriesForRange_(shiftDate_(date, -calendarDaysToPrime), date);
 }

function ensureAttendanceActionDate_(date, label, options) {
  options = options || {};
  date = normalizeDateStringStrict_(date, label || 'วันที่');
  var activeSemester = options.active_semester || null;
  var allowHoliday = options.allow_holiday === true;
  if (activeSemester) {
    var semesterStart = String(activeSemester.start_date || activeSemester.from || '');
    var semesterEnd = String(activeSemester.end_date || activeSemester.to || '');
    if (!semesterStart || !semesterEnd) {
      ensureDateInActiveSemester_(date, label || 'วันที่');
    } else if (date < semesterStart || date > semesterEnd) {
      throw new Error('OUT_OF_SEMESTER|' + (label || 'วันที่') + ' อยู่นอกภาคเรียนที่เปิดใช้งานอยู่ (' + semesterStart + ' - ' + semesterEnd + ')');
    }
  } else {
    ensureDateInActiveSemester_(date, label || 'วันที่');
  }
  var calendarEntry = getSchoolCalendarEntryByDate_(date);
  if (!allowHoliday && calendarEntry && calendarEntry.type === 'holiday') {
    throw new Error('DATE_IS_HOLIDAY|' + (label || 'วันที่') + ' ตรงกับวันหยุดในปฏิทินวันเรียน');
  }
  return date;
}

/**
 * บอกหน้าเช็คชื่อว่าวันที่กำลังเช็คอยู่ในปฏิทินวันเรียนหรือยัง
 *
 * ที่ต้องมีเพราะเดิมครูเช็คชื่อในวันที่ไม่อยู่ในปฏิทินได้ตามปกติ กดยืนยันได้ ไม่มีอะไรเตือน
 * แต่ข้อมูลจะไม่ถูกนับในรายงานและบนเอกสาร ปพ.6 กว่าจะรู้ก็ตอนสิ้นเทอม
 *
 * เตือนเฉพาะกรณีที่ "มีปฏิทินอยู่แล้วแต่วันนี้ไม่อยู่ในนั้น" เท่านั้น
 */
function buildAttendanceCalendarState_(date) {
  var calendarState = {
    has_calendar: false,
    in_calendar: false,
    type: '',
    needs_calendar_fix: false
  };

  try {
    calendarState.has_calendar = hasAnySchoolCalendarEntries_();
    var entry = getSchoolCalendarEntryByDate_(date);
    if (entry) {
      calendarState.in_calendar = true;
      calendarState.type = String(entry.type || '');
    }
  } catch (e) {
    return calendarState;
  }

  calendarState.needs_calendar_fix = calendarState.has_calendar && !calendarState.in_calendar;
  return calendarState;
}

function getAttendanceAlertLookbackDates_(date, threshold) {
  date = String(date || '').slice(0, 10);
  if (!date) return [];
  var thresholdDays = Math.max(1, parseInt(threshold, 10) || 0);
  var maxLookbackDays = Math.max(15, thresholdDays);
  var lookbackDates = [];
  var currentDate = date;

  while (lookbackDates.length < maxLookbackDays) {
    var calendarEntry = getSchoolCalendarEntryByDate_(currentDate);
    var isWeekend = getIsoWeekday_(currentDate) === 0 || getIsoWeekday_(currentDate) === 6;
    var isSchoolDay = calendarEntry
      ? calendarEntry.type === 'school_day'
      : !isWeekend;

    if (isSchoolDay) {
      lookbackDates.push(currentDate);
    }
    currentDate = shiftDate_(currentDate, -1);
  }
  return lookbackDates;
}

function getCachedAlertLookbackRecords_(date, threshold, sourceInfo) {
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  date = String(date || '').slice(0, 10);
  if (!date) return [];
  var lookbackDates = getAttendanceAlertLookbackDates_(date, threshold);
  if (!lookbackDates.length) return [];
  return getOrBuildLargeCachedJson_('attendance_alert_lookback_records', [
    String(sourceInfo.key || 'live'),
    String(date || ''),
    String(threshold || '')
  ], 120, function() {
    var confirmedDates = getConfirmedAttendanceDateMap_(sourceInfo);
    var records = [];
    lookbackDates.forEach(function(cursorDate) {
      if (!confirmedDates[cursorDate]) return;
      var dayRecords = getUniqueLatestRecordsByDateFromSource_(cursorDate, sourceInfo);
      if (dayRecords && dayRecords.length) {
        records = records.concat(dayRecords);
      }
    });
    return records;
  });
}

function getCachedAlerts_(students, date, threshold, sourceInfo) {
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  var alertOptions = arguments[4] || {};
  return getOrBuildCachedJson_('attendance_alerts', [
    String(sourceInfo.key || 'live'),
    String(date || ''),
    String(threshold || '')
  ], 120, function() {
    return buildAlerts_(students, date, threshold, sourceInfo, alertOptions);
  });
}

 function buildAlertStatusByDateAndStudentKey_(records, rosterContext) {
   var statusByDate = {};
   var studentIndex = rosterContext && rosterContext.student_index ? rosterContext.student_index : { byId: {}, byNumber: {} };
   var preferredStudentByNumber = rosterContext && rosterContext.preferred_student_by_number ? rosterContext.preferred_student_by_number : {};
   (records || []).forEach(function(record) {
     var recordDate = String(record && record.date || '').slice(0, 10);
     if (!recordDate) return;
     var studentId = parseInt(record && record.student_id, 10) || 0;
     var studentNumber = parseInt(record && record.student_number, 10) || 0;
     var student = studentId > 0 && studentIndex.byId[studentId]
       ? studentIndex.byId[studentId]
       : (studentNumber > 0 ? (preferredStudentByNumber[studentNumber] || null) : null);
     var studentKey = student
       ? getStudentKey_(student)
       : ((record && record.student_key) || (studentId > 0 ? ('id:' + studentId) : (studentNumber > 0 ? ('num:' + studentNumber) : '')));
     if (!studentKey) return;
     if (!statusByDate[recordDate]) statusByDate[recordDate] = {};
     statusByDate[recordDate][studentKey] = String(record && record.status_code || '');
   });
   return statusByDate;
 }

function clearAttendanceDayStatusExecutionCache_(sourceInfo) {
  var sourceKey = sourceInfo && sourceInfo.key ? String(sourceInfo.key) : '';
  if (sourceKey) {
    try { delete ATTENDANCE_DAY_STATUS_MAP_MEMO_[sourceKey]; } catch (e) {}
    try { delete ATTENDANCE_CONFIRMED_DATE_MAP_MEMO_[sourceKey]; } catch (e2) {}
    return;
  }
  ATTENDANCE_DAY_STATUS_MAP_MEMO_ = {};
  ATTENDANCE_CONFIRMED_DATE_MAP_MEMO_ = {};
}

function invalidateAttendanceCaches_(date) {
  clearAttendanceDayStatusExecutionCache_();
  bumpDerivedDataCacheVersion_();
}

function normalizeAttendanceDate_(date, fallbackInvalid) {
  if (!date) return fallbackInvalid === false ? '' : todayString_();
  try {
    return normalizeDateStringStrict_(date, 'วันที่');
  } catch (e) {
    return fallbackInvalid ? todayString_() : '';
  }
}

function getRecordsByDate_(date) {
  ensureStudentIdentityMigration_();
  date = String(date || '').slice(0, 10);
  if (!date) return [];
  var sourceInfo = getCurrentAttendanceSourceInfo_();
  if (!isDateWithinAttendanceSource_(date, sourceInfo)) return [];
  var records = getCachedRawAttendanceRecordsByDate_(date, sourceInfo);
  return Array.isArray(records) ? records.slice() : [];
}

/**
 * ★ ต้องอ่านชีต archive ด้วย ไม่ใช่ชีตหลักอย่างเดียว
 * ไม่งั้นพอครูเก็บถาวรภาคเรียนแล้วเปิดวันเก่าในหน้าเช็คชื่อ จะเห็นทุกคนเป็น
 * "ยังไม่เช็ค" ทั้งที่หัวข้อบอกว่า "ยืนยันแล้ว" (สถานะวันอ่านผ่าน
 * getAttendanceDayReadSheets_ ซึ่งรวม archive อยู่แล้ว แต่ตัวเรคอร์ดไม่รวม)
 *
 * ★ ลำดับสำคัญ: archive มาก่อน ชีตหลักมาทีหลัง ตามกติกา "แถวที่พบทีหลังชนะ"
 * ของ getUniqueLatestRecords_
 *
 * ★ ทุกแถวติด sheet_name ไว้ เพราะ row_index ของสองชีตชนกันได้
 * ผู้ที่เอา row_index ไปเขียนต้องกรองด้วย isMainAttendanceRecord_ ก่อนเสมอ
 */
/**
 * ★ ตัวนี้**ไม่ได้ถูกเรียกจากเส้นทาง production แล้ว** ตั้งแต่ให้เส้นทางรายวัน
 * เสิร์ฟจาก `getCachedAttendanceDateBuckets_` แทน (ดู `getCachedRawAttendanceRecordsByDate_`)
 * เหลือไว้เป็น**ตัวอ้างอิงที่อ่านชีตตรงๆ** ให้ `attendance:daily_reads_archive`
 * [Diagnostics.js] เทียบกับเส้นทางถัง = กลายเป็นการตรวจว่าสองวิธีให้ผลตรงกัน
 * ซึ่งมีค่ามากกว่าเดิม **ห้ามลบทิ้งเพราะคิดว่าไม่มีใครใช้**
 */
function readAttendanceRecordsByDate_(date, sourceInfo) {
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  var records = [];
  getAttendanceReadSheets_(sourceInfo).forEach(function(sheet) {
    appendAttendanceRecordsByDateFromSheet_(records, sheet, date);
  });
  return records;
}

function appendAttendanceRecordsByDateFromSheet_(records, sheet, date) {
  if (!sheet) return;
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  date = String(date || '').slice(0, 10);
  if (!date) return;

  // ★★ ห้ามใช้ createTextFinder กับคอลัมน์วันที่
  // วัดแล้ว (calendar:date_lookup_vs_scan) ทุกชีตเก็บวันที่เป็น Date object เหมือนกันหมด
  // ตัวที่ตัดสินว่า TextFinder เจอหรือไม่ คือ number format ของเซลล์ ซึ่งมองไม่เห็นจากโค้ด
  // ชีตหลักได้ format yyyy-mm-dd ตามสตริงที่โค้ดพิมพ์ลงไป จึงแสดง 2026-05-18 แล้วเจอ
  // ชีต archive รับ Date object มาจาก getValues() จึงได้ format เริ่มต้น แสดง 18/5/2026
  // TextFinder จับจาก "ข้อความที่แสดง" จึงหาไม่เจอสักแถวในชีต archive แบบเงียบๆ
  // (getAllAttendanceRecords_ ไม่เจอปัญหานี้เพราะอ่าน getValues() แล้วผ่าน formatDate_)
  // → อ่านคอลัมน์วันที่มาเทียบเอง ใช้ได้ทั้งกรณีข้อความและ Date object
  var sheetName = sheet.getName();
  var dateValues = sheet.getRange(2, COL.ATTENDANCE.DATE, lastRow - 1, 1).getValues();
  var rowIndexes = [];
  for (var scan = 0; scan < dateValues.length; scan++) {
    if (formatDate_(dateValues[scan][0]) === date) rowIndexes.push(scan + 2);
  }
  if (!rowIndexes.length) return;

  function appendRowBlock_(fromRow, toRow) {
    var values = sheet.getRange(fromRow, 1, toRow - fromRow + 1, COL.ATTENDANCE.STUDENT_ID).getValues();
    values.forEach(function(row, index) {
      var studentNumber = parseInt(row[COL.ATTENDANCE.STUDENT_NUMBER - 1], 10) || 0;
      var studentId = parseInt(row[COL.ATTENDANCE.STUDENT_ID - 1], 10) || 0;
      var batchId = String(row[COL.ATTENDANCE.BATCH_ID - 1] || '').trim();
      records.push({
        id: row[COL.ATTENDANCE.ID - 1],
        student_number: studentNumber,
        student_id: studentId,
        student_key: studentId > 0 ? ('id:' + studentId) : ('num:' + studentNumber),
        date: date,
        status_code: String(row[COL.ATTENDANCE.STATUS_CODE - 1] || ''),
        note: String(row[COL.ATTENDANCE.NOTE - 1] || ''),
        batch_id: batchId,
        sheet_name: sheetName,
        row_index: fromRow + index
      });
    });
  }

  var blockStart = rowIndexes[0];
  var blockEnd = rowIndexes[0];
  for (var i = 1; i < rowIndexes.length; i++) {
    if (rowIndexes[i] === blockEnd + 1) {
      blockEnd = rowIndexes[i];
      continue;
    }
    appendRowBlock_(blockStart, blockEnd);
    blockStart = rowIndexes[i];
    blockEnd = rowIndexes[i];
  }
  appendRowBlock_(blockStart, blockEnd);
}

/**
 * แถวนี้อยู่ในชีตหลักไหม — ใช้กรองก่อนเอา row_index ไปเขียน/ลบเสมอ
 * แถวจากชีต archive มี row_index ที่ชนกับชีตหลักได้ ถ้าเผลอเอาไปใช้จะลบผิดแถวแบบเงียบๆ
 */
function isMainAttendanceRecord_(record, sourceInfo) {
  var mainName = (sourceInfo && sourceInfo.attendance_sheet_name) || SHEET.ATTENDANCE;
  var name = record && record.sheet_name ? String(record.sheet_name) : '';
  return !name || name === mainName;
}

function filterMainAttendanceRecords_(records, sourceInfo) {
  return (records || []).filter(function(record) {
    return isMainAttendanceRecord_(record, sourceInfo);
  });
}

function getCachedRawAttendanceRecordsByDate_(date, sourceInfo) {
  ensureStudentIdentityMigration_();
  date = String(date || '').slice(0, 10);
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  if (!date || !isDateWithinAttendanceSource_(date, sourceInfo)) return [];
  return getOrBuildCachedJson_('attendance_raw_date_records', [String(sourceInfo.key || 'live'), date], 180, function() {
    // ★★ เสิร์ฟจากถังที่แยกตามวันที่ไว้แล้ว แทนการสแกนคอลัมน์วันที่ทั้งชีต "ต่อหนึ่งวัน"
    // วัดได้ว่าการสแกนกินเวลา 2,200-3,700 ms ต่อวันที่ยังไม่มีใน cache
    // เพราะต้นทุนโตตามขนาดชีต archive (2,586 แถว) ไม่ใช่ตามข้อมูลของวันนั้น
    // ขณะที่ถังอ่านทั้งชีตครั้งเดียวแล้วใช้ได้ทุกวันพร้อมกัน
    //
    // ★ เทียบเท่าของเดิมทุกด้าน ตรวจแล้ว:
    // - ลำดับแถวตรงกัน ทั้งสองทางใช้ `getAttendanceReadSheets_` (archive ก่อน ชีตหลักทีหลัง)
    //   และไล่แถวจากน้อยไปมาก → กติกา "แถวหลังชนะ" ของ `getUniqueLatestRecords_` ไม่เปลี่ยน
    // - `sheet_name` / `row_index` มีครบใน `readAllAttendanceRecords_` [ReportService.js]
    //   เส้นทางเขียนที่กรองด้วย `filterMainAttendanceRecords_` จึงใช้ได้เหมือนเดิม
    // - ถังไม่มี `student_key` แต่ไม่มีใครพึ่งมันจริง — `getRecordStudentKey_` [StudentService.js]
    //   ปั้นคีย์จาก `student_id` / `student_number` ซึ่งถังมีครบ
    // - `row_index` จาก cache ไม่ค้าง เพราะ `invalidateAttendanceCaches_` เรียก
    //   `bumpDerivedDataCacheVersion_` ซึ่งล้าง derived cache ทุกตัวพร้อมกัน
    var buckets = getCachedAttendanceDateBuckets_(sourceInfo) || {};
    var dayRecords = buckets[date];
    return Array.isArray(dayRecords) ? dayRecords : [];
  });
}

function getUniqueLatestRecordsByDateFromSource_(date, sourceInfo) {
  ensureStudentIdentityMigration_();
  date = String(date || '').slice(0, 10);
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  if (!isDateWithinAttendanceSource_(date, sourceInfo)) return [];
  return getOrBuildCachedJson_('attendance_unique_date_records', [String(sourceInfo.key || 'live'), date], 180, function() {
    return getUniqueLatestRecords_(getCachedRawAttendanceRecordsByDate_(date, sourceInfo));
  });
}

function getUniqueLatestRecordsByDate_(date) {
  date = String(date || '').slice(0, 10);
  if (!date) return [];
  return getUniqueLatestRecordsByDateFromSource_(date);
}

function getCachedAttendanceDailySnapshot_(date, sourceInfo) {
  ensureStudentIdentityMigration_();
  date = String(date || '').slice(0, 10);
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  if (!date || !isDateWithinAttendanceSource_(date, sourceInfo)) {
    return { record_map: {}, batch_info: null };
  }
  var snapshotOptions = arguments[2] || {};
  var builtTimingDetail = '';
  var snapshot = getOrBuildCachedJson_('attendance_daily_snapshot', [String(sourceInfo.key || 'live'), date], 180, function() {
    var snapshotTimings = {};
    var snapshotStartedAt = new Date().getTime();
    var rawDayRecords = getCachedRawAttendanceRecordsByDate_(date, sourceInfo);
    snapshotTimings.raw_records_ms = new Date().getTime() - snapshotStartedAt;

    snapshotStartedAt = new Date().getTime();
    var rosterContext = buildAttendanceRosterContext_(
      Array.isArray(snapshotOptions.students) ? snapshotOptions.students : getStudentsForAttendanceDate_(date),
      date,
      snapshotOptions.roster_context
    );
    var studentIndex = rosterContext.student_index;
    var preferredStudentByNumber = rosterContext.preferred_student_by_number || {};
    var recordMap = {};
    var seenStudentKeys = {};
    var latestBatchId = '';
    var latestBatchCount = 0;
    for (var rawIndex = rawDayRecords.length - 1; rawIndex >= 0; rawIndex--) {
      var record = rawDayRecords[rawIndex];
      var batchId = record && record.batch_id ? record.batch_id : '';
      if (batchId) {
        if (!latestBatchId) latestBatchId = batchId;
        if (batchId === latestBatchId) latestBatchCount++;
      }

      var studentId = record && typeof record.student_id === 'number'
        ? record.student_id
        : (parseInt(record && record.student_id, 10) || 0);
      var studentNumber = record && typeof record.student_number === 'number'
        ? record.student_number
        : (parseInt(record && record.student_number, 10) || 0);
      var student = studentId > 0 && studentIndex.byId[studentId]
        ? studentIndex.byId[studentId]
        : (studentNumber > 0 ? (preferredStudentByNumber[studentNumber] || null) : null);
      var studentKey = student
        ? getStudentKey_(student)
        : ((record && record.student_key) || (studentId > 0 ? ('id:' + studentId) : (studentNumber > 0 ? ('num:' + studentNumber) : '')));
      if (!studentKey || seenStudentKeys[studentKey]) continue;
      seenStudentKeys[studentKey] = true;
      if (!student) continue;
      recordMap[studentKey] = record;
    }
    snapshotTimings.record_map_ms = new Date().getTime() - snapshotStartedAt;

    snapshotStartedAt = new Date().getTime();
    var batchInfo = latestBatchId ? {
      batch_id: latestBatchId,
      count: latestBatchCount,
      pending: false
    } : null;
    snapshotTimings.batch_info_ms = new Date().getTime() - snapshotStartedAt;
    builtTimingDetail = Object.keys(snapshotTimings).map(function(key) {
      return key + '=' + snapshotTimings[key];
    }).join(';');
    return {
      record_map: recordMap,
      batch_info: batchInfo
    };
  });
  if (snapshotOptions.capture_timing_detail && builtTimingDetail) {
    attachAttendanceTimingDetail_(snapshot, builtTimingDetail);
  }
  return snapshot;
}

function getDayStatus_(date, sourceInfo) {
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  if (!isDateWithinAttendanceSource_(date, sourceInfo)) {
    return { date: date, status: 'draft', confirmed_at: '', notified_at: getDayNotifiedAt_(date) };
  }
  var notifiedAt = getDayNotifiedAt_(date);
  var dayStatus = getCachedAttendanceDayStatusByDate_(date, sourceInfo);
  if (dayStatus) {
    return {
      date: date,
      status: String(dayStatus.status || 'draft'),
      confirmed_at: String(dayStatus.confirmed_at || ''),
      notified_at: notifiedAt
    };
  }
  return { date: date, status: 'draft', confirmed_at: '', notified_at: notifiedAt };
}

function isDayConfirmed_(date) {
  return getDayStatus_(date).status === 'confirmed';
}

function saveDayStatus_(date, status, confirmedAt) {
  var sourceInfo = getCurrentAttendanceSourceInfo_();
  var sheet = getAttendanceDaySourceSheet_(sourceInfo);
  var lastRow = sheet.getLastRow();

  if (lastRow > 1) {
    var data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < data.length; i++) {
      var rowDate = data[i][0] instanceof Date ? formatDate_(data[i][0]) : String(data[i][0] || '');
      if (rowDate === date) {
        sheet.getRange(i + 2, COL.ATT_DAYS.STATUS, 1, 2).setValues([[status, confirmedAt || '']]);
        clearAttendanceDayStatusExecutionCache_(sourceInfo);
        return;
      }
    }
  }

  sheet.appendRow([date, status, confirmedAt || '']);
  clearAttendanceDayStatusExecutionCache_(sourceInfo);
}

 function buildAlerts_(students, date, threshold, sourceInfo) {
  var absentCodeSet = { absent: true, sick_leave: true, personal_leave: true };
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  var alertOptions = arguments[4] || {};
  var studentList = students || [];
  var rosterContext = buildAttendanceRosterContext_(studentList, date, alertOptions.roster_context);
  var activeStudentKeys = [];
  var consecutiveByKey = {};
  threshold = Math.max(1, parseInt(threshold, 10) || 0);
  var lookbackDates = getAttendanceAlertLookbackDates_(date, threshold);
  var confirmedDates = getConfirmedAttendanceDateMap_(sourceInfo);
  var statusByDate = buildAlertStatusByDateAndStudentKey_(getCachedAlertLookbackRecords_(date, threshold, sourceInfo), rosterContext);

  studentList.forEach(function(student) {
    var studentKey = getStudentKey_(student);
    activeStudentKeys.push(studentKey);
    consecutiveByKey[studentKey] = 0;
  });

  for (var lookbackIndex = 0; lookbackIndex < lookbackDates.length; lookbackIndex++) {
    var cursorDate = lookbackDates[lookbackIndex];
    if (!activeStudentKeys.length) break;
    if (cursorDate === date && !confirmedDates[cursorDate]) continue;

    var statusByKey = confirmedDates[cursorDate] ? (statusByDate[cursorDate] || {}) : {};
    var nextActiveStudentKeys = [];
    for (var activeIndex = 0; activeIndex < activeStudentKeys.length; activeIndex++) {
      var studentKey = activeStudentKeys[activeIndex];
      var status = statusByKey[studentKey];
      if (absentCodeSet[status]) {
        consecutiveByKey[studentKey] = (consecutiveByKey[studentKey] || 0) + 1;
        nextActiveStudentKeys.push(studentKey);
      }
    }
    activeStudentKeys = nextActiveStudentKeys;
  }

  var alerts = [];
  studentList.forEach(function(student) {
    var studentKey = getStudentKey_(student);
    var consecutive = consecutiveByKey[studentKey] || 0;
    if (consecutive >= threshold) {
      alerts.push({
        student_number: student.student_number,
        full_name: student.full_name,
        nickname: student.nickname,
        consecutive_days: consecutive
      });
    }
  });

  alerts.sort(function(a, b) { return b.consecutive_days - a.consecutive_days; });
  return alerts;
}

/**
 * id ถัดไปของชีตประวัติแก้ไข อ่านเฉพาะแถวล่างสุดแทนการสแกนทั้งคอลัมน์
 * ใช้ได้เพราะเราต่อท้ายอย่างเดียวและตัดทิ้งจากด้านบน แถวล่างสุดจึงมี id มากที่สุดเสมอ
 */
function getNextChangeLogId_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 1;
  return (parseInt(sheet.getRange(lastRow, COL.LOG.ID).getValue(), 10) || 0) + 1;
}

/**
 * ตัดประวัติเก่าทิ้งเมื่อเกินเพดาน โดยปล่อยให้ล้นได้ระดับหนึ่งก่อนค่อยตัดทีเดียว
 * จะได้ไม่ต้องเรียก deleteRows ทุกครั้งที่เช็คชื่อ
 */
function trimChangeLogSheet_(sheet) {
  var overflow = sheet.getLastRow() - (CHANGE_LOG_MAX_ROWS + 1);
  if (overflow < CHANGE_LOG_TRIM_SLACK_ROWS) return 0;
  sheet.deleteRows(2, overflow);
  return overflow;
}

function logAsync_(studentNumber, studentId, date, oldStatus, newStatus, oldNote, newNote, action) {
  try {
    var sheet = getSheet_(SHEET.CHANGE_LOG);
    sheet.appendRow([
      getNextChangeLogId_(sheet),
      studentNumber,
      date,
      oldStatus || '',
      newStatus || '',
      // หมายเหตุเก่า/ใหม่เป็นข้อความที่ครูพิมพ์เอง ต้องกันสูตรก่อนลงชีตประวัติแก้ไข
      sanitizeSheetText_(oldNote || ''),
      sanitizeSheetText_(newNote || ''),
      action || '',
      nowString_(),
      studentId || ''
    ]);
    trimChangeLogSheet_(sheet);
  } catch (e) {}
}

function logDayEvent_(date, action, oldStatus, newStatus, oldNote, newNote) {
  logAsync_('', '', date, oldStatus, newStatus, oldNote, newNote, action);
}

function getAttendanceAuditTrailEntries_(date) {
  var sheet = getSheet_(SHEET.CHANGE_LOG);
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  var rows = sheet.getRange(2, 1, lastRow - 1, COL.LOG.STUDENT_ID).getValues();
  var studentIndex = buildStudentIdentityIndex_(getStudentListData_().all_students || []);
  var entries = [];

  rows.forEach(function(row) {
    var rowDate = row[COL.LOG.DATE - 1] instanceof Date ? formatDate_(row[COL.LOG.DATE - 1]) : String(row[COL.LOG.DATE - 1] || '');
    if (rowDate !== date) return;

    var studentNumber = parseInt(row[COL.LOG.STUDENT_NUMBER - 1], 10) || 0;
    var studentId = parseInt(row[COL.LOG.STUDENT_ID - 1], 10) || 0;
    var student = studentId > 0 && studentIndex.byId[studentId]
      ? studentIndex.byId[studentId]
      : (studentNumber > 0 ? studentIndex.byNumber[studentNumber] : null);
    var oldStatus = String(row[COL.LOG.OLD_STATUS - 1] || '');
    var newStatus = String(row[COL.LOG.NEW_STATUS - 1] || '');
    var action = String(row[COL.LOG.ACTION - 1] || '');

    entries.push({
      id: parseInt(row[COL.LOG.ID - 1], 10) || 0,
      student_number: studentNumber,
      student_id: studentId,
      full_name: student ? String(student.full_name || '') : '',
      nickname: student ? String(student.nickname || '') : '',
      action: action,
      action_label: getAttendanceAuditActionLabel_(action),
      old_status: oldStatus,
      old_status_label: oldStatus && STATUS_MAP[oldStatus] ? STATUS_MAP[oldStatus].label : '',
      new_status: newStatus,
      new_status_label: newStatus && STATUS_MAP[newStatus] ? STATUS_MAP[newStatus].label : '',
      old_note: String(row[COL.LOG.OLD_NOTE - 1] || ''),
      new_note: String(row[COL.LOG.NEW_NOTE - 1] || ''),
      changed_at: normalizeTimestampValue_(row[COL.LOG.CHANGED_AT - 1]),
      // ★ changed_at ต้องคงรูปแบบ YYYY-MM-DD HH:mm:ss ไว้ เพราะ entries.sort ข้างล่าง
      // เรียงด้วย localeCompare ของสตริงนี้ตรงๆ · ตัวไทยเป็นฟิลด์แยกไว้ให้หน้าจอใช้
      changed_at_th: formatAuditTimestampTh_(normalizeTimestampValue_(row[COL.LOG.CHANGED_AT - 1])),
      is_day_event: studentNumber <= 0 && studentId <= 0
    });
  });

  entries.sort(function(a, b) {
    return String(b.changed_at || '').localeCompare(String(a.changed_at || '')) || ((b.id || 0) - (a.id || 0));
  });
  return entries.slice(0, 120);
}

/**
 * แปลง 'YYYY-MM-DD HH:mm:ss' เป็น 'ส. 16 ส.ค. 2569 15:11 น.'
 * ทั้งระบบใช้ปี พ.ศ. ประวัติแก้ไขเป็นที่เดียวที่ยังโผล่ปี ค.ศ. ให้ครูเห็น
 */
function formatAuditTimestampTh_(value) {
  var text = String(value || '').trim();
  if (!text) return '';
  var datePart = text.slice(0, 10);
  var timePart = text.length >= 16 ? text.slice(11, 16) : '';
  var label = thaiDate(datePart, 'short', true);
  if (!label || label === datePart) return text;
  return timePart ? (label + ' ' + timePart + ' น.') : label;
}

function getAttendanceAuditActionLabel_(action) {
  var map = {
    create: 'บันทึกสถานะ',
    update: 'แก้ไขสถานะ',
    undo: 'ยกเลิกสถานะ',
    bulk_present: 'เช็คมาทั้งหมด',
    undo_bulk_present: 'ยกเลิกเช็คมาทั้งหมด',
    confirm_day: 'ยืนยันวัน',
    unconfirm_day: 'ยกเลิกการยืนยัน',
    migrate_notifications: 'ย้ายสถานะแจ้งผู้ปกครองเดิม',
    reset_notifications: 'รีเซ็ตการแจ้งผู้ปกครอง'
  };
  return map[action] || action || 'แก้ไขข้อมูล';
}

function getCachedAttendanceDayStatusMap_(sourceInfo) {
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  var sourceKey = String(sourceInfo.key || 'live');
  if (ATTENDANCE_DAY_STATUS_MAP_MEMO_.hasOwnProperty(sourceKey)) {
    return ATTENDANCE_DAY_STATUS_MAP_MEMO_[sourceKey];
  }
  var dayStatusMap = getOrBuildCachedJson_('attendance_day_status_map', [sourceKey], 300, function() {
    var dayStatusMap = {};
    // อ่านรวมชีต archive ด้วย โดยชีตหลักมาทีหลังจึงเขียนทับค่าเดิมเมื่อวันซ้ำกัน
    getAttendanceDayReadSheets_(sourceInfo).forEach(function(sheet) {
      var lastRow = sheet ? sheet.getLastRow() : 0;
      if (lastRow <= 1) return;

      var data = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
      for (var i = 0; i < data.length; i++) {
        var rowDate = data[i][0];
        rowDate = rowDate instanceof Date ? formatDate_(rowDate) : String(rowDate || '').slice(0, 10);
        if (!rowDate) continue;
        dayStatusMap[rowDate] = {
          status: String(data[i][1] || 'draft'),
          confirmed_at: String(data[i][2] || '')
        };
      }
    });
    return dayStatusMap;
  });
  ATTENDANCE_DAY_STATUS_MAP_MEMO_[sourceKey] = dayStatusMap;
  return dayStatusMap;
}

function getCachedAttendanceDayStatusByDate_(date, sourceInfo) {
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  date = String(date || '').slice(0, 10);
  if (!date) return null;
  var dayStatusMap = getCachedAttendanceDayStatusMap_(sourceInfo);
  var dayStatus = dayStatusMap && dayStatusMap[date] ? dayStatusMap[date] : null;
  return dayStatus ? {
    status: String(dayStatus.status || 'draft'),
    confirmed_at: String(dayStatus.confirmed_at || '')
  } : null;
}

function getConfirmedAttendanceDateMap_(sourceInfo) {
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  var sourceKey = String(sourceInfo.key || 'live');
  if (ATTENDANCE_CONFIRMED_DATE_MAP_MEMO_.hasOwnProperty(sourceKey)) {
    return ATTENDANCE_CONFIRMED_DATE_MAP_MEMO_[sourceKey];
  }
  var dayStatusMap = getCachedAttendanceDayStatusMap_(sourceInfo);
  var confirmedDates = {};
  Object.keys(dayStatusMap || {}).forEach(function(date) {
    if (String(dayStatusMap[date] && dayStatusMap[date].status || '').trim() === 'confirmed') {
      confirmedDates[date] = true;
    }
  });
  ATTENDANCE_CONFIRMED_DATE_MAP_MEMO_[sourceKey] = confirmedDates;
  return confirmedDates;
}

function getCachedConfirmedAttendanceRecords_() {
  var sourceInfo = arguments[0] || getCurrentAttendanceSourceInfo_();
  return getOrBuildLargeCachedJson_('attendance_confirmed_records', [String(sourceInfo.key || 'live')], 180, function() {
    var confirmedDates = getConfirmedAttendanceDateMap_(sourceInfo);
    var dateBuckets = getCachedAttendanceDateBuckets_(sourceInfo);
    var dates = Object.keys(confirmedDates).sort();
    if (!dates.length) return [];
    var records = [];
    dates.forEach(function(date) {
      if (dateBuckets[date] && dateBuckets[date].length) {
        records = records.concat(dateBuckets[date]);
      }
    });
    return getUniqueLatestRecords_(records);
  });
}

function getCachedConfirmedAttendanceRange_(from, to, sourceInfo) {
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  from = String(from || '').slice(0, 10);
  to = String(to || '').slice(0, 10);
  if (!from || !to || to < from) return [];
  return getOrBuildLargeCachedJson_('attendance_confirmed_range', [String(sourceInfo.key || 'live'), from, to], 180, function() {
    var confirmedDates = getConfirmedAttendanceDateMap_(sourceInfo);
    var dateBuckets = getCachedAttendanceDateBuckets_(sourceInfo);
    var dates = generateDateList_(from, to);
    var records = [];
    dates.forEach(function(date) {
      if (!confirmedDates[date]) return;
      if (dateBuckets[date] && dateBuckets[date].length) {
        records = records.concat(dateBuckets[date]);
      }
    });
    return getUniqueLatestRecords_(records);
  });
}

function getAttendanceBasisDays_(totalDays, excusedLeaveDays) {
  totalDays = parseInt(totalDays, 10) || 0;
  excusedLeaveDays = parseInt(excusedLeaveDays, 10) || 0;
  return Math.max(0, totalDays - excusedLeaveDays);
}

function buildAttendanceComputationContext_(range, records, studentsOrIndex, options) {
  range = range || {};
  var normalizedRecords = options && options.records_are_unique && Array.isArray(records)
    ? records
    : getUniqueLatestRecords_(records || [], studentsOrIndex, options);
  var confirmedDateSet = {};
  var recordCountsByDate = {};
  normalizedRecords.forEach(function(record) {
    if (record && record.date) {
      var recordDate = String(record.date);
      confirmedDateSet[recordDate] = true;
      recordCountsByDate[recordDate] = (recordCountsByDate[recordDate] || 0) + 1;
    }
  });

  var calendarEntries = getSchoolCalendarEntriesForRange_(range);
  var calendarSchoolDaySet = {};
  var holidaySet = {};
  calendarEntries.forEach(function(entry) {
    if (!entry || !entry.date) return;
    if (entry.type === 'holiday') holidaySet[entry.date] = true;
    if (entry.type === 'school_day') calendarSchoolDaySet[entry.date] = true;
  });

  var confirmedDates = Object.keys(confirmedDateSet).sort();
  var calendarSchoolDays = Object.keys(calendarSchoolDaySet).sort();
  var usesCalendar = calendarSchoolDays.length > 0;
  var effectiveSchoolDays = usesCalendar ? calendarSchoolDays.slice() : confirmedDates.slice();
  var effectiveSchoolDaySet = {};
  var measurementDayDates = usesCalendar
    ? calendarSchoolDays.filter(function(date) { return !!confirmedDateSet[date]; })
    : confirmedDates.slice();
  var measurementDaySet = {};
  effectiveSchoolDays.forEach(function(date) {
    effectiveSchoolDaySet[date] = true;
  });
  measurementDayDates.forEach(function(date) {
    measurementDaySet[date] = true;
  });

  var filteredRecords = normalizedRecords.filter(function(record) {
    return !!effectiveSchoolDaySet[String(record.date || '')];
  });

  var missingConfirmedDates = [];
  var extraConfirmedDates = [];
  if (usesCalendar) {
    calendarSchoolDays.forEach(function(date) {
      if (!confirmedDateSet[date]) missingConfirmedDates.push(date);
    });
    confirmedDates.forEach(function(date) {
      if (!calendarSchoolDaySet[date]) extraConfirmedDates.push(date);
    });
  }

  return {
    uses_calendar: usesCalendar,
    confirmed_dates: confirmedDates,
    confirmed_dates_count: confirmedDates.length,
    school_day_dates: effectiveSchoolDays,
    school_day_dates_count: effectiveSchoolDays.length,
    school_day_map: effectiveSchoolDaySet,
    measurement_day_dates: measurementDayDates,
    measurement_day_dates_count: measurementDayDates.length,
    measurement_day_map: measurementDaySet,
    holiday_count: Object.keys(holidaySet).length,
    record_counts_by_date: recordCountsByDate,
    filtered_records: filteredRecords,
    missing_confirmed_dates: missingConfirmedDates,
    extra_confirmed_dates: extraConfirmedDates,
    has_calendar_mismatch: usesCalendar && (missingConfirmedDates.length > 0 || extraConfirmedDates.length > 0),
    warning_message: buildAttendanceCalendarWarningMessage_(usesCalendar, missingConfirmedDates, extraConfirmedDates)
  };
}

function buildAttendanceCalendarWarningMessage_(usesCalendar, missingConfirmedDates, extraConfirmedDates) {
  if (!usesCalendar) return '';
  var parts = [];
  if ((missingConfirmedDates || []).length > 0) {
    parts.push('ยังมีวันเรียนตามปฏิทินที่ยังไม่ได้ยืนยัน ' + missingConfirmedDates.length + ' วัน');
  }
  if ((extraConfirmedDates || []).length > 0) {
    parts.push('มีข้อมูลเช็คชื่อที่ยืนยันแล้วในวันที่ไม่ใช่วันเรียน ' + extraConfirmedDates.length + ' วัน');
  }
  return parts.join(' และ ');
}

function findSortedDateInsertionIndex_(dates, target) {
  var low = 0;
  var high = (dates && dates.length) || 0;
  while (low < high) {
    var mid = Math.floor((low + high) / 2);
    if (String(dates[mid] || '') < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function getStudentSchoolDayCountForContext_(student, context) {
  var dates = (context && context.measurement_day_dates) || (context && context.school_day_dates) || [];
  if (!student || !dates.length) return 0;
  var cache = context && context.__student_school_day_count_by_key;
  var studentKey = getStudentKey_(student);
  if (cache && cache.hasOwnProperty(studentKey)) return cache[studentKey];

  var bounds = getStudentRosterBounds_(student);
  var startIndex = bounds.start ? findSortedDateInsertionIndex_(dates, bounds.start) : 0;
  var endIndex = bounds.end ? findSortedDateInsertionIndex_(dates, bounds.end) : dates.length;
  var count = Math.max(0, endIndex - startIndex);

  if (context) {
    if (!cache) {
      cache = {};
      try {
        Object.defineProperty(context, '__student_school_day_count_by_key', {
          value: cache,
          writable: true,
          configurable: true,
          enumerable: false
        });
      } catch (e) {
        context.__student_school_day_count_by_key = cache;
      }
    }
    cache[studentKey] = count;
  }
  return count;
}

function buildStudentAttendanceStatsForContext_(student, recordBuckets, context) {
  var counts = { present: 0, late: 0, absent: 0, sick_leave: 0, personal_leave: 0 };
  var schoolDays = getStudentSchoolDayCountForContext_(student, context);
  var rawStudentRecords = getRecordsForStudent_(recordBuckets, student);
  var studentRecords = recordBuckets && recordBuckets.__filtered_to_school_days
    ? rawStudentRecords
    : rawStudentRecords.filter(function(record) {
        return !!(context && context.measurement_day_map && context.measurement_day_map[record.date]);
      });

  studentRecords.forEach(function(record) {
    if (counts.hasOwnProperty(record.status_code)) counts[record.status_code]++;
  });

  var excusedLeaveDays = counts.sick_leave + counts.personal_leave;
  var basisDays = getAttendanceBasisDays_(schoolDays, excusedLeaveDays);
  var attendancePercent = calculateAttendancePercent_(counts.present, counts.late, schoolDays, excusedLeaveDays);

  return {
    counts: counts,
    school_days: schoolDays,
    recorded_days: studentRecords.length,
    excused_leave_days: excusedLeaveDays,
    basis_days: basisDays,
    attend_days: counts.present + counts.late,
    attendance_percent: attendancePercent,
    records: studentRecords
  };
}

function isValidAttendanceStatusCode_(statusCode) {
  return !!STATUS_MAP[String(statusCode || '').trim()];
}

function calculateAttendancePercent_(presentCount, lateCount, totalDays, excusedLeaveDays) {
  var basisDays = getAttendanceBasisDays_(totalDays, excusedLeaveDays);
  if (basisDays <= 0) return null;

  var attendDays = (parseInt(presentCount, 10) || 0) + (parseInt(lateCount, 10) || 0);
  if (attendDays > basisDays) attendDays = basisDays;
  return Math.round((attendDays / basisDays) * 1000) / 10;
}

function getDayNotificationKey_(date) {
  return 'attendance_day_notified_' + String(date || '');
}

function getDayNotificationRecipientsKey_(date) {
  return 'attendance_day_notified_students_' + String(date || '');
}

function getDayNotifiedAt_(date) {
  return String(getCachedSettings_()[getDayNotificationKey_(date)] || '');
}

function getDayNotifiedStudentKeys_(date) {
  var raw = getCachedSettings_()[getDayNotificationRecipientsKey_(date)] || '[]';
  try {
    var items = JSON.parse(raw);
    if (!items || !items.forEach) return [];
    var seen = {};
    var keys = [];
    items.forEach(function(item) {
      var key = String(item || '').trim();
      if (!key || seen[key]) return;
      seen[key] = true;
      keys.push(key);
    });
    return keys;
  } catch (e) {
    return [];
  }
}

function saveDayNotifiedStudentKeys_(date, studentKeys) {
  var unique = [];
  var seen = {};
  (studentKeys || []).forEach(function(item) {
    var key = String(item || '').trim();
    if (!key || seen[key]) return;
    seen[key] = true;
    unique.push(key);
  });
  if (!unique.length) {
    try { removeSetting_(getDayNotificationRecipientsKey_(date)); } catch (e) {}
    return;
  }
  saveSetting_(getDayNotificationRecipientsKey_(date), JSON.stringify(unique));
}

function markDayStudentsNotified_(date, studentKeys) {
  var merged = getDayNotifiedStudentKeys_(date).concat(studentKeys || []);
  saveDayNotifiedStudentKeys_(date, merged);
}

function clearDayNotificationState_(date) {
  try { removeSetting_(getDayNotificationKey_(date)); } catch (e) {}
  try { removeSetting_(getDayNotificationRecipientsKey_(date)); } catch (e2) {}
}

function getEligibleParentNotificationStudentKeys_(date) {
  var notifyCodes = ['absent', 'late', 'sick_leave', 'personal_leave'];
  var records = getCachedConfirmedAttendanceRange_(date, date);
  var students = getOfficialStudentsForRange_({ from: date, to: date }, records);
  var studentIndex = buildStudentIdentityIndex_(students);
  var recordMap = buildRecordMapForStudents_(records, studentIndex, { records_are_unique: true });
  var keys = [];
  students.forEach(function(student) {
    var record = recordMap[getStudentKey_(student)];
    if (!record || notifyCodes.indexOf(record.status_code) < 0) return;
    if (!isValidEmailValue_(student.parent_email)) return;
    keys.push(getStudentKey_(student));
  });
  return keys;
}

function clearHolidayAttendance(date, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'clear_holiday_attendance'
  }, function() {
    date = normalizeAttendanceDate_(date, false);
    if (!date) return { success: false, message: 'วันที่ไม่ถูกต้อง' };

    var calendarEntry = getSchoolCalendarEntryByDate_(date);
    if (!calendarEntry || calendarEntry.type !== 'holiday') {
      return { success: false, message: 'วันที่เลือกไม่ได้ถูกตั้งเป็นวันหยุด จึงไม่สามารถล้างข้อมูลด้วยคำสั่งนี้ได้' };
    }

    if (hasDayNotificationActivity_(date)) {
      return { success: false, message: 'วันนี้มีการแจ้งผู้ปกครองแล้ว จึงล้างข้อมูลวันหยุดนี้ไม่ได้' };
    }

    return withAttendanceMutationLock_(function() {
      var sourceInfo = getCurrentAttendanceSourceInfo_();
      var attendanceSheet = getAttendanceSourceSheet_(sourceInfo);
      var dayStatusSheet = getAttendanceDaySourceSheet_(sourceInfo);
      var dayRecords = filterMainAttendanceRecords_(getRecordsByDate_(date), sourceInfo);
      var deletedRecords = dayRecords.length;
      deleteSheetRowsByIndexes_(attendanceSheet, dayRecords.map(function(record) {
        return record.row_index;
      }));

      var lastRow = dayStatusSheet.getLastRow();
      if (lastRow > 1) {
        var data = dayStatusSheet.getRange(2, 1, lastRow - 1, 1).getValues();
        var dayStatusRowIndexes = [];
        for (var j = data.length - 1; j >= 0; j--) {
          var rowDate = data[j][0] instanceof Date ? formatDate_(data[j][0]) : String(data[j][0] || '');
          if (rowDate === date) {
            dayStatusRowIndexes.push(j + 2);
          }
        }
        deleteSheetRowsByIndexes_(dayStatusSheet, dayStatusRowIndexes);
      }

      clearDayNotificationState_(date);
      invalidateAttendanceCaches_(date);
      // ★ เคยอุ่น cache ตรงนี้ วัดได้ 4.5-5.6 วินาที **ในล็อก ขณะครูรอ** — ตัดออกแล้ว
      // client ยิง getSummaryTable / getDailyGrid ต่อทันทีอยู่แล้ว และทั้งคู่ cache ให้เอง
      // การอุ่นก่อนจึงเป็นงานเดิมที่ถูกย้ายเข้าไปทำในล็อก ไม่ได้เร็วขึ้นเลย
      // ซ้ำร้ายมันอุ่น "เดือนของวันที่ล้าง" แต่ client ขอ "ช่วงที่เลือกในหน้ารายงาน" ซึ่งมักไม่ตรงกัน
      // ดู DECISIONS.md ข้อ 46

      return {
        success: true,
        message: deletedRecords > 0
          ? 'ล้างข้อมูลเช็คชื่อในวันหยุด ' + thaiDate(date, 'long', false) + ' แล้ว'
          : 'ไม่พบข้อมูลเช็คชื่อในวันหยุดที่ต้องล้าง',
        data: {
          date: date,
          deleted_records: deletedRecords
        }
      };
    });
  });
}

function hasDayNotificationActivity_(date) {
  return getDayNotifiedStudentKeys_(date).length > 0 || !!getDayNotifiedAt_(date);
}

function markDayNotified_(date, notifiedAt) {
  saveSetting_(getDayNotificationKey_(date), notifiedAt || nowString_());
}
