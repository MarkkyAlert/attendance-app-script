/**
 * Main web app routing and bootstrap data.
 */

function doGet(e) {
  ensureSecurityMigration_();

  var page = (e && e.parameter && e.parameter.page) ? String(e.parameter.page) : 'dashboard';
  if (page === 'parent') {
    return HtmlService.createHtmlOutputFromFile('ParentView')
      .setTitle('ข้อมูลการเข้าเรียน')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }

  if (page === 'print') {
    return HtmlService.createHtmlOutputFromFile('PrintReport')
      .setTitle('พิมพ์รายงาน')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }

  var template = HtmlService.createTemplateFromFile('Index');
  template.currentPage = page;
  template.params = (e && e.parameter) ? e.parameter : {};

  return template.evaluate()
    .setTitle('ระบบเช็คชื่อนักเรียน')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function getTeacherUrl(auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_teacher_url',
    rate_limit_limit: 30,
    rate_limit_window_sec: 60
  }, function() {
    var url = ScriptApp.getService().getUrl();
    return { url: url };
  });
}

function include_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function extractClientModuleScript_(filename) {
  var content = include_(filename);
  var match = String(content || '').match(/<script[^>]*>([\s\S]*?)<\/script>/i);
  return match ? String(match[1] || '').trim() : String(content || '').trim();
}

function extractClientStyleContent_(filename) {
  var content = include_(filename);
  var match = String(content || '').match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  return match ? String(match[1] || '').trim() : String(content || '').trim();
}

function getCachedClientAssetContent_(cacheKey, builder) {
  cacheKey = String(cacheKey || '').trim();
  if (!cacheKey) return String(builder() || '');

  var cached = getCachedJsonByKey_(cacheKey);
  if (cached !== null) return String(cached || '');

  var value = String(builder() || '');
  putCachedJsonByKey_(cacheKey, value, 900);
  return value;
}

function getClientModuleContent(name, auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_client_module_content',
    rate_limit_limit: 120,
    rate_limit_window_sec: 60
  }, function() {
    var moduleMap = {
      dashboard: 'JsDashboard',
      reports: 'JsReports',
      analytics: 'JsAnalytics',
      import: 'JsImport',
      profile: 'JsProfile',
      photoGrid: 'JsPhotoGrid'
    };
    name = String(name || '').trim();
    if (!moduleMap[name]) {
      throw new Error('ไม่พบโมดูลหน้าที่ร้องขอ');
    }
    return getCachedClientAssetContent_('client_module_asset|' + moduleMap[name], function() {
      return extractClientModuleScript_(moduleMap[name]);
    });
  });
}

function getClientStyleContent(name, auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_client_style_content',
    rate_limit_limit: 120,
    rate_limit_window_sec: 60
  }, function() {
    var styleMap = {
      report: 'StyleReport',
      phase3: 'StylePhase3',
      phase4: 'StylePhase4',
      pin: 'StylePin'
    };
    name = String(name || '').trim();
    if (!styleMap[name]) {
      throw new Error('ไม่พบชุดสไตล์ที่ร้องขอ');
    }
    return getCachedClientAssetContent_('client_style_asset|' + styleMap[name], function() {
      return extractClientStyleContent_(styleMap[name]);
    });
  });
}

function getScriptUrl_() {
  return ScriptApp.getService().getUrl();
}

function getCurrentUser(auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_current_user',
    rate_limit_limit: 120,
    rate_limit_window_sec: 60
  }, function(session) {
    var user = getTeacherSessionUser_(session);
    user.pinState = getPinState();
    return user;
  });
}

function getInitialData(page, params, auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_initial_data',
    rate_limit_limit: 120,
    rate_limit_window_sec: 60
  }, function(session) {
    var data = {
      user: null,
      page: page,
      auth: buildTeacherAuthPayload_(session)
    };

    try {
      data.user = getTeacherSessionUser_(session);
      data.user.pinState = getPinState();
    } catch (e) {
      data.error = 'โหลดข้อมูลผู้ใช้ไม่สำเร็จ: ' + e.message;
      return data;
    }

    try {
      switch (page) {
        case 'dashboard':
          data.dashboard = getDashboardBootstrapData_((params && params.month) ? params.month : null);
          break;
        case 'attendance':
          var requestedAttendanceDate = (params && params.date) ? params.date : todayString_();
          try {
            requestedAttendanceDate = normalizeDateStringStrict_(requestedAttendanceDate, 'วันที่เช็คชื่อ');
          } catch (eDate) {
            requestedAttendanceDate = todayString_();
          }
          if (requestedAttendanceDate > todayString_()) requestedAttendanceDate = todayString_();
          data.attendance = getAttendanceBootstrapPayload_(requestedAttendanceDate);
          break;
        case 'students':
          data.students = getStudentList();
          break;
        case 'reports':
          data.reportsBootstrap = getReportsBootstrapData_(params);
          break;
        case 'analytics':
          data.month = normalizeMonth_((params && params.month) ? params.month : null);
          break;
        case 'import':
          data.importBootstrap = getImportBootstrapData_();
          break;
        case 'settings':
          data.settingsBootstrap = getSettingsBootstrapData_();
          break;
      }
    } catch (e) {
      Logger.log('getInitialData error [' + page + ']: ' + e.message);
      data.error = 'โหลดข้อมูลไม่สำเร็จ: ' + e.message;
    }

    return data;
  });
}

