/**
 * Teacher-managed parent links and public parent view.
 */

var PARENT_LINK_SHEET = 'ลิงก์ผู้ปกครอง';
var PARENT_LINK_COL = {
  STUDENT_NUMBER: 1,
  TOKEN: 2,
  TOKEN_HASH: 3,
  CREATED_AT: 4,
  EXPIRES_AT: 5,
  REVOKED: 6,
  STUDENT_ID: 7
};

function revokeAllParentLinks_() {
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    var sheet = getOrCreateParentLinkSheet_();
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return 0;

    var rows = sheet.getRange(2, 1, lastRow - 1, PARENT_LINK_COL.STUDENT_ID).getValues();
    var changed = 0;
    for (var i = 0; i < rows.length; i++) {
      if (
        String(rows[i][PARENT_LINK_COL.TOKEN - 1] || '').trim() ||
        String(rows[i][PARENT_LINK_COL.TOKEN_HASH - 1] || '').trim() ||
        !(rows[i][PARENT_LINK_COL.REVOKED - 1] === true || String(rows[i][PARENT_LINK_COL.REVOKED - 1]).toUpperCase() === 'TRUE')
      ) {
        changed++;
      }
      rows[i][PARENT_LINK_COL.TOKEN - 1] = '';
      rows[i][PARENT_LINK_COL.TOKEN_HASH - 1] = '';
      rows[i][PARENT_LINK_COL.REVOKED - 1] = true;
    }
    sheet.getRange(2, 1, lastRow - 1, PARENT_LINK_COL.STUDENT_ID).setValues(rows);
    return changed;
  } finally {
    lock.releaseLock();
  }
}

function getParentLink(studentNumber, auth) {
  return issueParentLinkForTeacher_(studentNumber, auth, 'get_parent_link');
}

function openParentSession(token, month) {
  token = String(token || '').trim();
  if (!token || token.length < 24) {
    return { success: false, message: 'ลิงก์ไม่ถูกต้องหรือหมดอายุ' };
  }

  var link;
  try {
    link = validateParentLinkToken_(token);
  } catch (e) {
    return { success: false, message: String(e && e.message ? e.message : e || 'ไม่สามารถเปิดลิงก์ได้') };
  }
  if (!link) {
    return { success: false, message: 'ลิงก์ไม่ถูกต้องหรือหมดอายุ' };
  }

  var session = createParentSession_(link.student_number, { token_hash: link.token_hash, student_id: link.student_id });
  var data = buildParentViewDataByStudentIdentity_(link.student_id, link.student_number, month);
  if (!data || !data.success) {
    invalidateParentSession_(session.session_token);
    return data || { success: false, message: 'ไม่สามารถโหลดข้อมูลได้' };
  }

  data.auth = buildParentSessionPayload_(session);
  return data;
}

function getParentViewDataBySession(sessionToken, month) {
  try {
    return runAsParentSession_(sessionToken, {
      rate_limit_key: 'parent_view',
      rate_limit_limit: 180,
      rate_limit_window_sec: 60
    }, function(session) {
      if (!isParentSessionLinkActive_(session)) {
        invalidateParentSession_(session.session_token);
        return { success: false, message: 'ลิงก์ผู้ปกครองหมดอายุ กรุณาขอลิงก์ใหม่จากครู' };
      }

      var data = buildParentViewDataByStudentIdentity_(session.student_id, session.student_number, month);
      if (data && data.success) {
        data.auth = buildParentSessionPayload_(session);
      }
      return data;
    });
  } catch (e) {
    var raw = String(e && e.message ? e.message : e || '');
    if (raw.indexOf('PARENT_AUTH_REQUIRED|') === 0 || raw.indexOf('PARENT_AUTH_EXPIRED|') === 0) {
      return { success: false, message: raw.split('|').slice(1).join('|') || 'ลิงก์หมดอายุ กรุณาขอลิงก์ใหม่จากครู' };
    }
    return { success: false, message: raw || 'ไม่สามารถโหลดข้อมูลได้' };
  }
}

function logoutParentSession(sessionToken) {
  try {
    return runAsParentSession_(sessionToken, {
      rate_limit_key: 'parent_logout',
      rate_limit_limit: 20,
      rate_limit_window_sec: 60
    }, function(session) {
      invalidateParentSession_(session.session_token);
      return { success: true, message: 'ออกจากหน้าผู้ปกครองแล้ว' };
    });
  } catch (e) {
    return { success: false, message: 'ไม่พบเซสชันผู้ปกครองที่ใช้งานอยู่' };
  }
}

