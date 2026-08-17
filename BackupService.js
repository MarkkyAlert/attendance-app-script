/**
 * Teacher-only backup pack generation and restore.
 */

var BACKUP_VERSION = 3;

function createBackup(auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'create_backup'
  }, function(session) {
    var snapshot = buildBackupSnapshot_();
    var settings = snapshot.settings || {};
    var studentsSheet = snapshot.sheets.students || { rows: [] };
    var attendanceSheet = snapshot.sheets.attendance_records || { rows: [] };
    var calendarSheet = snapshot.sheets.school_calendar || { rows: [] };

    var studentHeaders = ['ID', 'เลขที่', 'ชื่อ-สกุล', 'ชื่อเล่น', 'เพศ', 'กลุ่ม', 'จับตา', 'ใช้งาน', 'วันที่สร้าง', 'อีเมลผู้ปกครอง', 'เริ่มใช้งานเมื่อ', 'พ้นสภาพเมื่อ'];
    var studentsCsv = buildCSVString_([studentHeaders].concat(studentsSheet.rows || []));

    var attHeaders = ['ID', 'เลขที่', 'วันที่', 'สถานะ', 'หมายเหตุ', 'Batch ID', 'บันทึกเมื่อ', 'แก้ไขเมื่อ', 'student_id'];
    var attendanceCsv = buildCSVString_([attHeaders].concat(attendanceSheet.rows || []));

    var semesterSheet = snapshot.sheets.semesters || { headers: [], rows: [] };
    var semestersCsv = buildCSVString_([(semesterSheet.headers || ['id', 'ชื่อภาคเรียน', 'วันเริ่มต้น', 'วันสิ้นสุด', 'ใช้งาน'])].concat(semesterSheet.rows || []));

    var calendarHeaders = ['id', 'วันที่', 'ประเภท', 'รายละเอียด'];
    var schoolCalendarCsv = buildCSVString_([calendarHeaders].concat(calendarSheet.rows || []));

    var settingsRows = Object.keys(settings).sort().map(function(key) {
      return [key, settings[key]];
    });
    var settingsCsv = buildCSVString_([['Key', 'Value']].concat(settingsRows));

    var readme = buildBackupReadme_(snapshot);
    var snapshotJson = JSON.stringify(snapshot, null, 2);

    var blobs = [
      Utilities.newBlob(studentsCsv, 'text/csv', 'students.csv'),
      Utilities.newBlob(attendanceCsv, 'text/csv', 'attendance_records.csv'),
      Utilities.newBlob(semestersCsv, 'text/csv', 'semesters.csv'),
      Utilities.newBlob(settingsCsv, 'text/csv', 'settings.csv'),
      Utilities.newBlob(schoolCalendarCsv, 'text/csv', 'school_calendar.csv'),
      Utilities.newBlob(readme, 'text/plain', 'README.txt'),
      Utilities.newBlob(snapshotJson, 'application/json', 'system_snapshot.json')
    ];

    var changeLogSheet = snapshot.sheets.change_log || { headers: [], rows: [] };
    if ((changeLogSheet.rows || []).length) {
      blobs.push(Utilities.newBlob(
        buildCSVString_([(changeLogSheet.headers || ['ID', 'เลขที่', 'วันที่', 'สถานะเดิม', 'สถานะใหม่', 'หมายเหตุเดิม', 'หมายเหตุใหม่', 'การกระทำ', 'แก้ไขเมื่อ', 'student_id'])].concat(changeLogSheet.rows || [])),
        'text/csv',
        'change_log.csv'
      ));
    }

    var zipBlob = Utilities.zip(blobs, 'backup-pack-' + String(snapshot.exported_at || nowString_()).replace(/[\s:]/g, '-') + '.zip');
    var file = DriveApp.createFile(zipBlob);
    registerTempDriveFile_(file.getId(), session, 'backup', 1800);

    return {
      success: true,
      url: file.getDownloadUrl(),
      filename: file.getName(),
      file_id: file.getId(),
      summary: {
        students: (studentsSheet.rows || []).length,
        records: (attendanceSheet.rows || []).length,
        calendar_entries: (calendarSheet.rows || []).length,
        created_at: snapshot.exported_at
      }
    };
  });
}

