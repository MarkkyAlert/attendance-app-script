/**
 * Teacher-only printable report payloads.
 */

function runAsPrintViewer_(auth, options, fn) {
  if (auth && auth.print_session_token) {
    return runAsPrintSession_(auth, options, fn);
  }
  return runAsTeacher_(auth, options, fn);
}

function enforcePrintRequestScope_(session, reportType, fromOrDate, toDate) {
  if (!session || !session.print_session_token) return;

  if (String(session.report_type || '') !== String(reportType || '')) {
    throw new Error('ลิงก์พิมพ์นี้ใช้ได้เฉพาะรายงานที่ครูเลือกไว้เท่านั้น');
  }

  if (reportType === 'daily') {
    var requestedDate = normalizeAttendanceDate_(fromOrDate, false);
    if (!requestedDate || requestedDate !== String(session.date || '')) {
      throw new Error('ลิงก์พิมพ์นี้ใช้ได้เฉพาะวันที่ครูเลือกไว้เท่านั้น');
    }
    return;
  }

  var range = normalizeDateRange_(fromOrDate, toDate);
  if (range.from !== String(session.start_date || '') || range.to !== String(session.end_date || '')) {
    throw new Error('ลิงก์พิมพ์นี้ใช้ได้เฉพาะช่วงวันที่ครูเลือกไว้เท่านั้น');
  }
}

function getPrintIdentityMeta_(settings) {
  settings = settings || {};

  var schoolName = String(settings.school_name || '').trim();
  var className = String(settings.class_name || '').trim();
  var teacherName = String(settings.teacher_name || '').trim();
  var invalidFields = [];

  if (!schoolName || schoolName === 'โรงเรียนตัวอย่าง') invalidFields.push('ชื่อโรงเรียน');
  if (!className) invalidFields.push('ชั้นเรียน');
  if (!teacherName || teacherName === 'ครูประจำชั้น') invalidFields.push('ชื่อครูประจำชั้น');

  return {
    school_name: schoolName,
    class_name: className,
    teacher_name: teacherName,
    printed_by_name: teacherName,
    invalid_fields: invalidFields
  };
}

function ensureFormalPrintIdentity_(identity, reportLabel) {
  identity = identity || {};
  if (!identity.invalid_fields || !identity.invalid_fields.length) return;
  throw new Error(
    (reportLabel || 'รายงานนี้') +
    ' ยังพิมพ์แบบทางการไม่ได้ กรุณาตั้งค่า ' +
    identity.invalid_fields.join(', ') +
    ' ในหน้า ตั้งค่า'
  );
}

function buildPrintedAtText_() {
  var now = String(nowString_() || '').trim();
  var parts = now.split(' ');
  var datePart = parts[0] || todayString_();
  var timePart = String(parts[1] || '').slice(0, 5);
  var text = thaiDate(datePart, 'long', false);
  if (timePart) text += ' เวลา ' + timePart + ' น.';
  return text;
}

