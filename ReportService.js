/**
 * Teacher-facing reports, analytics inputs, and CSV export helpers.
 */

var SUMMARY_ATTENDANCE_ALERT_PCT = 80;

function getDashboardData(month, auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_dashboard_data',
    rate_limit_limit: 120,
    rate_limit_window_sec: 60
  }, function() {
    month = normalizeMonth_(month);
    return getOrBuildCachedJson_('dashboard_data', [month], 120, function() {
      return buildDashboardData_(month);
    });
  });
}

function attachDashboardTimingDetail_(data, detail) {
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

function buildDashboardData_(month, options) {
  options = options || {};
  month = normalizeMonth_(month);
  var range = getEffectiveMonthRange_(month);
  var activeSemesterMeta = range && range.active_semester ? range.active_semester : getActiveSemesterRangeSafe_();
  var timingMeta = {
    page: 'dashboard',
    fn_name: 'buildDashboardData_',
    month: month,
    range_from: range && range.from || '',
    range_to: range && range.to || '',
    semester_name: activeSemesterMeta ? String(activeSemesterMeta.name || '') : ''
  };
  return measureTiming_('dashboard_build_ms', timingMeta, function() {
    var stepTimings = {};
    var effectiveMonth = getEffectiveRangeMonth_(range, month);
    var today = todayString_();
    var prevMonth = shiftMonth_(effectiveMonth, -1);
    var prevRange = clampRangeToActiveSemester_(monthRange_(prevMonth));
    var stepStartedAt = new Date().getTime();
    var studentData = getCachedStudentList_();
    var students = studentData.students || [];
    var allStudents = studentData.all_students || [];
    var studentIndex = buildStudentIdentityIndex_(allStudents);
    var studentSummary = getStudentSetupSummary_(studentData);
    var settings = getCachedSettings_();
    var readinessSettings = buildReadinessSettingsFromCachedSettings_(settings);
    var activeSemester = activeSemesterMeta;
    var schoolCalendarSummary = activeSemester
      ? getSchoolCalendarSummaryForRange_({ from: activeSemester.from, to: activeSemester.to })
      : { total_entries: 0, school_days: 0, holidays: 0 };
    var readinessSummary = getReadinessSummary_({
      settings: readinessSettings,
      activeSemester: activeSemester,
      studentSummary: studentSummary,
      schoolCalendarSummary: schoolCalendarSummary
    });
    stepTimings.prep_ms = new Date().getTime() - stepStartedAt;
    var thirtyDaysAgo = shiftDate_(today, -30);
    var todayRecords = getUniqueLatestRecordsByDate_(today);

    if (isEffectiveRangeEmpty_(range)) {
      var emptyTodaySummary = buildStatusCounts_(todayRecords, students.length, { records_are_unique: true, student_index: studentIndex });
      emptyTodaySummary.date_th = thaiDate(today, 'short', true);
      timingMeta.detail = Object.keys(stepTimings).map(function(key) {
        return key + '=' + stepTimings[key];
      }).join(';');
      var emptyDashboardData = buildEmptyDashboardData_(effectiveMonth, range, today, settings, students.length, emptyTodaySummary, readinessSummary);
      return options.capture_timing_detail ? attachDashboardTimingDetail_(emptyDashboardData, timingMeta.detail) : emptyDashboardData;
    }

    stepStartedAt = new Date().getTime();
    var monthRangeRecords = [];
    var prevRangeRecords = [];
    var recentRecords = [];
    var canShareRangeFetch = !!(range && range.from && range.to && range.to >= thirtyDaysAgo);
    if (canShareRangeFetch) {
      var sharedFrom = isEffectiveRangeEmpty_(prevRange)
        ? (range.from < thirtyDaysAgo ? range.from : thirtyDaysAgo)
        : (prevRange.from < thirtyDaysAgo ? prevRange.from : thirtyDaysAgo);
      var sharedTo = today > range.to ? today : range.to;
      var sharedRecords = getCachedConfirmedAttendanceRange_(sharedFrom, sharedTo);
      sharedRecords.forEach(function(record) {
        var recordDate = String(record && record.date || '').slice(0, 10);
        if (!recordDate) return;
        if (recordDate >= range.from && recordDate <= range.to) monthRangeRecords.push(record);
        if (!isEffectiveRangeEmpty_(prevRange) && recordDate >= prevRange.from && recordDate <= prevRange.to) prevRangeRecords.push(record);
        if (recordDate >= thirtyDaysAgo && recordDate <= today) recentRecords.push(record);
      });
    } else {
      monthRangeRecords = getCachedConfirmedAttendanceRange_(range.from, range.to);
      prevRangeRecords = isEffectiveRangeEmpty_(prevRange) ? [] : getCachedConfirmedAttendanceRange_(prevRange.from, prevRange.to);
      recentRecords = getCachedConfirmedAttendanceRange_(thirtyDaysAgo, today);
    }
    stepTimings.range_fetch_ms = new Date().getTime() - stepStartedAt;

    stepStartedAt = new Date().getTime();
    var contextStepStartedAt = new Date().getTime();
    var monthContext = buildAttendanceComputationContext_(range, monthRangeRecords, studentIndex, { records_are_unique: true });
    stepTimings.context_month_ms = new Date().getTime() - contextStepStartedAt;
    contextStepStartedAt = new Date().getTime();
    var prevContext = buildAttendanceComputationContext_(prevRange, prevRangeRecords, studentIndex, { records_are_unique: true });
    stepTimings.context_prev_ms = new Date().getTime() - contextStepStartedAt;
    var monthRecords = monthContext.filtered_records;
    var prevRecords = prevContext.filtered_records;
    contextStepStartedAt = new Date().getTime();
    var reportStudents = getOfficialStudentsForRange_(range, monthRecords, studentIndex);
    stepTimings.official_students_ms = new Date().getTime() - contextStepStartedAt;
    stepTimings.context_ms = new Date().getTime() - stepStartedAt;

    stepStartedAt = new Date().getTime();
    var monthlyCounts = buildStatusCounts_(monthRecords, 0, { records_are_unique: true, student_index: studentIndex });
    var prevCounts = buildStatusCounts_(prevRecords, 0, { records_are_unique: true, student_index: studentIndex });
    var studentStats = buildStudentMonthlyStats_(reportStudents, monthRecords, monthContext, studentIndex);
    var todaySummary = buildStatusCounts_(todayRecords, students.length, { records_are_unique: true, student_index: studentIndex });
    todaySummary.date_th = thaiDate(today, 'short', true);
    stepTimings.stats_ms = new Date().getTime() - stepStartedAt;

    stepStartedAt = new Date().getTime();
    var monthRecordAggregate = buildDashboardMonthRecordAggregate_(monthRecords);
    var coverage = buildCoverage_(todayRecords, monthRecords, reportStudents, range, today, monthContext.confirmed_dates_count, studentIndex, {
      dashboard_aggregate: monthRecordAggregate
    });
    var attentionList = buildAttentionList_(students, recentRecords, normalizeAttentionThresholdDays_(settings.attention_threshold_days), studentIndex);
    var dailyTrend = buildDailyTrend_(monthRecords, range, {
      records_are_unique: true,
      student_index: studentIndex,
      context: monthContext,
      dashboard_aggregate: monthRecordAggregate
    });
    var weekdayAnalysis = buildWeekdayAnalysis_(monthRecords, {
      records_are_unique: true,
      student_index: studentIndex,
      context: monthContext,
      dashboard_aggregate: monthRecordAggregate
    });
    var hallOfFame = buildHallOfFame_(
      studentStats,
      monthContext.measurement_day_dates_count || monthContext.confirmed_dates_count || monthContext.school_day_dates_count
    );
    var watchlist = buildWatchlist_(studentStats);
    var momDelta = buildMomDelta_(monthlyCounts, prevCounts, effectiveMonth, prevMonth);
    stepTimings.widgets_ms = new Date().getTime() - stepStartedAt;
    timingMeta.detail = Object.keys(stepTimings).map(function(key) {
      return key + '=' + stepTimings[key];
    }).join(';');

    var dashboardData = {
      month: effectiveMonth,
      month_th: thaiMonthLabel(effectiveMonth),
      today_summary: todaySummary,
      summary_cards: buildSummaryCards_(monthlyCounts, prevCounts),
      coverage: coverage,
      attention_list: attentionList,
      daily_trend: dailyTrend,
      doughnut_chart: buildDoughnutData_(monthlyCounts),
      weekday_analysis: weekdayAnalysis,
      hall_of_fame: hallOfFame,
      watchlist: watchlist,
      mom_delta: momDelta,
      teacher_name: settings.teacher_name || '',
      school_name: settings.school_name || '',
      class_name: settings.class_name || '',
      active_semester: range.active_semester || activeSemester,
      school_calendar_summary: schoolCalendarSummary,
      readiness_summary: readinessSummary
    };
    return options.capture_timing_detail ? attachDashboardTimingDetail_(dashboardData, timingMeta.detail) : dashboardData;
  });
}

function getSummaryTable(startDate, endDate, auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_summary_table',
    rate_limit_limit: 120,
    rate_limit_window_sec: 60
  }, function() {
    var range = clampRangeToActiveSemester_(normalizeDateRange_(startDate, endDate));
    return getCachedSummaryTableDataForRange_(range, true);
  });
}

