/**
 * Student CRUD and teacher-managed settings.
 */

var STUDENT_IDENTITY_MIGRATION_PROP = 'student_identity_migration_version';
var STUDENT_IDENTITY_MIGRATION_VERSION = '2026-04-06-v3';
var STUDENT_IDENTITY_MIGRATION_READY_ = false;
var STUDENTS_FOR_ATTENDANCE_DATE_MEMO_ = {};

function getStudentIdentityMigrationReadyCacheKey_() {
  return 'student_identity_migration_ready|' + STUDENT_IDENTITY_MIGRATION_VERSION;
}

function markStudentIdentityMigrationReady_() {
  STUDENT_IDENTITY_MIGRATION_READY_ = true;
  try {
    CacheService.getScriptCache().put(getStudentIdentityMigrationReadyCacheKey_(), '1', 21600);
  } catch (e) {}
}

function getStudentList(auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_student_list',
    rate_limit_limit: 120,
    rate_limit_window_sec: 60
  }, function() {
    return sanitizeStudentListForClient_(getStudentListData_());
  });
}

function sanitizeStudentForClient_(student) {
  student = student || {};
  return {
    id: student.id,
    student_number: student.student_number,
    full_name: student.full_name,
    nickname: student.nickname || '',
    gender: student.gender,
    group_name: student.group_name || '',
    is_flagged: !!student.is_flagged,
    is_active: !!student.is_active,
    created_at: String(student.created_at || ''),
    has_parent_email: !!String(student.parent_email || '').trim()
  };
}

function sanitizeStudentListForClient_(data) {
  data = data || {};
  return {
    students: (data.students || []).map(sanitizeStudentForClient_),
    all_students: (data.all_students || []).map(sanitizeStudentForClient_),
    groups: data.groups || [],
    total: parseInt(data.total, 10) || 0
  };
}

function normalizeStudentSheetDateValue_(value) {
  if (value == null || value === '') return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return formatDate_(value);
  }

  var text = String(value).trim();
  if (!text) return '';

  var isoMatch = text.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];

  var parsed = new Date(text);
  if (!isNaN(parsed)) return formatDate_(parsed);

  return text.slice(0, 10);
}

function attachStudentRuntimeFields_(student) {
  student = student || {};
  if (student.__student_key && student.__roster_bounds && student.__student_id_num !== undefined && student.__student_number_num !== undefined) {
    return student;
  }
  var studentId = student.__student_id_num;
  if (studentId === undefined) {
    studentId = typeof student.id === 'number' ? student.id : (parseInt(student.id, 10) || 0);
  }
  var studentNumber = student.__student_number_num;
  if (studentNumber === undefined) {
    studentNumber = typeof student.student_number === 'number' ? student.student_number : (parseInt(student.student_number, 10) || 0);
  }
  var createdAt = normalizeStudentSheetDateValue_(student.created_at) || '';
  var enrolledFrom = normalizeStudentSheetDateValue_(student.enrolled_from) || '';
  var inactiveAt = normalizeStudentSheetDateValue_(student.inactive_at) || '';
  var bounds = student.__roster_bounds && student.__roster_bounds.start !== undefined && student.__roster_bounds.end !== undefined
    ? student.__roster_bounds
    : {
        start: enrolledFrom || createdAt,
        end: inactiveAt
      };
  var studentKey = studentId > 0 ? ('id:' + studentId) : ('num:' + studentNumber);

  student.id = studentId;
  student.student_number = studentNumber;
  student.created_at = createdAt;
  student.enrolled_from = enrolledFrom;
  student.inactive_at = inactiveAt;

  try {
    Object.defineProperties(student, {
      __student_id_num: {
        value: studentId,
        writable: true,
        configurable: true,
        enumerable: false
      },
      __student_number_num: {
        value: studentNumber,
        writable: true,
        configurable: true,
        enumerable: false
      },
      __student_key: {
        value: studentKey,
        writable: true,
        configurable: true,
        enumerable: false
      },
      __roster_bounds: {
        value: bounds,
        writable: true,
        configurable: true,
        enumerable: false
      }
    });
  } catch (e) {
    student.__student_id_num = studentId;
    student.__student_number_num = studentNumber;
    student.__student_key = studentKey;
    student.__roster_bounds = bounds;
  }
  return student;
}

function rehydrateStudentListRuntimeFields_(data) {
  data = data || {};
  var seen = {};

  function rehydrateList_(items) {
    return (items || []).map(function(student) {
      var hydrated = attachStudentRuntimeFields_(student);
      var key = hydrated && hydrated.__student_key ? hydrated.__student_key : '';
      if (key) seen[key] = hydrated;
      return hydrated;
    });
  }

  var allStudents = rehydrateList_(data.all_students || []);
  var activeStudents = (data.students || []).map(function(student) {
    var hydrated = attachStudentRuntimeFields_(student);
    var key = hydrated && hydrated.__student_key ? hydrated.__student_key : '';
    return key && seen[key] ? seen[key] : hydrated;
  });

  data.all_students = allStudents;
  data.students = activeStudents;
  return data;
}

function getDefaultStudentEnrollmentDate_() {
  var semester = getActiveSemesterRangeSafe_();
  return semester && semester.from ? semester.from : todayString_();
}

function normalizeStudentRosterDateInput_(value, label, options) {
  options = options || {};
  var allowBlank = options.allow_blank === true;
  var defaultToSemesterStart = options.default_to_semester_start === true;
  var text = String(value == null ? '' : value).trim();

  if (!text) {
    if (allowBlank) return '';
    text = defaultToSemesterStart ? getDefaultStudentEnrollmentDate_() : todayString_();
  }

  var normalized = normalizeDateStringStrict_(text, label || 'วันที่');
  ensureDateInActiveSemester_(normalized, label || 'วันที่');
  if (normalized > todayString_()) {
    throw new Error((label || 'วันที่') + ' ต้องไม่เกินวันนี้');
  }
  return normalized;
}

function getStudentByIdentifier_(identifier) {
  var normalizedId = parseInt(identifier, 10) || 0;
  if (normalizedId > 0) {
    var byId = getStudentById_(normalizedId);
    if (byId) return byId;
  }
  return getStudentByNumberAny_(identifier);
}

function findStudentRowById_(studentId) {
  studentId = parseInt(studentId, 10) || 0;
  var student = studentId > 0 ? getStudentById_(studentId) : null;
  return student ? student.row_index : -1;
}

function findActiveStudentRowByIdentifier_(studentId, studentNumber) {
  var normalizedId = parseInt(studentId, 10) || 0;
  if (normalizedId > 0) {
    var byId = getStudentById_(normalizedId);
    if (byId && byId.is_active) return byId.row_index;
  }
  return findActiveStudentRowByNumber_(studentNumber);
}

function hasStudentAttendanceOnDate_(student, date) {
  student = student || {};
  date = String(date || '').slice(0, 10);
  if (!date) return false;

  var studentId = parseInt(student.id, 10) || 0;
  var studentNumber = parseInt(student.student_number, 10) || 0;
  return getRecordsByDate_(date).some(function(record) {
    var recordStudentId = parseInt(record.student_id, 10) || 0;
    var recordStudentNumber = parseInt(record.student_number, 10) || 0;
    if (studentId > 0 && recordStudentId > 0) return recordStudentId === studentId;
    return studentNumber > 0 && recordStudentNumber === studentNumber;
  });
}

function getStudentInactiveDateForDelete_(student) {
  var today = todayString_();
  return hasStudentAttendanceOnDate_(student, today) ? shiftDate_(today, 1) : today;
}

