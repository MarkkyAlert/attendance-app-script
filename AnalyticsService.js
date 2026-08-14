/**
 * Teacher-only advanced analytics.
 */

var RISK_WEIGHTS = { absent: 4, late: 2, leave: 1, recent_absent: 3 };
var THAI_WEEKDAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];

function buildAnalyticsTimingMeta_(fnName, month) {
  var semester = null;
  try { semester = getActiveSemesterRow_(); } catch (e) {}
  return {
    page: 'analytics',
    fn_name: fnName,
    month: String(month || ''),
    semester_id: semester ? String(semester.id || '') : '',
    semester_name: semester ? String(semester.name || '') : ''
  };
}

function getRiskScores(month, auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_risk_scores',
    rate_limit_limit: 60,
    rate_limit_window_sec: 60
  }, function() {
    month = normalizeMonth_(month);
    return getOrBuildCachedJson_('analytics_risk_scores', [month], 180, function() {
      return measureTiming_('analytics_build_ms', buildAnalyticsTimingMeta_('getRiskScores', month), function() {
        var range = getEffectiveMonthRange_(month);
        var effectiveMonth = getEffectiveRangeMonth_(range, month);
        var today = todayString_();
        var recentWindowEnd = range.to && range.to < today ? range.to : today;
        var recentFrom = shiftDate_(recentWindowEnd, -7);
        if (isEffectiveRangeEmpty_(range)) {
          return {
            month: effectiveMonth,
            month_th: thaiMonthLabel(effectiveMonth),
            from_th: thaiDate(getRangeDisplayFrom_(range), 'short', false),
            to_th: thaiDate(getRangeDisplayTo_(range), 'short', false),
            weights: RISK_WEIGHTS,
            items: [],
            active_semester: (function() {
              try {
                var active = getActiveSemesterRow_();
                return active ? active.name : null;
              } catch (e) {
                return null;
              }
            })(),
            out_of_semester: true
          };
        }
        if (recentFrom < range.from) recentFrom = range.from;

        var monthRangeRecords = getCachedConfirmedAttendanceRange_(range.from, range.to);
        var recentRangeRecords = getCachedConfirmedAttendanceRange_(recentFrom, recentWindowEnd);
        var monthContext = buildAttendanceComputationContext_(range, monthRangeRecords);
        var recentContext = buildAttendanceComputationContext_({ from: recentFrom, to: recentWindowEnd }, recentRangeRecords);
        var monthRecords = monthContext.filtered_records;
        var students = getOfficialStudentsForRange_(range, monthRecords);
        var monthBuckets = buildStudentRecordBuckets_(monthRecords);
        var recentBuckets = buildStudentRecordBuckets_(recentContext.filtered_records);

        var items = [];
        var maxRawScore = 0;

        students.forEach(function(student) {
          var stats = buildStudentAttendanceStatsForContext_(student, monthBuckets, monthContext);
          var counts = stats.counts;
          var recentAbsent = 0;
          getRecordsForStudent_(recentBuckets, student).forEach(function(record) {
            if (record.status_code === 'absent') recentAbsent++;
          });

          var leaveCount = counts.sick_leave + counts.personal_leave;
          var nonRecentAbsent = Math.max(0, counts.absent - recentAbsent);
          var weightedRecentAbsent = recentAbsent * (RISK_WEIGHTS.absent + RISK_WEIGHTS.recent_absent);
          var rawScore = (nonRecentAbsent * RISK_WEIGHTS.absent) +
            weightedRecentAbsent +
            (counts.late * RISK_WEIGHTS.late) +
            (leaveCount * RISK_WEIGHTS.leave);

          if (rawScore <= 0) return;
          maxRawScore = Math.max(maxRawScore, rawScore);

          items.push({
            student_number: student.student_number,
            full_name: student.full_name,
            nickname: student.nickname,
            is_flagged: student.is_flagged,
            present_count: counts.present,
            late_count: counts.late,
            absent_count: counts.absent,
            leave_count: leaveCount,
            recent_absent: recentAbsent,
            total_days: stats.school_days,
            attendance_pct: stats.attendance_percent,
            score_raw: rawScore
          });
        });

        items.sort(function(a, b) {
          return b.score_raw - a.score_raw || b.absent_count - a.absent_count || a.student_number - b.student_number;
        });

        return {
          month: effectiveMonth,
          month_th: thaiMonthLabel(effectiveMonth),
          from_th: thaiDate(range.from, 'short', false),
          to_th: thaiDate(range.to, 'short', false),
          weights: RISK_WEIGHTS,
          items: items.slice(0, 15).map(function(item, index) {
            var scorePct = maxRawScore > 0 ? Math.round((item.score_raw / maxRawScore) * 1000) / 10 : 0;
            item.rank = index + 1;
            item.score_percent = scorePct;
            item.risk_level = scorePct >= 70 ? 'สูง' : (scorePct >= 40 ? 'ปานกลาง' : 'ต่ำ');
            item.risk_color = scorePct >= 70 ? 'red' : (scorePct >= 40 ? 'amber' : 'green');
            return item;
          }),
          active_semester: (function() {
            try {
              var active = getActiveSemester();
              return active ? active.name : null;
            } catch (e) {
              return null;
            }
          })()
        };
      });
    });
  });
}

