/**
 * Teacher-only CSV import for students.
 */

var IMPORT_LIMITS = {
  MAX_BYTES: 1024 * 1024,
  MAX_ROWS: 1000,
  MAX_COLUMNS: 5
};

function normalizeImportGender_(value) {
  var raw = String(value || '').trim();
  if (!raw) return '';
  var compact = raw.replace(/\s+/g, '');
  var upper = compact.toUpperCase();

  if (upper === 'M' || upper === 'MALE' || upper === 'BOY') return 'M';
  if (upper === 'F' || upper === 'FEMALE' || upper === 'GIRL') return 'F';
  if (compact === 'ชาย' || compact === 'ช') return 'M';
  if (compact === 'หญิง' || compact === 'ญ') return 'F';
  return null;
}

function getImportTemplate(auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'get_import_template',
    rate_limit_limit: 10,
    rate_limit_window_sec: 300
  }, function(session) {
    var rows = [
      ['เลขที่', 'ชื่อ-สกุล', 'ชื่อเล่น', 'เพศ'],
      ['1', 'สมชาย ใจดี', 'เจ', 'M'],
      ['2', 'สมหญิง รักเรียน', 'หญิง', 'F'],
      ['3', 'สมศักดิ์ เก่งมาก', '', 'M']
    ];
    var blob = Utilities.newBlob(buildCSVString_(rows), 'text/csv', 'students-template.csv');
    var file = DriveApp.createFile(blob);
    registerTempDriveFile_(file.getId(), session, 'import_template', 1800);
    return { success: true, url: file.getDownloadUrl(), file_id: file.getId() };
  });
}

function cleanupImportTemplateFile(fileId, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'cleanup_import_template_file',
    rate_limit_limit: 30,
    rate_limit_window_sec: 300
  }, function(session) {
    if (!canCleanupTempDriveFile_(fileId, session, 'import_template')) {
      return { success: false, message: 'ไม่พบไฟล์ตัวอย่างชั่วคราวที่อนุญาตให้ลบ' };
    }
    try {
      DriveApp.getFileById(fileId).setTrashed(true);
    } catch (e) {}
    clearTempDriveFileRegistration_(fileId);
    return { success: true };
  });
}