function getStudentListData_() {
  var sheet = getSheet_(SHEET.STUDENTS);
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return {
      students: [],
      all_students: [],
      groups: [],
      total: 0
    };
  }

  var data = sheet.getRange(2, 1, lastRow - 1, COL.STUDENTS.INACTIVE_AT).getValues();
  var students = [];

  data.forEach(function(row) {
    var isActive = (row[7] === true || String(row[7]).toUpperCase() === 'TRUE');
    students.push(attachStudentRuntimeFields_({
      id: parseInt(row[0], 10) || 0,
      student_number: parseInt(row[1], 10) || 0,
      full_name: String(row[2] || ''),
      nickname: String(row[3] || ''),
      gender: String(row[4] || 'M'),
      group_name: String(row[5] || ''),
      is_flagged: row[6] === true || String(row[6]).toUpperCase() === 'TRUE',
      is_active: isActive,
      created_at: row[8],
      parent_email: String(row[9] || ''),
      enrolled_from: row[10],
      inactive_at: row[11]
    }));
  });

  students.sort(function(a, b) { return a.student_number - b.student_number; });

  var groupSet = {};
  students.forEach(function(student) {
    if (student.group_name && student.is_active) {
      groupSet[student.group_name] = true;
    }
  });

  return {
    students: students.filter(function(student) { return student.is_active; }),
    all_students: students,
    groups: Object.keys(groupSet).sort(),
    total: students.filter(function(student) { return student.is_active; }).length
  };
}

function getStudentSetupSummary_(data) {
  data = data || getCachedStudentList_();
  var activeStudents = data && data.students ? data.students : [];
  var allStudents = data && data.all_students ? data.all_students : [];
  var flaggedCount = 0;
  activeStudents.forEach(function(student) {
    if (student && student.is_flagged) flaggedCount++;
  });
  return {
    active_total: activeStudents.length,
    trashed_total: Math.max(0, allStudents.length - activeStudents.length),
    flagged_total: flaggedCount
  };
}

function isReadinessPlaceholderIdentityValue_(value, fallbackWords) {
  var normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return true;

  var placeholders = fallbackWords || [];
  if (placeholders.some(function(word) {
    return normalized === String(word || '').trim().toLowerCase();
  })) {
    return true;
  }

  return normalized.indexOf('ตัวอย่าง') >= 0 || normalized.indexOf('example') >= 0;
}

function getReadinessSummary_(options) {
  options = options || {};

  var settings = options.settings || getUiSettings_();
  var activeSemester = options.activeSemester || getActiveSemester();
  var studentSummary = options.studentSummary || getStudentSetupSummary_();
  var schoolCalendarSummary = options.schoolCalendarSummary;

  if (!schoolCalendarSummary) {
    if (activeSemester && (activeSemester.from || activeSemester.start_date) && (activeSemester.to || activeSemester.end_date)) {
      schoolCalendarSummary = getSchoolCalendarSummaryForRange_({
        from: activeSemester.from || activeSemester.start_date,
        to: activeSemester.to || activeSemester.end_date
      });
    } else {
      schoolCalendarSummary = { total_entries: 0, school_days: 0, holidays: 0 };
    }
  }

  var teacherName = String(settings.teacher_name || '').trim();
  var schoolName = String(settings.school_name || '').trim();
  var className = String(settings.class_name || '').trim();
  var basicReady = !!teacherName && !!schoolName && !!className;
  var activeStudentTotal = parseInt(studentSummary.active_total, 10) || 0;
  var schoolDays = parseInt(schoolCalendarSummary.school_days, 10) || 0;
  var holidayCount = parseInt(schoolCalendarSummary.holidays, 10) || 0;
  var teacherKeyConfigured = !!settings.teacher_key_configured;

  var identityIssues = [];
  if (!teacherName || isReadinessPlaceholderIdentityValue_(teacherName, ['ครูประจำชั้น', 'คุณครู'])) identityIssues.push('ชื่อครู');
  if (!schoolName || isReadinessPlaceholderIdentityValue_(schoolName, ['โรงเรียนตัวอย่าง'])) identityIssues.push('ชื่อโรงเรียน');
  if (!className || isReadinessPlaceholderIdentityValue_(className, ['ชั้นเรียน'])) identityIssues.push('ชื่อชั้น');
  var formalIdentityReady = identityIssues.length === 0;

  var items = [
    {
      key: 'classroom_profile',
      label: 'ข้อมูลชั้นเรียน',
      ready: basicReady,
      detail: basicReady ? 'ชื่อครู โรงเรียน และชั้นเรียนพร้อมแล้ว' : 'ยังขาดชื่อครู โรงเรียน หรือชั้นเรียน',
      action_page: 'settings',
      action_target: 'settings-step-class',
      action_label: 'ไปตั้งค่าชั้นเรียน',
      severity: basicReady ? 'ready' : 'blocking'
    },
    {
      key: 'active_semester',
      label: 'ภาคเรียนปัจจุบัน',
      ready: !!activeSemester,
      detail: activeSemester ? ('กำลังใช้ภาคเรียน ' + String(activeSemester.name || '')) : 'ยังไม่มีภาคเรียนที่เปิดใช้งาน',
      action_page: 'settings',
      action_target: 'settings-step-semester',
      action_label: activeSemester ? 'ไปดูภาคเรียน' : 'ไปสร้างภาคเรียน',
      severity: activeSemester ? 'ready' : 'blocking'
    },
    {
      key: 'student_roster',
      label: 'รายชื่อนักเรียน',
      ready: activeStudentTotal > 0,
      detail: activeStudentTotal > 0 ? ('มีนักเรียนพร้อมใช้งาน ' + activeStudentTotal + ' คน') : 'ยังไม่มีนักเรียนสำหรับเช็คชื่อจริง',
      action_page: 'students',
      action_target: '',
      action_label: activeStudentTotal > 0 ? 'ไปดูรายชื่อนักเรียน' : 'ไปเพิ่มนักเรียน',
      severity: activeStudentTotal > 0 ? 'ready' : 'blocking'
    },
    {
      key: 'school_calendar',
      label: 'ปฏิทินวันเรียน',
      ready: schoolDays > 0,
      detail: schoolDays > 0
        ? ('มีวันเรียนตามปฏิทิน ' + schoolDays + ' วัน และวันหยุด ' + holidayCount + ' วัน')
        : (activeSemester ? 'ยังไม่ได้สร้างวันเรียนตามปฏิทิน' : 'ยังตรวจปฏิทินไม่สำเร็จ เพราะยังไม่มีภาคเรียนอ้างอิง'),
      action_page: 'settings',
      action_target: 'settings-step-calendar',
      action_label: schoolDays > 0 ? 'ไปดูปฏิทินวันเรียน' : 'ไปสร้างปฏิทินวันเรียน',
      severity: schoolDays > 0 ? 'ready' : 'blocking'
    },
    {
      key: 'report_identity',
      label: 'ชื่อที่จะแสดงบนรายงาน',
      ready: formalIdentityReady,
      detail: formalIdentityReady ? 'ชื่อครู โรงเรียน และชั้นเรียนพร้อมใช้บนรายงานแล้ว' : ('ควรเปลี่ยนข้อมูลตัวอย่างหรือกรอกให้ครบ: ' + identityIssues.join(', ')),
      action_page: 'settings',
      action_target: 'settings-report-identity',
      action_label: formalIdentityReady ? 'ไปดูชื่อบนรายงาน' : 'ไปตั้งชื่อบนรายงาน',
      severity: formalIdentityReady ? 'ready' : 'warning'
    },
    {
      key: 'teacher_access_key',
      label: 'รหัสเข้าใช้งานครู',
      ready: teacherKeyConfigured,
      detail: teacherKeyConfigured ? 'ตั้งรหัสครูสำหรับใช้งานจริงแล้ว' : 'ยังไม่ได้ตั้งรหัสครูสำหรับเข้าใช้งาน',
      action_page: 'settings',
      action_target: 'settings-security-auth',
      action_label: teacherKeyConfigured ? 'ไปดูการตั้งค่ารหัสครู' : 'ไปตั้งรหัสครู',
      severity: teacherKeyConfigured ? 'ready' : 'warning'
    }
  ];

  var readyCount = items.filter(function(item) { return !!item.ready; }).length;
  var pendingItems = items.filter(function(item) { return !item.ready; });
  var blockingItems = pendingItems.filter(function(item) { return item.severity === 'blocking'; });
  var warningItems = pendingItems.filter(function(item) { return item.severity === 'warning'; });
  var nextIssue = blockingItems[0] || warningItems[0] || null;
  var isReadyForUat = pendingItems.length === 0;

  return {
    items: items,
    next_issue: nextIssue,
    summary: {
      ready_count: readyCount,
      total_count: items.length,
      pending_count: Math.max(0, items.length - readyCount),
      blocking_count: blockingItems.length,
      warning_count: warningItems.length,
      next_issue_key: nextIssue ? nextIssue.key : '',
      next_issue_label: nextIssue ? nextIssue.label : '',
      blocking_items: blockingItems.map(function(item) {
        return { key: item.key, label: item.label, severity: item.severity };
      }),
      is_ready_for_uat: isReadyForUat,
      status: isReadyForUat ? 'ready' : (blockingItems.length > 0 ? 'blocking' : 'warning'),
      headline: isReadyForUat ? 'ห้องเรียนพร้อมเริ่มใช้งานแล้ว' : 'ยังตั้งค่าไม่ครบ',
      detail: isReadyForUat
        ? 'ข้อมูลสำคัญครบแล้ว สามารถเริ่มเช็กชื่อ ดูรายงาน และใช้งานประจำวันได้'
        : ('ยังขาดอีก ' + (items.length - readyCount) + ' รายการ' + (nextIssue ? (' โดยสิ่งที่ควรทำต่อคือ ' + nextIssue.label) : ''))
    }
  };
}