function issueParentLinkForTeacher_(studentNumber, auth, rateLimitKey) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: rateLimitKey || 'issue_parent_link',
    rate_limit_limit: 30,
    rate_limit_window_sec: 60
  }, function() {
    ensureStudentIdentityMigration_();
    studentNumber = parseInt(studentNumber, 10);
    if (!studentNumber) return { success: false, message: 'ไม่พบเลขที่' };
    var lock = LockService.getDocumentLock();
    lock.waitLock(30000);
    try {
      var student = getActiveStudentByNumber_(studentNumber);
    if (!student) return { success: false, message: 'ไม่พบนักเรียนที่ใช้งานอยู่' };

    revokeParentLinksForStudent_(student);
    var link = issueParentLinkForStudent_(student);
    return {
      success: true,
      message: 'ออกลิงก์ผู้ปกครองใหม่แล้ว',
      expires_at: link.expires_at,
      // ฝั่ง client ไม่มีตัวแปลงวันที่ไทย ต้องส่งข้อความสำเร็จรูปไปให้
      // แปลงเป็นวันตามเขตเวลาของสคริปต์ก่อน ไม่ใช้ ISO ตรงๆ เพราะ ISO เป็น UTC
      // ซึ่งเลื่อนไปคนละวันได้เมื่อหมดอายุตอนหัวค่ำ
      expires_at_th: thaiDate(formatDate_(new Date(link.expires_at)), 'long', true),
      student_number: link.student_number,
      student_name: String(student.full_name || ''),
      url: ScriptApp.getService().getUrl() + '?page=parent&token=' + encodeURIComponent(link.token)
    };
    } finally {
      lock.releaseLock();
    }
  });
}

function validateParentLinkToken_(token) {
  token = String(token || '').trim();
  if (!token || token.length < 24) return null;

  var tokenHash = hashToken_(token);
  try {
    enforceRateLimit_('parent_open:' + tokenHash.substring(0, 24), 60, 60, 'เปิดลิงก์บ่อยเกินไป กรุณาลองใหม่ภายหลัง');
  } catch (e) {
    throw e;
  }

  var link = findParentLinkByHash_(tokenHash);
  if (!link) return null;
  if (link.revoked) return null;
  if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) return null;
  return link;
}

function isParentSessionLinkActive_(session) {
  session = session || {};
  if (!session.token_hash) return false;
  var link = findParentLinkByHash_(session.token_hash);
  if (!link) return false;
  if (link.revoked) return false;
  if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) return false;
  var sessionStudentId = parseInt(session.student_id, 10) || 0;
  if (sessionStudentId > 0 && (parseInt(link.student_id, 10) || 0) > 0) {
    return (parseInt(link.student_id, 10) || 0) === sessionStudentId;
  }
  return link.student_number === (parseInt(session.student_number, 10) || 0);
}