function getPP6Report(startDate, endDate, auth) {
  return runAsPrintViewer_(auth, {
    rate_limit_key: 'get_pp6_report',
    rate_limit_limit: 40,
    rate_limit_window_sec: 60
  }, function(session) {
    try {
      var pp6Semester = null;
      try { pp6Semester = getActiveSemesterRow_(); } catch (eSemester) {}
      return measureTiming_('print_build_ms', {
        page: 'print',
        fn_name: 'getPP6Report',
        range_from: String(startDate || ''),
        range_to: String(endDate || ''),
        semester_id: pp6Semester ? String(pp6Semester.id || '') : '',
        semester_name: pp6Semester ? String(pp6Semester.name || '') : ''
      }, function() {
        enforcePrintRequestScope_(session, 'pp6', startDate, endDate);
        var settings = getSettings_();
        var identity = getPrintIdentityMeta_(settings);
        ensureFormalPrintIdentity_(identity, 'รายงาน ปพ.6');
        var range = clampRangeToActiveSemester_(normalizeDateRange_(startDate, endDate));
        var printedAtText = buildPrintedAtText_();
        if (isEffectiveRangeEmpty_(range)) {
          return {
            school_name: identity.school_name,
            class_name: identity.class_name,
            teacher_name: identity.teacher_name,
            printed_by_name: identity.printed_by_name,
            start_date: getRangeDisplayFrom_(range),
            end_date: getRangeDisplayTo_(range),
            start_date_th: thaiDate(getRangeDisplayFrom_(range), 'long', false),
            end_date_th: thaiDate(getRangeDisplayTo_(range), 'long', false),
            printed_at: nowString_(),
            printed_at_th: thaiDate(todayString_(), 'long', false),
            printed_at_text: printedAtText,
            semester_name: range.active_semester ? range.active_semester.name : '',
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
            total_students: 0,
            male_count: 0,
            female_count: 0,
            count_above_80: 0,
            count_below_80: 0,
            totals: { present: 0, late: 0, absent: 0, sick_leave: 0, personal_leave: 0 },
            rows: [],
            has_measurement_data: false,
            out_of_semester: true
          };
        }
        var context = buildAttendanceComputationContext_(range, getCachedConfirmedAttendanceRange_(range.from, range.to));
        var records = context.filtered_records;
        var students = getOfficialStudentsForRange_(range, records);
        var recordBuckets = buildStudentRecordBuckets_(records);
        var rows = [];
        var totals = { present: 0, late: 0, absent: 0, sick_leave: 0, personal_leave: 0 };
        var countAbove80 = 0;
        var countBelow80 = 0;

        students.forEach(function(student) {
          var stats = buildStudentAttendanceStatsForContext_(student, recordBuckets, context);
          var counts = stats.counts;
          var totalDays = stats.school_days;
          var attendDays = stats.attend_days;
          var basisDays = stats.basis_days;
          var percent = stats.attendance_percent;
          var below80 = basisDays > 0 && percent < 80;
          var remark = '';

          if (below80) {
            countBelow80++;
            remark = 'ต่ำกว่า 80%';
          } else if (basisDays > 0) {
            countAbove80++;
          }
          if (student.is_flagged) remark = (remark ? remark + ', ' : '') + 'จับตา';

          rows.push({
            student_number: student.student_number,
            full_name: student.full_name,
            nickname: student.nickname || '',
            gender: student.gender,
            present: counts.present,
            late: counts.late,
            absent: counts.absent,
            sick_leave: counts.sick_leave,
            personal_leave: counts.personal_leave,
            attend_days: attendDays,
            confirmed_record_days: stats.recorded_days,
            total_days: totalDays,
            percent: percent,
            below_80: below80,
            remark: remark
          });

          totals.present += counts.present;
          totals.late += counts.late;
          totals.absent += counts.absent;
          totals.sick_leave += counts.sick_leave;
          totals.personal_leave += counts.personal_leave;
        });

        return {
          school_name: identity.school_name,
          class_name: identity.class_name,
          teacher_name: identity.teacher_name,
          printed_by_name: identity.printed_by_name,
          start_date: range.from,
          end_date: range.to,
          start_date_th: thaiDate(range.from, 'long', false),
          end_date_th: thaiDate(range.to, 'long', false),
          printed_at: nowString_(),
          printed_at_th: thaiDate(todayString_(), 'long', false),
          printed_at_text: printedAtText,
          semester_name: range.active_semester ? range.active_semester.name : '',
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
          total_students: students.length,
          male_count: students.filter(function(student) { return student.gender === 'M'; }).length,
          female_count: students.filter(function(student) { return student.gender === 'F'; }).length,
          count_above_80: countAbove80,
          count_below_80: countBelow80,
          totals: totals,
          rows: rows,
          has_measurement_data: context.confirmed_dates_count > 0 && context.school_day_dates_count > 0
        };
      });
    } catch (e) {
      Logger.log('getPP6Report error: ' + e.message);
      throw new Error('สร้างรายงาน ปพ.6 ไม่สำเร็จ: ' + e.message);
    }
  });
}

function getDailyReport(date, auth) {
  return runAsPrintViewer_(auth, {
    rate_limit_key: 'get_daily_report',
    rate_limit_limit: 60,
    rate_limit_window_sec: 60
  }, function(session) {
    try {
      var dailySemester = null;
      try { dailySemester = getActiveSemesterRow_(); } catch (eSemester) {}
      return measureTiming_('print_build_ms', {
        page: 'print',
        fn_name: 'getDailyReport',
        date: String(date || ''),
        semester_id: dailySemester ? String(dailySemester.id || '') : '',
        semester_name: dailySemester ? String(dailySemester.name || '') : ''
      }, function() {
        enforcePrintRequestScope_(session, 'daily', date);
        date = normalizeAttendanceDate_(date, false);
        if (!date) {
          throw new Error('วันที่ไม่ถูกต้อง');
        }

        var settings = getSettings_();
        var dayStatus = getDayStatus_(date);
        var isOfficial = dayStatus.status === 'confirmed';
        var identity = getPrintIdentityMeta_(settings);
        if (isOfficial) {
          ensureFormalPrintIdentity_(identity, 'รายงานเช็คชื่อประจำวัน');
        }
        var semester = getActiveSemesterRow_();
        var printedAtText = buildPrintedAtText_();
        var records = isOfficial
          ? getCachedConfirmedAttendanceRange_(date, date)
          : getRecordsByDate_(date);
        var students = isOfficial
          ? getOfficialStudentsForRange_({ from: date, to: date }, records)
          : getStudentsForAttendanceDate_(date);
        var studentIndex = buildStudentIdentityIndex_(students);
        var recordMap = buildRecordMapForStudents_(records, studentIndex, { records_are_unique: !!isOfficial });
        var summary = { present: 0, late: 0, absent: 0, sick_leave: 0, personal_leave: 0, unchecked: 0 };

        var rows = students.map(function(student) {
          var record = recordMap[getStudentKey_(student)];
          var statusCode = record ? record.status_code : 'unchecked';
          var info = STATUS_MAP[statusCode];

          if (summary.hasOwnProperty(statusCode)) summary[statusCode]++;
          else summary.unchecked++;

          return {
            student_number: student.student_number,
            full_name: student.full_name,
            nickname: student.nickname || '',
            gender: student.gender,
            status_code: statusCode,
            status_label: info ? info.label : (statusCode === 'unchecked' ? 'ยังไม่เช็ค' : statusCode),
            status_icon: info ? info.icon : '-',
            note: isOfficial && session && session.print_session_token ? '' : (record ? (record.note || '') : '')
          };
        });

        return {
          school_name: identity.school_name || String(settings.school_name || ''),
          class_name: identity.class_name || String(settings.class_name || ''),
          teacher_name: identity.teacher_name || String(settings.teacher_name || ''),
          printed_by_name: identity.printed_by_name || String(settings.teacher_name || ''),
          date: date,
          date_th: thaiDate(date, 'long', true),
          printed_at_th: thaiDate(todayString_(), 'long', false),
          printed_at_text: printedAtText,
          semester_name: semester ? String(semester.name || '') : '',
          is_official: isOfficial,
          is_draft: !isOfficial,
          status_label: isOfficial ? 'ยืนยันแล้ว' : 'ฉบับร่าง',
          total_students: students.length,
          summary: summary,
          rows: rows
        };
      });
    } catch (e) {
      Logger.log('getDailyReport error: ' + e.message);
      throw new Error('สร้างรายงานประจำวันไม่สำเร็จ: ' + e.message);
    }
  });
}