function getStudentEditorData(studentIdentifier, auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_student_editor_data',
    rate_limit_limit: 60,
    rate_limit_window_sec: 60
  }, function() {
    var identifier = parseInt(studentIdentifier, 10) || 0;
    if (!identifier) return { success: false, message: 'ไม่พบนักเรียนที่ต้องการแก้ไข' };

    var fullStudent = getStudentById_(identifier);
    if (!fullStudent || !fullStudent.is_active) {
      fullStudent = getActiveStudentByNumber_(identifier);
    }
    if (!fullStudent || !fullStudent.is_active) return { success: false, message: 'ไม่พบนักเรียนที่ใช้งานอยู่' };

    return {
      success: true,
      student: {
        id: parseInt(fullStudent.id, 10) || 0,
        student_number: fullStudent.student_number,
        full_name: fullStudent.full_name,
        nickname: fullStudent.nickname || '',
        gender: fullStudent.gender,
        group_name: fullStudent.group_name || '',
        parent_email: fullStudent.parent_email || '',
        enrolled_from: normalizeStudentSheetDateValue_(fullStudent.enrolled_from) || getDefaultStudentEnrollmentDate_()
      }
    };
  });
}

function createStudent(payload, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'create_student'
  }, function() {
    ensureStudentIdentityMigration_();
    payload = payload || {};

    var studentNumber = parseInt(payload.student_number, 10);
    var fullName = '';
    var nickname = '';
    var gender = String(payload.gender || 'M').toUpperCase();
    var groupName = '';
    var parentEmail = '';
    var enrolledFrom = '';

    try {
      fullName = normalizeLimitedText_(payload.full_name, 120, 'ชื่อ-สกุล');
      nickname = normalizeLimitedText_(payload.nickname, 60, 'ชื่อเล่น');
      groupName = normalizeLimitedText_(payload.group_name, 60, 'กลุ่ม');
      parentEmail = normalizeLimitedText_(payload.parent_email, 254, 'อีเมลผู้ปกครอง');
      enrolledFrom = normalizeStudentRosterDateInput_(payload.enrolled_from, 'วันที่เริ่มอยู่ในห้อง', {
        default_to_semester_start: true
      });
    } catch (e) {
      return { success: false, message: e.message };
    }

    if (!studentNumber || studentNumber <= 0) {
      return { success: false, message: 'กรุณากรอกเลขที่ให้ถูกต้อง' };
    }
    if (!fullName) {
      return { success: false, message: 'กรุณากรอกชื่อ-สกุล' };
    }
    if (gender !== 'M' && gender !== 'F') {
      return { success: false, message: 'เพศต้องเป็น M หรือ F' };
    }
    if (parentEmail && !isValidEmailValue_(parentEmail)) {
      return { success: false, message: 'อีเมลผู้ปกครองไม่ถูกต้อง' };
    }

    var lock = LockService.getDocumentLock();
    lock.waitLock(30000);

    try {
      if (getActiveStudentByNumber_(studentNumber)) {
        return { success: false, message: 'เลขที่ ' + studentNumber + ' ถูกใช้งานอยู่แล้ว' };
      }

      var id = getNextId_(SHEET.STUDENTS);
      var createdAt = nowString_();

      appendRow_(SHEET.STUDENTS, [
        id, studentNumber, fullName, nickname, gender, groupName,
        false, true, createdAt, parentEmail, enrolledFrom, ''
      ]);

      invalidateStudentCache_();

      return {
        success: true,
        message: 'เพิ่มนักเรียนเลขที่ ' + studentNumber + ' สำเร็จ',
        data: {
          id: id,
          student_number: studentNumber,
          full_name: fullName,
          created_at: createdAt
        }
      };
    } finally {
      lock.releaseLock();
    }
  });
}

function updateStudent(payload, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'update_student'
  }, function() {
    payload = payload || {};
    var studentId = parseInt(payload.student_id, 10) || 0;
    var studentNumber = parseInt(payload.student_number, 10);
    var rowIndex = findActiveStudentRowByIdentifier_(studentId, studentNumber);
    var currentStudent = studentId > 0 ? getStudentById_(studentId) : getActiveStudentByNumber_(studentNumber);

    if (rowIndex < 0 || !currentStudent || !currentStudent.is_active) {
      return { success: false, message: 'ไม่พบนักเรียนที่กำลังใช้งานอยู่' };
    }

    var updates = [];
    var nextStudentNumber = parseInt(currentStudent.student_number, 10) || 0;
    var nextEnrolledFrom = normalizeStudentSheetDateValue_(currentStudent.enrolled_from) || getDefaultStudentEnrollmentDate_();
    try {
      if (payload.new_student_number !== undefined) {
        nextStudentNumber = parseInt(payload.new_student_number, 10);
        if (!(nextStudentNumber > 0)) return { success: false, message: 'เลขที่ต้องเป็นตัวเลขตั้งแต่ 1 ขึ้นไป' };
        var duplicatedStudent = getActiveStudentByNumber_(nextStudentNumber);
        if (duplicatedStudent && (parseInt(duplicatedStudent.id, 10) || 0) !== (parseInt(currentStudent.id, 10) || 0)) {
          return { success: false, message: 'มีนักเรียนที่ใช้งานอยู่ด้วยเลขที่ ' + nextStudentNumber + ' แล้ว' };
        }
        if (nextStudentNumber !== (parseInt(currentStudent.student_number, 10) || 0)) {
          updates.push({ col: COL.STUDENTS.STUDENT_NUMBER, value: nextStudentNumber });
        }
      }
      if (payload.full_name !== undefined) {
        var fullName = normalizeLimitedText_(payload.full_name, 120, 'ชื่อ-สกุล');
        if (!fullName) return { success: false, message: 'ชื่อ-สกุลห้ามว่าง' };
        updates.push({ col: COL.STUDENTS.FULL_NAME, value: fullName });
      }
      if (payload.nickname !== undefined) {
        updates.push({ col: COL.STUDENTS.NICKNAME, value: normalizeLimitedText_(payload.nickname, 60, 'ชื่อเล่น') });
      }
      if (payload.gender !== undefined) {
        var gender = String(payload.gender).toUpperCase();
        if (gender !== 'M' && gender !== 'F') return { success: false, message: 'เพศต้องเป็น M หรือ F' };
        updates.push({ col: COL.STUDENTS.GENDER, value: gender });
      }
      if (payload.group_name !== undefined) {
        updates.push({ col: COL.STUDENTS.GROUP_NAME, value: normalizeLimitedText_(payload.group_name, 60, 'กลุ่ม') });
      }
      if (payload.parent_email !== undefined) {
        var parentEmail = normalizeLimitedText_(payload.parent_email, 254, 'อีเมลผู้ปกครอง');
        if (parentEmail && !isValidEmailValue_(parentEmail)) {
          return { success: false, message: 'อีเมลผู้ปกครองไม่ถูกต้อง' };
        }
        updates.push({ col: COL.STUDENTS.PARENT_EMAIL, value: parentEmail });
      }
      if (payload.enrolled_from !== undefined) {
        nextEnrolledFrom = normalizeStudentRosterDateInput_(payload.enrolled_from, 'วันที่เริ่มอยู่ในห้อง');
        updates.push({ col: COL.STUDENTS.ENROLLED_FROM, value: nextEnrolledFrom });
      }
    } catch (e) {
      return { success: false, message: e.message };
    }

    var inactiveAt = normalizeStudentSheetDateValue_(currentStudent.inactive_at);
    if (inactiveAt && nextEnrolledFrom && inactiveAt <= nextEnrolledFrom) {
      return { success: false, message: 'วันที่เริ่มอยู่ในห้องต้องมาก่อนวันที่พ้นจากห้อง' };
    }

    if (updates.length === 0) {
      return { success: false, message: 'ไม่มีข้อมูลที่ต้องอัปเดต' };
    }

    var lock = LockService.getDocumentLock();
    lock.waitLock(30000);
    try {
      rowIndex = findActiveStudentRowByIdentifier_(studentId, studentNumber);
      currentStudent = studentId > 0 ? getStudentById_(studentId) : getActiveStudentByNumber_(studentNumber);
      if (rowIndex < 0 || !currentStudent || !currentStudent.is_active) {
        return { success: false, message: 'ไม่พบนักเรียนที่กำลังใช้งานอยู่' };
      }
      if (payload.new_student_number !== undefined) {
        var duplicatedStudentLocked = getActiveStudentByNumber_(nextStudentNumber);
        if (duplicatedStudentLocked && (parseInt(duplicatedStudentLocked.id, 10) || 0) !== (parseInt(currentStudent.id, 10) || 0)) {
          return { success: false, message: 'มีนักเรียนที่ใช้งานอยู่ด้วยเลขที่ ' + nextStudentNumber + ' แล้ว' };
        }
      }
      var inactiveAtLocked = normalizeStudentSheetDateValue_(currentStudent.inactive_at);
      if (inactiveAtLocked && nextEnrolledFrom && inactiveAtLocked <= nextEnrolledFrom) {
        return { success: false, message: 'วันที่เริ่มอยู่ในห้องต้องมาก่อนวันที่พ้นจากห้อง' };
      }
      updateCells_(SHEET.STUDENTS, rowIndex, updates);
      invalidateStudentCache_();
      return { success: true, message: 'แก้ไขข้อมูลเรียบร้อย' };
    } finally {
      lock.releaseLock();
    }
  });
}