function getDailyGrid(startDate, endDate, auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_daily_grid',
    rate_limit_limit: 120,
    rate_limit_window_sec: 60
  }, function() {
    return getCachedDailyGridDataForRange_(
      clampRangeToActiveSemester_(normalizeDateRange_(startDate, endDate))
    );
  });
}

function getCachedDailyGridDataForRange_(range) {
  if (isEffectiveRangeEmpty_(range)) {
    return buildEmptyDailyGrid_(range);
  }
  return getOrBuildCachedJson_('daily_grid', [range.from, range.to], 180, function() {
    return buildDailyGridData_(range);
  });
}

function getCachedSummaryTableDataForRange_(range, includeComparison) {
  if (isEffectiveRangeEmpty_(range)) {
    return buildEmptySummaryTable_(range);
  }
  var cachePrefix = includeComparison ? 'summary_table' : 'summary_table_core';
  return getOrBuildCachedJson_(cachePrefix, [range.from, range.to], 180, function() {
    return buildSummaryTableData_(range, !includeComparison);
  });
}

function buildSummaryTableData_(range, skipComparison) {
  return measureTiming_('report_build_ms', {
    page: 'reports',
    fn_name: 'buildSummaryTableData_',
    range_from: range && range.from || '',
    range_to: range && range.to || '',
    semester_id: range && range.active_semester ? String(range.active_semester.id || '') : '',
    semester_name: range && range.active_semester ? String(range.active_semester.name || '') : ''
  }, function() {
    var studentData = getCachedStudentList_();
    var studentIndex = buildStudentIdentityIndex_(studentData.all_students || []);
    var context = buildAttendanceComputationContext_(range, getCachedConfirmedAttendanceRange_(range.from, range.to), studentIndex, { records_are_unique: true });
    var records = context.filtered_records;
    var students = getOfficialStudentsForRange_(range, records, studentIndex);
    var recordBuckets = buildStudentRecordBuckets_(records, studentIndex, { records_are_unique: true, filtered_to_school_days: true });
    var alertPct = SUMMARY_ATTENDANCE_ALERT_PCT;

    var rows = [];
    var totals = {
      present: 0,
      late: 0,
      absent: 0,
      sick_leave: 0,
      personal_leave: 0,
      total_days: 0
    };

    students.forEach(function(student) {
      var stats = buildStudentAttendanceStatsForContext_(student, recordBuckets, context);
      var counts = stats.counts;
      var totalDays = stats.school_days;
      var attendancePercent = stats.attendance_percent;
      var basisDays = stats.basis_days;

      rows.push({
        student_number: student.student_number,
        full_name: student.full_name,
        nickname: student.nickname,
        present_count: counts.present,
        late_count: counts.late,
        absent_count: counts.absent,
        sick_leave_count: counts.sick_leave,
        personal_leave_count: counts.personal_leave,
        confirmed_record_days: stats.recorded_days,
        total_days: totalDays,
        attendance_percent: attendancePercent,
        is_below_threshold: basisDays > 0 && attendancePercent < alertPct
      });

      totals.present += counts.present;
      totals.late += counts.late;
      totals.absent += counts.absent;
      totals.sick_leave += counts.sick_leave;
      totals.personal_leave += counts.personal_leave;
      totals.total_days += totalDays;
    });

    totals.student_count = students.length;
    totals.attendance_percent = calculateAttendancePercent_(
      totals.present,
      totals.late,
      totals.total_days,
      totals.sick_leave + totals.personal_leave
    );

    var summary = {
      start_date: range.from,
      end_date: range.to,
      start_date_th: thaiDate(range.from, 'short', false),
      end_date_th: thaiDate(range.to, 'short', false),
      attendance_alert_percent: alertPct,
      confirmed_days_count: context.confirmed_dates_count,
      school_days: context.school_day_dates_count,
      calendar_holidays: context.holiday_count || 0,
      uses_calendar: !!context.uses_calendar,
      calendar_warning: {
        has_mismatch: !!context.has_calendar_mismatch,
        missing_confirmed_count: (context.missing_confirmed_dates || []).length,
        extra_confirmed_count: (context.extra_confirmed_dates || []).length,
        message: context.warning_message || ''
      },
      holiday_conflicts: (context.extra_confirmed_dates || []).map(function(date) {
        return {
          date: date,
          date_th: thaiDate(date, 'short', true),
          record_count: parseInt((context.record_counts_by_date || {})[date], 10) || 0
        };
      }),
      rows: rows,
      totals: totals,
      top_absent: rows.slice().sort(function(a, b) { return b.absent_count - a.absent_count; }).slice(0, 5).filter(function(row) { return row.absent_count > 0; }),
      top_late: rows.slice().sort(function(a, b) { return b.late_count - a.late_count; }).slice(0, 5).filter(function(row) { return row.late_count > 0; }),
      leave_reasons: buildLeaveReasons_(records)
    };
    if (!skipComparison) {
      summary.comparison = buildSummaryComparison_(range, summary.totals);
    }
    return summary;
  });
}

function warmLikelyDerivedCachesForDate_(date) {
  date = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;

  var mode = String(arguments[1] && arguments[1].mode || 'default').trim().toLowerCase();
  if (['record', 'undo', 'bulk', 'undo_bulk', 'save_note', 'draft'].indexOf(mode) >= 0) {
    return;
  }

  try {
    measureTiming_('derived_cache_warm_ms', {
      page: 'attendance',
      fn_name: 'warmLikelyDerivedCachesForDate_',
      date: date,
      month: date.slice(0, 7),
      detail: 'mode=' + mode
    }, function() {
      var month = date.slice(0, 7);
      getOrBuildCachedJson_('dashboard_data', [month], 120, function() {
        return buildDashboardData_(month);
      });

      var monthRange = getEffectiveMonthRange_(month);
      if (!isEffectiveRangeEmpty_(monthRange)) {
        getCachedSummaryTableDataForRange_(monthRange, true);
        getCachedDailyGridDataForRange_(monthRange);
      }
    });
  } catch (e) {
    Logger.log('warmLikelyDerivedCachesForDate_ failed: ' + e.message);
  }
}

