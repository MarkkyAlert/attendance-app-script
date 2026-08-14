/**
 * Persistent attendance summaries by semester.
 */

var ATTENDANCE_CONFIRMED_SUMMARY_PREFIX = '_att_confirmed_';
var ATTENDANCE_DAILY_SUMMARY_PREFIX = '_att_daily_sum_';
var ATTENDANCE_STUDENT_MONTH_SUMMARY_PREFIX = '_att_student_month_';

var ATTENDANCE_CONFIRMED_SUMMARY_HEADERS = [
  'date',
  'month',
  'student_id',
  'student_number',
  'status_code',
  'note',
  'batch_id',
  'attendance_id'
];

var ATTENDANCE_DAILY_SUMMARY_HEADERS = [
  'date',
  'month',
  'weekday',
  'active_students',
  'checked_count',
  'present_count',
  'late_count',
  'absent_count',
  'sick_leave_count',
  'personal_leave_count',
  'coverage_percent'
];

var ATTENDANCE_STUDENT_MONTH_SUMMARY_HEADERS = [
  'month',
  'student_id',
  'student_number',
  'present_count',
  'late_count',
  'absent_count',
  'sick_leave_count',
  'personal_leave_count',
  'recorded_days',
  'total_days',
  'basis_days',
  'attendance_percent'
];

function getAttendanceConfirmedSummarySheetName_(semesterId) {
  return ATTENDANCE_CONFIRMED_SUMMARY_PREFIX + String(parseInt(semesterId, 10) || 0);
}

function getAttendanceDailySummarySheetName_(semesterId) {
  return ATTENDANCE_DAILY_SUMMARY_PREFIX + String(parseInt(semesterId, 10) || 0);
}

function getAttendanceStudentMonthSummarySheetName_(semesterId) {
  return ATTENDANCE_STUDENT_MONTH_SUMMARY_PREFIX + String(parseInt(semesterId, 10) || 0);
}

function getSemesterRowByIdOrNull_(semesterId) {
  var targetId = parseInt(semesterId, 10) || 0;
  if (!(targetId > 0)) return null;
  var rows = [];
  try {
    rows = getSemesterRows_();
  } catch (e) {
    return null;
  }
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i] || {};
    if ((parseInt(row.id, 10) || 0) === targetId) return row;
  }
  return null;
}

function getAttendanceSummarySemester_(semester) {
  if (semester && (parseInt(semester.id, 10) || 0) > 0) return semester;
  try {
    return getActiveSemesterRow_();
  } catch (e) {
    return null;
  }
}