function getAttendanceBootstrapPayload_(date) {
  var options = {
    capture_timing_detail: true,
    timing_context: 'bootstrap'
  };
  try {
    return getAttendanceDaily(date, null, options);
  } catch (e) {
    if (!isRequestedDocumentPermissionError_(e)) throw e;
    resetAttendanceBootstrapExecutionMemos_();
    return getAttendanceDaily(date, null, options);
  }
}

function isRequestedDocumentPermissionError_(error) {
  var message = String(error && error.message ? error.message : error || '');
  return /permission to access the requested document/i.test(message);
}

function resetAttendanceBootstrapExecutionMemos_() {
  try { CACHED_STUDENT_LIST_MEMO_ = null; } catch (e) {}
  try {
    if (typeof STUDENTS_FOR_ATTENDANCE_DATE_MEMO_ !== 'undefined') {
      STUDENTS_FOR_ATTENDANCE_DATE_MEMO_ = {};
    }
  } catch (e2) {}
  try { clearAttendanceDayStatusExecutionCache_(); } catch (e3) {}
}

function getDashboardBootstrapData_(month) {
  month = normalizeMonth_(month);

  var range = getEffectiveMonthRange_(month);
  var effectiveMonth = getEffectiveRangeMonth_(range, month);
  var today = todayString_();
  var settings = getCachedSettings_();
  var readinessSettings = buildReadinessSettingsFromCachedSettings_(settings);
  var studentData = getCachedStudentList_();
  var students = studentData.students || [];
  var studentIndex = buildStudentIdentityIndex_(studentData.all_students || []);
  var studentSummary = getStudentSetupSummary_(studentData);
  var activeSemester = getActiveSemesterRangeSafe_();
  var schoolCalendarSummary = activeSemester
    ? getSchoolCalendarSummaryForRange_({ from: activeSemester.from, to: activeSemester.to })
    : { total_entries: 0, school_days: 0, holidays: 0 };
  var readinessSummary = getReadinessSummary_({
    settings: readinessSettings,
    activeSemester: activeSemester,
    studentSummary: studentSummary,
    schoolCalendarSummary: schoolCalendarSummary
  });
  var todayRecords = getUniqueLatestRecordsByDate_(today);
  var todaySummary = buildStatusCounts_(todayRecords, students.length, { records_are_unique: true, student_index: studentIndex });
  var confirmedDateMap = getConfirmedAttendanceDateMap_();
  var confirmedDaysCount = 0;
  if (!isEffectiveRangeEmpty_(range) && range.from && range.to) {
    generateDateList_(range.from, range.to).forEach(function(date) {
      if (confirmedDateMap[date]) confirmedDaysCount++;
    });
  }

  todaySummary.date_th = thaiDate(today, 'short', true);

  return {
    bootstrap_only: true,
    month: effectiveMonth,
    month_th: thaiMonthLabel(effectiveMonth),
    today_summary: todaySummary,
    coverage: buildCoverage_(todayRecords, [], students, range, today, confirmedDaysCount, studentIndex),
    teacher_name: settings.teacher_name || '',
    school_name: settings.school_name || '',
    class_name: settings.class_name || '',
    active_semester: range.active_semester || activeSemester,
    school_calendar_summary: schoolCalendarSummary,
    readiness_summary: readinessSummary,
    out_of_semester: !!range.out_of_semester
  };
}