function exportCSV(reportType, params, auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'export_csv',
    rate_limit_limit: 40,
    rate_limit_window_sec: 60
  }, function() {
    return exportCSVData_(reportType, params);
  });
}

/**
 * สร้างไฟล์ CSV ชั่วคราวบน Drive แล้วส่ง URL ดาวน์โหลดกลับให้ client
 * client จะเรียก cleanupCSVFile ลบไฟล์ทิ้งหลังดาวน์โหลดเสร็จ
 */
function downloadCSV(reportType, params, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'download_csv',
    rate_limit_limit: 20,
    rate_limit_window_sec: 300
  }, function(session) {
    var exportData;
    try {
      exportData = exportCSVData_(reportType, params);
    } catch (e) {
      return { success: false, message: e.message };
    }

    var file = DriveApp.createFile(
      Utilities.newBlob(exportData.content, 'text/csv', exportData.filename)
    );
    registerTempDriveFile_(file.getId(), session, 'csv_export', 1800);

    return {
      success: true,
      url: file.getDownloadUrl(),
      filename: file.getName(),
      file_id: file.getId()
    };
  });
}

function cleanupCSVFile(fileId, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'cleanup_csv_file',
    rate_limit_limit: 30,
    rate_limit_window_sec: 300
  }, function(session) {
    if (!canCleanupTempDriveFile_(fileId, session, 'csv_export')) {
      return { success: false, message: 'ไม่พบไฟล์ CSV ชั่วคราวที่อนุญาตให้ลบ' };
    }
    try {
      DriveApp.getFileById(fileId).setTrashed(true);
    } catch (e) {}
    clearTempDriveFileRegistration_(fileId);
    return { success: true };
  });
}

function exportCSVData_(reportType, params) {
  reportType = String(reportType || '').trim();
  params = params || {};

  if (reportType === 'monthly') {
    return buildSummaryCsvExport_(
      clampRangeToActiveSemester_(normalizeDateRange_(params.start_date, params.end_date))
    );
  }
  if (reportType === 'daily') {
    return buildDailyGridCsvExport_(
      clampRangeToActiveSemester_(normalizeDateRange_(params.from, params.to))
    );
  }
  throw new Error('ประเภทรายงานไม่ถูกต้อง');
}

function buildSummaryCsvExport_(range) {
  if (isEffectiveRangeEmpty_(range)) {
    throw new Error('ช่วงวันที่ที่เลือกอยู่นอกภาคเรียนที่ใช้งานอยู่');
  }

  var data = getCachedSummaryTableDataForRange_(range, false);
  var rows = [[
    'เลขที่', 'ชื่อ-สกุล', 'ชื่อเล่น', 'มาเรียน', 'สาย', 'ขาด', 'ลาป่วย', 'ลากิจ',
    'วันที่มีบันทึก', 'วันเรียนทั้งหมด', 'ร้อยละการมาเรียน'
  ]];

  (data.rows || []).forEach(function(row) {
    rows.push([
      row.student_number,
      row.full_name,
      row.nickname || '',
      row.present_count,
      row.late_count,
      row.absent_count,
      row.sick_leave_count,
      row.personal_leave_count,
      row.confirmed_record_days,
      row.total_days,
      row.attendance_percent == null ? '' : row.attendance_percent
    ]);
  });

  var totals = data.totals || {};
  rows.push([
    '', 'รวม', '',
    totals.present || 0,
    totals.late || 0,
    totals.absent || 0,
    totals.sick_leave || 0,
    totals.personal_leave || 0,
    '',
    totals.total_days || 0,
    totals.attendance_percent == null ? '' : totals.attendance_percent
  ]);

  return {
    filename: 'attendance-summary-' + range.from + '_' + range.to + '.csv',
    content: buildCSVString_(rows)
  };
}

function buildDailyGridCsvExport_(range) {
  if (isEffectiveRangeEmpty_(range)) {
    throw new Error('ช่วงวันที่ที่เลือกอยู่นอกภาคเรียนที่ใช้งานอยู่');
  }

  var data = getCachedDailyGridDataForRange_(range);
  var dates = data.dates || [];
  var header = ['เลขที่', 'ชื่อ-สกุล', 'ชื่อเล่น'];
  dates.forEach(function(dateInfo) {
    header.push(dateInfo.date);
  });

  var rows = [header];
  (data.students || []).forEach(function(student) {
    var row = [student.student_number, student.full_name, student.nickname || ''];
    dates.forEach(function(dateInfo) {
      var status = student.statuses ? student.statuses[dateInfo.date] : null;
      row.push(status ? status.label : '');
    });
    rows.push(row);
  });

  return {
    filename: 'attendance-daily-' + range.from + '_' + range.to + '.csv',
    content: buildCSVString_(rows)
  };
}

function getAllAttendanceRecords_(sourceInfo) {
  ensureStudentIdentityMigration_();
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  return getOrBuildLargeCachedJson_('attendance_all_records', [String(sourceInfo.key || 'live')], 180, function() {
    return readAllAttendanceRecords_(sourceInfo);
  });
}

function readAllAttendanceRecords_(sourceInfo) {
  sourceInfo = sourceInfo || getCurrentAttendanceSourceInfo_();
  var startedAt = new Date().getTime();
  var sheet = null;
  var lastRow = 0;
  var records = [];
  try {
    sheet = getAttendanceSourceSheet_(sourceInfo);
    if (!sheet) return [];
    lastRow = sheet.getLastRow();
    if (lastRow <= 1) return [];

    var data = sheet.getRange(2, 1, lastRow - 1, COL.ATTENDANCE.STUDENT_ID).getValues();

    data.forEach(function(row, index) {
      var date = row[2];
      try {
        date = normalizeDateStringStrict_(date, 'วันที่');
      } catch (e) {
        return;
      }
      if (!isDateWithinAttendanceSource_(date, sourceInfo)) return;

      records.push({
        id: row[0],
        student_number: parseInt(row[1], 10),
        student_id: parseInt(row[COL.ATTENDANCE.STUDENT_ID - 1], 10) || 0,
        date: date,
        status_code: String(row[3] || ''),
        note: String(row[4] || ''),
        batch_id: String(row[5] || ''),
        row_index: index + 2
      });
    });

    var durationMs = new Date().getTime() - startedAt;
    if (shouldWriteTimingLog_('attendance_scan_ms', durationMs, 'slow')) {
      appendTimingLog_({
        metric: 'attendance_scan_ms',
        duration_ms: durationMs,
        status: 'slow',
        page: 'reports',
        fn_name: 'readAllAttendanceRecords_',
        range_from: String(sourceInfo.from || ''),
        range_to: String(sourceInfo.to || ''),
        semester_id: String(sourceInfo.semester_id || ''),
        semester_name: sourceInfo && sourceInfo.semester ? String(sourceInfo.semester.name || '') : '',
        detail: 'source=' + String(sourceInfo.key || 'live') + ';sheet=' + String(sheet.getName() || '') + ';rows=' + Math.max(0, lastRow - 1) + ';records=' + records.length
      });
    }

    return records;
  } catch (eScan) {
    var errorDurationMs = new Date().getTime() - startedAt;
    appendTimingLog_({
      metric: 'attendance_scan_ms',
      duration_ms: errorDurationMs,
      status: 'error',
      page: 'reports',
      fn_name: 'readAllAttendanceRecords_',
      range_from: String(sourceInfo && sourceInfo.from || ''),
      range_to: String(sourceInfo && sourceInfo.to || ''),
      semester_id: String(sourceInfo && sourceInfo.semester_id || ''),
      semester_name: sourceInfo && sourceInfo.semester ? String(sourceInfo.semester.name || '') : '',
      detail: 'source=' + String(sourceInfo && sourceInfo.key || 'live') + ';sheet=' + String(sheet && sheet.getName ? sheet.getName() : '') + ';rows=' + Math.max(0, lastRow - 1) + ';records=' + records.length + ';message=' + String(eScan && eScan.message || eScan)
    });
    throw eScan;
  }
}