function ensureNamedHiddenSheetSchema_(name, headers) {
  name = String(name || '').trim();
  if (!name) throw new Error('ไม่พบชื่อชีตสรุปข้อมูล');
  var sheet = getSheetByNameOrNull_(name);
  if (!sheet) {
    sheet = getSpreadsheet_().insertSheet(name);
  }
  headers = Array.isArray(headers) ? headers.slice() : [];
  if (sheet.getLastColumn() < headers.length) {
    sheet.insertColumnsAfter(sheet.getLastColumn(), headers.length - sheet.getLastColumn());
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f5f0eb');
  sheet.setFrozenRows(1);
  try { sheet.hideSheet(); } catch (e) {}
  return sheet;
}

function getOrCreateAttendanceConfirmedSummarySheet_(semester) {
  semester = getAttendanceSummarySemester_(semester);
  if (!semester) throw new Error('ไม่พบภาคเรียนสำหรับสร้างดัชนีเช็คชื่อที่ยืนยันแล้ว');
  return ensureNamedHiddenSheetSchema_(
    getAttendanceConfirmedSummarySheetName_(semester.id),
    ATTENDANCE_CONFIRMED_SUMMARY_HEADERS
  );
}

function getOrCreateAttendanceDailySummarySheet_(semester) {
  semester = getAttendanceSummarySemester_(semester);
  if (!semester) throw new Error('ไม่พบภาคเรียนสำหรับสร้างสรุปรายวัน');
  return ensureNamedHiddenSheetSchema_(
    getAttendanceDailySummarySheetName_(semester.id),
    ATTENDANCE_DAILY_SUMMARY_HEADERS
  );
}

function getOrCreateAttendanceStudentMonthSummarySheet_(semester) {
  semester = getAttendanceSummarySemester_(semester);
  if (!semester) throw new Error('ไม่พบภาคเรียนสำหรับสร้างสรุปรายเดือนของนักเรียน');
  return ensureNamedHiddenSheetSchema_(
    getAttendanceStudentMonthSummarySheetName_(semester.id),
    ATTENDANCE_STUDENT_MONTH_SUMMARY_HEADERS
  );
}

function ensureAttendanceSummarySheets_(semester) {
  semester = getAttendanceSummarySemester_(semester);
  if (!semester) return null;
  return {
    semester: semester,
    confirmed: getOrCreateAttendanceConfirmedSummarySheet_(semester),
    daily: getOrCreateAttendanceDailySummarySheet_(semester),
    studentMonth: getOrCreateAttendanceStudentMonthSummarySheet_(semester)
  };
}

function clampRangeToSemesterRow_(semester, requestedRange) {
  semester = getAttendanceSummarySemester_(semester);
  requestedRange = requestedRange || {};
  if (!semester || !semester.start_date || !semester.end_date) {
    return { from: '', to: '', out_of_semester: true, active_semester: semester || null };
  }
  var from = String(requestedRange.from || semester.start_date || '');
  var to = String(requestedRange.to || semester.end_date || '');
  if (!from || !to) {
    return { from: '', to: '', out_of_semester: true, active_semester: semester };
  }
  if (from < semester.start_date) from = semester.start_date;
  if (to > semester.end_date) to = semester.end_date;
  if (!from || !to || to < from) {
    return { from: '', to: '', out_of_semester: true, active_semester: semester };
  }
  return {
    from: from,
    to: to,
    out_of_semester: false,
    active_semester: semester
  };
}

function normalizeAttendanceSummaryMonth_(month) {
  return normalizeMonth_(month);
}

function readSummarySheetRows_(sheet, parser) {
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  var lastCol = sheet.getLastColumn();
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var rows = [];
  values.forEach(function(row) {
    var parsed = parser(row || []);
    if (parsed) rows.push(parsed);
  });
  return rows;
}

function parseConfirmedSummaryRow_(row) {
  var date = String(row[0] || '').slice(0, 10);
  if (!date) return null;
  return {
    date: date,
    month: String(row[1] || '').slice(0, 7),
    student_id: parseInt(row[2], 10) || 0,
    student_number: parseInt(row[3], 10) || 0,
    status_code: String(row[4] || ''),
    note: String(row[5] || ''),
    batch_id: String(row[6] || ''),
    id: parseInt(row[7], 10) || 0
  };
}

function parseDailySummaryRow_(row) {
  var date = String(row[0] || '').slice(0, 10);
  if (!date) return null;
  return {
    date: date,
    month: String(row[1] || '').slice(0, 7),
    weekday: String(row[2] || ''),
    active_students: parseInt(row[3], 10) || 0,
    checked_count: parseInt(row[4], 10) || 0,
    present_count: parseInt(row[5], 10) || 0,
    late_count: parseInt(row[6], 10) || 0,
    absent_count: parseInt(row[7], 10) || 0,
    sick_leave_count: parseInt(row[8], 10) || 0,
    personal_leave_count: parseInt(row[9], 10) || 0,
    coverage_percent: parseFloat(row[10]) || 0
  };
}

function parseStudentMonthSummaryRow_(row) {
  var month = String(row[0] || '').slice(0, 7);
  if (!month) return null;
  return {
    month: month,
    student_id: parseInt(row[1], 10) || 0,
    student_number: parseInt(row[2], 10) || 0,
    present_count: parseInt(row[3], 10) || 0,
    late_count: parseInt(row[4], 10) || 0,
    absent_count: parseInt(row[5], 10) || 0,
    sick_leave_count: parseInt(row[6], 10) || 0,
    personal_leave_count: parseInt(row[7], 10) || 0,
    recorded_days: parseInt(row[8], 10) || 0,
    total_days: parseInt(row[9], 10) || 0,
    basis_days: parseInt(row[10], 10) || 0,
    attendance_percent: row[11] === '' || row[11] === null || typeof row[11] === 'undefined'
      ? null
      : (parseFloat(row[11]) || 0)
  };
}

function deleteRowsByKeyFromSheet_(sheet, columnIndex, keyValue) {
  if (!sheet) return;
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  var values = sheet.getRange(2, columnIndex, lastRow - 1, 1).getValues();
  var rowIndexes = [];
  values.forEach(function(row, index) {
    var value = String(row[0] || '').trim();
    if (value === String(keyValue || '').trim()) {
      rowIndexes.push(index + 2);
    }
  });
  if (rowIndexes.length) deleteAttendanceDuplicateRows_(sheet, rowIndexes);
}

function replaceRowsByKeyInSheet_(sheet, columnIndex, keyValue, rows, totalColumns) {
  if (!sheet) return;
  deleteRowsByKeyFromSheet_(sheet, columnIndex, keyValue);
  rows = Array.isArray(rows) ? rows.filter(function(row) { return Array.isArray(row) && row.length; }) : [];
  if (!rows.length) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, totalColumns).setValues(rows);
}