function getTrendComparison(month, auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_trend_comparison',
    rate_limit_limit: 60,
    rate_limit_window_sec: 60
  }, function() {
    month = normalizeMonth_(month);
    return getOrBuildCachedJson_('analytics_trend_comparison', [month], 180, function() {
      return measureTiming_('analytics_build_ms', buildAnalyticsTimingMeta_('getTrendComparison', month), function() {
        var curRange = getEffectiveMonthRange_(month);
        var effectiveMonth = getEffectiveRangeMonth_(curRange, month);
        var prevMonth = shiftMonth_(effectiveMonth, -1);
        var prevRange = clampRangeToActiveSemester_(monthRange_(prevMonth));
        if (isEffectiveRangeEmpty_(curRange)) {
          return {
            month: effectiveMonth,
            month_th: thaiMonthLabel(effectiveMonth),
            prev_month: prevMonth,
            prev_month_th: thaiMonthLabel(prevMonth),
            improved: [],
            declined: [],
            all: [],
            out_of_semester: true
          };
        }

        var curContext = buildAttendanceComputationContext_(curRange, getCachedConfirmedAttendanceRange_(curRange.from, curRange.to));
        var prevContext = buildAttendanceComputationContext_(prevRange, isEffectiveRangeEmpty_(prevRange) ? [] : getCachedConfirmedAttendanceRange_(prevRange.from, prevRange.to));
        var curRecords = curContext.filtered_records;
        var prevRecords = prevContext.filtered_records;
        var comparisonRange = {
          from: isEffectiveRangeEmpty_(prevRange) ? curRange.from : (curRange.from < prevRange.from ? curRange.from : prevRange.from),
          to: isEffectiveRangeEmpty_(prevRange) ? curRange.to : (curRange.to > prevRange.to ? curRange.to : prevRange.to)
        };
        var students = getOfficialStudentsForRange_(comparisonRange, curRecords.concat(prevRecords));
        var curBuckets = buildStudentRecordBuckets_(curRecords);
        var prevBuckets = buildStudentRecordBuckets_(prevRecords);

        var items = students.map(function(student) {
          var curStats = buildStudentAttendanceStatsForContext_(student, curBuckets, curContext);
          var prevStats = buildStudentAttendanceStatsForContext_(student, prevBuckets, prevContext);
          var curPresent = curStats.counts.present, curAbsent = curStats.counts.absent, curTotal = curStats.school_days;
          var prevPresent = prevStats.counts.present, prevAbsent = prevStats.counts.absent, prevTotal = prevStats.school_days;
          var curBasis = curStats.basis_days;
          var prevBasis = prevStats.basis_days;
          var curPct = curStats.attendance_percent;
          var prevPct = prevStats.attendance_percent;
          var isComparable = curBasis > 0 && prevBasis > 0;
          var pctDelta = isComparable ? (curPct - prevPct) : 0;

          return {
            student_number: student.student_number,
            full_name: student.full_name,
            nickname: student.nickname,
            cur_present: curPresent,
            cur_absent: curAbsent,
            cur_total: curTotal,
            cur_pct: curPct,
            prev_present: prevPresent,
            prev_absent: prevAbsent,
            prev_total: prevTotal,
            prev_pct: prevPct,
            pct_delta: pctDelta,
            direction: !isComparable ? 'no_data' : (pctDelta > 0 ? 'improved' : (pctDelta < 0 ? 'declined' : 'stable'))
          };
        });

        return {
          month: effectiveMonth,
          month_th: thaiMonthLabel(effectiveMonth),
          prev_month: prevMonth,
          prev_month_th: thaiMonthLabel(prevMonth),
          improved: items.slice().filter(function(item) { return item.direction === 'improved'; }).sort(function(a, b) { return b.pct_delta - a.pct_delta; }).slice(0, 5),
          declined: items.slice().filter(function(item) { return item.direction === 'declined'; }).sort(function(a, b) { return a.pct_delta - b.pct_delta; }).slice(0, 5),
          all: items
        };
      });
    });
  });
}