function buildDailyGridData_(range) {
  return measureTiming_('report_build_ms', {
    page: 'reports',
    fn_name: 'buildDailyGridData_',
    range_from: range && range.from || '',
    range_to: range && range.to || '',
    semester_id: range && range.active_semester ? String(range.active_semester.id || '') : '',
    semester_name: range && range.active_semester ? String(range.active_semester.name || '') : ''
  }, function() {
    var studentData = getCachedStudentList_();
    var studentIndex = buildStudentIdentityIndex_(studentData.all_students || []);
    var confirmedRecords = getCachedConfirmedAttendanceRange_(range.from, range.to);
    var context = buildAttendanceComputationContext_(range, confirmedRecords, studentIndex, { records_are_unique: true });
    var students = getOfficialStudentsForRange_(range, confirmedRecords, studentIndex);
    var recordBuckets = buildStudentRecordBuckets_(confirmedRecords, studentIndex, { records_are_unique: true });
    var calendarMap = getSchoolCalendarEntryMap_(range);
    var holidayConflictSet = {};
    (context.extra_confirmed_dates || []).forEach(function(date) {
      holidayConflictSet[date] = true;
    });

    var displayDateSet = {};
    (context.school_day_dates || []).forEach(function(date) {
      displayDateSet[date] = true;
    });
    Object.keys(holidayConflictSet).forEach(function(date) {
      displayDateSet[date] = true;
    });

    var dates = Object.keys(displayDateSet).sort().map(function(date) {
      var calendarEntry = calendarMap[date] || null;
      var isoWeekday = getIsoWeekday_(date);
      return {
        date: date,
        label: thaiDate(date, 'short', true),
        is_weekend: isoWeekday === 0 || isoWeekday === 6,
        is_holiday: !!holidayConflictSet[date] || !!(calendarEntry && calendarEntry.type === 'holiday')
      };
    });

    var studentRows = students.map(function(student) {
      var statuses = {};
      getRecordsForStudent_(recordBuckets, student).forEach(function(record) {
        var info = STATUS_MAP[record.status_code] || {};
        statuses[record.date] = {
          status_code: String(record.status_code || ''),
          label: String(info.label || record.status_code || ''),
          icon: String(info.icon || '?'),
          color: String(info.color || 'stone'),
          note: String(record.note || '')
        };
      });

      return {
        id: parseInt(student.id, 10) || 0,
        student_number: student.student_number,
        full_name: student.full_name,
        nickname: student.nickname || '',
        group_name: student.group_name || '',
        is_flagged: !!student.is_flagged,
        statuses: statuses
      };
    });

    return {
      from: range.from,
      to: range.to,
      from_th: thaiDate(range.from, 'short', false),
      to_th: thaiDate(range.to, 'short', false),
      school_days: context.school_day_dates_count || 0,
      confirmed_days_count: context.confirmed_dates_count || 0,
      calendar_warning: {
        has_mismatch: !!context.has_calendar_mismatch,
        missing_confirmed_count: (context.missing_confirmed_dates || []).length,
        extra_confirmed_count: (context.extra_confirmed_dates || []).length,
        message: context.warning_message || ''
      },
      holiday_conflicts: (context.extra_confirmed_dates || []).map(function(date) {
        return {
          date: date,
          date_th: thaiDate(date, 'short', true),
          record_count: parseInt((context.record_counts_by_date || {})[date], 10) || 0
        };
      }),
      dates: dates,
      students: studentRows,
      out_of_semester: false
    };
  });
}

function buildStatusCounts_(records, totalStudents) {
  var options = arguments[2] || {};
  if (options && options.byId && options.byNumber) options = { student_index: options };
  var counts = {
    present: 0,
    late: 0,
    absent: 0,
    sick_leave: 0,
    personal_leave: 0,
    total: totalStudents,
    checked: 0
  };
  var uniqueRecords = options.records_are_unique && Array.isArray(records)
    ? records
    : getUniqueLatestRecords_(records, options.student_index || options.studentIndex || null, {
      records_are_unique: !!options.records_are_unique
    });

  uniqueRecords.forEach(function(record) {
    if (counts.hasOwnProperty(record.status_code)) counts[record.status_code]++;
  });

  counts.checked = uniqueRecords.length;
  counts.unchecked = Math.max(0, totalStudents - uniqueRecords.length);
  counts.total_students = totalStudents;
  return counts;
}

function buildSummaryCards_(current, previous) {
  var items = [
    { code: 'present', label: 'มาเรียน', icon: '✅', color: 'green' },
    { code: 'late', label: 'สาย', icon: '⏰', color: 'amber' },
    { code: 'absent', label: 'ขาด', icon: '❌', color: 'red' },
    { code: 'sick_leave', label: 'ลาป่วย', icon: '🏥', color: 'blue' },
    { code: 'personal_leave', label: 'ลากิจ', icon: '📋', color: 'indigo' }
  ];
  var totalCurrent = items.reduce(function(sum, item) {
    return sum + (current[item.code] || 0);
  }, 0) || 1;

  return items.map(function(item) {
    var count = current[item.code] || 0;
    var prevCount = previous[item.code] || 0;
    var delta = count - prevCount;
    return {
      code: item.code,
      label: item.label,
      icon: item.icon,
      color: item.color,
      count: count,
      percent: Math.round((count / totalCurrent) * 1000) / 10,
      prev_count: prevCount,
      delta: delta,
      delta_text: delta > 0 ? '+' + delta : (delta < 0 ? String(delta) : '0'),
      delta_direction: delta > 0 ? 'up' : (delta < 0 ? 'down' : 'same')
    };
  });
}

function buildDashboardMonthRecordAggregate_(records) {
  var aggregate = {
    by_date: {},
    record_counts_by_date: {},
    recorded_dates: [],
    weekday_stats: {}
  };
  for (var dayIndex = 0; dayIndex < 7; dayIndex++) {
    aggregate.weekday_stats[dayIndex] = { total: 0, absent: 0, late: 0, present: 0 };
  }

  (records || []).forEach(function(record) {
    var recordDate = String(record && record.date || '').slice(0, 10);
    if (!recordDate) return;
    var statusCode = String(record && record.status_code || '');
    var byDate = aggregate.by_date[recordDate];
    if (!byDate) {
      byDate = { present: 0, late: 0, absent: 0, leave: 0, total: 0 };
      aggregate.by_date[recordDate] = byDate;
    }
    byDate.total++;
    if (statusCode === 'present') byDate.present++;
    else if (statusCode === 'late') byDate.late++;
    else if (statusCode === 'absent') byDate.absent++;
    else byDate.leave++;
    aggregate.record_counts_by_date[recordDate] = byDate.total;

    var dow = getIsoWeekday_(recordDate);
    var weekdayEntry = aggregate.weekday_stats[dow] || { total: 0, absent: 0, late: 0, present: 0 };
    weekdayEntry.total++;
    if (statusCode === 'absent') weekdayEntry.absent++;
    if (statusCode === 'late') weekdayEntry.late++;
    if (statusCode === 'present') weekdayEntry.present++;
    aggregate.weekday_stats[dow] = weekdayEntry;
  });

  aggregate.recorded_dates = Object.keys(aggregate.record_counts_by_date).sort();
  return aggregate;
}