function getRawAttendanceDateBucketForSource_(date, sourceInfo) {
  date = String(date || '').slice(0, 10);
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  if (!date || !isDateWithinAttendanceSource_(date, sourceInfo)) return [];
  var buckets = getCachedAttendanceDateBuckets_(sourceInfo);
  var records = (buckets && buckets[date]) ? buckets[date] : [];
  return Array.isArray(records) ? records.slice() : [];
}

function getRawConfirmedAttendanceRangeForSource_(from, to, sourceInfo) {
  from = String(from || '').slice(0, 10);
  to = String(to || '').slice(0, 10);
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  if (!from || !to || to < from) return [];
  var confirmedDates = getConfirmedAttendanceDateMap_(sourceInfo);
  var dateBuckets = getCachedAttendanceDateBuckets_(sourceInfo);
  var records = [];
  generateDateList_(from, to).forEach(function(date) {
    if (!confirmedDates[date]) return;
    if (dateBuckets[date] && dateBuckets[date].length) {
      records = records.concat(dateBuckets[date]);
    }
  });
  return getUniqueLatestRecords_(records);
}

function buildConfirmedSummaryRowsForDate_(semester, date) {
  semester = getAttendanceSummarySemester_(semester);
  if (!semester) return [];
  var sourceInfo = getAttendanceSourceInfoForSemester_(semester);
  if (!isDateWithinAttendanceSource_(date, sourceInfo)) return [];
  var confirmedDates = getConfirmedAttendanceDateMap_(sourceInfo);
  if (!confirmedDates[date]) return [];
  var records = getUniqueLatestRecords_(getRawAttendanceDateBucketForSource_(date, sourceInfo));
  return records.map(function(record) {
    return [
      date,
      String(date || '').slice(0, 7),
      parseInt(record.student_id, 10) || 0,
      parseInt(record.student_number, 10) || 0,
      String(record.status_code || ''),
      String(record.note || ''),
      String(record.batch_id || ''),
      parseInt(record.id, 10) || 0
    ];
  });
}

