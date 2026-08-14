/**
 * Teacher-only student profile detail view.
 */

function getStudentProfile(studentNumber, month, auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_student_profile',
    rate_limit_limit: 120,
    rate_limit_window_sec: 60
  }, function() {
    try {
      studentNumber = parseInt(studentNumber, 10);
      if (!studentNumber) return { success: false, message: 'ไม่พบเลขที่นักเรียน' };
      month = normalizeMonth_(month);
      return getOrBuildCachedJson_('student_profile', [studentNumber, month], 180, function() {
        var range = getEffectiveMonthRange_(month);
        var effectiveMonth = getEffectiveRangeMonth_(range, month);
        var student = getActiveStudentByNumber_(studentNumber) || getStudentByNumberAny_(studentNumber);
        if (!student) return { success: false, code: 'not_found', message: 'ไม่พบนักเรียน' };

        var scopedRange = range.active_semester || range;
        var scopedAllRecords = range.active_semester
          ? getCachedConfirmedAttendanceRange_(range.active_semester.from, range.active_semester.to)
          : getCachedConfirmedAttendanceRecords_();
        var monthAllRecords = isEffectiveRangeEmpty_(range) ? [] : getCachedConfirmedAttendanceRange_(range.from, range.to);
        var scopedContext = buildAttendanceComputationContext_(scopedRange, scopedAllRecords);
        var monthContext = buildAttendanceComputationContext_(range, monthAllRecords);
        var scopedStudentRecords = getRecordsForStudent_(buildStudentRecordBuckets_(scopedContext.filtered_records), student);
        var monthStudentRecords = getRecordsForStudent_(buildStudentRecordBuckets_(monthContext.filtered_records), student);
        var monthStats = buildStudentAttendanceStatsForContext_(student, buildStudentRecordBuckets_(monthContext.filtered_records), monthContext);
        var stats = {
          present: monthStats.counts.present,
          late: monthStats.counts.late,
          absent: monthStats.counts.absent,
          sick_leave: monthStats.counts.sick_leave,
          personal_leave: monthStats.counts.personal_leave,
          total: monthStats.school_days,
          confirmed_record_days: monthStats.recorded_days,
          attendance_percent: monthStats.attendance_percent
        };

        var calendarInfo = getMonthCalendarInfo_(effectiveMonth);
        var calendarMap = {};
        monthStudentRecords.forEach(function(record) {
          var info = STATUS_MAP[record.status_code];
          calendarMap[record.date] = {
            status_code: record.status_code,
            icon: info ? info.icon : '?',
            color: info ? info.color : 'stone',
            label: info ? info.label : record.status_code,
            note: record.note || ''
          };
        });

        scopedStudentRecords.sort(function(a, b) { return b.date.localeCompare(a.date); });
        var history = scopedStudentRecords.slice(0, 20).map(function(record) {
          var info = STATUS_MAP[record.status_code];
          return {
            date: record.date,
            date_th: thaiDate(record.date, 'short', true),
            status_code: record.status_code,
            icon: info ? info.icon : '?',
            color: info ? info.color : 'stone',
            label: info ? info.label : record.status_code,
            note: record.note || ''
          };
        });

        var scopedStats = buildStudentAttendanceStatsForContext_(student, buildStudentRecordBuckets_(scopedContext.filtered_records), scopedContext);
        var allStats = {
          present: scopedStats.counts.present,
          late: scopedStats.counts.late,
          absent: scopedStats.counts.absent,
          sick_leave: scopedStats.counts.sick_leave,
          personal_leave: scopedStats.counts.personal_leave,
          total: scopedStats.school_days,
          confirmed_record_days: scopedStats.recorded_days,
          attendance_percent: scopedStats.attendance_percent
        };

        return {
          success: true,
          data: {
            student: {
              student_number: student.student_number,
              full_name: student.full_name,
              nickname: student.nickname,
              gender: student.gender,
              group_name: student.group_name || '',
              is_flagged: student.is_flagged,
              gender_label: student.gender === 'M' ? 'ชาย' : (student.gender === 'F' ? 'หญิง' : 'ไม่ระบุ')
            },
            month: effectiveMonth,
            month_th: thaiMonthLabel(effectiveMonth),
            summary_scope_label: range.active_semester ? ('ภาคเรียน ' + range.active_semester.name) : 'ทั้งหมด',
            stats: stats,
            all_stats: allStats,
            calendar: {
              month: effectiveMonth,
              days_in_month: calendarInfo.days_in_month,
              first_weekday: calendarInfo.first_weekday,
              records: calendarMap
            },
            history: history
          }
        };
      });
    } catch (e) {
      Logger.log('getStudentProfile error: ' + e.message);
      return { success: false, message: 'โหลดประวัตินักเรียนไม่ได้: ' + e.message };
    }
  });
}
