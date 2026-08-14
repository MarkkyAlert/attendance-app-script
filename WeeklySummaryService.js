/**
 * Weekly summary trigger management and email generation.
 */

function withWeeklySummaryLock_(callback) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function getWeeklySummarySentKey_(fromDate, toDate) {
  return 'weekly_summary_sent_' + String(fromDate || '') + '_' + String(toDate || '');
}

function getWeeklySummarySentState_(fromDate, toDate) {
  var key = getWeeklySummarySentKey_(fromDate, toDate);
  var raw = String(getSettings_()[key] || '').trim();
  if (!raw) return null;
  try {
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    return { sent_at: raw };
  }
}

function markWeeklySummarySent_(fromDate, toDate, recipient, mode) {
  saveSetting_(getWeeklySummarySentKey_(fromDate, toDate), JSON.stringify({
    sent_at: nowString_(),
    recipient: String(recipient || '').trim(),
    mode: String(mode || '').trim() || 'auto'
  }));
}

function disableWeeklySummaryTriggers_() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'sendWeeklySummary' || trigger.getHandlerFunction() === 'sendWeeklySummary_') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function sendWeeklySummaryEmail_(recipient, data, settings) {
  var schoolName = settings.school_name || 'ระบบเช็คชื่อ';
  var className = settings.class_name || '';
  var html = buildWeeklySummaryHtml_(data, settings);

  MailApp.sendEmail({
    to: recipient,
    subject: 'สรุปเช็คชื่อประจำสัปดาห์ - ' + className + ' (' + data.week_label + ')',
    htmlBody: html,
    name: schoolName + ' - ระบบเช็คชื่อ'
  });
}

function enableWeeklySummary(auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'enable_weekly_summary'
  }, function() {
    return withWeeklySummaryLock_(function() {
      disableWeeklySummaryTriggers_();
      ScriptApp.newTrigger('sendWeeklySummary_')
        .timeBased()
        .onWeekDay(ScriptApp.WeekDay.FRIDAY)
        .atHour(16)
        .create();
      saveSetting_('weekly_summary_enabled', 'true');
      return { success: true, message: 'เปิดสรุปประจำสัปดาห์แล้ว (ทุกศุกร์ 16:00)' };
    });
  });
}

function disableWeeklySummary(auth) {
  if (isTeacherTrustedContext_()) {
    return disableWeeklySummary_();
  }
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'disable_weekly_summary'
  }, function() {
    return disableWeeklySummary_();
  });
}

function isWeeklySummaryEnabled(auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'is_weekly_summary_enabled',
    rate_limit_limit: 60,
    rate_limit_window_sec: 60
  }, function() {
    return getSettings_().weekly_summary_enabled === 'true';
  });
}

function isWeeklySummaryTriggerEvent_(e) {
  var triggerUid = String(e && e.triggerUid || '').trim();
  if (!triggerUid) return false;
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    var trigger = triggers[i];
    if (trigger.getHandlerFunction() !== 'sendWeeklySummary_') continue;
    if (typeof trigger.getUniqueId === 'function' && String(trigger.getUniqueId() || '') === triggerUid) {
      return true;
    }
  }
  return false;
}

function sendWeeklySummary_(e) {
  try {
    if (!isWeeklySummaryTriggerEvent_(e)) {
      Logger.log('Weekly Summary blocked: trigger context required');
      return;
    }

    var result = withWeeklySummaryLock_(function() {
      var settings = getSettings_();
      if (settings.weekly_summary_enabled !== 'true') {
        return { log: 'Weekly Summary skipped: disabled' };
      }

      var recipient = getSingleTeacherEmail_();
      if (!recipient) {
        return { log: 'Weekly Summary: no teacher email available' };
      }

      var data = buildWeeklySummaryData_();
      if (data && data.skip_send) {
        return { log: 'Weekly Summary skipped: ' + String(data.message || 'no active-semester overlap') };
      }

      var sentState = getWeeklySummarySentState_(data.from_date, data.to_date);
      if (sentState) {
        return { log: 'Weekly Summary skipped: already sent for ' + data.from_date + ' to ' + data.to_date + ' at ' + String(sentState.sent_at || '') };
      }

      sendWeeklySummaryEmail_(recipient, data, settings);
      markWeeklySummarySent_(data.from_date, data.to_date, recipient, 'auto');
      return { log: 'Weekly Summary sent to: ' + recipient };
    });

    Logger.log(result && result.log ? result.log : 'Weekly Summary completed');
  } catch (e) {
    Logger.log('Weekly Summary error: ' + e.message);
  }
}