function toggleStudentFlag(studentNumber, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'toggle_student_flag'
  }, function() {
    studentNumber = parseInt(studentNumber, 10);
    var rowIndex = findActiveStudentRowByNumber_(studentNumber);
    if (rowIndex < 0) return { success: false, message: 'ไม่พบนักเรียน' };

    var sheet = getSheet_(SHEET.STUDENTS);
    var current = sheet.getRange(rowIndex, COL.STUDENTS.IS_FLAGGED).getValue();
    var newValue = !(current === true || current === 'TRUE');

    sheet.getRange(rowIndex, COL.STUDENTS.IS_FLAGGED).setValue(newValue);
    invalidateStudentCache_();

    return {
      success: true,
      message: newValue ? 'เพิ่มเข้ารายการจับตาแล้ว' : 'นำออกจากรายการจับตาแล้ว',
      data: { is_flagged: newValue }
    };
  });
}

function deleteStudent(studentNumber, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'delete_student'
  }, function() {
    ensureStudentIdentityMigration_();
    var identifier = studentNumber;
    var studentId = parseInt(identifier, 10) || 0;
    var student = studentId > 0 ? getStudentById_(studentId) : null;
    if (!student || !student.is_active) {
      studentNumber = parseInt(studentNumber, 10);
      student = getActiveStudentByNumber_(studentNumber);
    }
    if (!student || !student.is_active) return { success: false, message: 'ไม่พบนักเรียน' };
    var rowIndex = student.row_index;

    var lock = LockService.getDocumentLock();
    lock.waitLock(30000);
    try {
      var inactiveAt = getStudentInactiveDateForDelete_(student);
      revokeParentLinksForStudent_(student);
      updateCells_(SHEET.STUDENTS, rowIndex, [
        { col: COL.STUDENTS.IS_ACTIVE, value: false },
        { col: COL.STUDENTS.INACTIVE_AT, value: inactiveAt }
      ]);

      invalidateStudentCache_();
      return {
        success: true,
        message: 'ลบนักเรียนเลขที่ ' + student.student_number + ' แล้ว',
        data: { inactive_at: inactiveAt }
      };
    } finally {
      lock.releaseLock();
    }
  });
}

function restoreStudent(studentIdentifier, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'restore_student'
  }, function() {
    ensureStudentIdentityMigration_();
    var identifier = parseInt(studentIdentifier, 10) || 0;
    if (!identifier) return { success: false, message: 'ไม่พบนักเรียนที่ต้องการกู้คืน' };
    var lock = LockService.getDocumentLock();
    lock.waitLock(30000);
    try {
      var student = getStudentById_(identifier);
      if (!student) {
        student = getStudentByNumberAny_(identifier);
      }
      if (!student || student.is_active) return { success: false, message: 'ไม่พบนักเรียนในถังขยะ' };

      var duplicatedStudent = getActiveStudentByNumber_(student.student_number);
      if (duplicatedStudent && (parseInt(duplicatedStudent.id, 10) || 0) !== (parseInt(student.id, 10) || 0)) {
        return { success: false, message: 'มีนักเรียนที่ใช้งานอยู่ด้วยเลขที่ ' + student.student_number + ' แล้ว' };
      }

      var today = todayString_();
      var restoreFrom = today;
      var inactiveAt = normalizeStudentSheetDateValue_(student.inactive_at);
      if (inactiveAt && inactiveAt > restoreFrom && !hasStudentAttendanceOnDate_(student, today)) restoreFrom = inactiveAt;

      updateCells_(SHEET.STUDENTS, student.row_index, [
        { col: COL.STUDENTS.IS_ACTIVE, value: true },
        { col: COL.STUDENTS.ENROLLED_FROM, value: restoreFrom },
        { col: COL.STUDENTS.INACTIVE_AT, value: '' }
      ]);
      invalidateStudentCache_();
      return {
        success: true,
        message: 'กู้คืนนักเรียนเลขที่ ' + student.student_number + ' สำเร็จ',
        data: { student_id: parseInt(student.id, 10) || 0, enrolled_from: restoreFrom }
      };
    } finally {
      lock.releaseLock();
    }
  });
}

function bulkUpdateGroup(studentNumbers, groupName, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'bulk_update_group'
  }, function() {
    if (!Array.isArray(studentNumbers) || studentNumbers.length === 0) {
      return { success: false, message: 'กรุณาเลือกนักเรียน' };
    }

    try {
      groupName = normalizeLimitedText_(groupName, 60, 'กลุ่ม');
    } catch (e) {
      return { success: false, message: e.message };
    }
    var sheet = getSheet_(SHEET.STUDENTS);
    var lastRow = sheet.getLastRow();
    if (lastRow <= 1) return { success: false, message: 'ไม่มีข้อมูลนักเรียน' };

    var data = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
    var targetNumbers = {};
    studentNumbers.forEach(function(num) {
      targetNumbers[parseInt(num, 10)] = true;
    });

    var ranges = [];
    var count = 0;
    for (var i = 0; i < data.length; i++) {
      var studentNumber = parseInt(data[i][1], 10);
      var isActive = data[i][7] === true || String(data[i][7]).toUpperCase() === 'TRUE';
      if (isActive && targetNumbers[studentNumber]) {
        ranges.push('F' + (i + 2));
        count++;
      }
    }

    if (count === 0) {
      return { success: false, message: 'ไม่พบนักเรียนที่เลือก' };
    }

    sheet.getRangeList(ranges).setValue(groupName);
    invalidateStudentCache_();
    return { success: true, message: 'อัปเดตกลุ่มให้ ' + count + ' คนเรียบร้อย' };
  });
}