function getReportsBootstrapData_(params) {
  var activeSemester = getActiveSemester();
  var reportMonth = (params && params.month) ? params.month : null;
  var monthRange = monthRange_(normalizeMonth_(reportMonth));
  var summaryRange = activeSemester && activeSemester.start_date && activeSemester.end_date
    ? { from: activeSemester.start_date, to: activeSemester.end_date }
    : { from: monthRange.from, to: monthRange.to };
  var requestedTab = params && params.tab ? String(params.tab) : '';

  return {
    activeSemester: activeSemester || null,
    default_summary_range: summaryRange,
    default_daily_range: summaryRange,
    initial_report_tab: requestedTab === 'daily' ? 'daily' : 'summary'
  };
}

function getImportBootstrapData_() {
  return {
    activeSemester: getActiveSemester() || null
  };
}

function getSettingsBootstrapData_() {
  var settings = getUiSettings_();
  var pinState = getPinState();
  var activeSemester = getActiveSemester();
  var studentSummary = getStudentSetupSummary_();
  var schoolCalendarSummary = activeSemester && activeSemester.start_date && activeSemester.end_date
    ? getSchoolCalendarSummaryForRange_({ from: activeSemester.start_date, to: activeSemester.end_date })
    : { total_entries: 0, school_days: 0, holidays: 0 };

  return {
    settings: settings,
    pinState: pinState,
    activeSemester: activeSemester || null,
    studentSummary: studentSummary,
    schoolCalendarSummary: schoolCalendarSummary,
    readinessSummary: getReadinessSummary_({
      settings: settings,
      activeSemester: activeSemester,
      studentSummary: studentSummary,
      schoolCalendarSummary: schoolCalendarSummary
    })
  };
}

function getSettingsDetails(auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_settings_details',
    rate_limit_limit: 120,
    rate_limit_window_sec: 60
  }, function() {
    return {
      semesters: getSemesterList(),
      activeSemester: getActiveSemester(),
      schoolCalendar: getSchoolCalendar()
    };
  });
}

/**
 * Diagnostic only — รันจาก Apps Script editor เท่านั้น
 * ต้องลงท้ายด้วย _ เพราะ runAsTrustedTeacher_ ข้ามการตรวจสิทธิ์ทั้งหมด
 * ถ้าไม่มี _ จะเรียกได้จากอินเทอร์เน็ตผ่าน google.script.run
 */