function sendWeeklySummaryNow(auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'send_weekly_summary_now',
    rate_limit_limit: 5,
    rate_limit_window_sec: 300
  }, function(session) {
    try {
      return withWeeklySummaryLock_(function() {
        var settings = getSettings_();
        var email = String(session && session.teacher_email || getSingleTeacherEmail_() || '').trim();
        if (!email) return { success: false, message: 'ไม่พบ email ของครู' };

        var data = buildWeeklySummaryData_();
        if (data && data.skip_send) {
          return { success: false, message: data.message || 'ไม่มีช่วงวันที่ในภาคเรียนที่ใช้งานสำหรับการส่งสรุปสัปดาห์นี้' };
        }

        var sentState = getWeeklySummarySentState_(data.from_date, data.to_date);
        if (sentState) {
          return { success: false, message: 'สัปดาห์นี้ถูกส่งแล้วเมื่อ ' + String(sentState.sent_at || data.week_label) };
        }

        sendWeeklySummaryEmail_(email, data, settings);
        markWeeklySummarySent_(data.from_date, data.to_date, email, 'manual');
        return { success: true, message: 'ส่งสรุปประจำสัปดาห์ไปที่ ' + email + ' แล้ว' };
      });
    } catch (e) {
      return { success: false, message: 'ส่งไม่สำเร็จ: ' + e.message };
    }
  });
}

function disableWeeklySummary_() {
  return withWeeklySummaryLock_(function() {
    disableWeeklySummaryTriggers_();
    saveSetting_('weekly_summary_enabled', 'false');
    return { success: true, message: 'ปิดสรุปประจำสัปดาห์แล้ว' };
  });
}
function buildWeeklySummaryData_() {
  var today = todayString_();
  var dayOfWeek = getIsoWeekday_(today);
  var mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  var fromDate = shiftDate_(today, mondayOffset);
  var toDate = shiftDate_(fromDate, 4);
  var activeSemester = getActiveSemesterRangeSafe_();
  if (activeSemester) {
    if (fromDate < activeSemester.from) fromDate = activeSemester.from;
    if (toDate > activeSemester.to) toDate = activeSemester.to;
  }
  if (fromDate > toDate) {
    return {
      skip_send: true,
      message: 'ไม่มีช่วงวันที่ในภาคเรียนที่ใช้งานสำหรับสรุปประจำสัปดาห์นี้'
    };
  }
  var weekRecords = getCachedConfirmedAttendanceRange_(fromDate, toDate);
  var students = getOfficialStudentsForRange_({ from: fromDate, to: toDate }, weekRecords);
  var weekBuckets = buildStudentRecordBuckets_(weekRecords);
  var studentIndex = buildStudentIdentityIndex_(students);
  var weekdayNames = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

  var days = [];
  var dayCursor = fromDate;
  while (dayCursor <= toDate) {
    var dateStr = dayCursor;
    var weekday = getIsoWeekday_(dateStr);
    if (weekday < 1 || weekday > 5) {
      dayCursor = shiftDate_(dayCursor, 1);
      continue;
    }
    var dayRecs = weekRecords.filter(function(record) { return record.date === dateStr; });
    var counts = { present: 0, late: 0, absent: 0, sick_leave: 0, personal_leave: 0 };
    dayRecs.forEach(function(record) {
      if (counts.hasOwnProperty(record.status_code)) counts[record.status_code]++;
    });
    days.push({
      date: dateStr,
      date_th: thaiDate(dateStr, 'short', true),
      day_name: weekdayNames[getIsoWeekday_(dateStr)],
      has_data: dayRecs.length > 0,
      total_checked: dayRecs.length,
      counts: counts
    });
    dayCursor = shiftDate_(dayCursor, 1);
  }
  if (!days.length) {
    return {
      skip_send: true,
      message: 'ไม่มีวันเรียนในภาคเรียนที่ใช้งานสำหรับสรุปประจำสัปดาห์นี้'
    };
  }

  var weekCounts = { present: 0, late: 0, absent: 0, sick_leave: 0, personal_leave: 0, total: 0 };
  weekRecords.forEach(function(record) {
    if (weekCounts.hasOwnProperty(record.status_code)) weekCounts[record.status_code]++;
    weekCounts.total++;
  });

  var daysWithData = days.filter(function(day) { return day.has_data; }).length;
  var attendRate = calculateAttendancePercent_(
    weekCounts.present,
    weekCounts.late,
    weekCounts.total,
    weekCounts.sick_leave + weekCounts.personal_leave
  );
  var absentMap = {};
  weekRecords.forEach(function(record) {
    if (record.status_code === 'absent') {
      var studentKey = getResolvedRecordStudentKey_(record, studentIndex);
      absentMap[studentKey] = (absentMap[studentKey] || 0) + 1;
    }
  });

  var topAbsent = [];
  var perfectStudents = [];
  students.forEach(function(student) {
    var count = absentMap[getStudentKey_(student)] || 0;
    if (count > 0) {
      topAbsent.push({ full_name: student.full_name, nickname: student.nickname, count: count });
    }

    var studentRecords = getRecordsForStudent_(weekBuckets, student);
    if (daysWithData > 0 && studentRecords.length >= daysWithData && studentRecords.every(function(record) {
      return record.status_code === 'present' || record.status_code === 'late';
    })) {
      perfectStudents.push(student.full_name);
    }
  });
  topAbsent.sort(function(a, b) { return b.count - a.count; });

  return {
    from_date: fromDate,
    to_date: toDate,
    from_date_th: thaiDate(fromDate, 'short', false),
    to_date_th: thaiDate(toDate, 'short', false),
    week_label: thaiDate(fromDate, 'short', false) + ' - ' + thaiDate(toDate, 'short', false),
    total_students: students.length,
    days_with_data: daysWithData,
    days: days,
    week_counts: weekCounts,
    attend_rate: attendRate,
    top_absent: topAbsent.slice(0, 5),
    perfect_count: perfectStudents.length,
    perfect_students: perfectStudents.slice(0, 10),
    perfect_label: daysWithData === days.length ? 'มาเรียนครบทุกวัน' : 'มาเรียนครบทุกวันที่มีการบันทึก'
  };
}