function getAbsentReport(startDate, endDate, threshold, auth) {
  return runAsPrintViewer_(auth, {
    rate_limit_key: 'get_absent_report',
    rate_limit_limit: 40,
    rate_limit_window_sec: 60
  }, function(session) {
    try {
      var absentSemester = null;
      try { absentSemester = getActiveSemesterRow_(); } catch (eSemester) {}
      return measureTiming_('print_build_ms', {
        page: 'print',
        fn_name: 'getAbsentReport',
        range_from: String(startDate || ''),
        range_to: String(endDate || ''),
        semester_id: absentSemester ? String(absentSemester.id || '') : '',
        semester_name: absentSemester ? String(absentSemester.name || '') : ''
      }, function() {
        enforcePrintRequestScope_(session, 'absent', startDate, endDate);
        threshold = parseInt(threshold, 10);
        var settings = getSettings_();
        var identity = getPrintIdentityMeta_(settings);
        ensureFormalPrintIdentity_(identity, 'รายงานนักเรียนที่ต้องติดตาม');
        if (!(threshold > 0)) {
          threshold = (session && session.print_session_token)
            ? (parseInt(session.absent_threshold, 10) || 0)
            : 0;
        }
        if (!(threshold > 0)) threshold = normalizeAttentionThresholdDays_(settings.attention_threshold_days);
        var requestedRange = normalizeDateRange_(startDate, endDate);
        var range = clampRangeToActiveSemester_(requestedRange);
        var data = isEffectiveRangeEmpty_(range) ? buildEmptySummaryTable_(range) : buildSummaryTableData_(range);
        var printedAtText = buildPrintedAtText_();
        var flagged = data.rows.filter(function(row) {
          return row.absent_count >= threshold || row.is_below_threshold;
        }).sort(function(a, b) {
          return b.absent_count - a.absent_count;
        });

        return {
          school_name: identity.school_name,
          class_name: identity.class_name,
          teacher_name: identity.teacher_name,
          printed_by_name: identity.printed_by_name,
          start_date_th: thaiDate(data.start_date, 'long', false),
          end_date_th: thaiDate(data.end_date, 'long', false),
          printed_at_th: thaiDate(todayString_(), 'long', false),
          printed_at_text: printedAtText,
          semester_name: range.active_semester ? range.active_semester.name : '',
          school_days: data.school_days || 0,
          confirmed_days_count: data.confirmed_days_count || 0,
          out_of_semester: !!data.out_of_semester,
          calendar_warning: data.calendar_warning || {
            has_mismatch: false,
            missing_confirmed_count: 0,
            extra_confirmed_count: 0,
            message: ''
          },
          threshold: threshold,
          total_flagged: flagged.length,
          rows: flagged
        };
      });
    } catch (e) {
      Logger.log('getAbsentReport error: ' + e.message);
      throw new Error('สร้างรายงานนักเรียนขาดบ่อยไม่สำเร็จ: ' + e.message);
    }
  });
}

function getPrintActiveSemesterRange(auth) {
  return runAsPrintViewer_(auth, {
    rate_limit_key: 'get_print_active_semester_range',
    rate_limit_limit: 60,
    rate_limit_window_sec: 60
  }, function() {
    var semester = getActiveSemesterRow_();
    if (!semester) return null;
    return { from: semester.start_date, to: semester.end_date, name: semester.name, id: semester.id };
  });
}