function runPreReleaseSmokeChecks_() {
  ensureSecurityMigration_();
  return runAsTrustedTeacher_(function() {
    var startedAt = new Date().getTime();
    var context = buildPreReleaseSmokeContext_();
    var functionMap = getPreReleaseSmokeFunctionMap_();
    var checks = [];

    Object.keys(functionMap).forEach(function(name) {
      checks.push(runPreReleaseSmokeCheck_('function:' + name, function() {
        assertPreReleaseSmoke_(typeof functionMap[name] === 'function', 'Missing function ' + name);
        return { function_name: name };
      }));
    });

    checks.push(runPreReleaseSmokeCheck_('bootstrap:dashboard', function() {
      var result = getInitialData('dashboard', { month: context.month });
      var payload = assertSmokeBootstrapResult_('Dashboard', result, 'dashboard');
      assertPreReleaseSmoke_(String(payload.month || '') === context.month, 'Dashboard bootstrap returned wrong month');
      return {
        month: payload.month,
        user_loaded: !!result.user
      };
    }));

    checks.push(runPreReleaseSmokeCheck_('bootstrap:attendance', function() {
      var result = getInitialData('attendance', { date: context.attendance_date });
      var payload = assertSmokeBootstrapResult_('Attendance', result, 'attendance');
      assertPreReleaseSmoke_(String(payload.date || '') === context.attendance_date, 'Attendance bootstrap returned wrong date');
      assertPreReleaseSmoke_(Array.isArray(payload.students), 'Attendance bootstrap missing students');
      return {
        date: payload.date,
        students: (payload.students || []).length,
        timing_detail: String(payload.__timing_detail || '')
      };
    }));

    checks.push(runPreReleaseSmokeCheck_('attendance:diagnostic_load', function() {
      var startedAtDiagnostic = new Date().getTime();
      var result = getAttendanceDaily(context.attendance_date, null, { capture_timing_detail: true });
      var diagnosticDurationMs = new Date().getTime() - startedAtDiagnostic;
      assertPreReleaseSmoke_(!!result, 'Attendance diagnostic load missing payload');
      assertPreReleaseSmoke_(String(result.date || '') === context.attendance_date, 'Attendance diagnostic load returned wrong date');
      assertPreReleaseSmoke_(Array.isArray(result.students), 'Attendance diagnostic load missing students');
      try {
        appendTimingLog_({
          metric: 'attendance_load_smoke_ms',
          duration_ms: diagnosticDurationMs,
          status: 'ok',
          page: 'attendance',
          fn_name: 'getAttendanceDaily[smoke]',
          date: context.attendance_date || '',
          range_from: context.range_from || '',
          range_to: context.range_to || '',
          month: context.month || '',
          semester_name: String(context.active_semester_name || ''),
          detail: String(result.__timing_detail || '')
        });
      } catch (eDiagnosticLog) {}
      return {
        date: result.date,
        students: (result.students || []).length,
        timing_detail: String(result.__timing_detail || '')
      };
    }));

    checks.push(runPreReleaseSmokeCheck_('bootstrap:reports', function() {
      var result = getInitialData('reports', { month: context.month });
      var payload = assertSmokeBootstrapResult_('Reports', result, 'reportsBootstrap');
      assertPreReleaseSmoke_(!!(payload.default_summary_range && payload.default_daily_range), 'Reports bootstrap missing default ranges');
      return {
        summary_from: payload.default_summary_range.from,
        summary_to: payload.default_summary_range.to,
        user_loaded: !!result.user
      };
    }));

    checks.push(runPreReleaseSmokeCheck_('dashboard:full', function() {
      var result = getDashboardData(context.month);
      assertPreReleaseSmoke_(!!result, 'Dashboard data missing');
      assertPreReleaseSmoke_(!!result.today_summary, 'Dashboard missing today summary');
      assertPreReleaseSmoke_(!!result.coverage, 'Dashboard missing coverage');
      return {
        month: result.month,
        active_students: result.coverage && result.coverage.active_students || 0
      };
    }));

    checks.push(runPreReleaseSmokeCheck_('dashboard:diagnostic_build', function() {
      var startedAtDiagnostic = new Date().getTime();
      var result = buildDashboardData_(context.month, { capture_timing_detail: true });
      var diagnosticDurationMs = new Date().getTime() - startedAtDiagnostic;
      assertPreReleaseSmoke_(!!result, 'Dashboard diagnostic build missing');
      assertPreReleaseSmoke_(!!result.today_summary, 'Dashboard diagnostic build missing today summary');
      assertPreReleaseSmoke_(!!result.coverage, 'Dashboard diagnostic build missing coverage');
      try {
        appendTimingLog_({
          metric: 'dashboard_build_smoke_ms',
          duration_ms: diagnosticDurationMs,
          status: 'ok',
          page: 'dashboard',
          fn_name: 'buildDashboardData_[smoke]',
          date: context.attendance_date || '',
          range_from: context.range_from || '',
          range_to: context.range_to || '',
          month: context.month || '',
          semester_name: String(context.active_semester_name || ''),
          detail: String(result.__timing_detail || '')
        });
      } catch (eDiagnosticLog) {}
      return {
        month: result.month,
        active_students: result.coverage && result.coverage.active_students || 0,
        timing_detail: String(result.__timing_detail || '')
      };
    }));

    checks.push(runPreReleaseSmokeCheck_('reports:summary', function() {
      var result = getSummaryTable(context.range_from, context.range_to);
      assertPreReleaseSmoke_(!!result, 'Summary report missing');
      assertPreReleaseSmoke_(Array.isArray(result.rows), 'Summary report missing rows');
      assertPreReleaseSmoke_(!!result.totals, 'Summary report missing totals');
      return {
        from: result.start_date,
        to: result.end_date,
        rows: (result.rows || []).length
      };
    }));

    checks.push(runPreReleaseSmokeCheck_('reports:daily_grid', function() {
      var result = getDailyGrid(context.range_from, context.range_to);
      assertPreReleaseSmoke_(!!result, 'Daily grid missing');
      assertPreReleaseSmoke_(Array.isArray(result.dates), 'Daily grid missing dates');
      assertPreReleaseSmoke_(Array.isArray(result.students), 'Daily grid missing students');
      return {
        from: result.from,
        to: result.to,
        dates: (result.dates || []).length,
        students: (result.students || []).length
      };
    }));

    var durationMs = new Date().getTime() - startedAt;
    var failures = checks.filter(function(check) { return !check.ok; });
    var summary = {
      success: failures.length === 0,
      ran_at: nowString_(),
      duration_ms: durationMs,
      context: context,
      checks: checks,
      failed_checks: failures.map(function(check) { return check.name; }),
      failure_details: buildSmokeFailureDetails_(failures)
    };

    try {
      appendTimingLog_({
        metric: 'pre_release_smoke_ms',
        duration_ms: durationMs,
        status: summary.success ? 'ok' : 'error',
        page: 'admin',
        fn_name: 'runPreReleaseSmokeChecks_',
        date: context.attendance_date || '',
        range_from: context.range_from || '',
        range_to: context.range_to || '',
        month: context.month || '',
        semester_name: String(context.active_semester_name || ''),
        detail: 'checks=' + checks.length + ';failed=' + failures.length + (failures.length ? ';names=' + failures.map(function(check) { return check.name; }).join(',') + ';first_error=' + String(failures[0] && failures[0].error || '') : '')
      });
    } catch (eLog) {}

    Logger.log(JSON.stringify(summary));
    return summary;
  });
}