function previewRestoreBackup(dataUrl, filename, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'preview_restore_backup',
    rate_limit_limit: 10,
    rate_limit_window_sec: 300
  }, function(session) {
    var snapshot;
    try {
      snapshot = extractBackupSnapshotFromDataUrl_(dataUrl);
    } catch (e) {
      return buildFailurePayload_(e);
    }

    var snapshotFile = DriveApp.createFile(
      Utilities.newBlob(JSON.stringify(snapshot), 'application/json', 'restore-preview-' + Date.now() + '.json')
    );
    registerTempDriveFile_(snapshotFile.getId(), session, 'backup_restore_preview', 1800);

    return {
      success: true,
      message: 'อ่านไฟล์สำรองเรียบร้อย',
      data: {
        preview_token: snapshotFile.getId(),
        filename: String(filename || 'backup.zip'),
        version: parseInt(snapshot.version, 10) || BACKUP_VERSION,
        exported_at: String(snapshot.exported_at || ''),
        teacher_name: String(snapshot.settings && snapshot.settings.teacher_name || ''),
        school_name: String(snapshot.settings && snapshot.settings.school_name || ''),
        class_name: String(snapshot.settings && snapshot.settings.class_name || ''),
        students: getBackupSheetRowCount_(snapshot, 'students'),
        attendance_records: getBackupSheetRowCount_(snapshot, 'attendance_records'),
        attendance_days: getBackupSheetRowCount_(snapshot, 'attendance_days'),
        semesters: getBackupSheetRowCount_(snapshot, 'semesters'),
        school_calendar: getBackupSheetRowCount_(snapshot, 'school_calendar'),
        change_log: getBackupSheetRowCount_(snapshot, 'change_log'),
        note: 'การกู้คืนนี้จะเขียนทับข้อมูลนักเรียน การเช็คชื่อ ภาคเรียน ปฏิทินวันเรียน และการตั้งค่าในชีตทั้งหมด แต่จะไม่เปลี่ยนรหัสครูหรือ PIN'
      }
    };
  });
}

function restoreBackupSnapshotUnsafe_(snapshot) {
  snapshot = snapshot || {};
  var sheets = snapshot.sheets || {};

  restoreBackupSheet_(SHEET.STUDENTS, sheets.students, ['ID', 'เลขที่', 'ชื่อ-สกุล', 'ชื่อเล่น', 'เพศ', 'กลุ่ม', 'จับตา', 'ใช้งาน', 'วันที่สร้าง', 'อีเมลผู้ปกครอง', 'เริ่มใช้งานเมื่อ', 'พ้นสภาพเมื่อ']);
  restoreBackupSheet_(SHEET.ATTENDANCE, sheets.attendance_records, ['ID', 'เลขที่', 'วันที่', 'สถานะ', 'หมายเหตุ', 'Batch ID', 'บันทึกเมื่อ', 'แก้ไขเมื่อ', 'student_id']);
  restoreBackupSheet_(SHEET.ATTENDANCE_DAYS, sheets.attendance_days, ['วันที่', 'สถานะ', 'ยืนยันเมื่อ']);
  restoreBackupSheet_(SHEET.CHANGE_LOG, sheets.change_log, ['ID', 'เลขที่', 'วันที่', 'สถานะเดิม', 'สถานะใหม่', 'หมายเหตุเดิม', 'หมายเหตุใหม่', 'การกระทำ', 'แก้ไขเมื่อ', 'student_id']);
  restoreBackupSheet_(SHEET.SETTINGS, sheets.settings, ['Key', 'Value']);
  restoreBackupSheet_(SEMESTER_SHEET, sheets.semesters, ['id', 'ชื่อภาคเรียน', 'วันเริ่มต้น', 'วันสิ้นสุด', 'ใช้งาน']);
  restoreBackupSheet_(SCHOOL_CALENDAR_SHEET, sheets.school_calendar, ['id', 'วันที่', 'ประเภท', 'รายละเอียด']);
  restoreBackupArchiveSheets_(ATTENDANCE_ARCHIVE_SHEET_PREFIX, sheets.attendance_archives, ensureAttendanceArchiveSheetSchema_);
  restoreBackupArchiveSheets_(ATTENDANCE_DAY_ARCHIVE_SHEET_PREFIX, sheets.attendance_day_archives, ensureAttendanceArchiveDaySheetSchema_);

  ensureStudentIdentityMigration_();
  ensureSemesterSchema_(getOrCreateSemesterSheet_());
  ensureSchoolCalendarSchema_(getOrCreateSchoolCalendarSheet_());
  invalidateStudentCache_();
  invalidateSemesterCaches_();
  invalidateSchoolCalendarCaches_();
}