function saveSettings(payload, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'save_settings'
  }, function() {
    payload = payload || {};
    var hasTeacherName = payload.teacher_name !== undefined;
    var hasSchoolName = payload.school_name !== undefined;
    var hasClassName = payload.class_name !== undefined;
    var validatedTeacherName = null;
    var validatedSchoolName = null;
    var validatedClassName = null;

    try {
      if (payload.teacher_name !== undefined) {
        validatedTeacherName = normalizeLimitedText_(payload.teacher_name, 120, 'ชื่อครู');
      }
      if (payload.school_name !== undefined) {
        validatedSchoolName = normalizeLimitedText_(payload.school_name, 160, 'ชื่อโรงเรียน');
      }
      if (payload.class_name !== undefined) {
        validatedClassName = normalizeLimitedText_(payload.class_name, 60, 'ระดับชั้นเรียน');
      }
    } catch (e) {
      return { success: false, message: e.message };
    }
    if (payload.absence_alert_days !== undefined) {
      var days = parseInt(payload.absence_alert_days, 10);
      if (!(days > 0 && days <= 30)) {
        return { success: false, message: 'เกณฑ์แจ้งเตือนต้องอยู่ระหว่าง 1-30 วัน' };
      }
    }
    if (payload.attention_threshold_days !== undefined) {
      var attentionDays = parseInt(payload.attention_threshold_days, 10);
      if (!(attentionDays > 0 && attentionDays <= 30)) {
        return { success: false, message: 'เกณฑ์รายการที่ต้องติดตามต้องอยู่ระหว่าง 1-30 วัน' };
      }
    }

    if (hasTeacherName) {
      saveSetting_('teacher_name', validatedTeacherName);
    }
    if (hasSchoolName) {
      saveSetting_('school_name', validatedSchoolName);
    }
    if (hasClassName) {
      saveSetting_('class_name', validatedClassName);
    }
    if (payload.absence_alert_days !== undefined) {
      saveSetting_('absence_alert_days', days);
    }
    if (payload.attention_threshold_days !== undefined) {
      saveSetting_('attention_threshold_days', attentionDays);
    }

    saveSetting_('setup_completed_at', nowString_());
    bumpDerivedDataCacheVersion_();
    return {
      success: true,
      message: 'บันทึกการตั้งค่าเรียบร้อย',
      settings: getUiSettings_()
    };
  });
}

function saveTeacherSecuritySettings(payload, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'save_teacher_security'
  }, function(session) {
    payload = payload || {};

    var parentTokenTtlDays = parseInt(payload.parent_token_ttl_days, 10);
    var newTeacherKey = String(payload.new_teacher_access_key || '').trim();
    var parentTokenTtlValid = parentTokenTtlDays >= SECURITY.PARENT_TOKEN_TTL_MIN_DAYS && parentTokenTtlDays <= SECURITY.PARENT_TOKEN_TTL_MAX_DAYS;
    var shouldLogout = false;

    if (!parentTokenTtlValid) {
      return { success: false, message: 'อายุลิงก์ผู้ปกครองต้องอยู่ระหว่าง ' + SECURITY.PARENT_TOKEN_TTL_MIN_DAYS + '-' + SECURITY.PARENT_TOKEN_TTL_MAX_DAYS + ' วัน' };
    }

    if (newTeacherKey) {
      try {
        setTeacherAccessKey_(newTeacherKey);
        shouldLogout = true;
      } catch (e) {
        return { success: false, message: e.message };
      }
    } else if (!isTeacherAccessKeyConfigured_()) {
      return { success: false, message: 'ต้องตั้งรหัสครูใหม่ก่อนใช้งานจริง' };
    }

    try { removeSetting_('teacher_key_login_enabled'); } catch (e) {}
    try { removeSetting_('teacher_auth_emails'); } catch (e) {}
    saveSetting_('parent_token_ttl_days', String(parentTokenTtlDays));
    if (shouldLogout) {
      try {
        revokeAllParentLinks_();
      } catch (e2) {
        return { success: false, message: 'ไม่สามารถเพิกถอนลิงก์ผู้ปกครองเดิมได้' };
      }
      invalidateTeacherSession_(session.session_token);
    }
    bumpDerivedDataCacheVersion_();

    return {
      success: true,
      message: shouldLogout
        ? 'บันทึกการตั้งค่าความปลอดภัยแล้ว ระบบยกเลิกลิงก์ผู้ปกครองเดิมและกรุณาเข้าสู่ระบบใหม่ด้วยรหัสครูล่าสุด'
        : 'บันทึกการตั้งค่าความปลอดภัยเรียบร้อย',
      settings: getUiSettings_(),
      logged_out: shouldLogout
    };
  });
}

function getActiveStudentByNumber_(studentNumber) {
  studentNumber = parseInt(studentNumber, 10);

  var sheet = getSheet_(SHEET.STUDENTS);
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return null;

  var data = sheet.getRange(2, 1, lastRow - 1, COL.STUDENTS.INACTIVE_AT).getValues();
  for (var i = 0; i < data.length; i++) {
    var rowStudentNumber = parseInt(data[i][1], 10);
    var isActive = data[i][7] === true || String(data[i][7]).toUpperCase() === 'TRUE';

    if (rowStudentNumber === studentNumber && isActive) {
      return {
        id: data[i][0],
        student_number: rowStudentNumber,
        full_name: String(data[i][2] || ''),
        nickname: String(data[i][3] || ''),
        gender: String(data[i][4] || 'M'),
        group_name: String(data[i][5] || ''),
        is_flagged: data[i][6] === true || String(data[i][6]).toUpperCase() === 'TRUE',
        parent_email: String(data[i][COL.STUDENTS.PARENT_EMAIL - 1] || ''),
        created_at: String(data[i][COL.STUDENTS.CREATED_AT - 1] || ''),
        enrolled_from: String(data[i][COL.STUDENTS.ENROLLED_FROM - 1] || ''),
        inactive_at: String(data[i][COL.STUDENTS.INACTIVE_AT - 1] || ''),
        row_index: i + 2
      };
    }
  }

  return null;
}

function findActiveStudentRowByNumber_(studentNumber) {
  var student = getActiveStudentByNumber_(studentNumber);
  return student ? student.row_index : -1;
}

function getStudentByNumberAny_(studentNumber) {
  studentNumber = parseInt(studentNumber, 10);

  var sheet = getSheet_(SHEET.STUDENTS);
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return null;

  var data = sheet.getRange(2, 1, lastRow - 1, COL.STUDENTS.INACTIVE_AT).getValues();
  var matches = [];
  for (var i = 0; i < data.length; i++) {
    if (parseInt(data[i][1], 10) === studentNumber) {
      var student = {
        id: data[i][0],
        student_number: parseInt(data[i][1], 10),
        full_name: String(data[i][2] || ''),
        nickname: String(data[i][3] || ''),
        gender: String(data[i][4] || 'M'),
        group_name: String(data[i][5] || ''),
        is_flagged: data[i][6] === true || String(data[i][6]).toUpperCase() === 'TRUE',
        is_active: data[i][7] === true || String(data[i][7]).toUpperCase() === 'TRUE',
        row_index: i + 2,
        parent_email: String(data[i][COL.STUDENTS.PARENT_EMAIL - 1] || ''),
        created_at: String(data[i][COL.STUDENTS.CREATED_AT - 1] || ''),
        enrolled_from: String(data[i][COL.STUDENTS.ENROLLED_FROM - 1] || ''),
        inactive_at: String(data[i][COL.STUDENTS.INACTIVE_AT - 1] || '')
      };
      matches.push(student);
    }
  }

  return pickBestStudentCandidate_(matches, '');
}