function buildDailySummaryRowForDate_(semester, date) {
  semester = getAttendanceSummarySemester_(semester);
  if (!semester) return [];
  var sourceInfo = getAttendanceSourceInfoForSemester_(semester);
  if (!isDateWithinAttendanceSource_(date, sourceInfo)) return [];
  var confirmedDates = getConfirmedAttendanceDateMap_(sourceInfo);
  if (!confirmedDates[date]) return [];
  var records = getRawConfirmedAttendanceRangeForSource_(date, date, sourceInfo);
  var rosterRange = { from: date, to: date, active_semester: semester };
  var students = getOfficialStudentsForRange_(rosterRange, records);
  var counts = buildStatusCounts_(records, students.length);
  var checkedCount = parseInt(counts.checked, 10) || 0;
  var activeStudents = students.length;
  var coveragePercent = activeStudents > 0 ? Math.round((checkedCount / activeStudents) * 100) : 0;
  return [[
    date,
    String(date || '').slice(0, 7),
    THAI_WEEKDAYS[getIsoWeekday_(date)] || '',
    activeStudents,
    checkedCount,
    parseInt(counts.present, 10) || 0,
    parseInt(counts.late, 10) || 0,
    parseInt(counts.absent, 10) || 0,
    parseInt(counts.sick_leave, 10) || 0,
    parseInt(counts.personal_leave, 10) || 0,
    coveragePercent
  ]];
}

function buildStudentMonthSummaryRowsForMonth_(semester, month, affectedStudentIds) {
  semester = getAttendanceSummarySemester_(semester);
  if (!semester) return [];
  month = normalizeAttendanceSummaryMonth_(month);
  var range = clampRangeToSemesterRow_(semester, monthRange_(month));
  if (range.out_of_semester) return [];

  var sourceInfo = getAttendanceSourceInfoForSemester_(semester);
  var records = getRawConfirmedAttendanceRangeForSource_(range.from, range.to, sourceInfo);
  var context = buildAttendanceComputationContext_(range, records);
  var students = getOfficialStudentsForRange_(range, context.filtered_records);
  var recordBuckets = buildStudentRecordBuckets_(context.filtered_records);
  var allowedIds = {};
  if (Array.isArray(affectedStudentIds) && affectedStudentIds.length) {
    affectedStudentIds.forEach(function(id) {
      var normalizedId = parseInt(id, 10) || 0;
      if (normalizedId > 0) allowedIds[normalizedId] = true;
    });
  }

  return students.filter(function(student) {
    if (!Object.keys(allowedIds).length) return true;
    return !!allowedIds[parseInt(student.id, 10) || 0];
  }).map(function(student) {
    var stats = buildStudentAttendanceStatsForContext_(student, recordBuckets, context);
    var counts = stats.counts || {};
    return [
      month,
      parseInt(student.id, 10) || 0,
      parseInt(student.student_number, 10) || 0,
      parseInt(counts.present, 10) || 0,
      parseInt(counts.late, 10) || 0,
      parseInt(counts.absent, 10) || 0,
      parseInt(counts.sick_leave, 10) || 0,
      parseInt(counts.personal_leave, 10) || 0,
      parseInt(stats.recorded_days, 10) || 0,
      parseInt(stats.school_days, 10) || 0,
      parseInt(stats.basis_days, 10) || 0,
      stats.attendance_percent == null ? '' : Number(stats.attendance_percent)
    ];
  });
}

function rebuildConfirmedIndexForDate_(semester, date) {
  semester = getAttendanceSummarySemester_(semester);
  if (!semester) return [];
  date = normalizeDateStringStrict_(date, 'วันที่');
  var sheet = getOrCreateAttendanceConfirmedSummarySheet_(semester);
  var rows = buildConfirmedSummaryRowsForDate_(semester, date);
  replaceRowsByKeyInSheet_(sheet, 1, date, rows, ATTENDANCE_CONFIRMED_SUMMARY_HEADERS.length);
  return rows;
}

function rebuildDailySummaryForDate_(semester, date) {
  semester = getAttendanceSummarySemester_(semester);
  if (!semester) return [];
  date = normalizeDateStringStrict_(date, 'วันที่');
  var sheet = getOrCreateAttendanceDailySummarySheet_(semester);
  var rows = buildDailySummaryRowForDate_(semester, date);
  replaceRowsByKeyInSheet_(sheet, 1, date, rows, ATTENDANCE_DAILY_SUMMARY_HEADERS.length);
  return rows;
}