function restoreBackupArchiveSheets_(prefix, snapshots, ensureSchemaFn) {
  prefix = String(prefix || '');
  snapshots = Array.isArray(snapshots) ? snapshots : [];
  var expected = {};
  var ss = getSpreadsheet_();

  snapshots.forEach(function(snapshot) {
    var sheetName = String(snapshot && snapshot.sheet_name || '').trim();
    if (!sheetName || sheetName.indexOf(prefix) !== 0) return;
    expected[sheetName] = true;
    restoreBackupSheet_(sheetName, snapshot, snapshot && snapshot.headers || []);
    try {
      ensureSchemaFn(getSheet_(sheetName));
    } catch (e) {}
  });

  ss.getSheets().forEach(function(sheet) {
    var sheetName = String(sheet.getName() || '');
    if (sheetName.indexOf(prefix) !== 0 || expected[sheetName]) return;
    sheet.clearContents();
    try {
      ensureSchemaFn(sheet);
    } catch (e) {}
  });
}

function restoreBackup(previewToken, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'restore_backup',
    rate_limit_limit: 5,
    rate_limit_window_sec: 300
  }, function(session) {
    previewToken = String(previewToken || '').trim();
    if (!previewToken) return { success: false, message: 'ไม่พบข้อมูลไฟล์สำรองที่ตรวจไว้' };
    if (!canCleanupTempDriveFile_(previewToken, session, 'backup_restore_preview')) {
      return { success: false, message: 'Preview ไฟล์สำรองหมดอายุ กรุณาเลือกไฟล์ใหม่' };
    }

    var snapshot;
    try {
      snapshot = JSON.parse(DriveApp.getFileById(previewToken).getBlob().getDataAsString('UTF-8'));
    } catch (e) {
      return { success: false, message: 'ข้อมูลไฟล์สำรองเสียหาย' };
    }

    var lock = LockService.getDocumentLock();
    lock.waitLock(30000);
    try {
      var beforeSnapshot = buildBackupSnapshot_();
      try {
        ensureSystemSheets_();
        restoreBackupSnapshotUnsafe_(snapshot);
      } catch (restoreError) {
        try {
          restoreBackupSnapshotUnsafe_(beforeSnapshot);
        } catch (rollbackError) {
          Logger.log('restoreBackup rollback failed: ' + rollbackError.message);
          return {
            success: false,
            message: 'กู้คืนข้อมูลไม่สำเร็จ และไม่สามารถคืนข้อมูลเดิมอัตโนมัติได้: ' + restoreError.message
          };
        }
        return {
          success: false,
          message: 'กู้คืนข้อมูลไม่สำเร็จ ระบบคืนข้อมูลเดิมแล้ว: ' + restoreError.message
        };
      }

      try { DriveApp.getFileById(previewToken).setTrashed(true); } catch (e2) {}
      clearTempDriveFileRegistration_(previewToken);

      return {
        success: true,
        message: 'กู้คืนข้อมูลจากไฟล์สำรองเรียบร้อย',
        data: {
          students: getBackupSheetRowCount_(snapshot, 'students'),
          attendance_records: getBackupSheetRowCount_(snapshot, 'attendance_records'),
          semesters: getBackupSheetRowCount_(snapshot, 'semesters'),
          school_calendar: getBackupSheetRowCount_(snapshot, 'school_calendar')
        }
      };
    } finally {
      lock.releaseLock();
    }
  });
}