function buildParentViewDataByStudentIdentity_(studentId, studentNumber, month) {
  var student = getStudentByIdentity_(studentId, studentNumber);
  if (!student) {
    return { success: false, message: 'ไม่พบนักเรียน' };
  }

  var settings = getPublicBrandingSettings_();
  var range;
  try {
    range = getEffectiveMonthRange_(month);
    month = getEffectiveRangeMonth_(range, month);
  } catch (e) {
    return buildFailurePayload_(e, 'เดือนไม่ถูกต้อง');
  }
  var semRange = range.active_semester || null;

  var scopedRange = semRange || range;
  var scopedAllRecords = semRange
    ? getCachedConfirmedAttendanceRange_(semRange.from, semRange.to)
    : getCachedConfirmedAttendanceRecords_();
  var monthAllRecords = getCachedConfirmedAttendanceRange_(range.from, range.to);
  var scopedContext = buildAttendanceComputationContext_(scopedRange, scopedAllRecords);
  var monthContext = buildAttendanceComputationContext_(range, monthAllRecords);
  var scopedRecords = getRecordsForStudent_(buildStudentRecordBuckets_(scopedContext.filtered_records), student);
  var monthScopedRecords = getRecordsForStudent_(buildStudentRecordBuckets_(monthContext.filtered_records), student);
  var monthStats = buildStudentAttendanceStatsForContext_(student, buildStudentRecordBuckets_(monthContext.filtered_records), monthContext);
  var stats = {
    present: monthStats.counts.present,
    late: monthStats.counts.late,
    absent: monthStats.counts.absent,
    sick_leave: monthStats.counts.sick_leave,
    personal_leave: monthStats.counts.personal_leave,
    total: monthStats.school_days,
    confirmed_record_days: monthStats.recorded_days,
    attend_days: monthStats.attend_days,
    attendance_pct: monthStats.attendance_percent
  };

  var calendarInfo = getMonthCalendarInfo_(month);
  var calendarMap = {};
  monthScopedRecords.forEach(function(record) {
    var info = STATUS_MAP[record.status_code];
    calendarMap[record.date] = {
      status_code: record.status_code,
      icon: info ? info.icon : '?',
      color: info ? info.color : 'stone',
      label: info ? info.label : record.status_code
    };
  });

  var scopedStudentContext = buildAttendanceComputationContext_(scopedRange, scopedRecords);
  var scopedStats = buildStudentAttendanceStatsForContext_(student, buildStudentRecordBuckets_(scopedStudentContext.filtered_records), scopedStudentContext);
  var allStats = {
    present: scopedStats.counts.present,
    late: scopedStats.counts.late,
    absent: scopedStats.counts.absent,
    sick_leave: scopedStats.counts.sick_leave,
    personal_leave: scopedStats.counts.personal_leave,
    total: scopedStats.school_days,
    confirmed_record_days: scopedStats.recorded_days,
    attend_days: scopedStats.attend_days,
    attendance_pct: scopedStats.attendance_percent
  };

  scopedRecords.sort(function(a, b) { return b.date.localeCompare(a.date); });
  var history = scopedRecords.slice(0, 10).map(function(record) {
    var info = STATUS_MAP[record.status_code];
    return {
      date_th: thaiDate(record.date, 'short', true),
      icon: info ? info.icon : '?',
      label: info ? info.label : record.status_code,
      color: info ? info.color : 'stone'
    };
  });

  return {
    success: true,
    school_name: settings.school_name || '',
    class_name: settings.class_name || '',
    teacher_name: settings.teacher_name || '',
    student: {
      student_number: student.student_number,
      full_name: student.full_name,
      nickname: student.nickname || '',
      gender: student.gender,
      gender_label: student.gender === 'M' ? 'ชาย' : (student.gender === 'F' ? 'หญิง' : 'ไม่ระบุ')
    },
    month: month,
    month_th: thaiMonthLabel(month),
    semester: semRange ? semRange.name : null,
    all_stats_scope_label: semRange ? ('ภาคเรียน ' + semRange.name) : 'ทั้งหมด',
    stats: stats,
    all_stats: allStats,
    calendar: {
      month: month,
      days_in_month: calendarInfo.days_in_month,
      first_weekday: calendarInfo.first_weekday,
      records: calendarMap
    },
    history: history
  };
}

function issueParentLinkForStudent_(student) {
  student = student || {};
  var studentNumber = parseInt(student.student_number, 10) || 0;
  var studentId = parseInt(student.id, 10) || 0;
  var token = generateSecureToken_(48);
  var tokenHash = hashToken_(token);
  var createdAt = nowString_();
  var expiresAt = new Date(Date.now() + (getParentTokenTtlDays_() * 24 * 60 * 60 * 1000)).toISOString();

  var sheet = getOrCreateParentLinkSheet_();
  sheet.appendRow([
    studentNumber,
    '',
    tokenHash,
    createdAt,
    expiresAt,
    false,
    studentId || ''
  ]);

  return {
    student_number: studentNumber,
    student_id: studentId,
    token: token,
    token_hash: tokenHash,
    created_at: createdAt,
    expires_at: expiresAt,
    revoked: false
  };
}