function getStudentById_(studentId) {
  studentId = parseInt(studentId, 10);
  if (!studentId) return null;

  var sheet = getSheet_(SHEET.STUDENTS);
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return null;

  var data = sheet.getRange(2, 1, lastRow - 1, COL.STUDENTS.INACTIVE_AT).getValues();
  for (var i = 0; i < data.length; i++) {
    if ((parseInt(data[i][0], 10) || 0) !== studentId) continue;
    return {
      id: parseInt(data[i][0], 10) || 0,
      student_number: parseInt(data[i][1], 10) || 0,
      full_name: String(data[i][2] || ''),
      nickname: String(data[i][3] || ''),
      gender: String(data[i][4] || 'M'),
      group_name: String(data[i][5] || ''),
      is_flagged: data[i][6] === true || String(data[i][6]).toUpperCase() === 'TRUE',
      is_active: data[i][7] === true || String(data[i][7]).toUpperCase() === 'TRUE',
      row_index: i + 2,
      created_at: String(data[i][COL.STUDENTS.CREATED_AT - 1] || ''),
      parent_email: String(data[i][COL.STUDENTS.PARENT_EMAIL - 1] || ''),
      enrolled_from: String(data[i][COL.STUDENTS.ENROLLED_FROM - 1] || ''),
      inactive_at: String(data[i][COL.STUDENTS.INACTIVE_AT - 1] || '')
    };
  }
  return null;
}

function getStudentByIdentity_(studentId, studentNumber) {
  return getStudentById_(studentId) || getStudentByNumberAny_(studentNumber);
}

function buildStudentIdentityIndex_(students) {
  var byId = {};
  var byNumber = {};
  (students || []).forEach(function(student) {
    student = attachStudentRuntimeFields_(student);
    var studentId = student && student.__student_id_num || 0;
    var studentNumber = student && student.__student_number_num || 0;
    if (studentId > 0) byId[studentId] = student;
    if (studentNumber > 0) {
      if (!byNumber[studentNumber]) byNumber[studentNumber] = [];
      byNumber[studentNumber].push(student);
    }
  });
  return { byId: byId, byNumber: byNumber, students: (students || []).slice() };
}

function pickBestStudentCandidate_(candidates, date) {
  var matches = (candidates || []).slice();
  if (!matches.length) return null;
  if (date) {
    var rosterMatches = matches.filter(function(student) {
      return isStudentInRosterOnDate_(student, date);
    });
    if (rosterMatches.length) matches = rosterMatches;
  }
  matches.sort(function(a, b) {
    var aActive = a && a.is_active ? 1 : 0;
    var bActive = b && b.is_active ? 1 : 0;
    if (bActive !== aActive) return bActive - aActive;
    var aStart = getStudentRosterStartDate_(a);
    var bStart = getStudentRosterStartDate_(b);
    if (aStart !== bStart) return String(bStart || '').localeCompare(String(aStart || ''));
    return (parseInt(b && b.id, 10) || 0) - (parseInt(a && a.id, 10) || 0);
  });
  return matches[0];
}

function resolveRecordStudent_(record, studentsOrIndex) {
  record = record || {};
  var index = studentsOrIndex && studentsOrIndex.byId && studentsOrIndex.byNumber
    ? studentsOrIndex
    : buildStudentIdentityIndex_(studentsOrIndex || (getStudentListData_().all_students || []));
  var studentId = parseInt(record.student_id, 10) || 0;
  if (studentId > 0 && index.byId[studentId]) return index.byId[studentId];

  var studentNumber = parseInt(record.student_number, 10) || 0;
  if (!studentNumber) return null;
  var recordDate = String(record.date || '').slice(0, 10);
  var resolvedCache = index.__resolved_student_by_number_date;
  var cacheKey = studentNumber + '|' + recordDate;
  if (resolvedCache && resolvedCache.hasOwnProperty(cacheKey)) {
    return resolvedCache[cacheKey];
  }
  var resolvedStudent = pickBestStudentCandidate_(index.byNumber[studentNumber] || [], recordDate);
  if (!resolvedCache) {
    resolvedCache = {};
    try {
      Object.defineProperty(index, '__resolved_student_by_number_date', {
        value: resolvedCache,
        writable: true,
        configurable: true,
        enumerable: false
      });
    } catch (e) {
      index.__resolved_student_by_number_date = resolvedCache;
    }
  }
  resolvedCache[cacheKey] = resolvedStudent;
  return resolvedStudent;
}

function getResolvedRecordStudentKey_(record, studentsOrIndex) {
  var student = resolveRecordStudent_(record, studentsOrIndex);
  return student ? getStudentKey_(student) : getRecordStudentKey_(record);
}

function getStudentKey_(student) {
  student = attachStudentRuntimeFields_(student);
  return student && student.__student_key ? student.__student_key : 'num:0';
}

function getRecordStudentKey_(record) {
  record = record || {};
  var studentId = parseInt(record.student_id, 10) || 0;
  if (studentId > 0) return 'id:' + studentId;
  return 'num:' + (parseInt(record.student_number, 10) || 0);
}

function getRecordStudentDateKey_(record, studentsOrIndex) {
  var studentKey = getResolvedRecordStudentKey_(record, studentsOrIndex);
  var date = String(record && record.date || '');
  if (!studentKey || !date) return '';
  return studentKey + '|' + date;
}

function getUniqueLatestRecords_(records, studentsOrIndex, options) {
  var opts = options || {};
  if (!options && studentsOrIndex && studentsOrIndex.records_are_unique) {
    opts = studentsOrIndex;
    studentsOrIndex = null;
  }
  var recordList = Array.isArray(records) ? records : [];
  if (opts.records_are_unique) return recordList.slice();
  var studentIndex = studentsOrIndex && studentsOrIndex.byId && studentsOrIndex.byNumber
    ? studentsOrIndex
    : buildStudentIdentityIndex_(studentsOrIndex || (getCachedStudentList_().all_students || []));
  var latestByKey = {};
  var order = [];
  recordList.forEach(function(record) {
    var key = getRecordStudentDateKey_(record, studentIndex);
    if (!key) return;
    if (!latestByKey.hasOwnProperty(key)) order.push(key);
    latestByKey[key] = record;
  });
  return order.map(function(key) {
    return latestByKey[key];
  });
}

function buildStudentRecordBuckets_(records, studentsOrIndex, options) {
  var opts = options || {};
  if (!options && studentsOrIndex && studentsOrIndex.records_are_unique) {
    opts = studentsOrIndex;
    studentsOrIndex = null;
  }
  var buckets = {};
  var studentIndex = studentsOrIndex && studentsOrIndex.byId && studentsOrIndex.byNumber
    ? studentsOrIndex
    : buildStudentIdentityIndex_(studentsOrIndex || (getCachedStudentList_().all_students || []));
  var uniqueRecords = opts.records_are_unique && Array.isArray(records)
    ? records
    : getUniqueLatestRecords_(records, studentIndex, { records_are_unique: !!opts.records_are_unique });
  uniqueRecords.forEach(function(record) {
    var student = resolveRecordStudent_(record, studentIndex);
    if (!student || !isStudentInRosterOnDate_(student, record.date)) return;
    var key = getStudentKey_(student);
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(record);
  });
  if (opts.filtered_to_school_days) {
    try {
      Object.defineProperty(buckets, '__filtered_to_school_days', {
        value: true,
        writable: true,
        configurable: true,
        enumerable: false
      });
    } catch (e) {
      buckets.__filtered_to_school_days = true;
    }
  }
  return buckets;
}

function getRecordsForStudent_(recordBuckets, student) {
  var studentKey = getStudentKey_(student);
  var records = ((recordBuckets && recordBuckets[studentKey]) || []).slice();
  if (records.length) return records;

  var fallbackKey = 'num:' + (parseInt(student && student.student_number, 10) || 0);
  if (!recordBuckets || !fallbackKey || fallbackKey === studentKey) return records;
  return (recordBuckets[fallbackKey] || []).filter(function(record) {
    return getResolvedRecordStudentKey_(record) === studentKey && isStudentInRosterOnDate_(student, record.date);
  });
}