function previewImportCSV(csvContent, effectiveFrom, options, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'preview_import'
  }, function() {
    ensureStudentIdentityMigration_();
    if (!csvContent || typeof csvContent !== 'string') {
      return { success: false, message: 'ไม่พบข้อมูล CSV' };
    }
    options = options || {};
    var importMode = String(options.mode || 'add_only').trim();
    if (['add_only', 'upsert'].indexOf(importMode) < 0) importMode = 'add_only';

    try {
      effectiveFrom = normalizeStudentRosterDateInput_(effectiveFrom, 'วันที่เริ่มอยู่ในห้อง', {
        default_to_semester_start: true
      });
    } catch (e) {
      return buildFailurePayload_(e);
    }
    if (Utilities.newBlob(csvContent).getBytes().length > IMPORT_LIMITS.MAX_BYTES) {
      return { success: false, message: 'ไฟล์ CSV มีขนาดใหญ่เกิน 1 MB' };
    }

    var parsed = parseCSV_(csvContent);
    if (!parsed.length) return { success: false, message: 'ไฟล์ CSV ว่าง' };
    if (parsed.length > IMPORT_LIMITS.MAX_ROWS + 1) {
      return { success: false, message: 'ไฟล์มีจำนวนแถวเกิน ' + IMPORT_LIMITS.MAX_ROWS + ' แถว' };
    }

    for (var i = 0; i < parsed.length; i++) {
      if (parsed[i].length > IMPORT_LIMITS.MAX_COLUMNS) {
        return { success: false, message: 'พบคอลัมน์เกินกว่ารูปแบบที่รองรับที่บรรทัด ' + (i + 1) };
      }
    }

    var headerRow = parsed[0];
    var hasHeader = isHeaderRow_(headerRow);
    var dataRows = hasHeader ? parsed.slice(1) : parsed;
    if (!dataRows.length) return { success: false, message: 'ไม่พบข้อมูลนักเรียนใน CSV' };

    var existingStudents = {};
    getStudentListData_().students.forEach(function(student) {
      existingStudents[student.student_number] = student;
    });

    var validRows = [];
    var errors = [];
    var warnings = [];
    var preview = [];
    var addCount = 0;
    var updateCount = 0;

    dataRows.forEach(function(row, index) {
      var lineNum = hasHeader ? index + 2 : index + 1;
      var studentNumber = parseInt(String(row[0] || '').trim(), 10);
      var fullName = '';
      var nickname = '';
      var gender = normalizeImportGender_(row[3]);
      var rowErrors = [];

      try {
        fullName = normalizeLimitedText_(row[1], 120, 'ชื่อ-สกุล');
        nickname = normalizeLimitedText_(row[2], 60, 'ชื่อเล่น');
      } catch (e) {
        errors.push({ line: lineNum, message: splitErrorCode_(e).message, data: row });
        return;
      }

      if (!studentNumber || studentNumber <= 0) rowErrors.push('เลขที่ไม่ถูกต้อง');
      if (!fullName) rowErrors.push('ไม่มีชื่อ-สกุล');
      if (gender === null) rowErrors.push('เพศต้องเป็น M/F หรือ ชาย/หญิง');
      if (!gender) gender = 'M';

      if (rowErrors.length) {
        errors.push({ line: lineNum, message: rowErrors.join(', '), data: row });
        return;
      }

      var dupInFile = validRows.some(function(item) {
        return item.student_number === studentNumber;
      });
      if (dupInFile) {
        errors.push({ line: lineNum, message: 'เลขที่ ' + studentNumber + ' ซ้ำในไฟล์', data: row });
        return;
      }

      var existingStudent = existingStudents[studentNumber];
      if (existingStudent) {
        if (importMode !== 'upsert') {
          warnings.push({ line: lineNum, message: 'เลขที่ ' + studentNumber + ' มีอยู่แล้ว จะข้าม', data: row });
          return;
        }

        validRows.push({
          action: 'update',
          student_id: parseInt(existingStudent.id, 10) || 0,
          student_number: studentNumber,
          full_name: fullName,
          nickname: nickname,
          gender: gender,
          enrolled_from: effectiveFrom
        });
        preview.push({
          line: lineNum,
          student_number: studentNumber,
          full_name: fullName,
          nickname: nickname,
          gender: gender,
          action: 'update'
        });
        updateCount++;
        return;
      }

      validRows.push({
        action: 'create',
        student_number: studentNumber,
        full_name: fullName,
        nickname: nickname,
        gender: gender,
        enrolled_from: effectiveFrom
      });
      preview.push({
        line: lineNum,
        student_number: studentNumber,
        full_name: fullName,
        nickname: nickname,
        gender: gender,
        action: 'create'
      });
      addCount++;
    });

    var previewToken = generateSecureToken_(36);
    CacheService.getScriptCache().put('import_' + previewToken, JSON.stringify({
      rows: validRows,
      enrolled_from: effectiveFrom
    }), 1800);

    return {
      success: true,
      message: 'ตรวจสอบไฟล์เรียบร้อย',
      data: {
        preview_token: previewToken,
        import_mode: importMode,
        total_rows: dataRows.length,
        valid_count: validRows.length,
        add_count: addCount,
        update_count: updateCount,
        error_count: errors.length,
        warning_count: warnings.length,
        enrolled_from: effectiveFrom,
        preview: preview.slice(0, 20),
        errors: errors.slice(0, 10),
        warnings: warnings.slice(0, 10)
      }
    };
  });
}