function getAbsencePatterns(month, auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_absence_patterns',
    rate_limit_limit: 60,
    rate_limit_window_sec: 60
  }, function() {
    month = normalizeMonth_(month);
    return getOrBuildCachedJson_('analytics_absence_patterns', [month], 180, function() {
      return measureTiming_('analytics_build_ms', buildAnalyticsTimingMeta_('getAbsencePatterns', month), function() {
        var range = getEffectiveMonthRange_(month);
        var effectiveMonth = getEffectiveRangeMonth_(range, month);
        if (isEffectiveRangeEmpty_(range)) {
          return {
            month: effectiveMonth,
            month_th: thaiMonthLabel(effectiveMonth),
            mon_fri_pattern: [],
            consecutive_streaks: [],
            weekday_absence_rates: [1, 2, 3, 4, 5].map(function(day) {
              return { day: THAI_WEEKDAYS[day], absent: 0, total: 0, rate: 0 };
            }),
            out_of_semester: true
          };
        }
        var monthContext = buildAttendanceComputationContext_(range, getCachedConfirmedAttendanceRange_(range.from, range.to));
        var monthRecords = monthContext.filtered_records;
        var students = getOfficialStudentsForRange_(range, monthRecords);
        var monthBuckets = buildStudentRecordBuckets_(monthRecords);

        var dayAbsence = {};
        for (var i = 0; i < 7; i++) {
          dayAbsence[i] = { absent: 0, total: 0 };
        }

        monthRecords.forEach(function(record) {
          var dow = getIsoWeekday_(record.date);
          dayAbsence[dow].total++;
          if (record.status_code === 'absent') dayAbsence[dow].absent++;
        });

        var monFriStudents = [];
        var streaks = [];

        students.forEach(function(student) {
          var studentRecords = getRecordsForStudent_(monthBuckets, student).slice().sort(function(a, b) {
            return a.date.localeCompare(b.date);
          });

          var monAbsent = 0, friAbsent = 0, otherAbsent = 0;
          var maxStreak = 0, currentStreak = 0, currentStart = null, maxStart = null, maxEnd = null;

          studentRecords.forEach(function(record) {
            if (record.status_code === 'absent') {
              var dow = getIsoWeekday_(record.date);
              if (dow === 1) monAbsent++;
              else if (dow === 5) friAbsent++;
              else otherAbsent++;

              if (currentStreak === 0) currentStart = record.date;
              currentStreak++;
              if (currentStreak > maxStreak) {
                maxStreak = currentStreak;
                maxStart = currentStart;
                maxEnd = record.date;
              }
            } else {
              currentStreak = 0;
              currentStart = null;
            }
          });

          var monFriTotal = monAbsent + friAbsent;
          var totalAbsent = monFriTotal + otherAbsent;
          if (totalAbsent >= 2 && monFriTotal > otherAbsent) {
            monFriStudents.push({
              student_number: student.student_number,
              full_name: student.full_name,
              nickname: student.nickname,
              mon_absent: monAbsent,
              fri_absent: friAbsent,
              other_absent: otherAbsent,
              total_absent: totalAbsent,
              pattern_pct: Math.round((monFriTotal / totalAbsent) * 100)
            });
          }
          if (maxStreak >= 2) {
            streaks.push({
              student_number: student.student_number,
              full_name: student.full_name,
              nickname: student.nickname,
              streak_days: maxStreak,
              start_date: maxStart,
              end_date: maxEnd
            });
          }
        });

        monFriStudents.sort(function(a, b) { return b.pattern_pct - a.pattern_pct; });
        streaks.sort(function(a, b) { return b.streak_days - a.streak_days; });

        return {
          month: effectiveMonth,
          month_th: thaiMonthLabel(effectiveMonth),
          mon_fri_pattern: monFriStudents.slice(0, 10),
          consecutive_streaks: streaks.slice(0, 10),
          weekday_absence_rates: [1, 2, 3, 4, 5].map(function(day) {
            var entry = dayAbsence[day];
            return {
              day: THAI_WEEKDAYS[day],
              absent: entry.absent,
              total: entry.total,
              rate: entry.total > 0 ? Math.round((entry.absent / entry.total) * 100) : 0
            };
          })
        };
      });
    });
  });
}