function buildWeeklySummaryHtml_(data, settings) {
  var schoolName = settings.school_name || 'โรงเรียน';
  var className = settings.class_name || '';
  var teacherName = settings.teacher_name || 'ครูประจำชั้น';
  var wc = data.week_counts;
  var attendRate = data.attend_rate;
  var hasAttendRate = attendRate !== null && attendRate !== undefined && attendRate !== '';
  var html = '<div style="font-family:Sarabun,Kanit,sans-serif;max-width:600px;margin:0 auto;background:#faf9f7">';

  html += '<div style="background:linear-gradient(135deg,#7a624f,#5b4a3f);color:#fff;padding:24px;text-align:center;border-radius:16px 16px 0 0">';
  html += '<div style="font-size:14px;opacity:.8">สรุปประจำสัปดาห์</div>';
  html += '<div style="font-size:20px;font-weight:700;margin:6px 0">' + escEmail_(schoolName) + '</div>';
  html += '<div style="font-size:14px;opacity:.8">' + escEmail_(className) + ' - ' + escEmail_(data.week_label) + '</div>';
  html += '</div><div style="padding:20px;background:#fff">';

  var rateColor = !hasAttendRate ? '#78716c' : (attendRate >= 80 ? '#22c55e' : (attendRate >= 60 ? '#f59e0b' : '#ef4444'));
  html += '<div style="text-align:center;padding:20px;margin-bottom:16px;background:#faf9f7;border-radius:12px">';
  html += '<div style="font-size:48px;font-weight:800;color:' + rateColor + '">' + (hasAttendRate ? (attendRate + '%') : '-') + '</div>';
  html += '<div style="font-size:13px;color:#78716c">อัตราการมาเรียนสัปดาห์นี้</div></div>';

  html += '<table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px"><tr style="text-align:center">';
  html += statCell_('✅', wc.present, 'มาเรียน', '#dcfce7', '#166534');
  html += statCell_('⏰', wc.late, 'สาย', '#fef3c7', '#92400e');
  html += statCell_('❌', wc.absent, 'ขาด', '#fee2e2', '#991b1b');
  html += statCell_('🏥', wc.sick_leave, 'ลาป่วย', '#dbeafe', '#1e40af');
  html += statCell_('📋', wc.personal_leave, 'ลากิจ', '#e0e7ff', '#3730a3');
  html += '</tr></table>';

  html += '<div style="font-weight:700;font-size:14px;margin-bottom:8px">รายวัน</div>';
  html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:16px">';
  html += '<tr style="background:#f5f0eb;font-weight:700"><td style="padding:6px 8px">วัน</td><td style="text-align:center">✅</td><td style="text-align:center">⏰</td><td style="text-align:center">❌</td><td style="text-align:center">🏥</td><td style="text-align:center">📋</td></tr>';
  data.days.forEach(function(day) {
    if (!day.has_data) {
      html += '<tr style="color:#a8a29e"><td style="padding:4px 8px;border-bottom:1px solid #f5f5f4">' + day.day_name + '</td><td colspan="5" style="text-align:center;border-bottom:1px solid #f5f5f4;font-style:italic">ไม่มีข้อมูล</td></tr>';
    } else {
      html += '<tr><td style="padding:4px 8px;border-bottom:1px solid #f5f5f4;font-weight:600">' + day.day_name + '</td>';
      html += '<td style="text-align:center;border-bottom:1px solid #f5f5f4">' + day.counts.present + '</td>';
      html += '<td style="text-align:center;border-bottom:1px solid #f5f5f4">' + day.counts.late + '</td>';
      html += '<td style="text-align:center;border-bottom:1px solid #f5f5f4;color:' + (day.counts.absent > 0 ? '#ef4444;font-weight:700' : '#a8a29e') + '">' + day.counts.absent + '</td>';
      html += '<td style="text-align:center;border-bottom:1px solid #f5f5f4">' + day.counts.sick_leave + '</td>';
      html += '<td style="text-align:center;border-bottom:1px solid #f5f5f4">' + day.counts.personal_leave + '</td></tr>';
    }
  });
  html += '</table>';

  if (data.top_absent.length > 0) {
    html += '<div style="font-weight:700;font-size:14px;margin-bottom:8px">ขาดมากสุดสัปดาห์นี้</div>';
    html += '<div style="background:#fff5f5;border-radius:10px;padding:10px 14px;margin-bottom:16px">';
    data.top_absent.forEach(function(student) {
      html += '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px">';
      html += '<span>' + escEmail_(student.full_name) + (student.nickname ? ' (' + escEmail_(student.nickname) + ')' : '') + '</span>';
      html += '<span style="font-weight:700;color:#ef4444">' + student.count + ' วัน</span></div>';
    });
    html += '</div>';
  }

  if (data.perfect_count > 0) {
    html += '<div style="font-weight:700;font-size:14px;margin-bottom:8px">' + escEmail_(data.perfect_label || 'มาเรียนครบทุกวัน') + ' (' + data.perfect_count + ' คน)</div>';
    html += '<div style="background:#f0fdf4;border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:13px;color:#166534">';
    html += data.perfect_students.map(escEmail_).join(', ');
    if (data.perfect_count > 10) html += ' ...และอีก ' + (data.perfect_count - 10) + ' คน';
    html += '</div>';
  }

  html += '</div><div style="padding:16px;text-align:center;font-size:11px;color:#a8a29e;border-top:1px solid #e7e5e4">';
  html += 'ส่งอัตโนมัติโดยระบบเช็คชื่อนักเรียน - ' + escEmail_(teacherName) + ' - ' + escEmail_(schoolName);
  html += '</div></div>';
  return html;
}

function statCell_(icon, count, label, bg, color) {
  return '<td style="padding:10px 4px;background:' + bg + ';border-radius:8px;text-align:center">' +
    '<div style="font-size:18px">' + icon + '</div>' +
    '<div style="font-size:18px;font-weight:800;color:' + color + '">' + count + '</div>' +
    '<div style="font-size:10px;color:' + color + '">' + label + '</div></td>';
}