function buildCoverage_(todayRecords, monthRecords, reportStudents, range, today, confirmedDaysCount) {
  var studentIndex = arguments[6] || null;
  var options = arguments[7] || {};
  var dashboardAggregate = options.dashboard_aggregate || null;
  var uniqueTodayRecords = Array.isArray(todayRecords) ? todayRecords : getUniqueLatestRecords_(todayRecords, studentIndex, { records_are_unique: true });
  var uniqueMonthRecords = Array.isArray(monthRecords) ? monthRecords : getUniqueLatestRecords_(monthRecords, studentIndex, { records_are_unique: true });
  var totalStudents = (reportStudents && reportStudents.length) || 0;
  var studentCountByDate = {};
  var recordedDatesForRosterCount = dashboardAggregate && Array.isArray(dashboardAggregate.recorded_dates)
    ? dashboardAggregate.recorded_dates.filter(function(date) { return date !== today; })
    : [];
  if (!recordedDatesForRosterCount.length) {
    var recordedDateSet = {};
    uniqueMonthRecords.forEach(function(record) {
      var recordDate = String(record && record.date || '').slice(0, 10);
      if (!recordDate || recordDate === today || recordedDateSet[recordDate]) return;
      recordedDateSet[recordDate] = true;
      recordedDatesForRosterCount.push(recordDate);
    });
  }
  recordedDatesForRosterCount.sort();
  if (recordedDatesForRosterCount.length) {
    var diff = [];
    for (var i = 0; i <= recordedDatesForRosterCount.length; i++) diff[i] = 0;
    (reportStudents || []).forEach(function(student) {
      var bounds = getStudentRosterBounds_(student);
      var startIndex = bounds.start ? findSortedDateInsertionIndex_(recordedDatesForRosterCount, bounds.start) : 0;
      var endIndex = bounds.end ? findSortedDateInsertionIndex_(recordedDatesForRosterCount, bounds.end) : recordedDatesForRosterCount.length;
      if (startIndex >= endIndex) return;
      diff[startIndex]++;
      diff[endIndex]--;
    });
    var running = 0;
    recordedDatesForRosterCount.forEach(function(date, index) {
      running += diff[index] || 0;
      studentCountByDate[date] = running;
    });
  }
  function getStudentCountForDate_(date) {
    date = String(date || '').slice(0, 10);
    if (!date) return 0;
    if (studentCountByDate.hasOwnProperty(date)) return studentCountByDate[date];
    if (date === today) {
      studentCountByDate[date] = getStudentsForAttendanceDate_(date).length;
      return studentCountByDate[date];
    }
    var count = 0;
    (reportStudents || []).forEach(function(student) {
      if (isStudentInRosterOnDate_(student, date)) count++;
    });
    studentCountByDate[date] = count;
    return studentCountByDate[date];
  }
  var todayStudentTotal = getStudentCountForDate_(today);
  var todayChecked = uniqueTodayRecords.length;
  var todayPct = todayStudentTotal > 0 ? Math.round((todayChecked / todayStudentTotal) * 100) : 0;
  var dailyCounts = dashboardAggregate && dashboardAggregate.record_counts_by_date
    ? dashboardAggregate.record_counts_by_date
    : {};
  if (!dashboardAggregate || !dashboardAggregate.record_counts_by_date) {
    uniqueMonthRecords.forEach(function(record) {
      dailyCounts[record.date] = (dailyCounts[record.date] || 0) + 1;
    });
  }

  var recordedDates = dashboardAggregate && Array.isArray(dashboardAggregate.recorded_dates)
    ? dashboardAggregate.recorded_dates.slice()
    : Object.keys(dailyCounts);
  var recordedDays = recordedDates.length;
  var totalCheckedAcrossDays = 0;
  var coverageRatios = [];
  recordedDates.forEach(function(date) {
    var checkedCount = dailyCounts[date] || 0;
    var studentCount = getStudentCountForDate_(date);
    totalCheckedAcrossDays += checkedCount;
    if (studentCount > 0) {
      coverageRatios.push(checkedCount / studentCount);
    }
  });
  var avgPerDay = recordedDays > 0 ? Math.round(totalCheckedAcrossDays / recordedDays) : 0;
  var avgPct = coverageRatios.length > 0 ? Math.round((coverageRatios.reduce(function(sum, ratio) {
    return sum + ratio;
  }, 0) / coverageRatios.length) * 100) : 0;

  return {
    active_students: todayStudentTotal || totalStudents,
    today: {
      checked: todayChecked,
      unchecked: Math.max(0, (todayStudentTotal || totalStudents) - todayChecked),
      percent: todayPct,
      date_th: thaiDate(today, 'short', true)
    },
    month: {
      avg_coverage_percent: avgPct,
      avg_checked_per_day: avgPerDay,
      recorded_days: recordedDays,
      confirmed_days: parseInt(confirmedDaysCount, 10) || 0,
      from_th: thaiDate(range.from, 'short', false),
      to_th: thaiDate(range.to, 'short', false)
    }
  };
}

function buildAttentionList_(students, recentRecords, threshold) {
  var items = [];
  var studentIndex = arguments[3] || null;
  var countsByStudentKey = {};

  (recentRecords || []).forEach(function(record) {
    var student = resolveRecordStudent_(record, studentIndex);
    if (!student || !isStudentInRosterOnDate_(student, record.date)) return;
    var key = getStudentKey_(student);
    if (!countsByStudentKey[key]) {
      countsByStudentKey[key] = { absent: 0, late: 0 };
    }
    if (record.status_code === 'absent') countsByStudentKey[key].absent++;
    if (record.status_code === 'late') countsByStudentKey[key].late++;
  });

  students.forEach(function(student) {
    var counts = countsByStudentKey[getStudentKey_(student)] || { absent: 0, late: 0 };
    var absentCount = counts.absent;
    var lateCount = counts.late;

    var total = absentCount + lateCount;
    if (total >= threshold) {
      items.push({
        student_number: student.student_number,
        full_name: student.full_name,
        nickname: student.nickname,
        absent_count: absentCount,
        late_count: lateCount,
        total: total,
        is_flagged: student.is_flagged
      });
    }
  });

  items.sort(function(a, b) { return b.total - a.total; });
  return items;
}

