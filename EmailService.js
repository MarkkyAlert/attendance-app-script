/**
 * Teacher-only parent notification emails.
 */

function sendParentEmails(date, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'send_parent_emails',
    rate_limit_limit: 10,
    rate_limit_window_sec: 300
  }, function() {
    var lock = LockService.getDocumentLock();
    lock.waitLock(30000);
    try {
    date = normalizeAttendanceDate_(date, false);
    if (!date) return { success: false, message: 'วันที่ไม่ถูกต้อง' };
    try {
      ensureAttendanceActionDate_(date, 'วันที่เช็คชื่อ');
    } catch (e) {
      return buildFailurePayload_(e);
    }
    if (!isDayConfirmed_(date)) {
      return { success: false, message: 'กรุณายืนยันวันนี้ก่อนส่งอีเมลให้ผู้ปกครอง' };
    }

    var settings = getSettings_();
    var notifyCodes = ['absent', 'late', 'sick_leave', 'personal_leave'];
    var records = getCachedConfirmedAttendanceRange_(date, date);
    var students = getOfficialStudentsForRange_({ from: date, to: date }, records);
    var studentIndex = buildStudentIdentityIndex_(students);
    var recordMap = buildRecordMapForStudents_(records, studentIndex, { records_are_unique: true });
    var dayStatus = getDayStatus_(date);
    var sentStudentKeys = getDayNotifiedStudentKeys_(date);
    var sentStudentMap = {};
    sentStudentKeys.forEach(function(key) {
      sentStudentMap[key] = true;
    });
    var isLegacyFullyNotified = !!dayStatus.notified_at && sentStudentKeys.length === 0;

    if (isLegacyFullyNotified) {
      return { success: false, message: 'วันนี้ใช้สถานะแจ้งผู้ปกครองแบบเก่าอยู่ กรุณาใช้เครื่องมือซ่อมข้อมูลก่อนส่งใหม่' };
    }

    var sentCount = 0;
    var failCount = 0;
    var skippedCount = 0;
    var alreadySentCount = 0;
    var errors = [];
    var newlySentStudentKeys = [];
    var eligibleStudentKeys = [];

    students.forEach(function(student) {
      var record = recordMap[getStudentKey_(student)];
      if (!record || notifyCodes.indexOf(record.status_code) < 0) return;

      var email = String(student.parent_email || '').trim();
      if (!isValidEmailValue_(email)) {
        skippedCount++;
        return;
      }

      var studentKey = getStudentKey_(student);
      eligibleStudentKeys.push(studentKey);
      if (sentStudentMap[studentKey]) {
        alreadySentCount++;
        return;
      }

      var statusInfo = STATUS_MAP[record.status_code] || {};
      var schoolName = settings.school_name || 'โรงเรียน';
      var className = settings.class_name || '';
      var teacherName = settings.teacher_name || 'ครูประจำชั้น';
      var dateTh = thaiDate(date, 'long', true);
      var subject = 'แจ้งเตือนการเข้าเรียน - ' + student.full_name + ' (' + dateTh + ')';

      var body = '';
      body += '<div style="font-family:Sarabun,sans-serif;max-width:600px;margin:0 auto;padding:20px">';
      body += '<div style="background:#7a624f;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0;text-align:center">';
      body += '<h2 style="margin:0;font-size:18px">' + escEmail_(schoolName) + '</h2>';
      if (className) body += '<p style="margin:4px 0 0;font-size:14px;opacity:.8">' + escEmail_(className) + '</p>';
      body += '</div><div style="border:1px solid #e7e5e4;border-top:none;border-radius:0 0 12px 12px;padding:20px">';
      body += '<p style="font-size:15px;color:#44403c">เรียน ผู้ปกครองของ <strong>' + escEmail_(student.full_name) + '</strong>';
      if (student.nickname) body += ' (' + escEmail_(student.nickname) + ')';
      body += '</p>';
      body += '<div style="background:' + getStatusBg_(record.status_code) + ';border-radius:10px;padding:14px 18px;margin:14px 0;text-align:center">';
      body += '<p style="font-size:24px;margin:0">' + (statusInfo.icon || '') + '</p>';
      body += '<p style="font-size:16px;font-weight:700;margin:6px 0 0;color:' + getStatusColor_(record.status_code) + '">' + escEmail_(statusInfo.label || record.status_code) + '</p>';
      body += '</div>';
      body += '<table style="width:100%;font-size:14px;color:#57534e;border-collapse:collapse">';
      body += '<tr><td style="padding:6px 0;font-weight:600">วันที่</td><td style="padding:6px 0">' + escEmail_(dateTh) + '</td></tr>';
      body += '<tr><td style="padding:6px 0;font-weight:600">เลขที่</td><td style="padding:6px 0">' + student.student_number + '</td></tr>';
      if (record.note) {
        body += '<tr><td style="padding:6px 0;font-weight:600">หมายเหตุ</td><td style="padding:6px 0">' + escEmail_(record.note) + '</td></tr>';
      }
      body += '</table><hr style="border:none;border-top:1px solid #e7e5e4;margin:16px 0">';
      body += '<p style="font-size:12px;color:#a8a29e;text-align:center">';
      body += 'ส่งโดย ' + escEmail_(teacherName) + ' - ' + escEmail_(schoolName);
      body += '<br>ระบบเช็คชื่อนักเรียนอัตโนมัติ</p></div></div>';

      try {
        MailApp.sendEmail({
          to: email,
          subject: subject,
          htmlBody: body,
          name: teacherName + ' - ' + schoolName
        });
        sentCount++;
        newlySentStudentKeys.push(studentKey);
        markDayStudentsNotified_(date, [studentKey]);
        sentStudentMap[studentKey] = true;
      } catch (e) {
        failCount++;
        errors.push({ student_number: student.student_number, full_name: student.full_name, error: e.message });
      }
    });

    sentStudentKeys = getDayNotifiedStudentKeys_(date);

    var allEligibleSent = eligibleStudentKeys.length > 0 && eligibleStudentKeys.every(function(studentKey) {
      return sentStudentKeys.indexOf(studentKey) >= 0;
    });
    if (allEligibleSent) {
      markDayNotified_(date, nowString_());
    }

    if (!eligibleStudentKeys.length) {
      return { success: false, message: 'ยังไม่มีอีเมลผู้ปกครองที่พร้อมส่งในวันนี้' };
    }

    if (sentCount <= 0 && failCount <= 0) {
      return { success: false, message: 'รายการที่ส่งได้ของวันนี้ถูกส่งครบแล้ว' };
    }

    return {
      success: true,
      message: 'ส่งอีเมล ' + sentCount + ' ฉบับ'
        + (alreadySentCount > 0 ? ' (ส่งไปแล้ว ' + alreadySentCount + ')' : '')
        + (skippedCount > 0 ? ' (ข้าม ' + skippedCount + ')' : '')
        + (failCount > 0 ? ' (ล้มเหลว ' + failCount + ')' : ''),
      data: {
        sent: sentCount,
        already_sent: alreadySentCount,
        skipped: skippedCount,
        failed: failCount,
        pending: Math.max(0, eligibleStudentKeys.length - getDayNotifiedStudentKeys_(date).length),
        errors: errors.slice(0, 10)
      }
    };
    } finally {
      lock.releaseLock();
    }
  });
}