function cleanupBackupFile(fileId, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'cleanup_backup_file',
    rate_limit_limit: 30,
    rate_limit_window_sec: 300
  }, function(session) {
    if (!canCleanupTempDriveFile_(fileId, session, 'backup')) {
      return { success: false, message: 'ไม่พบไฟล์สำรองชั่วคราวที่อนุญาตให้ลบ' };
    }
    try {
      DriveApp.getFileById(fileId).setTrashed(true);
    } catch (e) {}
    clearTempDriveFileRegistration_(fileId);
    return { success: true };
  });
}

function buildBackupSnapshot_() {
  ensureStudentIdentityMigration_();
  var settings = getSettings_();
  var now = nowString_();
  return {
    version: BACKUP_VERSION,
    exported_at: now,
    app: 'attendance1',
    settings: settings,
    sheets: {
      students: exportSheetSnapshot_(SHEET.STUDENTS),
      attendance_records: exportSheetSnapshot_(SHEET.ATTENDANCE),
      attendance_days: exportSheetSnapshot_(SHEET.ATTENDANCE_DAYS),
      change_log: exportSheetSnapshot_(SHEET.CHANGE_LOG),
      settings: exportSheetSnapshot_(SHEET.SETTINGS),
      semesters: exportSheetSnapshot_(SEMESTER_SHEET),
      school_calendar: exportSheetSnapshot_(SCHOOL_CALENDAR_SHEET),
      attendance_archives: exportSheetSnapshotsByPrefix_(ATTENDANCE_ARCHIVE_SHEET_PREFIX),
      attendance_day_archives: exportSheetSnapshotsByPrefix_(ATTENDANCE_DAY_ARCHIVE_SHEET_PREFIX)
    }
  };
}

function exportSheetSnapshotsByPrefix_(prefix) {
  prefix = String(prefix || '');
  if (!prefix) return [];
  return getSpreadsheet_().getSheets().map(function(sheet) {
    var name = String(sheet.getName() || '');
    if (name.indexOf(prefix) !== 0) return null;
    var snapshot = exportSheetSnapshotFromSheet_(sheet);
    snapshot.sheet_name = name;
    return snapshot;
  }).filter(function(snapshot) {
    return !!snapshot;
  });
}

function exportSheetSnapshotFromSheet_(sheet) {
  var headers = [];
  var rows = [];
  try {
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastCol > 0) {
      headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function(value) {
        return value instanceof Date ? formatDate_(value) : String(value || '');
      });
    }
    if (lastRow > 1 && lastCol > 0) {
      rows = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues().map(function(row) {
        return row.map(function(value) {
          return value instanceof Date ? formatDate_(value) : value;
        });
      });
    }
  } catch (e) {}
  return { headers: headers, rows: rows };
}

function exportSheetSnapshot_(sheetName) {
  try {
    var sheet = getSheet_(sheetName);
    return exportSheetSnapshotFromSheet_(sheet);
  } catch (e) {}
  return { headers: [], rows: [] };
}