function rebuildStudentMonthSummaryForMonth_(semester, month, affectedStudentIds) {
  semester = getAttendanceSummarySemester_(semester);
  if (!semester) return [];
  month = normalizeAttendanceSummaryMonth_(month);
  var sheet = getOrCreateAttendanceStudentMonthSummarySheet_(semester);
  var rows = buildStudentMonthSummaryRowsForMonth_(semester, month, affectedStudentIds);
  replaceRowsByKeyInSheet_(sheet, 1, month, rows, ATTENDANCE_STUDENT_MONTH_SUMMARY_HEADERS.length);
  return rows;
}

function rebuildAttendanceSummaryForRange_(semester, from, to) {
  semester = getAttendanceSummarySemester_(semester);
  if (!semester) return;
  var range = clampRangeToSemesterRow_(semester, { from: from, to: to });
  if (range.out_of_semester) return;
  var months = {};
  generateDateList_(range.from, range.to).forEach(function(date) {
    rebuildConfirmedIndexForDate_(semester, date);
    rebuildDailySummaryForDate_(semester, date);
    months[String(date || '').slice(0, 7)] = true;
  });
  Object.keys(months).forEach(function(month) {
    rebuildStudentMonthSummaryForMonth_(semester, month);
  });
}

function rebuildAttendanceSummaryForDate_(semester, date) {
  semester = getAttendanceSummarySemester_(semester);
  if (!semester) return;
  date = normalizeDateStringStrict_(date, 'วันที่');
  rebuildConfirmedIndexForDate_(semester, date);
  rebuildDailySummaryForDate_(semester, date);
  rebuildStudentMonthSummaryForMonth_(semester, String(date || '').slice(0, 7));
}

function getCachedConfirmedSummaryRecords_(semester) {
  semester = getAttendanceSummarySemester_(semester);
  if (!semester) return [];
  ensureAttendanceSummarySheets_(semester);
  return getOrBuildLargeCachedJson_('attendance_summary_confirmed_all', [String(semester.id || 0)], 300, function() {
    var sheet = getOrCreateAttendanceConfirmedSummarySheet_(semester);
    return readSummarySheetRows_(sheet, parseConfirmedSummaryRow_);
  });
}

function getCachedConfirmedSummaryRangeRecords_(semester, from, to) {
  semester = getAttendanceSummarySemester_(semester);
  if (!semester) return [];
  from = String(from || '').slice(0, 10);
  to = String(to || '').slice(0, 10);
  if (!from || !to || to < from) return [];
  ensureAttendanceSummarySheets_(semester);
  return getOrBuildLargeCachedJson_('attendance_summary_confirmed_range', [String(semester.id || 0), from, to], 180, function() {
    var rows = getCachedConfirmedSummaryRecords_(semester).filter(function(row) {
      return row.date >= from && row.date <= to;
    });
    if (rows.length) return rows;

    var sourceInfo = getAttendanceSourceInfoForSemester_(semester);
    var raw = getRawConfirmedAttendanceRangeForSource_(from, to, sourceInfo);
    if (!raw.length) return [];
    rebuildAttendanceSummaryForRange_(semester, from, to);
    return getCachedConfirmedSummaryRecords_(semester).filter(function(row) {
      return row.date >= from && row.date <= to;
    });
  }).map(function(row) {
    return {
      id: parseInt(row.id, 10) || 0,
      student_number: parseInt(row.student_number, 10) || 0,
      student_id: parseInt(row.student_id, 10) || 0,
      date: row.date,
      status_code: row.status_code,
      note: row.note || '',
      batch_id: row.batch_id || '',
      row_index: 0
    };
  });
}