function previewParentEmails(date, auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'preview_parent_emails',
    rate_limit_limit: 60,
    rate_limit_window_sec: 60
  }, function() {
    date = normalizeAttendanceDate_(date, false);
    if (!date) return { success: false, message: 'วันที่ไม่ถูกต้อง' };
    try {
      ensureAttendanceActionDate_(date, 'วันที่เช็คชื่อ');
    } catch (e) {
      return buildFailurePayload_(e);
    }
    if (!isDayConfirmed_(date)) {
      return { success: false, message: 'กรุณายืนยันวันนี้ก่อนดูตัวอย่างการส่งอีเมล' };
    }

    var notifyCodes = ['absent', 'late', 'sick_leave', 'personal_leave'];
    var records = getCachedConfirmedAttendanceRange_(date, date);
    var students = getOfficialStudentsForRange_({ from: date, to: date }, records);
    var dayStatus = getDayStatus_(date);
    var studentIndex = buildStudentIdentityIndex_(students);
    var recordMap = buildRecordMapForStudents_(records, studentIndex, { records_are_unique: true });
    var sentStudentKeys = getDayNotifiedStudentKeys_(date);
    var isLegacyFullyNotified = !!dayStatus.notified_at && sentStudentKeys.length === 0;
    var sentStudentMap = {};
    sentStudentKeys.forEach(function(key) {
      sentStudentMap[key] = true;
    });

    var willSend = [];
    var noEmail = [];
    var alreadySent = [];

    students.forEach(function(student) {
      var record = recordMap[getStudentKey_(student)];
      if (!record || notifyCodes.indexOf(record.status_code) < 0) return;

      var info = STATUS_MAP[record.status_code] || {};
      var item = {
        student_number: student.student_number,
        full_name: student.full_name,
        nickname: student.nickname || '',
        status_label: info.label || record.status_code,
        status_icon: info.icon || '',
        note: record.note || '',
        has_parent_email: isValidEmailValue_(student.parent_email)
      };

      if (!item.has_parent_email) {
        noEmail.push(item);
      } else if (isLegacyFullyNotified) {
        alreadySent.push(item);
      } else if (sentStudentMap[getStudentKey_(student)]) {
        alreadySent.push(item);
      } else {
        willSend.push(item);
      }
    });

    return {
      success: true,
      date: date,
      date_th: thaiDate(date, 'long', true),
      notified_at: dayStatus.notified_at || '',
      legacy_fully_notified: isLegacyFullyNotified,
      will_send: willSend,
      already_sent: alreadySent,
      no_email: noEmail,
      remaining_quota: MailApp.getRemainingDailyQuota(),
      message: isLegacyFullyNotified
        ? 'วันนี้มีสถานะแจ้งผู้ปกครองแบบเก่า คุณสามารถย้ายสถานะเดิมหรือรีเซ็ตเพื่อส่งใหม่ได้'
        : (willSend.length > 0 ? '' : (alreadySent.length > 0 ? 'รายการที่ส่งได้ของวันนี้ถูกส่งครบแล้ว' : 'ยังไม่มีอีเมลผู้ปกครองที่พร้อมส่ง')),
      data: {
        ready_count: willSend.length,
        already_sent_count: alreadySent.length,
        no_email_count: noEmail.length,
        legacy_fully_notified: isLegacyFullyNotified,
        total_students: students.length,
        will_send: willSend,
        already_sent: alreadySent,
        no_email: noEmail
      }
    };
  });
}

function escEmail_(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getStatusBg_(code) {
  var map = {
    present: '#dcfce7',
    late: '#fef3c7',
    absent: '#fee2e2',
    sick_leave: '#dbeafe',
    personal_leave: '#e0e7ff'
  };
  return map[code] || '#f5f5f4';
}

function getStatusColor_(code) {
  var map = {
    present: '#166534',
    late: '#92400e',
    absent: '#991b1b',
    sick_leave: '#1e40af',
    personal_leave: '#3730a3'
  };
  return map[code] || '#44403c';
}