function buildRecordMapForStudents_(records, studentsOrIndex, options) {
  var map = {};
  var opts = options || {};
  if (!options && studentsOrIndex && studentsOrIndex.records_are_unique) {
    opts = studentsOrIndex;
    studentsOrIndex = null;
  }
  var studentIndex = studentsOrIndex && studentsOrIndex.byId && studentsOrIndex.byNumber
    ? studentsOrIndex
    : buildStudentIdentityIndex_(studentsOrIndex || []);
  var uniqueRecords = opts.records_are_unique && Array.isArray(records)
    ? records
    : getUniqueLatestRecords_(records, studentIndex, { records_are_unique: !!opts.records_are_unique });
  uniqueRecords.forEach(function(record) {
    var student = resolveRecordStudent_(record, studentIndex);
    if (!student || !isStudentInRosterOnDate_(student, record.date)) return;
    map[getStudentKey_(student)] = record;
  });
  return map;
}

function getOfficialStudentsForRange_(range, records, studentsOrIndex) {
  ensureStudentIdentityMigration_();
  if (!range || !range.from || !range.to) return [];

  range = range || {};
  var providedIndex = studentsOrIndex && studentsOrIndex.byId && studentsOrIndex.byNumber ? studentsOrIndex : null;
  var allStudents = providedIndex
    ? (providedIndex.students || Object.keys(providedIndex.byId || {}).map(function(id) { return providedIndex.byId[id]; }))
    : Array.isArray(studentsOrIndex)
      ? studentsOrIndex.slice()
      : (getCachedStudentList_().all_students || []).slice();
  var studentIndex = providedIndex || buildStudentIdentityIndex_(allStudents);
  var recordKeySet = {};

  (records || []).forEach(function(record) {
    var student = resolveRecordStudent_(record, studentIndex);
    if (!student || !isStudentInRosterOnDate_(student, record.date)) return;
    recordKeySet[getStudentKey_(student)] = true;
  });

  return allStudents.filter(function(student) {
    if (recordKeySet[getStudentKey_(student)]) return true;
    return doesStudentRosterOverlapRange_(student, range);
  }).sort(function(a, b) {
    return a.student_number - b.student_number || (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0);
  });
}

function getStudentRosterBounds_(student) {
  student = attachStudentRuntimeFields_(student);
  if (student.__roster_bounds && student.__roster_bounds.start !== undefined && student.__roster_bounds.end !== undefined) {
    return student.__roster_bounds;
  }

  var bounds = {
    start: normalizeStudentSheetDateValue_(student.enrolled_from) || normalizeStudentSheetDateValue_(student.created_at) || '',
    end: normalizeStudentSheetDateValue_(student.inactive_at) || ''
  };
  try {
    Object.defineProperty(student, '__roster_bounds', {
      value: bounds,
      writable: true,
      configurable: true,
      enumerable: false
    });
  } catch (e) {
    student.__roster_bounds = bounds;
  }
  return bounds;
}

function getStudentRosterStartDate_(student) {
  return getStudentRosterBounds_(student).start;
}

function getStudentRosterEndDate_(student) {
  return getStudentRosterBounds_(student).end;
}

function isStudentInRosterOnDate_(student, date) {
  if (!student) return false;
  date = String(date || '').slice(0, 10);
  if (!date) return !!student.is_active;

  var bounds = getStudentRosterBounds_(student);
  var startDate = bounds.start;
  var endDate = bounds.end;
  if (startDate && date < startDate) return false;
  if (endDate && date >= endDate) return false;
  return true;
}

function doesStudentRosterOverlapRange_(student, range) {
  if (!student || !range || !range.from || !range.to) return false;

  var bounds = getStudentRosterBounds_(student);
  var startDate = bounds.start;
  var endDate = bounds.end;
  if (startDate && startDate > range.to) return false;
  if (endDate) {
    var inclusiveEnd = shiftDate_(endDate, -1);
    if (inclusiveEnd < range.from) return false;
  }
  return true;
}

function getGroupsForStudents_(students) {
  var groupSet = {};
  (students || []).forEach(function(student) {
    var groupName = String(student.group_name || '').trim();
    if (groupName) groupSet[groupName] = true;
  });
  return Object.keys(groupSet).sort();
}

function getStudentsForAttendanceDate_(date) {
  date = String(date || '').slice(0, 10);
  if (!date) return [];
  if (STUDENTS_FOR_ATTENDANCE_DATE_MEMO_[date]) return STUDENTS_FOR_ATTENDANCE_DATE_MEMO_[date];

  var cacheKey = buildDerivedCacheKey_('students_for_attendance_date', [date]);
  var cached = getCachedJsonByKey_(cacheKey);
  if (cached !== null) {
    STUDENTS_FOR_ATTENDANCE_DATE_MEMO_[date] = (cached || []).map(function(student) {
      return attachStudentRuntimeFields_(student);
    });
    return STUDENTS_FOR_ATTENDANCE_DATE_MEMO_[date];
  }

  var roster = ((getCachedStudentList_().all_students || []).filter(function(student) {
    return isStudentInRosterOnDate_(student, date);
  })).sort(function(a, b) {
    return a.student_number - b.student_number || ((a && a.__student_id_num) || 0) - ((b && b.__student_id_num) || 0);
  });
  putCachedJsonByKey_(cacheKey, roster, 300);
  STUDENTS_FOR_ATTENDANCE_DATE_MEMO_[date] = roster;
  return STUDENTS_FOR_ATTENDANCE_DATE_MEMO_[date];
}

function getStudentForAttendanceDate_(date, studentId, studentNumber) {
  var roster = getStudentsForAttendanceDate_(date);
  var normalizedId = parseInt(studentId, 10) || 0;
  if (normalizedId > 0) {
    for (var i = 0; i < roster.length; i++) {
      if ((parseInt(roster[i].id, 10) || 0) === normalizedId) return roster[i];
    }
    return null;
  }

  var normalizedNumber = parseInt(studentNumber, 10) || 0;
  if (!normalizedNumber) return null;

  var matches = roster.filter(function(student) {
    return (parseInt(student.student_number, 10) || 0) === normalizedNumber;
  });
  return matches.length ? matches[0] : null;
}

function ensureStudentIdentityMigration_() {
  if (STUDENT_IDENTITY_MIGRATION_READY_) {
    return;
  }

  try {
    if (CacheService.getScriptCache().get(getStudentIdentityMigrationReadyCacheKey_()) === '1') {
      STUDENT_IDENTITY_MIGRATION_READY_ = true;
      return;
    }
  } catch (eCache) {}

  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(STUDENT_IDENTITY_MIGRATION_PROP) === STUDENT_IDENTITY_MIGRATION_VERSION) {
    markStudentIdentityMigrationReady_();
    return;
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    if (props.getProperty(STUDENT_IDENTITY_MIGRATION_PROP) === STUDENT_IDENTITY_MIGRATION_VERSION) {
      markStudentIdentityMigrationReady_();
      return;
    }

    ensureAttendanceStudentIdColumn_();
    ensureParentLinkStudentIdColumn_();
    ensureStudentRosterColumns_();
    backfillAttendanceStudentIds_();
    backfillParentLinkStudentIds_();
    backfillStudentRosterDates_();
    invalidateStudentCache_();

    props.setProperty(STUDENT_IDENTITY_MIGRATION_PROP, STUDENT_IDENTITY_MIGRATION_VERSION);
    markStudentIdentityMigrationReady_();
  } finally {
    lock.releaseLock();
  }
}

function ensureAttendanceStudentIdColumn_() {
  var sheet = getSheet_(SHEET.ATTENDANCE);
  ensureSheetColumnHeader_(sheet, COL.ATTENDANCE.STUDENT_ID, 'student_id');
}