function buildBackupReadme_(snapshot) {
  var settings = snapshot.settings || {};
  var lines = [];
  lines.push('ระบบเช็คชื่อนักเรียน - Backup');
  lines.push('');
  lines.push('สำรองข้อมูลเมื่อ: ' + String(snapshot.exported_at || ''));
  lines.push('รูปแบบไฟล์สำรอง: v' + BACKUP_VERSION);
  lines.push('');
  lines.push('ชื่อครู: ' + (settings.teacher_name || '-'));
  lines.push('โรงเรียน: ' + (settings.school_name || '-'));
  lines.push('ชั้นเรียน: ' + (settings.class_name || '-'));
  lines.push('');
  lines.push('จำนวนแถวนักเรียน: ' + getBackupSheetRowCount_(snapshot, 'students'));
  lines.push('จำนวนบันทึกเช็คชื่อ: ' + getBackupSheetRowCount_(snapshot, 'attendance_records'));
  lines.push('จำนวนภาคเรียน: ' + getBackupSheetRowCount_(snapshot, 'semesters'));
  lines.push('จำนวนรายการปฏิทินวันเรียน: ' + getBackupSheetRowCount_(snapshot, 'school_calendar'));
  lines.push('');
  lines.push('หมายเหตุ: ไฟล์สำรองนี้ไม่รวมรหัสครู, PIN, หรือ session ปัจจุบัน');
  return lines.join('\r\n');
}

function extractBackupSnapshotFromDataUrl_(dataUrl) {
  dataUrl = String(dataUrl || '').trim();
  if (!dataUrl) throw new Error('ไม่พบไฟล์สำรอง');

  var match = dataUrl.match(/^data:.*?;base64,(.+)$/);
  if (!match || !match[1]) throw new Error('รูปแบบไฟล์สำรองไม่ถูกต้อง');

  var bytes = Utilities.base64Decode(match[1]);
  if (!bytes || !bytes.length) throw new Error('ไม่สามารถอ่านไฟล์สำรองได้');

  var blobs = Utilities.unzip(Utilities.newBlob(bytes, 'application/zip', 'backup.zip'));
  if (!blobs || !blobs.length) throw new Error('ไฟล์สำรองไม่ถูกต้องหรือไม่ได้อยู่ในรูปแบบ ZIP');

  var snapshotBlob = null;
  blobs.forEach(function(blob) {
    if (String(blob.getName() || '') === 'system_snapshot.json') {
      snapshotBlob = blob;
    }
  });
  if (!snapshotBlob) {
    throw new Error('ไฟล์สำรองชุดนี้ยังไม่รองรับการกู้คืนอัตโนมัติ กรุณาใช้ไฟล์สำรองที่สร้างจากระบบเวอร์ชันล่าสุด');
  }

  var snapshot;
  try {
    snapshot = JSON.parse(snapshotBlob.getDataAsString('UTF-8'));
  } catch (e) {
    throw new Error('ไม่สามารถอ่านข้อมูล snapshot ภายในไฟล์สำรองได้');
  }
  if (!snapshot || !snapshot.sheets) {
    throw new Error('ไฟล์สำรองนี้ไม่มีข้อมูลที่กู้คืนได้');
  }
  return snapshot;
}

function restoreBackupSheet_(sheetName, snapshot, fallbackHeaders) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }

  var headers = snapshot && snapshot.headers && snapshot.headers.length ? snapshot.headers : (fallbackHeaders || []);
  var rows = snapshot && snapshot.rows && snapshot.rows.length ? snapshot.rows : [];

  sheet.clearContents();
  if (headers.length) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f5f0eb');
    sheet.setFrozenRows(1);
  }
  if (rows.length && headers.length) {
    // ข้อมูลในไฟล์สำรองเป็นข้อความดิบ ต้องกันสูตรอีกรอบก่อนเขียนกลับลงชีต
    sheet.getRange(2, 1, rows.length, headers.length).setValues(sanitizeSheetRows_(rows.map(function(row) {
      var normalized = row.slice(0, headers.length);
      while (normalized.length < headers.length) normalized.push('');
      return normalized;
    })));
  }
}

function getBackupSheetRowCount_(snapshot, key) {
  var sheet = snapshot && snapshot.sheets && snapshot.sheets[key];
  return sheet && sheet.rows ? sheet.rows.length : 0;
}