function buildPreReleaseSmokeContext_() {
  var activeSemester = getActiveSemester();
  assertPreReleaseSmoke_(!!(activeSemester && activeSemester.start_date && activeSemester.end_date), 'ยังไม่มีภาคเรียนที่กำลังใช้งานสำหรับ smoke check');

  var today = todayString_();
  var attendanceDate = today;
  if (attendanceDate < activeSemester.start_date) attendanceDate = activeSemester.start_date;
  if (attendanceDate > activeSemester.end_date) attendanceDate = activeSemester.end_date;

  var rangeTo = attendanceDate;
  var rangeFrom = shiftDate_(rangeTo, -4);
  if (rangeFrom < activeSemester.start_date) rangeFrom = activeSemester.start_date;

  return {
    active_semester_name: String(activeSemester.name || ''),
    month: String(attendanceDate || '').slice(0, 7),
    attendance_date: attendanceDate,
    range_from: rangeFrom,
    range_to: rangeTo
  };
}

function getPreReleaseSmokeFunctionMap_() {
  return {
    getInitialData: typeof getInitialData === 'function' ? getInitialData : null,
    getAttendanceDaily: typeof getAttendanceDaily === 'function' ? getAttendanceDaily : null,
    getDashboardData: typeof getDashboardData === 'function' ? getDashboardData : null,
    getSummaryTable: typeof getSummaryTable === 'function' ? getSummaryTable : null,
    getDailyGrid: typeof getDailyGrid === 'function' ? getDailyGrid : null
  };
}

function assertSmokeBootstrapResult_(page, result, payloadKey) {
  var pageName = String(page || 'page');
  var key = String(payloadKey || '').trim();
  assertPreReleaseSmoke_(!!result, pageName + ' bootstrap returned empty result');
  assertPreReleaseSmoke_(!result.error, pageName + ' bootstrap error: ' + String(result.error || 'unknown error'));
  assertPreReleaseSmoke_(!!(key && result[key]), pageName + ' bootstrap missing payload');
  return result[key];
}

function buildSmokeCheckErrorMessage_(error) {
  if (!error) return 'Unknown smoke failure';
  var message = String(error && error.message ? error.message : error || 'Unknown smoke failure');
  var stack = String(error && error.stack ? error.stack : '').trim();
  if (!stack) return message;
  var stackLines = stack.split('\n').map(function(line) {
    return String(line || '').trim();
  }).filter(function(line) {
    return !!line && line !== message;
  });
  return stackLines.length ? (message + ' | ' + stackLines.slice(0, 2).join(' | ')) : message;
}

function buildSmokeFailureDetails_(checks) {
  var details = {};
  (checks || []).forEach(function(check) {
    if (!check || check.ok) return;
    details[String(check.name || '')] = {
      duration_ms: parseInt(check.duration_ms, 10) || 0,
      error: String(check.error || '')
    };
  });
  return details;
}

function runPreReleaseSmokeCheck_(name, fn) {
  var startedAt = new Date().getTime();
  try {
    return {
      name: String(name || ''),
      ok: true,
      duration_ms: new Date().getTime() - startedAt,
      detail: fn() || null
    };
  } catch (e) {
    return {
      name: String(name || ''),
      ok: false,
      duration_ms: new Date().getTime() - startedAt,
      error: buildSmokeCheckErrorMessage_(e)
    };
  }
}

function assertPreReleaseSmoke_(condition, message) {
  if (!condition) {
    throw new Error(String(message || 'Pre-release smoke check failed'));
  }
}

function adminBootstrapTeacherAccessOnce() {
  throw new Error('ปิดการใช้งานฟังก์ชันนี้ในระบบจริงแล้ว กรุณาใช้ setupSystem_ จากเมนู Google Sheets เพื่อติดตั้งระบบครั้งแรก');
}
