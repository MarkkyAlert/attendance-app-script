/**
 * Diagnostics ชั่วคราวสำหรับตรวจงานแก้ชุด P0 — ลบไฟล์นี้ทิ้งได้เมื่อทดสอบผ่านแล้ว
 * (ลบเมนู '🧪 ตรวจงานแก้ P0 (dev)' ใน Utils.js onOpen ออกด้วย)
 *
 * วิธีใช้ เลือกทางใดทางหนึ่ง:
 *   - Apps Script editor > เลือก runP0Diagnostics > Run > ดูผลใน Execution log
 *   - Google Sheets > เมนู 🎓 ระบบเช็คชื่อ > 🧪 ตรวจงานแก้ P0 (dev)
 * แล้วก๊อป JSON ทั้งก้อนส่งกลับมา
 *
 * ทุกเช็คไม่แตะข้อมูลจริง (ชีตทดสอบถูกสร้างและลบทิ้งในตัวเอง)
 * และผลลัพธ์ไม่มีชื่อนักเรียนติดออกมา
 */

var P0_DIAG_TEMP_SHEET_ = '_p0_diag_tmp';

/**
 * ประตูเข้าสำหรับ editor และเมนูในชีต
 * ต้องไม่มี _ ต่อท้าย เพราะช่องเลือกฟังก์ชันของ editor ไม่แสดงฟังก์ชันที่ลงท้ายด้วย _
 * แต่นั่นแปลว่ามันถูกเรียกผ่าน google.script.run ได้ด้วย จึงต้องมีด่านกันไว้
 */
function runP0Diagnostics() {
  requireP0DiagnosticLocalContext_();
  var summary = runP0Diagnostics_();

  try {
    SpreadsheetApp.getUi().showModalDialog(buildP0DiagnosticDialog_(summary), 'ผลตรวจงานแก้ P0');
  } catch (e) {
    // รันจาก editor จะไม่มี UI ให้เปิด — ไม่เป็นไร ผลเต็มอยู่ใน Execution log แล้ว
  }
  return summary;
}

/**
 * ด่านกันไม่ให้เรียกผ่าน google.script.run
 * Web App ตั้งเป็น ANYONE_ANONYMOUS ผู้เรียกจากเน็ตจึงไม่มีอีเมลติดมา
 * ส่วนการรันจาก editor หรือเมนูในชีตจะได้อีเมลเจ้าของสคริปต์เสมอ
 * (ห้ามใช้ SpreadsheetApp.getUi() เป็นด่าน เพราะมันพังตอนรันจาก editor ด้วย)
 */
function requireP0DiagnosticLocalContext_() {
  var email = '';
  try {
    email = String(Session.getActiveUser().getEmail() || '').trim();
  } catch (e) {
    email = '';
  }
  if (!email) {
    throw new Error('ฟังก์ชันนี้เรียกได้จาก Apps Script editor หรือเมนูในชีตเท่านั้น');
  }
  return email;
}

function buildP0DiagnosticDialog_(summary) {
  var headline = summary.success
    ? '✅ ผ่านทั้งหมด'
    : ('❌ ไม่ผ่าน ' + summary.failed_checks.length + ' รายการ: ' + summary.failed_checks.join(', '));

  return HtmlService.createHtmlOutput(
    '<div style="font-family:Sarabun,Arial,sans-serif;font-size:13px">' +
    '<p style="margin:0 0 8px">' + escapeP0DiagnosticHtml_(headline) + '</p>' +
    '<p style="margin:0 0 8px;color:#78716c">ก๊อปข้อความทั้งหมดด้านล่างส่งกลับไปให้ผู้พัฒนา</p>' +
    '<textarea id="p0-out" style="width:100%;height:340px;font-family:monospace;font-size:11px">' +
    escapeP0DiagnosticHtml_(JSON.stringify(summary, null, 2)) +
    '</textarea>' +
    '<script>var el=document.getElementById("p0-out");el.focus();el.select();<\/script>' +
    '</div>'
  ).setWidth(720).setHeight(460);
}