function getCachedDailySummaryRowsForRange_(semester, from, to) {
  semester = getAttendanceSummarySemester_(semester);
  if (!semester) return [];
  from = String(from || '').slice(0, 10);
  to = String(to || '').slice(0, 10);
  if (!from || !to || to < from) return [];
  ensureAttendanceSummarySheets_(semester);
  return getOrBuildCachedJson_('attendance_summary_daily_range', [String(semester.id || 0), from, to], 180, function() {
    var sheet = getOrCreateAttendanceDailySummarySheet_(semester);
    var rows = readSummarySheetRows_(sheet, parseDailySummaryRow_).filter(function(row) {
      return row.date >= from && row.date <= to;
    });
    if (rows.length) return rows;
    rebuildAttendanceSummaryForRange_(semester, from, to);
    return readSummarySheetRows_(sheet, parseDailySummaryRow_).filter(function(row) {
      return row.date >= from && row.date <= to;
    });
  });
}

function getCachedStudentMonthSummaryRows_(semester, month) {
  semester = getAttendanceSummarySemester_(semester);
  if (!semester) return [];
  month = normalizeAttendanceSummaryMonth_(month);
  ensureAttendanceSummarySheets_(semester);
  return getOrBuildCachedJson_('attendance_summary_student_month', [String(semester.id || 0), month], 300, function() {
    var sheet = getOrCreateAttendanceStudentMonthSummarySheet_(semester);
    var rows = readSummarySheetRows_(sheet, parseStudentMonthSummaryRow_).filter(function(row) {
      return row.month === month;
    });
    if (rows.length) return rows;
    rebuildStudentMonthSummaryForMonth_(semester, month);
    return readSummarySheetRows_(sheet, parseStudentMonthSummaryRow_).filter(function(row) {
      return row.month === month;
    });
  });
}

function buildAttendanceCountsFromDailySummaryRows_(rows) {
  var counts = {
    present: 0,
    late: 0,
    absent: 0,
    sick_leave: 0,
    personal_leave: 0
  };
  (rows || []).forEach(function(row) {
    counts.present += parseInt(row.present_count, 10) || 0;
    counts.late += parseInt(row.late_count, 10) || 0;
    counts.absent += parseInt(row.absent_count, 10) || 0;
    counts.sick_leave += parseInt(row.sick_leave_count, 10) || 0;
    counts.personal_leave += parseInt(row.personal_leave_count, 10) || 0;
  });
  return counts;
}

function buildCoverageFromDailySummaryRows_(todayRecords, dailyRows, activeStudents, today, confirmedDaysCount) {
  var uniqueTodayRecords = getUniqueLatestRecords_(todayRecords || []);
  var todayChecked = uniqueTodayRecords.length;
  var todayPct = activeStudents > 0 ? Math.round((todayChecked / activeStudents) * 100) : 0;
  var totalCheckedAcrossDays = 0;
  var coverageRatios = [];
  (dailyRows || []).forEach(function(row) {
    var checkedCount = parseInt(row.checked_count, 10) || 0;
    var studentCount = parseInt(row.active_students, 10) || 0;
    totalCheckedAcrossDays += checkedCount;
    if (studentCount > 0) {
      coverageRatios.push(checkedCount / studentCount);
    }
  });
  var recordedDays = (dailyRows || []).length;
  var avgPerDay = recordedDays > 0 ? Math.round(totalCheckedAcrossDays / recordedDays) : 0;
  var avgPct = coverageRatios.length > 0
    ? Math.round((coverageRatios.reduce(function(sum, ratio) { return sum + ratio; }, 0) / coverageRatios.length) * 100)
    : 0;
  return {
    active_students: activeStudents,
    today: {
      checked: todayChecked,
      unchecked: Math.max(0, activeStudents - todayChecked),
      percent: todayPct,
      date_th: thaiDate(today, 'short', true)
    },
    month: {
      avg_coverage_percent: avgPct,
      avg_checked_per_day: avgPerDay,
      confirmed_days: parseInt(confirmedDaysCount, 10) || 0
    }
  };
}