function buildDailyTrend_(records, range) {
  var options = arguments[2] || {};
  if (options && options.byId && options.byNumber) options = { student_index: options };
  var dashboardAggregate = options.dashboard_aggregate || null;
  var byDate = dashboardAggregate && dashboardAggregate.by_date ? dashboardAggregate.by_date : {};
  var labels = [];
  var present = [];
  var late = [];
  var absent = [];
  var leave = [];

  if (!dashboardAggregate || !dashboardAggregate.by_date) {
    var uniqueRecords = options.records_are_unique && Array.isArray(records)
      ? records
      : getUniqueLatestRecords_(records, options.student_index || options.studentIndex || null, {
        records_are_unique: !!options.records_are_unique
      });

    uniqueRecords.forEach(function(record) {
      if (!byDate[record.date]) {
        byDate[record.date] = { present: 0, late: 0, absent: 0, leave: 0, total: 0 };
      }
      byDate[record.date].total++;
      if (record.status_code === 'present') byDate[record.date].present++;
      else if (record.status_code === 'late') byDate[record.date].late++;
      else if (record.status_code === 'absent') byDate[record.date].absent++;
      else byDate[record.date].leave++;
    });
  }

  var trendDates = options.context && Array.isArray(options.context.school_day_dates) && options.context.school_day_dates.length
    ? options.context.school_day_dates.slice()
    : generateDateList_(range.from, range.to).filter(function(date) {
        var weekday = getIsoWeekday_(date);
        return weekday !== 0 && weekday !== 6;
      });

  trendDates.forEach(function(date) {

    labels.push(String(getIsoDayOfMonth_(date)));
    var entry = byDate[date] || { present: 0, late: 0, absent: 0, leave: 0 };
    present.push(entry.present);
    late.push(entry.late);
    absent.push(entry.absent);
    leave.push(entry.leave);
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

function buildDoughnutData_(counts) {
  return {
    labels: ['มาเรียน', 'สาย', 'ขาด', 'ลาป่วย', 'ลากิจ'],
    values: [counts.present, counts.late, counts.absent, counts.sick_leave, counts.personal_leave],
    colors: ['#22c55e', '#f59e0b', '#ef4444', '#3b82f6', '#6366f1']
  };
}

function buildWeekdayAnalysis_(records) {
  var options = arguments[1] || {};
  if (options && options.byId && options.byNumber) options = { student_index: options };
  var names = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
  var shortNames = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
  var dashboardAggregate = options.dashboard_aggregate || null;
  var stats = {};
  var schoolDayMap = options.context && options.context.school_day_map ? options.context.school_day_map : null;

  for (var i = 0; i < 7; i++) {
    stats[i] = { total: 0, absent: 0, late: 0, present: 0 };
  }

  if (dashboardAggregate && dashboardAggregate.weekday_stats && !schoolDayMap) {
    for (var weekdayIndex = 0; weekdayIndex < 7; weekdayIndex++) {
      var aggregateEntry = dashboardAggregate.weekday_stats[weekdayIndex] || {};
      stats[weekdayIndex] = {
        total: parseInt(aggregateEntry.total, 10) || 0,
        absent: parseInt(aggregateEntry.absent, 10) || 0,
        late: parseInt(aggregateEntry.late, 10) || 0,
        present: parseInt(aggregateEntry.present, 10) || 0
      };
    }
  } else {
    var uniqueRecords = options.records_are_unique && Array.isArray(records)
      ? records
      : getUniqueLatestRecords_(records, options.student_index || options.studentIndex || null, {
        records_are_unique: !!options.records_are_unique
      });

    uniqueRecords.forEach(function(record) {
      if (schoolDayMap && !schoolDayMap[String(record.date || '')]) return;
      var dow = getIsoWeekday_(record.date);
      stats[dow].total++;
      if (record.status_code === 'absent') stats[dow].absent++;
      if (record.status_code === 'late') stats[dow].late++;
      if (record.status_code === 'present') stats[dow].present++;
    });
  }

  var rows = [];
  for (var day = 1; day <= 5; day++) {
    var entry = stats[day];
    rows.push({
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

  var worstAbsent = rows.slice().sort(function(a, b) { return b.absent_pct - a.absent_pct; })[0];
  var worstLate = rows.slice().sort(function(a, b) { return b.late_pct - a.late_pct; })[0];

  return {
    rows: rows,
    insight: {
      worst_absent_day: worstAbsent ? worstAbsent.day : '-',
      worst_absent_pct: worstAbsent ? worstAbsent.absent_pct : 0,
      worst_late_day: worstLate ? worstLate.day : '-',
      worst_late_pct: worstLate ? worstLate.late_pct : 0
    }
  };
}

function buildStudentMonthlyStats_(students, records, context, studentsOrIndex) {
  var studentIndex = studentsOrIndex && studentsOrIndex.byId && studentsOrIndex.byNumber
    ? studentsOrIndex
    : buildStudentIdentityIndex_(studentsOrIndex || (getCachedStudentList_().all_students || []));
  context = context || buildAttendanceComputationContext_({}, records, studentIndex);
  var sourceRecords = context && context.filtered_records ? context.filtered_records : records;
  var recordBuckets = buildStudentRecordBuckets_(sourceRecords, studentIndex, {
    records_are_unique: !!(context && context.filtered_records),
    filtered_to_school_days: !!(context && context.filtered_records)
  });
  var statsByStudentKey = {};
  Object.keys(recordBuckets || {}).forEach(function(studentKey) {
    var bucket = recordBuckets[studentKey] || [];
    var counts = { present: 0, late: 0, absent: 0, sick_leave: 0, personal_leave: 0 };
    for (var i = 0; i < bucket.length; i++) {
      var statusCode = String(bucket[i] && bucket[i].status_code || '');
      if (counts.hasOwnProperty(statusCode)) counts[statusCode]++;
    }
    statsByStudentKey[studentKey] = {
      counts: counts,
      recorded_days: bucket.length
    };
  });
  return students.map(function(student) {
    var studentKey = student && student.__student_key ? student.__student_key : getStudentKey_(student);
    var aggregated = statsByStudentKey[studentKey] || null;
    var counts = aggregated ? aggregated.counts : { present: 0, late: 0, absent: 0, sick_leave: 0, personal_leave: 0 };
    var schoolDays = getStudentSchoolDayCountForContext_(student, context);
    var excusedLeaveDays = counts.sick_leave + counts.personal_leave;
    var attendancePercent = calculateAttendancePercent_(counts.present, counts.late, schoolDays, excusedLeaveDays);

    return {
      student_number: student.student_number,
      full_name: student.full_name,
      nickname: student.nickname,
      total: schoolDays,
      present: counts.present,
      late: counts.late,
      absent: counts.absent,
      sick_leave: counts.sick_leave,
      personal_leave: counts.personal_leave,
      attendance_pct: attendancePercent
      };
    });
}

function buildHallOfFame_(studentStats, recordedDays) {
  if (!recordedDays || recordedDays < 3) return { level: 'empty', items: [], recorded_days: recordedDays || 0 };

  var minSampleDays = Math.min(5, recordedDays);
  var items = studentStats.slice().filter(function(student) {
    return student.attendance_pct != null && student.total >= minSampleDays;
  }).sort(function(a, b) {
    var pctDiff = (b.attendance_pct == null ? -1 : b.attendance_pct) - (a.attendance_pct == null ? -1 : a.attendance_pct);
    if (pctDiff !== 0) return pctDiff;
    return (b.total || 0) - (a.total || 0);
  }).slice(0, 5);

  var level = 'empty';
  if (items.length) {
    if (items[0].attendance_pct >= 100) level = 'gold';
    else if (items[0].attendance_pct >= 90) level = 'silver';
    else if (items[0].attendance_pct >= 80) level = 'bronze';
    else level = 'iron';
  }

  return {
    level: level,
    items: items.map(function(student) {
      return {
        student_number: student.student_number,
        full_name: student.full_name,
        nickname: student.nickname,
        attendance_pct: student.attendance_pct,
        present: student.present,
        total: student.total
      };
    }),
    recorded_days: recordedDays
  };
}

function buildWatchlist_(studentStats) {
  return {
    low_attendance: studentStats.slice().filter(function(student) {
      return student.attendance_pct != null && student.total > 0 && student.attendance_pct < 80;
    }).sort(function(a, b) { return a.attendance_pct - b.attendance_pct; }).slice(0, 5),
    most_late: studentStats.slice().filter(function(student) {
      return student.late > 0;
    }).sort(function(a, b) { return b.late - a.late; }).slice(0, 5),
    most_absent: studentStats.slice().filter(function(student) {
      return student.absent > 0;
    }).sort(function(a, b) { return b.absent - a.absent; }).slice(0, 5)
  };
}

function buildMomDelta_(current, previous, currentMonth, previousMonth) {
  var metrics = [
    { label: 'มาเรียน', key: 'present', icon: '✅' },
    { label: 'สาย', key: 'late', icon: '⏰' },
    { label: 'ขาด', key: 'absent', icon: '❌' },
    { label: 'ลาป่วย', key: 'sick_leave', icon: '🏥' },
    { label: 'ลากิจ', key: 'personal_leave', icon: '📋' }
  ];

  return {
    current_month_th: thaiMonthLabel(currentMonth),
    previous_month_th: thaiMonthLabel(previousMonth),
    metrics: metrics.map(function(metric) {
      var cur = current[metric.key] || 0;
      var prev = previous[metric.key] || 0;
      var delta = cur - prev;
      return {
        label: metric.label,
        icon: metric.icon,
        current_count: cur,
        previous_count: prev,
        delta: delta,
        delta_text: delta > 0 ? '+' + delta : String(delta),
        direction: delta > 0 ? 'up' : (delta < 0 ? 'down' : 'same')
      };
    })
  };
}

function buildLeaveReasons_(records) {
  var reasons = {};

  records.forEach(function(record) {
    if (['sick_leave', 'personal_leave', 'late'].indexOf(record.status_code) < 0) return;
    var note = String(record.note || '').trim();
    if (!note) return;

    if (!reasons[note]) {
      reasons[note] = { note: note, count: 0, status_code: record.status_code };
    }
    reasons[note].count++;
  });

  return Object.keys(reasons).map(function(key) {
    return reasons[key];
  }).sort(function(a, b) {
    return b.count - a.count;
  }).slice(0, 12);
}

function normalizeMonth_(month) {
  if (!month) {
    return todayString_().substring(0, 7);
  }
  var match = String(month || '').trim().match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    throw new Error('เดือนไม่ถูกต้อง');
  }
  var year = parseInt(match[1], 10);
  var monthNum = parseInt(match[2], 10);
  if (!(year > 0 && monthNum >= 1 && monthNum <= 12)) {
    throw new Error('เดือนไม่ถูกต้อง');
  }
  return match[1] + '-' + match[2];
}

function monthRange_(month) {
  month = normalizeMonth_(month);
  var parts = String(month).split('-');
  var year = parseInt(parts[0], 10);
  var monthNum = parseInt(parts[1], 10);
  var firstDay = year + '-' + ('0' + monthNum).slice(-2) + '-01';
  var lastDay = year + '-' + ('0' + monthNum).slice(-2) + '-' + ('0' + getMonthLastDay_(year, monthNum)).slice(-2);
  return { from: firstDay, to: lastDay };
}

function shiftMonth_(month, offset) {
  month = normalizeMonth_(month);
  var parts = String(month).split('-');
  var baseMonthIndex = (parseInt(parts[0], 10) * 12) + (parseInt(parts[1], 10) - 1) + offset;
  var year = Math.floor(baseMonthIndex / 12);
  var monthNum = (baseMonthIndex % 12 + 12) % 12;
  return year + '-' + ('0' + (monthNum + 1)).slice(-2);
}

function normalizeDateRange_(start, end) {
  var defaultRange = monthRange_(normalizeMonth_(null));
  start = start ? normalizeDateStringStrict_(start, 'วันที่เริ่มต้น') : defaultRange.from;
  end = end ? normalizeDateStringStrict_(end, 'วันที่สิ้นสุด') : todayString_();
  if (start > end) {
    throw new Error('วันที่เริ่มต้นต้องไม่มากกว่าวันที่สิ้นสุด');
  }
  return { from: start, to: end };
}

function getActiveSemesterRangeSafe_() {
  try {
    var semester = getActiveSemesterRow_();
    return semester ? {
      name: semester.name,
      from: semester.start_date,
      to: semester.end_date,
      start_date: semester.start_date,
      end_date: semester.end_date,
      start_date_th: semester.start_date_th,
      end_date_th: semester.end_date_th
    } : null;
  } catch (e) {
    return null;
  }
}

function clampRangeToActiveSemester_(range) {
  range = range || {};
  var normalized = {
    from: String(range.from || ''),
    to: String(range.to || ''),
    requested_from: String(range.from || ''),
    requested_to: String(range.to || '')
  };
  var semester = getActiveSemesterRangeSafe_();
  if (!semester) {
    normalized.active_semester = null;
    normalized.semester_clamped = false;
    normalized.out_of_semester = false;
    return normalized;
  }

  var from = normalized.from;
  var to = normalized.to;
  if (to && from && (to < semester.from || from > semester.to)) {
    return {
      from: '',
      to: '',
      requested_from: normalized.requested_from,
      requested_to: normalized.requested_to,
      active_semester: semester,
      semester_clamped: true,
      out_of_semester: true
    };
  }

  if (!from || from < semester.from) from = semester.from;
  if (!to || to > semester.to) to = semester.to;

  return {
    from: from,
    to: to,
    requested_from: normalized.requested_from,
    requested_to: normalized.requested_to,
    active_semester: semester,
    semester_clamped: from !== normalized.from || to !== normalized.to,
    out_of_semester: false
  };
}

function getEffectiveMonthRange_(month) {
  var requestedMonth = normalizeMonth_(month);
  var range = clampRangeToActiveSemester_(monthRange_(requestedMonth));
  range.requested_month = requestedMonth;
  return range;
}

function isEffectiveRangeEmpty_(range) {
  return !range || !range.from || !range.to || range.out_of_semester === true;
}

function filterRecordsByRange_(records, range) {
  if (isEffectiveRangeEmpty_(range)) return [];
  return (records || []).filter(function(record) {
    return record.date >= range.from && record.date <= range.to;
  });
}

function getEffectiveRangeMonth_(range, fallbackMonth) {
  if (range && range.from) return String(range.from).substring(0, 7);
  return normalizeMonth_((range && range.requested_month) || fallbackMonth || null);
}

function getRangeDisplayFrom_(range) {
  return String((range && (range.from || range.requested_from)) || '');
}

function getRangeDisplayTo_(range) {
  return String((range && (range.to || range.requested_to)) || '');
}

function buildEmptyDailyTrend_() {
  return {
    labels: [],
    datasets: [
      { label: 'มาเรียน', data: [], color: '#22c55e' },
      { label: 'สาย', data: [], color: '#f59e0b' },
      { label: 'ขาด', data: [], color: '#ef4444' },
      { label: 'ลา', data: [], color: '#3b82f6' }
    ]
  };
}

function buildEmptyWeekdayAnalysis_() {
  var shortNames = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
  return {
    rows: [1, 2, 3, 4, 5].map(function(day) {
      return {
        day: shortNames[day],
        day_short: shortNames[day],
        total: 0,
        absent: 0,
        late: 0,
        present: 0,
        absent_pct: 0,
        late_pct: 0
      };
    }),
    insight: {
      worst_absent_day: '-',
      worst_absent_pct: 0,
      worst_late_day: '-',
      worst_late_pct: 0
    }
  };
}

function buildEmptyDashboardData_(effectiveMonth, range, today, settings, activeStudentCount, todaySummary, readinessSummary) {
  var zeroCounts = buildStatusCounts_([], 0);
  var prevMonth = shiftMonth_(effectiveMonth, -1);
  todaySummary = todaySummary || buildStatusCounts_([], activeStudentCount || 0);
  todaySummary.date_th = todaySummary.date_th || thaiDate(today, 'short', true);
  activeStudentCount = parseInt(activeStudentCount, 10) || 0;

  return {
    month: effectiveMonth,
    month_th: thaiMonthLabel(effectiveMonth),
    today_summary: todaySummary,
    summary_cards: buildSummaryCards_(zeroCounts, zeroCounts),
    coverage: {
      active_students: activeStudentCount,
      today: {
        checked: todaySummary.checked || 0,
        unchecked: todaySummary.unchecked || 0,
        percent: activeStudentCount > 0 ? Math.round(((todaySummary.checked || 0) / activeStudentCount) * 100) : 0,
        date_th: thaiDate(today, 'short', true)
      },
      month: {
        avg_coverage_percent: 0,
        avg_checked_per_day: 0,
        recorded_days: 0,
        confirmed_days: 0,
        from_th: thaiDate(getRangeDisplayFrom_(range), 'short', false),
        to_th: thaiDate(getRangeDisplayTo_(range), 'short', false)
      }
    },
    attention_list: [],
    daily_trend: buildEmptyDailyTrend_(),
    doughnut_chart: buildDoughnutData_(zeroCounts),
    weekday_analysis: buildEmptyWeekdayAnalysis_(),
    hall_of_fame: { level: 'empty', items: [], recorded_days: 0 },
    watchlist: { low_attendance: [], most_late: [], most_absent: [] },
    mom_delta: buildMomDelta_(zeroCounts, zeroCounts, effectiveMonth, prevMonth),
    teacher_name: settings.teacher_name || '',
    school_name: settings.school_name || '',
    class_name: settings.class_name || '',
    active_semester: range.active_semester || getActiveSemesterRangeSafe_(),
    readiness_summary: readinessSummary || getReadinessSummary_(),
    out_of_semester: true
  };
}

function buildEmptySummaryTable_(range) {
  return {
    start_date: getRangeDisplayFrom_(range),
    end_date: getRangeDisplayTo_(range),
    start_date_th: thaiDate(getRangeDisplayFrom_(range), 'short', false),
    end_date_th: thaiDate(getRangeDisplayTo_(range), 'short', false),
    attendance_alert_percent: SUMMARY_ATTENDANCE_ALERT_PCT,
    confirmed_days_count: 0,
    school_days: 0,
    calendar_holidays: 0,
    uses_calendar: false,
    calendar_warning: {
      has_mismatch: false,
      missing_confirmed_count: 0,
      extra_confirmed_count: 0,
      message: ''
    },
    holiday_conflicts: [],
    rows: [],
    totals: {
      present: 0,
      late: 0,
      absent: 0,
      sick_leave: 0,
      personal_leave: 0,
      total_days: 0,
      student_count: 0,
      attendance_percent: null
    },
    top_absent: [],
    top_late: [],
    leave_reasons: [],
    comparison: null,
    out_of_semester: true
  };
}

function buildSummaryComparison_(range, currentTotals) {
  var previousRange = getPreviousSummaryComparisonRange_(range);
  if (isEffectiveRangeEmpty_(previousRange)) {
    return {
      available: false,
      is_partial: false,
      previous_summary: null,
      delta: {
        attendance_percent: null,
        absent: null,
        late: null
      }
    };
  }

  var previousSummary = getCachedSummaryTableDataForRange_(previousRange, false);
  var previousTotals = previousSummary && previousSummary.totals ? previousSummary.totals : {};
  var hasComparisonData = !!(previousSummary
    && previousSummary.out_of_semester !== true
    && ((parseInt(previousSummary.confirmed_days_count, 10) || 0) > 0
      || (parseInt(previousSummary.school_days, 10) || 0) > 0
      || (parseInt(previousTotals.total_days, 10) || 0) > 0));

  return {
    available: hasComparisonData,
    is_partial: !!previousRange.is_partial,
    previous_summary: previousSummary,
    delta: {
      attendance_percent: buildSummaryComparisonDeltaValue_(currentTotals && currentTotals.attendance_percent, previousTotals.attendance_percent, 1),
      absent: buildSummaryComparisonDeltaValue_(currentTotals && currentTotals.absent, previousTotals.absent, 0),
      late: buildSummaryComparisonDeltaValue_(currentTotals && currentTotals.late, previousTotals.late, 0)
    }
  };
}

function getPreviousSummaryComparisonRange_(range) {
  range = range || {};
  if (isEffectiveRangeEmpty_(range)) {
    return {
      from: '',
      to: '',
      active_semester: range.active_semester || null,
      semester_clamped: false,
      out_of_semester: true,
      is_partial: false
    };
  }

  var semester = range.active_semester || getActiveSemesterRangeSafe_();
  if (!semester || !semester.from || !semester.to) {
    return {
      from: '',
      to: '',
      active_semester: semester || null,
      semester_clamped: false,
      out_of_semester: true,
      is_partial: false
    };
  }

  var currentDates = generateDateList_(range.from, range.to);
  var length = currentDates.length;
  if (!(length > 0)) {
    return {
      from: '',
      to: '',
      active_semester: semester,
      semester_clamped: false,
      out_of_semester: true,
      is_partial: false
    };
  }

  var previousTo = shiftDate_(range.from, -1);
  if (previousTo < semester.from) {
    return {
      from: '',
      to: '',
      active_semester: semester,
      semester_clamped: true,
      out_of_semester: true,
      is_partial: false
    };
  }

  var desiredFrom = shiftDate_(previousTo, -(length - 1));
  var previousFrom = desiredFrom < semester.from ? semester.from : desiredFrom;
  return {
    from: previousFrom,
    to: previousTo,
    requested_from: desiredFrom,
    requested_to: previousTo,
    active_semester: semester,
    semester_clamped: previousFrom !== desiredFrom,
    out_of_semester: false,
    is_partial: previousFrom !== desiredFrom
  };
}

function buildSummaryComparisonDeltaValue_(currentValue, previousValue, precision) {
  if (currentValue === null || currentValue === undefined || currentValue === '') return null;
  if (previousValue === null || previousValue === undefined || previousValue === '') return null;
  var currentNum = Number(currentValue);
  var previousNum = Number(previousValue);
  if (!isFinite(currentNum) || !isFinite(previousNum)) return null;
  var factor = Math.pow(10, parseInt(precision, 10) || 0);
  if (factor <= 1) return currentNum - previousNum;
  return Math.round((currentNum - previousNum) * factor) / factor;
}

function buildEmptyDailyGrid_(range) {
  return {
    from: getRangeDisplayFrom_(range),
    to: getRangeDisplayTo_(range),
    from_th: thaiDate(getRangeDisplayFrom_(range), 'short', false),
    to_th: thaiDate(getRangeDisplayTo_(range), 'short', false),
    school_days: 0,
    confirmed_days_count: 0,
    calendar_warning: {
      has_mismatch: false,
      missing_confirmed_count: 0,
      extra_confirmed_count: 0,
      message: ''
    },
    holiday_conflicts: [],
    dates: [],
    students: [],
    out_of_semester: true
  };
}

function generateDateList_(from, to) {
  var dates = [];
  var current = normalizeDateStringStrict_(from, 'วันที่เริ่มต้น');
  var endDate = normalizeDateStringStrict_(to, 'วันที่สิ้นสุด');

  while (current <= endDate) {
    dates.push(current);
    current = shiftDate_(current, 1);
  }

  return dates;
}

function countDistinctDates_(records) {
  var dates = {};
  records.forEach(function(record) {
    dates[record.date] = true;
  });
  return Object.keys(dates).length;
}

function buildCSVString_(rows) {
  var BOM = '\uFEFF';
  return BOM + rows.map(function(row) {
    return row.map(function(cell) {
      var text = sanitizeCsvCell_(cell == null ? '' : cell);
      if (text.indexOf(',') >= 0 || text.indexOf('"') >= 0 || text.indexOf('\n') >= 0) {
        return '"' + text.replace(/"/g, '""') + '"';
      }
      return text;
    }).join(',');
  }).join('\r\n');
}