function confirmImport(previewToken, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'confirm_import'
  }, function() {
    ensureStudentIdentityMigration_();
    if (!previewToken) return { success: false, message: 'ไม่พบข้อมูล preview' };

    var lock = LockService.getDocumentLock();
    lock.waitLock(30000);

    try {
      var cache = CacheService.getScriptCache();
      var cacheKey = 'import_' + previewToken;
      var consumedKey = 'import_done_' + previewToken;

      if (cache.get(consumedKey)) {
        return { success: false, message: 'รายการนี้ถูกนำเข้าไปแล้ว กรุณาอัปโหลดใหม่' };
      }

      var raw = cache.get(cacheKey);
      if (!raw) return { success: false, message: 'Preview หมดอายุ กรุณาอัปโหลดใหม่' };

      var validRows;
      var enrolledFrom = '';
      try {
        var parsedPreview = JSON.parse(raw);
        if (Array.isArray(parsedPreview)) {
          validRows = parsedPreview;
          enrolledFrom = getDefaultStudentEnrollmentDate_();
        } else {
          validRows = parsedPreview && Array.isArray(parsedPreview.rows) ? parsedPreview.rows : [];
          enrolledFrom = normalizeStudentRosterDateInput_(parsedPreview && parsedPreview.enrolled_from, 'วันที่เริ่มอยู่ในห้อง', {
            default_to_semester_start: true
          });
        }
      } catch (e) {
        return { success: false, message: 'ข้อมูล preview เสียหาย' };
      }
      if (!validRows || !validRows.length) return { success: false, message: 'ไม่มีรายการที่จะนำเข้า' };

      var existingMap = {};
      getStudentListData_().students.forEach(function(student) {
        existingMap[student.student_number] = student;
      });

      var rowsToInsert = [];
      var rowsToUpdate = [];
      validRows.forEach(function(item) {
        var action = String(item.action || 'create');
        if (action === 'update') {
          var target = existingMap[item.student_number];
          if (target && (parseInt(target.id, 10) || 0) === (parseInt(item.student_id, 10) || 0)) {
            rowsToUpdate.push(item);
          }
          return;
        }
        if (existingMap[item.student_number]) return;
        rowsToInsert.push(item);
        existingMap[item.student_number] = { id: '', student_number: item.student_number };
      });

      if (!rowsToInsert.length && !rowsToUpdate.length) {
        cache.remove(cacheKey);
        cache.put(consumedKey, '1', 1800);
        return { success: false, message: 'ไม่มีรายการที่จะนำเข้าหรืออัปเดต' };
      }

      var sheet = getSheet_(SHEET.STUDENTS);
      var nextId = getNextId_(SHEET.STUDENTS);
      var now = nowString_();
      var rows = rowsToInsert.map(function(item, index) {
        return [
          nextId + index,
          item.student_number,
          item.full_name,
          item.nickname || '',
          item.gender || 'M',
          '',
          false,
          true,
          now,
          '',
          item.enrolled_from || enrolledFrom,
          ''
        ];
      });

      if (rows.length) {
        sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, COL.STUDENTS.INACTIVE_AT).setValues(sanitizeSheetRows_(rows));
      }

      rowsToUpdate.forEach(function(item) {
        var rowIndex = findActiveStudentRowByIdentifier_(item.student_id, item.student_number);
        if (rowIndex < 0) return;
        updateCells_(SHEET.STUDENTS, rowIndex, [
          { col: COL.STUDENTS.FULL_NAME, value: item.full_name },
          { col: COL.STUDENTS.NICKNAME, value: item.nickname || '' },
          { col: COL.STUDENTS.GENDER, value: item.gender || 'M' },
          { col: COL.STUDENTS.ENROLLED_FROM, value: item.enrolled_from || enrolledFrom }
        ]);
      });
      cache.put(consumedKey, '1', 1800);
      cache.remove(cacheKey);
      invalidateStudentCache_();

      return {
        success: true,
        message: buildImportResultMessage_(rows.length, rowsToUpdate.length),
        data: {
          imported_count: rows.length,
          updated_count: rowsToUpdate.length,
          imported_at: now
        }
      };
    } finally {
      lock.releaseLock();
    }
  });
}

function buildImportResultMessage_(createdCount, updatedCount) {
  createdCount = parseInt(createdCount, 10) || 0;
  updatedCount = parseInt(updatedCount, 10) || 0;
  if (createdCount > 0 && updatedCount > 0) {
    return 'นำเข้าใหม่ ' + createdCount + ' คน และอัปเดตรายชื่อเดิม ' + updatedCount + ' คน';
  }
  if (updatedCount > 0) {
    return 'อัปเดตรายชื่อเดิม ' + updatedCount + ' คน';
  }
  return 'นำเข้าสำเร็จ ' + createdCount + ' คน';
}

function parseCSV_(content) {
  if (content.charCodeAt(0) === 0xFEFF) content = content.substring(1);

  var lines = content.split(/\r\n|\r|\n/);
  var result = [];

  lines.forEach(function(line) {
    if (!String(line || '').trim()) return;

    var fields = [];
    var current = '';
    var inQuotes = false;

    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }

    fields.push(current);
    result.push(fields);
  });

  return result;
}

function isHeaderRow_(row) {
  if (!row || !row.length) return false;
  var first = String(row[0]).trim().toLowerCase();
  return isNaN(parseInt(first, 10)) && (
    first === 'เลขที่' ||
    first === 'student_number' ||
    first === 'no' ||
    first === 'no.' ||
    first === 'number' ||
    first === 'ลำดับ' ||
    first === '#'
  );
}