function getGenderAnalytics(month, auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_gender_analytics',
    rate_limit_limit: 60,
    rate_limit_window_sec: 60
  }, function() {
    month = normalizeMonth_(month);
    return getOrBuildCachedJson_('analytics_gender', [month], 180, function() {
      return measureTiming_('analytics_build_ms', buildAnalyticsTimingMeta_('getGenderAnalytics', month), function() {
        var range = getEffectiveMonthRange_(month);
        var effectiveMonth = getEffectiveRangeMonth_(range, month);
        if (isEffectiveRangeEmpty_(range)) {
          return {
            month_th: thaiMonthLabel(effectiveMonth),
            male: {
              count: 0,
              stats: { present: 0, late: 0, absent: 0, leave: 0, total: 0 },
              attendance_pct: null
            },
            female: {
              count: 0,
              stats: { present: 0, late: 0, absent: 0, leave: 0, total: 0 },
              attendance_pct: null
            },
            unspecified: {
              count: 0,
              stats: { present: 0, late: 0, absent: 0, leave: 0, total: 0 },
              attendance_pct: null
            },
            out_of_semester: true
          };
        }
        var context = buildAttendanceComputationContext_(range, getCachedConfirmedAttendanceRange_(range.from, range.to));
        var records = context.filtered_records;
        var students = getOfficialStudentsForRange_(range, records);
        var studentIndex = buildStudentIdentityIndex_(students);
        var genderMap = {};
        var stats = {
          M: { present: 0, late: 0, absent: 0, leave: 0, total: 0 },
          F: { present: 0, late: 0, absent: 0, leave: 0, total: 0 },
          U: { present: 0, late: 0, absent: 0, leave: 0, total: 0 }
        };

        students.forEach(function(student) {
          genderMap[getStudentKey_(student)] = (student.gender === 'M' || student.gender === 'F') ? student.gender : 'U';
          var gender = genderMap[getStudentKey_(student)] || 'U';
          if (!stats[gender]) return;
          stats[gender].total += getStudentSchoolDayCountForContext_(student, context);
        });

        records.forEach(function(record) {
          var gender = genderMap[getResolvedRecordStudentKey_(record, studentIndex)] || 'U';
          if (!stats[gender]) return;
          if (record.status_code === 'present') stats[gender].present++;
          else if (record.status_code === 'late') stats[gender].late++;
          else if (record.status_code === 'absent') stats[gender].absent++;
          else stats[gender].leave++;
        });

        var maleCount = students.filter(function(student) { return student.gender === 'M'; }).length;
        var femaleCount = students.filter(function(student) { return student.gender === 'F'; }).length;
        var unspecifiedCount = students.filter(function(student) { return student.gender !== 'M' && student.gender !== 'F'; }).length;

        return {
          month_th: thaiMonthLabel(effectiveMonth),
          male: {
            count: maleCount,
            stats: stats.M,
            attendance_pct: calculateAttendancePercent_(stats.M.present, stats.M.late, stats.M.total, stats.M.leave)
          },
          female: {
            count: femaleCount,
            stats: stats.F,
            attendance_pct: calculateAttendancePercent_(stats.F.present, stats.F.late, stats.F.total, stats.F.leave)
          },
          unspecified: {
            count: unspecifiedCount,
            stats: stats.U,
            attendance_pct: calculateAttendancePercent_(stats.U.present, stats.U.late, stats.U.total, stats.U.leave)
          }
        };
      });
    });
  });
}