function ensureParentLinkStudentIdColumn_() {
  var sheet;
  try {
    sheet = getSheet_(PARENT_LINK_SHEET);
  } catch (e) {
    return;
  }
  ensureSheetColumnHeader_(sheet, PARENT_LINK_COL.STUDENT_ID, 'student_id');
}

function ensureStudentRosterColumns_() {
  var sheet = getSheet_(SHEET.STUDENTS);
  ensureSheetColumnHeader_(sheet, COL.STUDENTS.ENROLLED_FROM, 'enrolled_from');
  ensureSheetColumnHeader_(sheet, COL.STUDENTS.INACTIVE_AT, 'inactive_at');
}

function ensureSheetColumnHeader_(sheet, colIndex, headerLabel) {
  if (sheet.getLastColumn() < colIndex) {
    sheet.insertColumnsAfter(sheet.getLastColumn(), colIndex - sheet.getLastColumn());
  }
  var header = String(sheet.getRange(1, colIndex).getValue() || '').trim();
  if (header !== headerLabel) {
    sheet.getRange(1, colIndex).setValue(headerLabel);
  }
}

function backfillAttendanceStudentIds_() {
  var sheet = getSheet_(SHEET.ATTENDANCE);
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  var studentIndex = buildStudentIdentityIndex_(getStudentListData_().all_students || []);
  var data = sheet.getRange(2, 1, lastRow - 1, COL.ATTENDANCE.STUDENT_ID).getValues();
  var values = [];
  var changed = false;

  for (var i = 0; i < data.length; i++) {
    var currentId = parseInt(data[i][COL.ATTENDANCE.STUDENT_ID - 1], 10) || 0;
    if (currentId > 0) {
      values.push([currentId]);
      continue;
    }

    var studentNumber = parseInt(data[i][COL.ATTENDANCE.STUDENT_NUMBER - 1], 10) || 0;
    var rowDate = data[i][COL.ATTENDANCE.DATE - 1];
    try {
      rowDate = normalizeDateStringStrict_(rowDate, 'วันที่');
    } catch (e) {
      rowDate = '';
    }
    var mappedStudent = resolveRecordStudent_({ student_number: studentNumber, date: rowDate }, studentIndex);
    var mappedId = parseInt(mappedStudent && mappedStudent.id, 10) || '';
    if (mappedId) changed = true;
    values.push([mappedId || '']);
  }

  if (changed) {
    sheet.getRange(2, COL.ATTENDANCE.STUDENT_ID, values.length, 1).setValues(values);
  }
}

function backfillParentLinkStudentIds_() {
  var sheet;
  try {
    sheet = getSheet_(PARENT_LINK_SHEET);
  } catch (e) {
    return;
  }

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  var studentIndex = buildStudentIdentityIndex_(getStudentListData_().all_students || []);
  var data = sheet.getRange(2, 1, lastRow - 1, PARENT_LINK_COL.STUDENT_ID).getValues();
  var values = [];
  var changed = false;

  for (var i = 0; i < data.length; i++) {
    var currentId = parseInt(data[i][PARENT_LINK_COL.STUDENT_ID - 1], 10) || 0;
    if (currentId > 0) {
      values.push([currentId]);
      continue;
    }

    var studentNumber = parseInt(data[i][PARENT_LINK_COL.STUDENT_NUMBER - 1], 10) || 0;
    var mappedStudent = resolveRecordStudent_({ student_number: studentNumber }, studentIndex);
    var mappedId = parseInt(mappedStudent && mappedStudent.id, 10) || '';
    if (mappedId) changed = true;
    values.push([mappedId || '']);
  }

  if (changed) {
    sheet.getRange(2, PARENT_LINK_COL.STUDENT_ID, values.length, 1).setValues(values);
  }
}

function backfillStudentRosterDates_() {
  var sheet = getSheet_(SHEET.STUDENTS);
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;

  var studentData = sheet.getRange(2, 1, lastRow - 1, COL.STUDENTS.INACTIVE_AT).getValues();
  var attendanceSheet = getSheet_(SHEET.ATTENDANCE);
  var attendanceLastRow = attendanceSheet.getLastRow();
  var boundaries = {};

  if (attendanceLastRow > 1) {
    var attendanceData = attendanceSheet.getRange(2, 1, attendanceLastRow - 1, COL.ATTENDANCE.STUDENT_ID).getValues();
    for (var i = 0; i < attendanceData.length; i++) {
      var recordDate = attendanceData[i][COL.ATTENDANCE.DATE - 1] instanceof Date
        ? formatDate_(attendanceData[i][COL.ATTENDANCE.DATE - 1])
        : String(attendanceData[i][COL.ATTENDANCE.DATE - 1] || '').slice(0, 10);
      if (!recordDate) continue;

      var recordStudentId = parseInt(attendanceData[i][COL.ATTENDANCE.STUDENT_ID - 1], 10) || 0;
      var recordStudentNumber = parseInt(attendanceData[i][COL.ATTENDANCE.STUDENT_NUMBER - 1], 10) || 0;
      var key = recordStudentId > 0 ? ('id:' + recordStudentId) : ('num:' + recordStudentNumber);
      if (!boundaries[key]) {
        boundaries[key] = { earliest: recordDate, latest: recordDate };
      } else {
        if (recordDate < boundaries[key].earliest) boundaries[key].earliest = recordDate;
        if (recordDate > boundaries[key].latest) boundaries[key].latest = recordDate;
      }
    }
  }

  var enrolledValues = [];
  var inactiveValues = [];
  var enrolledChanged = false;
  var inactiveChanged = false;
  var today = todayString_();

  for (var j = 0; j < studentData.length; j++) {
    var student = {
      id: studentData[j][COL.STUDENTS.ID - 1],
      student_number: studentData[j][COL.STUDENTS.STUDENT_NUMBER - 1],
      created_at: studentData[j][COL.STUDENTS.CREATED_AT - 1],
      enrolled_from: studentData[j][COL.STUDENTS.ENROLLED_FROM - 1],
      inactive_at: studentData[j][COL.STUDENTS.INACTIVE_AT - 1]
    };
    var isActive = studentData[j][COL.STUDENTS.IS_ACTIVE - 1] === true || String(studentData[j][COL.STUDENTS.IS_ACTIVE - 1]).toUpperCase() === 'TRUE';
    var key = getStudentKey_(student);
    var boundary = boundaries[key] || null;

    var enrolledFrom = normalizeStudentSheetDateValue_(studentData[j][COL.STUDENTS.ENROLLED_FROM - 1]);
    if (!enrolledFrom) {
      enrolledFrom = boundary && boundary.earliest
        ? boundary.earliest
        : (normalizeStudentSheetDateValue_(studentData[j][COL.STUDENTS.CREATED_AT - 1]) || today);
      enrolledChanged = true;
    }

    var inactiveAt = normalizeStudentSheetDateValue_(studentData[j][COL.STUDENTS.INACTIVE_AT - 1]);
    if (!inactiveAt && !isActive) {
      inactiveAt = boundary && boundary.latest ? shiftDate_(boundary.latest, 1) : today;
      inactiveChanged = true;
    }

    enrolledValues.push([enrolledFrom]);
    inactiveValues.push([inactiveAt]);
  }

  if (enrolledChanged) {
    sheet.getRange(2, COL.STUDENTS.ENROLLED_FROM, enrolledValues.length, 1).setValues(enrolledValues);
  }
  if (inactiveChanged) {
    sheet.getRange(2, COL.STUDENTS.INACTIVE_AT, inactiveValues.length, 1).setValues(inactiveValues);
  }
}

function getUniqueStudentIdByNumberMap_() {
  var map = {};
  var duplicates = {};
  (getStudentListData_().all_students || []).forEach(function(student) {
    var studentNumber = parseInt(student.student_number, 10) || 0;
    var studentId = parseInt(student.id, 10) || 0;
    if (!studentNumber || !studentId) return;
    if (map[studentNumber] && map[studentNumber] !== studentId) {
      duplicates[studentNumber] = true;
      delete map[studentNumber];
      return;
    }
    if (!duplicates[studentNumber]) {
      map[studentNumber] = studentId;
    }
  });
  return map;
}