function escapeP0DiagnosticHtml_(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function runP0Diagnostics_() {
  ensureSecurityMigration_();

  return runAsTrustedTeacher_(function() {
    var startedAt = new Date().getTime();
    var checks = [];
    var range = buildP0DiagnosticRange_();
    var monthlyCsv = null;
    var dailyCsv = null;

    // 1. โค้ดใหม่ถูก push ขึ้นไปแล้วจริงไหม
    checks.push(runPreReleaseSmokeCheck_('deploy:functions_present', function() {
      var presence = {
        deleteSheetRowsByIndexes_: typeof deleteSheetRowsByIndexes_,
        exportCSVData_: typeof exportCSVData_,
        downloadCSV: typeof downloadCSV,
        cleanupCSVFile: typeof cleanupCSVFile,
        ensureSystemSheets_: typeof ensureSystemSheets_,
        getCachedDailyGridDataForRange_: typeof getCachedDailyGridDataForRange_,
        runPreReleaseSmokeChecks: typeof runPreReleaseSmokeChecks
      };

      Object.keys(presence).forEach(function(name) {
        if (name === 'runPreReleaseSmokeChecks') return;
        assertPreReleaseSmoke_(presence[name] === 'function', 'ยังไม่พบฟังก์ชัน ' + name + ' (โค้ดใหม่ยังไม่ถูก push?)');
      });
      assertPreReleaseSmoke_(
        presence.runPreReleaseSmokeChecks === 'undefined',
        'runPreReleaseSmokeChecks ยังเรียกได้จากอินเทอร์เน็ตอยู่ — การเปลี่ยนชื่อยังไม่ขึ้น'
      );
      return presence;
    }));

    // 2. หัวใจของงานชุดนี้: ลบแถวไม่ติดกัน บนชีตทดสอบที่แยกออกมาต่างหาก
    checks.push(runPreReleaseSmokeCheck_('delete_rows:non_contiguous', function() {
      var ss = getSpreadsheet_();
      var stale = ss.getSheetByName(P0_DIAG_TEMP_SHEET_);
      if (stale) ss.deleteSheet(stale);

      var sheet = ss.insertSheet(P0_DIAG_TEMP_SHEET_);
      try {
        var values = [['header']];
        for (var i = 2; i <= 12; i++) {
          values.push(['row' + i]);
        }
        sheet.getRange(1, 1, values.length, 1).setValues(values);

        // จงใจใส่: ไม่เรียงลำดับ, มีค่าซ้ำ, มีแถว header (1) และค่าขยะที่ต้องถูกเมิน
        var deleted = deleteSheetRowsByIndexes_(sheet, [4, 3, 2, 7, 10, 10, 1, 0, null, '']);
        var remaining = sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues().map(function(row) {
          return String(row[0] || '');
        });
        var expected = ['header', 'row5', 'row6', 'row8', 'row9', 'row11', 'row12'];

        assertPreReleaseSmoke_(deleted === 5, 'ควรลบ 5 แถว แต่ได้ ' + deleted);
        assertPreReleaseSmoke_(
          remaining.join(',') === expected.join(','),
          'แถวที่เหลือไม่ตรง — ได้: ' + remaining.join(',') + ' | ควรเป็น: ' + expected.join(',')
        );
        return { deleted: deleted, remaining: remaining };
      } finally {
        var temp = ss.getSheetByName(P0_DIAG_TEMP_SHEET_);
        if (temp) ss.deleteSheet(temp);
      }
    }));

    // 3-4. CSV ทั้งสองแบบ สร้างจากช่วงภาคเรียนที่ใช้งานอยู่ (ไม่สร้างไฟล์บน Drive)
    checks.push(runPreReleaseSmokeCheck_('csv:monthly', function() {
      monthlyCsv = summarizeP0Csv_(
        exportCSVData_('monthly', { start_date: range.from, end_date: range.to }),
        { include_last_line: true }
      );
      return monthlyCsv;
    }));

    checks.push(runPreReleaseSmokeCheck_('csv:daily', function() {
      dailyCsv = summarizeP0Csv_(
        exportCSVData_('daily', { from: range.from, to: range.to }),
        { include_last_line: false }
      );
      return dailyCsv;
    }));

    // รายชื่อนักเรียนของสองรายงานมาจากฟังก์ชันเดียวกัน จำนวนแถวจึงต้องตรงกัน
    // monthly = หัวตาราง + นักเรียน + แถวรวม, daily = หัวตาราง + นักเรียน
    checks.push(runPreReleaseSmokeCheck_('csv:row_counts_agree', function() {
      assertPreReleaseSmoke_(!!(monthlyCsv && dailyCsv), 'สร้าง CSV ไม่ครบทั้งสองแบบ จึงเทียบไม่ได้');
      var monthlyStudents = monthlyCsv.line_count - 2;
      var dailyStudents = dailyCsv.line_count - 1;
      assertPreReleaseSmoke_(
        monthlyStudents === dailyStudents,
        'จำนวนนักเรียนไม่ตรงกัน — monthly ' + monthlyStudents + ' / daily ' + dailyStudents
      );
      return { student_rows: monthlyStudents };
    }));

    checks.push(runPreReleaseSmokeCheck_('csv:invalid_type_rejected', function() {
      var message = '';
      try {
        exportCSVData_('ไม่มีประเภทนี้', {});
      } catch (e) {
        message = String(e && e.message || e);
      }
      assertPreReleaseSmoke_(!!message, 'ประเภทรายงานที่ไม่รู้จักต้อง throw');
      return { message: message };
    }));

    // 5. เส้นทางที่ restoreBackup ใช้ ต้องรันได้โดยไม่แตะ SpreadsheetApp.getUi()
    checks.push(runPreReleaseSmokeCheck_('restore:ensure_system_sheets', function() {
      var result = ensureSystemSheets_();
      assertPreReleaseSmoke_(!!result, 'ensureSystemSheets_ ไม่คืนค่า');
      return { created_new_teacher_key: !!result.initial_teacher_key };
    }));

    // 6. เส้นทางลบของปฏิทินวันเรียน (array ว่าง = ไม่ลบอะไร แต่พิสูจน์ว่าไม่ ReferenceError)
    checks.push(runPreReleaseSmokeCheck_('calendar:delete_path_reachable', function() {
      var deleted = deleteSheetRowsByIndexes_(getOrCreateSchoolCalendarSheet_(), []);
      assertPreReleaseSmoke_(deleted === 0, 'ลบด้วย array ว่างต้องได้ 0 แต่ได้ ' + deleted);
      return {
        deleted: deleted,
        calendar_summary: getSchoolCalendarSummaryForRange_({ from: range.from, to: range.to })
      };
    }));

    var failures = checks.filter(function(check) { return !check.ok; });
    var summary = {
      success: failures.length === 0,
      ran_at: nowString_(),
      duration_ms: new Date().getTime() - startedAt,
      range: range,
      failed_checks: failures.map(function(check) { return check.name; }),
      checks: checks
    };

    Logger.log(JSON.stringify(summary, null, 2));
    return summary;
  });
}

function buildP0DiagnosticRange_() {
  var semester = getActiveSemesterRow_();
  assertPreReleaseSmoke_(
    !!(semester && semester.start_date && semester.end_date),
    'ยังไม่มีภาคเรียนที่เปิดใช้งานอยู่ จึงทดสอบ CSV ไม่ได้'
  );

  var to = todayString_();
  if (to > semester.end_date) to = semester.end_date;
  if (to < semester.start_date) to = semester.start_date;

  return {
    semester_name: String(semester.name || ''),
    from: semester.start_date,
    to: to
  };
}

/**
 * สรุปผล CSV โดยไม่เอาชื่อนักเรียนออกมา
 * หัวตารางปลอดภัยเสมอ (เป็นชื่อคอลัมน์/วันที่) ส่วนบรรทัดสุดท้ายเอาออกมาเฉพาะ
 * รายงาน monthly ที่บรรทัดท้ายเป็นแถว 'รวม'
 */
function summarizeP0Csv_(exportData, options) {
  options = options || {};
  assertPreReleaseSmoke_(!!(exportData && exportData.content), 'ไม่ได้เนื้อหา CSV กลับมา');

  var content = String(exportData.content || '');
  assertPreReleaseSmoke_(content.charCodeAt(0) === 0xFEFF, 'CSV ไม่มี BOM — Excel จะอ่านภาษาไทยเพี้ยน');

  var lines = content.slice(1).split('\r\n').filter(function(line) {
    return String(line || '').length > 0;
  });
  assertPreReleaseSmoke_(lines.length > 1, 'CSV มีแต่หัวตาราง ไม่มีข้อมูล');

  var result = {
    filename: String(exportData.filename || ''),
    content_length: content.length,
    line_count: lines.length,
    header: lines[0]
  };
  if (options.include_last_line) {
    result.last_line = lines[lines.length - 1];
  }
  return result;
}