function revokeParentLinksForStudent_(student) {
  student = student || {};
  var studentNumber = parseInt(student.student_number, 10) || 0;
  var studentId = parseInt(student.id, 10) || 0;
  if (!studentNumber && !studentId) return;

  var sheet;
  try {
    sheet = getSheet_(PARENT_LINK_SHEET);
  } catch (e) {
    return;
  }

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  var data = sheet.getRange(2, 1, lastRow - 1, PARENT_LINK_COL.STUDENT_ID).getValues();
  var changed = false;
  for (var i = 0; i < data.length; i++) {
    var rowStudentId = parseInt(data[i][PARENT_LINK_COL.STUDENT_ID - 1], 10) || 0;
    var rowStudentNumber = parseInt(data[i][0], 10) || 0;
    var matchesStudentId = studentId > 0 && rowStudentId === studentId;
    var matchesStudentNumber = studentNumber > 0 && rowStudentNumber === studentNumber;
    if (!matchesStudentId && !matchesStudentNumber) {
      continue;
    }
    data[i][PARENT_LINK_COL.TOKEN - 1] = '';
    data[i][PARENT_LINK_COL.REVOKED - 1] = true;
    changed = true;
  }
  if (changed) {
    sheet.getRange(2, 1, lastRow - 1, PARENT_LINK_COL.STUDENT_ID).setValues(data);
  }
}

function findActiveParentLinkByStudent_(student) {
  var rows = getParentLinkRows_();
  var now = Date.now();
  var studentId = parseInt(student && student.id, 10) || 0;
  var studentNumber = parseInt(student && student.student_number, 10) || 0;
  var fallback = null;
  for (var i = rows.length - 1; i >= 0; i--) {
    var matchesStudentId = studentId > 0 && (parseInt(rows[i].student_id, 10) || 0) === studentId;
    var matchesStudentNumber = studentNumber > 0 && rows[i].student_number === studentNumber;
    if (!matchesStudentId && !matchesStudentNumber) continue;
    if (rows[i].revoked) continue;
    if (rows[i].expires_at && new Date(rows[i].expires_at).getTime() < now) continue;

    if (matchesStudentId) return rows[i];
    if (!fallback && matchesStudentNumber) fallback = rows[i];
  }
  return fallback;
}

function findParentLinkByHash_(tokenHash) {
  var rows = getParentLinkRows_();
  for (var i = rows.length - 1; i >= 0; i--) {
    if (rows[i].token_hash === tokenHash) return rows[i];
  }
  return null;
}

function getParentLinkRows_() {
  ensureStudentIdentityMigration_();
  var sheet;
  try {
    sheet = getSheet_(PARENT_LINK_SHEET);
  } catch (e) {
    return [];
  }

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  var data = sheet.getRange(2, 1, lastRow - 1, PARENT_LINK_COL.STUDENT_ID).getValues();
  var changed = false;
  var rows = data.map(function(row) {
    var token = String(row[PARENT_LINK_COL.TOKEN - 1] || '').trim();
    var tokenHash = String(row[PARENT_LINK_COL.TOKEN_HASH - 1] || '').trim();
    if (token) {
      if (!tokenHash) {
        tokenHash = hashToken_(token);
        row[PARENT_LINK_COL.TOKEN_HASH - 1] = tokenHash;
      }
      row[PARENT_LINK_COL.TOKEN - 1] = '';
      changed = true;
    }

    return {
      student_number: parseInt(row[PARENT_LINK_COL.STUDENT_NUMBER - 1], 10) || 0,
      student_id: parseInt(row[PARENT_LINK_COL.STUDENT_ID - 1], 10) || 0,
      token_hash: tokenHash,
      created_at: normalizeTimestampValue_(row[PARENT_LINK_COL.CREATED_AT - 1]),
      expires_at: String(row[PARENT_LINK_COL.EXPIRES_AT - 1] || ''),
      revoked: row[PARENT_LINK_COL.REVOKED - 1] === true || String(row[PARENT_LINK_COL.REVOKED - 1]).toUpperCase() === 'TRUE'
    };
  });

  if (changed) {
    sheet.getRange(2, 1, lastRow - 1, PARENT_LINK_COL.STUDENT_ID).setValues(data);
  }

  return rows;
}

function getOrCreateParentLinkSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(PARENT_LINK_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(PARENT_LINK_SHEET);
    sheet.appendRow(['student_number', 'token', 'token_hash', 'created_at', 'expires_at', 'revoked', 'student_id']);
    var header = sheet.getRange(1, 1, 1, PARENT_LINK_COL.STUDENT_ID);
    header.setFontWeight('bold');
    header.setBackground('#f5f0eb');
    sheet.setFrozenRows(1);
  } else {
    ensureSheetColumnHeader_(sheet, PARENT_LINK_COL.STUDENT_ID, 'student_id');
  }
  return sheet;
}