function buildDailyTrendFromSummaryRows_(rows, range) {
  var byDate = {};
  (rows || []).forEach(function(row) {
    byDate[row.date] = row;
  });
  var labels = [];
  var present = [];
  var late = [];
  var absent = [];
  var leave = [];
  generateDateList_(range.from, range.to).forEach(function(date) {
    var weekday = getIsoWeekday_(date);
    if (weekday === 0 || weekday === 6) return;
    labels.push(String(getIsoDayOfMonth_(date)));
    var entry = byDate[date] || null;
    present.push(entry ? (parseInt(entry.present_count, 10) || 0) : 0);
    late.push(entry ? (parseInt(entry.late_count, 10) || 0) : 0);
    absent.push(entry ? (parseInt(entry.absent_count, 10) || 0) : 0);
    leave.push(entry ? ((parseInt(entry.sick_leave_count, 10) || 0) + (parseInt(entry.personal_leave_count, 10) || 0)) : 0);
  });
  return {
    labels: labels,
    datasets: [
      { label: 'มาเรียน', data: present, color: '#22c55e' },
      { label: 'สาย', data: late, color: '#f59e0b' },
      { label: 'ขาด', data: absent, color: '#ef4444' },
      { label: 'ลา', data: leave, color: '#3b82f6' }
    ]
  };
}

function buildWeekdayAnalysisFromDailySummaryRows_(rows) {
  var names = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
  var shortNames = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
  var stats = {};
  for (var i = 0; i < 7; i++) {
    stats[i] = { total: 0, absent: 0, late: 0, present: 0 };
  }
  (rows || []).forEach(function(row) {
    var date = String(row.date || '').slice(0, 10);
    if (!date) return;
    var dow = getIsoWeekday_(date);
    stats[dow].total += parseInt(row.checked_count, 10) || 0;
    stats[dow].absent += parseInt(row.absent_count, 10) || 0;
    stats[dow].late += parseInt(row.late_count, 10) || 0;
    stats[dow].present += parseInt(row.present_count, 10) || 0;
  });
  var rowsOut = [];
  for (var day = 1; day <= 5; day++) {
    var entry = stats[day];
    rowsOut.push({
      day: names[day],
      day_short: shortNames[day],
      total: entry.total,
      absent: entry.absent,
      late: entry.late,
      present: entry.present,
      absent_pct: entry.total > 0 ? Math.round((entry.absent / entry.total) * 100) : 0,
      late_pct: entry.total > 0 ? Math.round((entry.late / entry.total) * 100) : 0
    });
  }
  var worstAbsent = rowsOut.slice().sort(function(a, b) { return b.absent_pct - a.absent_pct; })[0];
  var worstLate = rowsOut.slice().sort(function(a, b) { return b.late_pct - a.late_pct; })[0];
  return {
    rows: rowsOut,
    insight: {
      worst_absent_day: worstAbsent ? worstAbsent.day : '-',
      worst_absent_pct: worstAbsent ? worstAbsent.absent_pct : 0,
      worst_late_day: worstLate ? worstLate.day : '-',
      worst_late_pct: worstLate ? worstLate.late_pct : 0
    }
  };
}

function buildStudentStatsFromMonthSummaryRows_(rows, month, students) {
  var studentIndex = buildStudentIdentityIndex_(students || []);
  return (rows || []).map(function(row) {
    var student = row.student_id > 0 && studentIndex.byId[row.student_id]
      ? studentIndex.byId[row.student_id]
      : (row.student_number > 0 ? studentIndex.byNumber[row.student_number] : null);
    return {
      student_id: row.student_id,
      student_number: student ? student.student_number : row.student_number,
      full_name: student ? student.full_name : ('เลขที่ ' + String(row.student_number || '-')),
      nickname: student ? student.nickname : '',
      total: row.total_days,
      present: row.present_count,
      late: row.late_count,
      absent: row.absent_count,
      sick_leave: row.sick_leave_count,
      personal_leave: row.personal_leave_count,
      attendance_pct: row.attendance_percent,
      basis_days: row.basis_days,
      recorded_days: row.recorded_days,
      month: month,
      is_flagged: student ? !!student.is_flagged : false,
      gender: student ? String(student.gender || '') : '',
      group_name: student ? String(student.group_name || '') : ''
    };
  });
}

