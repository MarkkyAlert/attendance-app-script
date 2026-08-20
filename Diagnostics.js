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

// ★ ถ้าใช้เวลาไปเกินนี้แล้ว ให้ข้ามตัวควบคุมที่แพงที่สุด (การสแกนชีตตรงๆ)
// เพราะ Apps Script จำกัดฟังก์ชันเดียวที่ 6 นาที และรอบที่ช้าเคยไปถึง 344 วินาทีมาแล้ว
//
// ⚠️ **วัดแล้วรอบปกติใช้ไปแล้ว 18,848 ms ก่อนถึง check นั้น** (20 ส.ค. 2569) ไม่ใช่ "ไม่กี่วินาที"
// อย่างที่เคยเขียนไว้ตอนแรก · เกณฑ์ 30,000 จึงเหลือระยะห่างแค่ 11 วินาที ซึ่งบางเกินไป
// ถ้าเพิ่ม check ก่อนหน้าอีกนิดเดียว รอบที่แข็งแรงจะเริ่มถูกข้ามเงียบๆ แล้วเราจะเสียตัวควบคุมไป
// ตั้งไว้ 45,000 เพื่อให้เหลือระยะห่างราว 26 วินาทีจากค่าที่วัดได้จริง
// ยังไม่รู้ว่ารอบที่ช้าเคยใช้ไปเท่าไรก่อนถึง check นี้ เพราะตอนนั้นยังไม่มีฟิลด์ `elapsed_before_ms`
// → ดูค่านั้นทุกรอบ ถ้าเข้าใกล้ 45,000 เมื่อไร ให้ย้าย check นี้ไปไว้ต้นๆ แทนการเพิ่มเกณฑ์ไปเรื่อยๆ
var P0_DIAGNOSTIC_CONTROL_SCAN_BUDGET_MS = 45000;

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

    // 1.5 หน้าเช็คชื่ออ่านชีต archive ได้จริงไหม (รอบ 1 · 16 ส.ค. 2569)
    // อ่านอย่างเดียว ไม่เขียนอะไรทั้งนั้น · ถอดออกได้เมื่อปิดข้อนี้แล้ว
    checks.push(runPreReleaseSmokeCheck_('attendance:daily_reads_archive', function() {
      var semester = getActiveSemesterRow_();
      assertPreReleaseSmoke_(!!semester, 'ยังไม่มีภาคเรียนที่ใช้งานอยู่');

      var sourceInfo = getAttendanceSourceInfoForSemester_(semester);
      var readSheets = getAttendanceReadSheets_(sourceInfo).map(function(sheet) {
        return { name: sheet.getName(), last_row: sheet.getLastRow() };
      });

      // เลือกวันเรียนที่มีข้อมูลจริงจากชีตที่อ่านได้ แทนการ hard-code วันที่
      var probeDate = '';
      var buckets = getCachedAttendanceDateBuckets_(sourceInfo) || {};
      Object.keys(buckets).sort().forEach(function(date) {
        if (!probeDate && buckets[date] && buckets[date].length) probeDate = date;
      });

      var result = {
        semester: String(semester.name || ''),
        semester_range: String(semester.start_date || '') + ' - ' + String(semester.end_date || ''),
        is_archived: isSemesterAttendanceArchived_(semester),
        source_key: String(sourceInfo.key || ''),
        archive_sheet_name: String(sourceInfo.attendance_archive_sheet_name || '(ไม่มี)'),
        read_sheets: readSheets,
        probe_date: probeDate || '(ไม่พบวันที่มีข้อมูลเลย)',
        records_via_date_read: probeDate ? readAttendanceRecordsByDate_(probeDate, sourceInfo).length : 0,
        records_via_bucket: probeDate && buckets[probeDate] ? buckets[probeDate].length : 0
      };

      assertPreReleaseSmoke_(!!probeDate, 'ไม่พบวันที่มีข้อมูลเช็คชื่อเลยในภาคเรียนนี้');
      assertPreReleaseSmoke_(
        result.records_via_date_read > 0,
        'readAttendanceRecordsByDate_ คืน 0 แถวสำหรับ ' + probeDate +
        ' ทั้งที่รวมทั้งภาคเรียนมี ' + result.records_via_bucket + ' แถวในวันนั้น'
      );
      return result;
    }));

    // 1ข. ชนิดของค่าในคอลัมน์วันที่ + การหาวันในปฏิทินให้ผลตรงกับการสแกนตรงไหม
    // ★ อ่านอย่างเดียว ไม่แก้ชีต
    // เดิมมีไว้จับ `createTextFinder` ซึ่งเทียบกับ "ข้อความที่แสดง" — **ตอนนี้ไม่มีใครใช้แล้ว**
    // `readSchoolCalendarEntryByDate_` เปลี่ยนไปใช้ `getAllSchoolCalendarEntries_` แทน
    // แต่ check นี้ยังมีค่า เพราะกลายเป็นการตรวจว่า **เส้นทางที่ cache ไว้ ให้ผลตรงกับ
    // การสแกนชีตตรงๆ** ซึ่งเป็นสิ่งที่ `deleteSchoolCalendarEntry` พึ่งพา (เอา `row_index` ไปลบแถว)
    checks.push(runPreReleaseSmokeCheck_('calendar:date_lookup_vs_scan', function() {
      var result = { date_cell_types: describeDateCellTypes_() };

      var sheet = getSchoolCalendarSheetForRead_();
      assertPreReleaseSmoke_(!!sheet, 'ไม่พบชีต ' + SCHOOL_CALENDAR_SHEET);
      var lastRow = sheet.getLastRow();
      assertPreReleaseSmoke_(lastRow > 1, 'ชีตปฏิทินวันเรียนยังว่าง ไม่มีวันที่ให้ทดสอบ');

      // สแกนทั้งคอลัมน์ด้วย formatDate_ ซึ่งรับทั้ง Date และข้อความ = ความจริงที่ใช้เทียบ
      var values = sheet.getRange(2, SCHOOL_CALENDAR_COL.DATE, lastRow - 1, 1).getValues();
      var scanned = {};
      var scannedCount = 0;
      for (var i = 0; i < values.length; i++) {
        var date = formatDate_(values[i][0]);
        if (!date || scanned[date]) continue;
        scanned[date] = true;
        scannedCount++;
      }
      result.dates_via_scan = scannedCount;

      var probeDate = '';
      Object.keys(scanned).sort().forEach(function(date) {
        if (!probeDate) probeDate = date;
      });
      result.probe_date = probeDate || '(ไม่พบวันที่ที่อ่านได้เลย)';
      assertPreReleaseSmoke_(!!probeDate, 'สแกนคอลัมน์วันที่แล้วไม่ได้วันที่ที่ใช้ได้เลย');

      var entry = readSchoolCalendarEntryByDate_(probeDate);
      result.lookup_found = !!entry;
      result.lookup_type = entry ? String(entry.type || '') : '';
      assertPreReleaseSmoke_(
        !!entry,
        'readSchoolCalendarEntryByDate_ หา ' + probeDate + ' ไม่เจอ ทั้งที่สแกนตรงๆ เจอ ' +
        scannedCount + ' วัน — เส้นทางที่ cache ไว้กับการสแกนชีตให้ผลไม่ตรงกัน'
      );
      return result;
    }));

    // 1ค. ตอบข้อค้างใน TODO: ทำไมเช็คชื่อ "วันเดียว" ช้ากว่ารายงานรายวัน "3 เดือน"
    // ★ อ่านอย่างเดียว · โค้ดมี instrument รายขั้นตอนอยู่แล้ว แค่ไม่มีใครเอามาดู
    //   วัดในการรันเดียวกันจึงเทียบกันได้จริง ต่างจากการจับเวลาบนเบราว์เซอร์
    //   ซึ่งรวม round-trip กับการวาดหน้าจอเข้าไปด้วย
    checks.push(runPreReleaseSmokeCheck_('perf:attendance_vs_report', function() {
      var semester = getActiveSemesterRow_();
      assertPreReleaseSmoke_(!!semester, 'ยังไม่มีภาคเรียนที่ใช้งานอยู่');
      var sourceInfo = getAttendanceSourceInfoForSemester_(semester);

      // วันที่มีข้อมูลเช็คชื่อ = อยู่ในภาคเรียนและเป็นวันเรียนแน่นอน จึงไม่ทำให้ guard โยน error
      var probeDate = '';
      var buckets = getCachedAttendanceDateBuckets_(sourceInfo) || {};
      Object.keys(buckets).sort().forEach(function(date) {
        if (!probeDate && buckets[date] && buckets[date].length) probeDate = date;
      });
      assertPreReleaseSmoke_(!!probeDate, 'ไม่พบวันที่มีข้อมูลเช็คชื่อให้วัด');

      var result = { probe_date: probeDate, semester: String(semester.name || '') };

      // รันสองครั้ง ครั้งแรกอาจ cache ยังไม่อุ่น ครั้งที่สองอุ่นแน่
      for (var pass = 1; pass <= 2; pass++) {
        var startedAt = new Date().getTime();
        var payload = buildAttendanceDailyPayload_(probeDate, {
          source_info: sourceInfo,
          active_semester: semester,
          capture_timing_detail: true
        });
        result['attendance_pass' + pass + '_ms'] = new Date().getTime() - startedAt;
        result['attendance_pass' + pass + '_steps'] = String(payload && payload.__timing_detail || '(ไม่มี)');
        result['attendance_pass' + pass + '_students'] = payload && payload.students ? payload.students.length : 0;
      }

      // ★★ pass3 = "วันที่สอง" ซึ่งเป็นเคสเดียวที่วัดผลของการเลิก cache ผูกช่วงวันที่ได้
      // pass1/pass2 อยู่บนวันเดียวกัน ทั้งโค้ดเก่าและใหม่จึงอ่านปฏิทินหนึ่งครั้งแล้ว hit
      // เหมือนกันหมด → **วัดความต่างไม่ได้เลย** ความต่างโผล่ตอนเปลี่ยนวันที่
      // โค้ดเก่า: คีย์ `[date-35, date]` เปลี่ยนตามวันที่ = miss = อ่านชีตใหม่ (~800 ms)
      // โค้ดใหม่: คีย์ไม่ผูกช่วง = hit = เกือบ 0
      var secondDate = '';
      Object.keys(buckets).sort().forEach(function(date) {
        if (date !== probeDate && !secondDate && buckets[date] && buckets[date].length) secondDate = date;
      });
      result.second_date = secondDate || '(ไม่พบวันที่สอง)';
      if (secondDate) {
        var secondStartedAt = new Date().getTime();
        var secondPayload = buildAttendanceDailyPayload_(secondDate, {
          source_info: sourceInfo,
          active_semester: semester,
          capture_timing_detail: true
        });
        result.attendance_pass3_other_date_ms = new Date().getTime() - secondStartedAt;
        result.attendance_pass3_other_date_steps = String(secondPayload && secondPayload.__timing_detail || '(ไม่มี)');
      }

      // เทียบกับรายงานรายวันทั้งภาคเรียน สร้างสดไม่ผ่าน cache เพื่อไม่ให้ได้เวลาปลอม
      var range = clampRangeToActiveSemester_(normalizeDateRange_(semester.start_date, semester.end_date));
      if (isEffectiveRangeEmpty_(range)) {
        result.report_note = 'ช่วงภาคเรียนว่าง ข้ามการเทียบ';
      } else {
        var reportStartedAt = new Date().getTime();
        var grid = buildDailyGridData_(range);
        result.report_uncached_ms = new Date().getTime() - reportStartedAt;
        result.report_range = String(range.from || '') + ' - ' + String(range.to || '');
        result.report_days = grid && grid.dates ? grid.dates.length : 0;
        result.report_students = grid && grid.students ? grid.students.length : 0;
      }
      return result;
    }));

    // 1ง. ไฟล์สำรองมีชีตลิงก์ผู้ปกครองไหม และคอลัมน์ token ถูกล้างจริงไหม
    // ★ อ่านอย่างเดียว — `buildBackupSnapshot_` แค่อ่านชีต ไม่เขียนอะไร และไม่สร้างไฟล์บน Drive
    //   ตรวจทางนี้เพราะการกดปุ่มบนหน้าจอต้องพึ่ง pop-up ซึ่งถูกเบราว์เซอร์บล็อกได้
    // ★★ พิสูจน์ 2 อย่างพร้อมกัน — ดู DECISIONS.md ข้อ 37
    // 1) เส้นทางที่แยก cache แล้ว ได้ข้อมูล "ชุดเดียวกันและลำดับเดียวกัน" กับการสแกนตรงๆ
    // 2) cache ส่วน archive รอดจากการแตะสถานะ (จำลองด้วยการ bump derived_cache_version เอง)
    // ⚠️ check นี้ bump เวอร์ชันจริง = ล้าง derived cache ทั้งชุด คำขอถัดไปจะช้าลงชั่วคราว แต่ไม่แก้ข้อมูลใดๆ
    checks.push(runPreReleaseSmokeCheck_('perf:archive_cache_survives_mark', function() {
      var semester = getActiveSemesterRow_();
      assertPreReleaseSmoke_(!!semester, 'ยังไม่มีภาคเรียนที่ใช้งานอยู่');
      var sourceInfo = getAttendanceSourceInfoForSemester_(semester);

      function signature_(records) {
        return (records || []).map(function(r) {
          return String(r.sheet_name || '') + '#' + String(r.row_index || '') + '|' +
                 String(r.date || '') + '|' + String(r.student_number || '') + '|' +
                 String(r.student_id || '') + '|' + String(r.status_code || '') + '|' + String(r.note || '');
        }).join('~');
      }

      // ★★ การสแกนตรงคือตัวควบคุมที่แพงที่สุดในชุดนี้ — วัดได้ 136,459 ms เมื่อ Apps Script
      // ช้าทั้งกระดาน (19 ส.ค. 2569) ทำให้ทั้งรอบใช้ 344 วินาทีจากเพดาน 360
      // อีกนิดเดียวจะตายทั้งรอบและไม่ได้ผลอะไรเลยสักตัว จึงข้ามเมื่อรู้ตัวว่าช้าอยู่แล้ว
      var elapsedBeforeMs = new Date().getTime() - startedAt;
      var hasScanBudget = elapsedBeforeMs < P0_DIAGNOSTIC_CONTROL_SCAN_BUDGET_MS;

      var direct = null;
      var directMs = null;
      if (hasScanBudget) {
        var scanStarted = new Date().getTime();
        direct = readAllAttendanceRecords_(sourceInfo);
        directMs = new Date().getTime() - scanStarted;
      }

      var warmStarted = new Date().getTime();
      var viaSplit = getAllAttendanceRecords_(sourceInfo);
      var warmMs = new Date().getTime() - warmStarted;

      if (direct) {
        assertPreReleaseSmoke_(
          direct.length === viaSplit.length,
          'จำนวน record ไม่ตรง: สแกนตรง ' + direct.length + ' แต่เส้นทางแยก cache ' + viaSplit.length
        );
        assertPreReleaseSmoke_(
          signature_(direct) === signature_(viaSplit),
          'ข้อมูลหรือลำดับไม่ตรงกันระหว่างการสแกนตรงกับเส้นทางแยก cache'
        );
      }

      // จำลองสิ่งที่เกิดขึ้นจริงเมื่อครูแตะสถานะ 1 ครั้ง
      bumpDerivedDataCacheVersion_();
      var afterStarted = new Date().getTime();
      var afterBump = getAllAttendanceRecords_(sourceInfo);
      var afterMs = new Date().getTime() - afterStarted;

      // เทียบกับผลของ getAllAttendanceRecords_ ก่อน bump ได้เสมอ ไม่ต้องพึ่งการสแกนตรง
      assertPreReleaseSmoke_(
        signature_(afterBump) === signature_(viaSplit),
        'หลังจำลองการแตะสถานะ ข้อมูลไม่ตรงกับก่อนหน้า'
      );

      var archiveSheets = getArchiveAttendanceReadSheets_(sourceInfo);
      return {
        semester: String(semester.name || ''),
        source_key: String(sourceInfo.key || ''),
        archive_sheets: archiveSheets.map(function(sh) { return sh.getName() + ':' + sh.getLastRow(); }),
        records_total: viaSplit.length,
        elapsed_before_ms: elapsedBeforeMs,
        direct_scan_ms: directMs,
        direct_scan_skipped: !hasScanBudget,
        split_path_ms: warmMs,
        after_simulated_mark_ms: afterMs,
        // ★ ตัวเลขที่ต้องดู: after_simulated_mark_ms ควรต่ำกว่า direct_scan_ms มาก
        // ถ้าใกล้เคียงกัน แปลว่า cache ส่วน archive ไม่รอด ให้สงสัยว่ามีใคร bump เวอร์ชัน archive เกินจำเป็น
        archive_cache_survived: directMs === null ? null : (afterMs * 2 < directMs || directMs < 300),
        // ★ เทียบกับการสแกนตรงได้เฉพาะรอบที่มีเวลาพอ รอบที่ข้ามยังเทียบก่อน/หลัง bump ได้อยู่
        records_identical_vs_direct_scan: direct ? true : 'ข้ามรอบนี้เพราะแพลตฟอร์มช้า',
        records_stable_across_mark: true
      };
    }));

    // ★★ วัดว่าโมดูล client แต่ละตัวใหญ่แค่ไหน และ **เขียน cache ติดจริงไหม**
    // เทียบทางคีย์เดียวกับทางแบ่ง chunk ตามไบต์ ในรอบเดียว
    // ★ ผลรอบ 19 ส.ค. 2569: `single_key_cached` เป็น true ทั้ง 6 ตัว รวม JsReports ที่ 107,972 ไบต์
    //   → CacheService **ไม่บังคับเพดาน 100KB ตามที่เอกสารระบุ** ยังไม่รู้ว่าเพดานจริงอยู่ตรงไหน
    //   ให้ดู `broken_with_single_key` ทุกรอบ ถ้าวันหนึ่งมันไม่ว่าง แปลว่าชนเพดานจริงแล้ว
    // ⚠️ เขียนคีย์ทดสอบอายุ 60 วินาที แล้วลบทิ้ง ไม่แตะ cache ที่ระบบใช้จริง
    checks.push(runPreReleaseSmokeCheck_('cache:client_modules_fit', function() {
      var moduleNames = ['JsDashboard', 'JsReports', 'JsAnalytics', 'JsImport', 'JsProfile', 'JsPhotoGrid'];
      var cache = CacheService.getScriptCache();
      var rows = [];
      var brokenOnChunked = [];

      moduleNames.forEach(function(name) {
        var script = extractClientModuleScript_(name);
        var serialized = JSON.stringify(script);
        var bytes = utf8ByteLength_(serialized);

        // ทางเดิม: ยัดคีย์เดียว
        var singleKey = 'p0_probe_single|' + name;
        putCachedJsonByKey_(singleKey, script, 60);
        var singleBack = getCachedJsonByKey_(singleKey);
        var singleOk = singleBack !== null && String(singleBack) === script;

        // ทางใหม่: แบ่ง chunk ตามไบต์
        var chunkKey = 'p0_probe_chunk|' + name;
        putLargeCachedJsonByKey_(chunkKey, script, 60);
        var chunkBack = getLargeCachedJsonByKey_(chunkKey);
        var chunkOk = chunkBack !== null && String(chunkBack) === script;
        if (!chunkOk) brokenOnChunked.push(name);

        var chunkCount = splitStringByUtf8Bytes_(serialized, LARGE_CACHE_CHUNK_MAX_BYTES).length;

        rows.push({
          module: name,
          chars: script.length,
          stringify_bytes: bytes,
          over_100kb: bytes > 102400,
          chunks_needed: chunkCount,
          single_key_cached: singleOk,
          chunked_cached: chunkOk
        });

        try {
          cache.remove(singleKey);
          cache.remove(chunkKey + '|meta');
          for (var c = 0; c < chunkCount; c++) cache.remove(chunkKey + '|c' + c);
        } catch (eClean) {}
      });

      assertPreReleaseSmoke_(
        brokenOnChunked.length === 0,
        'แบ่ง chunk แล้วยังอ่านกลับไม่ได้: ' + brokenOnChunked.join(', ')
      );

      var brokenBefore = [];
      rows.forEach(function(r) { if (!r.single_key_cached) brokenBefore.push(r.module); });

      return {
        chunk_max_bytes: LARGE_CACHE_CHUNK_MAX_BYTES,
        // ★ รายชื่อนี้คือโมดูลที่ "ทางเดิมเขียนไม่ติด" = เปิดหน้านั้นทีไร server อ่านไฟล์ใหม่ทุกครั้ง
        broken_with_single_key: brokenBefore,
        all_ok_with_chunking: brokenOnChunked.length === 0,
        modules: rows
      };
    }));

    // ★ วัดว่าการ inline CSS ทั้ง 5 ไฟล์ตอน doGet กินเวลาฝั่ง server เท่าไร
    // ใช้ตัดสินว่าควรกลับไปทำ lazy CSS ไหม (`DECISIONS.md` ข้อ 27 ตั้งเงื่อนไขไว้ว่า
    // "ค่อยกลับมาทำเมื่อ CSS ใหญ่จนหน้าแรกช้าจนครูรู้สึกได้" ซึ่งไม่เคยมีใครวัด)
    // อ่านอย่างเดียว ไม่เขียนอะไรเลย
    checks.push(runPreReleaseSmokeCheck_('perf:inline_css_cost', function() {
      var names = ['Stylesheet', 'StyleReport', 'StylePhase3', 'StylePhase4', 'StylePin'];
      var rows = [];
      var totalMs = 0;
      var totalBytes = 0;

      names.forEach(function(name) {
        var startedAt = new Date().getTime();
        var content = include_(name);
        var ms = new Date().getTime() - startedAt;
        var bytes = utf8ByteLength_(content);
        totalMs += ms;
        totalBytes += bytes;
        rows.push({ file: name, ms: ms, bytes: bytes });
      });

      // เรียกซ้ำรอบสอง เผื่อ Apps Script มี cache ของตัวเองที่เรามองไม่เห็น
      var secondPassMs = 0;
      names.forEach(function(name) {
        var startedAt = new Date().getTime();
        include_(name);
        secondPassMs += new Date().getTime() - startedAt;
      });

      var shellStarted = new Date().getTime();
      var shellBytes = utf8ByteLength_(include_('Index')) + utf8ByteLength_(include_('JavaScript'));
      var shellMs = new Date().getTime() - shellStarted;

      return {
        css_total_ms: totalMs,
        css_total_ms_second_pass: secondPassMs,
        css_total_bytes: totalBytes,
        shell_ms: shellMs,
        shell_bytes: shellBytes,
        // ★ 3 ไฟล์ที่หน้าส่วนใหญ่ไม่ได้ใช้ — คือส่วนที่ lazy CSS จะประหยัดได้
        lazy_candidate_bytes: rows.reduce(function(sum, r) {
          return sum + ((r.file === 'StyleReport' || r.file === 'StylePhase4' || r.file === 'StylePin') ? r.bytes : 0);
        }, 0),
        files: rows
      };
    }));

    // ★★ จับกรณีชื่อนักเรียนถูก Sheets ตีความเป็นสูตรจนกลายเป็น #ERROR!
    // เกิดขึ้นจริงกับเลขที่ 28 (ชื่อขึ้นต้นด้วย =) เพราะ SeedTestData กันด้วย setNumberFormat('@')
    // ซึ่ง SecurityService บันทึกไว้เองว่ากันไม่อยู่ · แก้ให้ใช้ sanitizeSheetRows_ แล้ว
    // เช็คนี้ไว้กันไม่ให้พังซ้ำแบบเงียบๆ — ชื่อหายไปทั้งชื่อทั้งในระบบและบนเอกสาร ปพ.6
    checks.push(runPreReleaseSmokeCheck_('sheet_text:stored_names_intact', function() {
      var sheet = getSheet_(SHEET.STUDENTS);
      var lastRow = sheet.getLastRow();
      if (lastRow <= 1) return { rows: 0, note: 'ยังไม่มีนักเรียน' };

      var values = sheet.getRange(2, COL.STUDENTS.STUDENT_NUMBER, lastRow - 1, 2).getValues();
      var broken = [];
      var startsWithFormulaChar = [];
      values.forEach(function(row) {
        var num = row[0];
        var name = String(row[1] == null ? '' : row[1]);
        if (/^#[A-Z_]+[!?]?$/.test(name.trim())) {
          broken.push({ student_number: num, stored: name });
        } else if (/^[=+\-@]/.test(name)) {
          // ★ ไม่ใช่ความผิดพลาด — sanitizeSheetText_ กลืน ' ตอนอ่านกลับ ค่านี้จึงถูกต้อง
          startsWithFormulaChar.push({ student_number: num });
        }
      });

      assertPreReleaseSmoke_(
        broken.length === 0,
        'ชื่อนักเรียนกลายเป็นค่าสูตรผิดพลาด ' + broken.length + ' คน: ' +
          broken.map(function(b) { return 'เลขที่ ' + b.student_number + ' = ' + b.stored; }).join(', ')
      );

      return {
        rows: values.length,
        broken_names: broken,
        // ถ้าชุดข้อมูลตั้งใจมีชื่อขึ้นต้นด้วย = ต้องเห็นตัวเลขนี้ > 0 ไม่งั้นแปลว่าเคสทดสอบหายไป
        names_starting_with_formula_char: startsWithFormulaChar.length
      };
    }));

    checks.push(runPreReleaseSmokeCheck_('backup:includes_parent_links', function() {
      var snapshot = buildBackupSnapshot_();
      var sheets = (snapshot && snapshot.sheets) || {};
      var parentLinks = sheets.parent_links || null;
      var rows = (parentLinks && parentLinks.rows) || [];
      var tokenIndex = PARENT_LINK_COL.TOKEN - 1;

      var rowsWithToken = 0;
      rows.forEach(function(row) {
        if (row.length > tokenIndex && String(row[tokenIndex] || '').trim()) rowsWithToken++;
      });

      var result = {
        backup_version: parseInt(snapshot && snapshot.version, 10) || 0,
        sheet_keys: Object.keys(sheets).sort(),
        has_parent_links_key: !!parentLinks,
        parent_link_rows: rows.length,
        parent_link_headers: (parentLinks && parentLinks.headers) || [],
        rows_with_plaintext_token: rowsWithToken
      };

      assertPreReleaseSmoke_(!!parentLinks, 'ไฟล์สำรองไม่มีส่วน parent_links');
      assertPreReleaseSmoke_(
        (parseInt(snapshot && snapshot.version, 10) || 0) >= 4,
        'BACKUP_VERSION ควรเป็น 4 ขึ้นไปเมื่อมีลิงก์ผู้ปกครองในไฟล์'
      );
      // ★ ข้อนี้สำคัญกว่าจำนวนแถว — token ที่หลุดไปในไฟล์ = กุญแจเปิดข้อมูลนักเรียน
      assertPreReleaseSmoke_(
        rowsWithToken === 0,
        'มี token แบบอ่านได้หลงเหลือใน backup ' + rowsWithToken + ' แถว'
      );
      return result;
    }));

    // 1จ. สรุป `_timing_log` — ข้อมูลความช้าจากการใช้งานจริงที่สะสมไว้แล้ว
    // ★ อ่านอย่างเดียว · โปรเจกต์เขียน log นี้มาตลอดผ่าน `measureTiming_` แต่**ไม่มีใครอ่านออกมาดู**
    //   เพราะไม่มีฟังก์ชันอ่าน ต้องไปเปิดชีตซ่อนเอง — เป็นข้อมูลที่ดีที่สุดที่มี
    //   เพราะมาจากครูใช้งานจริง ไม่ใช่การจำลองใน Diagnostics
    // ★ บันทึกเฉพาะที่เกิน threshold (ดู `TIMING_LOG_THRESHOLDS_MS` [Utils.js])
    //   จึงเป็นรายการ "ครั้งที่ช้า" ไม่ใช่ค่าเฉลี่ยของทุกครั้ง **อย่าตีความว่าเป็นค่ากลาง**
    checks.push(runPreReleaseSmokeCheck_('perf:timing_log_summary', function() {
      var sheet = getSheetByNameOrNull_(TIMING_LOG_SHEET);
      if (!sheet) return { note: 'ยังไม่มีชีต ' + TIMING_LOG_SHEET + ' (ยังไม่เคยมีครั้งไหนช้าเกินเกณฑ์)' };

      var lastRow = sheet.getLastRow();
      if (lastRow <= 1) return { note: 'ชีตว่าง ยังไม่เคยมีครั้งไหนช้าเกินเกณฑ์' };

      var values = sheet.getRange(2, 1, lastRow - 1, 13).getValues();
      var byMetric = {};
      for (var i = 0; i < values.length; i++) {
        var metric = String(values[i][1] || '(ไม่ระบุ)');
        var duration = parseInt(values[i][2], 10) || 0;
        var status = String(values[i][3] || '');
        if (!byMetric[metric]) byMetric[metric] = { count: 0, errors: 0, durations: [] };
        byMetric[metric].count++;
        if (status === 'error') byMetric[metric].errors++;
        else byMetric[metric].durations.push(duration);
      }

      var summary = Object.keys(byMetric).sort().map(function(metric) {
        var bucket = byMetric[metric];
        var sorted = bucket.durations.slice().sort(function(a, b) { return a - b; });
        return {
          metric: metric,
          threshold_ms: getTimingThresholdMs_(metric),
          slow_count: sorted.length,
          error_count: bucket.errors,
          median_ms: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
          max_ms: sorted.length ? sorted[sorted.length - 1] : 0
        };
      });

      // 10 แถวล่าสุด เอาไว้ดูว่าอะไรช้าล่าสุดและช้าตอนทำอะไร
      var recent = values.slice(Math.max(0, values.length - 10)).map(function(row) {
        return {
          at: String(row[0] || ''),
          metric: String(row[1] || ''),
          ms: parseInt(row[2], 10) || 0,
          status: String(row[3] || ''),
          fn: String(row[5] || ''),
          detail: String(row[12] || '').slice(0, 160)
        };
      }).reverse();

      return { total_rows: values.length, by_metric: summary, recent_10: recent };
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

    // 2.2 ลบ "ทุกแถวข้อมูล" บนชีตที่ตรึงหัวตาราง — เส้นทางเดียวกับที่ archive ภาคเรียน
    //     จะเดินเมื่อข้อมูลในชีตเป็นของภาคเรียนนั้นทั้งหมด (ครูปีแรกที่มีภาคเรียนเดียว)
    //     ถ้าเช็คนี้แดง แปลว่า archiveSemesterAttendance จะพังในเคสนั้นจริง
    checks.push(runPreReleaseSmokeCheck_('delete_rows:all_data_rows_frozen_header', function() {
      var ss = getSpreadsheet_();
      var stale = ss.getSheetByName(P0_DIAG_TEMP_SHEET_);
      if (stale) ss.deleteSheet(stale);

      var sheet = ss.insertSheet(P0_DIAG_TEMP_SHEET_);
      try {
        sheet.setFrozenRows(1); // เหมือนทุกชีตจริงในระบบนี้
        sheet.getRange(1, 1, 4, 1).setValues([['header'], ['row2'], ['row3'], ['row4']]);

        // ★ ต้องหั่นแถวว่างท้ายชีตทิ้งให้ getMaxRows() เท่ากับ getLastRow() ก่อน
        // ไม่งั้นเช็คนี้เขียวหลอก — insertSheet ให้แถวว่างมา 1,000 แถวเสมอ พอลบ 3 แถว
        // ก็ยังเหลือแถวไม่ถูกตรึงอีกเกือบพัน Sheets จึงไม่บ่น
        // ส่วนชีตจริงอย่าง "เช็คชื่อ" โตมาจากการเขียนต่อท้ายพอดีเป๊ะ ไม่มีแถวว่างเหลือ
        var maxRows = sheet.getMaxRows();
        if (maxRows > 4) sheet.deleteRows(5, maxRows - 4);

        var threwMessage = '';
        var deleted = 0;
        try {
          deleted = deleteSheetRowsByIndexes_(sheet, [2, 3, 4]); // ทุกแถวข้อมูล
        } catch (eDelete) {
          threwMessage = String(eDelete && eDelete.message ? eDelete.message : eDelete);
        }

        assertPreReleaseSmoke_(
          !threwMessage,
          'ลบทุกแถวข้อมูลบนชีตที่ตรึงหัวตารางและไม่มีแถวว่างเหลือ ไม่ผ่าน — ' +
          'archive ภาคเรียนจะพังในเคสที่ข้อมูลทั้งชีตเป็นของภาคเรียนเดียว · ' +
          'ข้อความจาก Sheets: ' + threwMessage
        );
        assertPreReleaseSmoke_(deleted === 3, 'ควรลบ 3 แถว แต่ได้ ' + deleted);
        assertPreReleaseSmoke_(
          sheet.getLastRow() <= 1,
          'ลบแล้วแต่ยังเหลือข้อมูลอยู่ getLastRow=' + sheet.getLastRow()
        );
        return {
          deleted: deleted,
          last_row_after: sheet.getLastRow(),
          max_rows_before_delete: 4
        };
      } finally {
        var temp = ss.getSheetByName(P0_DIAG_TEMP_SHEET_);
        if (temp) ss.deleteSheet(temp);
      }
    }));

    // 2.5 กันสูตร: พิสูจน์บนชีตจริงว่า sanitizeSheetText_ ทำให้ค่ากลับมาครบ ไม่เป็น #ERROR!
    checks.push(runPreReleaseSmokeCheck_('sheet_text:formula_injection', function() {
      var ss = getSpreadsheet_();
      var stale = ss.getSheetByName(P0_DIAG_TEMP_SHEET_);
      if (stale) ss.deleteSheet(stale);

      var sheet = ss.insertSheet(P0_DIAG_TEMP_SHEET_);
      try {
        // ค่าที่ Sheets จะตีความเป็นสูตรถ้าเขียนดิบๆ + ค่าปกติที่ต้องไม่ถูกแตะ
        var samples = [
          '=1+1',
          '=ด.ช.สมชาย ใจดี',
          '+66812345678',
          '-5 วัน',
          '@บ้าน',
          'ด.ญ.ณิชาภัทร แก้วใส',
          'ปุ๊กกี้'
        ];

        var raw = samples.map(function(text) { return [text]; });
        sheet.getRange(1, 1, raw.length, 1).setValues(raw);

        var guarded = samples.map(function(text) { return [sanitizeSheetText_(text)]; });
        sheet.getRange(1, 2, guarded.length, 1).setValues(guarded);

        var rawDisplay = sheet.getRange(1, 1, samples.length, 1).getDisplayValues();
        var guardedDisplay = sheet.getRange(1, 2, samples.length, 1).getDisplayValues();
        var guardedValues = sheet.getRange(1, 2, samples.length, 1).getValues();

        var broken = [];
        var stillWrong = [];
        for (var i = 0; i < samples.length; i++) {
          if (String(rawDisplay[i][0]) !== samples[i]) {
            broken.push(samples[i] + ' → ' + rawDisplay[i][0]);
          }
          if (String(guardedDisplay[i][0]) !== samples[i] || String(guardedValues[i][0]) !== samples[i]) {
            stillWrong.push(
              samples[i] + ' → แสดง: ' + guardedDisplay[i][0] + ' | อ่านกลับ: ' + guardedValues[i][0]
            );
          }
        }

        // ต้องยังพังอยู่ตอนเขียนดิบ ไม่งั้นแปลว่าเทสต์นี้ไม่ได้ทดสอบอะไรเลย
        assertPreReleaseSmoke_(
          broken.length > 0,
          'เขียนดิบแล้วไม่พังเลย แปลว่าเทสต์นี้พิสูจน์อะไรไม่ได้ — ตรวจสมมติฐานใหม่'
        );
        assertPreReleaseSmoke_(
          stillWrong.length === 0,
          'sanitizeSheetText_ ยังกันไม่อยู่: ' + stillWrong.join(' ; ')
        );

        return { broken_when_raw: broken, guarded_ok: samples.length };
      } finally {
        var temp = ss.getSheetByName(P0_DIAG_TEMP_SHEET_);
        if (temp) ss.deleteSheet(temp);
      }
    }));

    // 2.6 เวลา: เขียนเป็นข้อความแล้ว Sheets แปลงเป็น Date — อ่านกลับต้องได้รูปแบบเดิม
    checks.push(runPreReleaseSmokeCheck_('timestamp:round_trip', function() {
      var ss = getSpreadsheet_();
      var stale = ss.getSheetByName(P0_DIAG_TEMP_SHEET_);
      if (stale) ss.deleteSheet(stale);

      var sheet = ss.insertSheet(P0_DIAG_TEMP_SHEET_);
      try {
        var written = nowString_();
        sheet.getRange(1, 1).setValue(written);

        var readBack = sheet.getRange(1, 1).getValue();
        var viaString = String(readBack);
        var normalized = normalizeTimestampValue_(readBack);

        assertPreReleaseSmoke_(
          /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(normalized),
          'normalizeTimestampValue_ ให้รูปแบบผิด: ' + normalized
        );
        assertPreReleaseSmoke_(
          normalized === written,
          'อ่านกลับไม่ตรงกับที่เขียน — เขียน: ' + written + ' | ได้: ' + normalized
        );

        return {
          written: written,
          raw_string: viaString,
          normalized: normalized,
          sheets_converted_to_date: viaString !== written
        };
      } finally {
        var temp = ss.getSheetByName(P0_DIAG_TEMP_SHEET_);
        if (temp) ss.deleteSheet(temp);
      }
    }));

    // 2.7 กติกากันแก้ปฏิทินย้อนหลัง — ต้องกันเฉพาะทิศที่ทำให้ข้อมูลหลุดออกจากรายงาน
    checks.push(runPreReleaseSmokeCheck_('calendar:guard_direction', function() {
      var sourceInfo = getCurrentAttendanceSourceInfo_();
      var confirmedMap = getConfirmedAttendanceDateMap_(sourceInfo) || {};
      var confirmedDates = Object.keys(confirmedMap).sort();
      assertPreReleaseSmoke_(
        confirmedDates.length > 0,
        'ไม่มีวันที่ยืนยันแล้วเลย ทดสอบกติกานี้ไม่ได้'
      );

      // ใช้วันจริงที่ยืนยันข้อมูลไปแล้ว เพื่อให้เงื่อนไข conflict เป็นจริงแน่ๆ
      var date = confirmedDates[confirmedDates.length - 1];
      var asSchoolDay = { type: 'school_day' };
      var asHoliday = { type: 'holiday' };

      var cases = [
        { name: 'ยังไม่มีในปฏิทิน → ตั้งเป็นวันหยุด', existing: null, type: 'holiday', want_block: true },
        { name: 'ยังไม่มีในปฏิทิน → เพิ่มเป็นวันเรียน', existing: null, type: 'school_day', want_block: false },
        { name: 'เป็นวันเรียนอยู่ → เปลี่ยนเป็นวันหยุด', existing: asSchoolDay, type: 'holiday', want_block: true },
        { name: 'เป็นวันหยุดอยู่ → เปลี่ยนเป็นวันเรียน', existing: asHoliday, type: 'school_day', want_block: false },
        { name: 'เป็นวันเรียนอยู่ → บันทึกซ้ำเป็นวันเรียน', existing: asSchoolDay, type: 'school_day', want_block: false },
        { name: 'เป็นวันหยุดอยู่ → บันทึกซ้ำเป็นวันหยุด', existing: asHoliday, type: 'holiday', want_block: false }
      ];

      var wrong = [];
      cases.forEach(function(testCase) {
        var blocked = shouldBlockSchoolCalendarChange_(testCase.existing, testCase.type, date, sourceInfo);
        if (blocked !== testCase.want_block) {
          wrong.push(testCase.name + ' → ได้ ' + (blocked ? 'กัน' : 'ผ่าน') + ' แต่ควร ' + (testCase.want_block ? 'กัน' : 'ผ่าน'));
        }
      });

      assertPreReleaseSmoke_(wrong.length === 0, 'กติกากันปฏิทินผิดทิศ: ' + wrong.join(' ; '));
      return { tested_date: date, cases_checked: cases.length };
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


/**
 * รายงานชนิดของค่าในคอลัมน์วันที่ของทุกชีตที่มีวันที่ (อ่านอย่างเดียว)
 * ★ ชีตหลักเก็บเป็นข้อความ ชีต archive เก็บเป็น Date object — ต่างกันจริง ทดสอบแล้ว
 *   ตัวเลือกอ่านที่ปลอดภัยคือ formatDate_ ซึ่งรับทั้งสองแบบ ไม่ใช่ createTextFinder
 */
function describeDateCellTypes_() {
  var targets = [
    { sheet: SHEET.ATTENDANCE, column: COL.ATTENDANCE.DATE },
    { sheet: SHEET.ATTENDANCE_DAYS, column: 1 },
    { sheet: SCHOOL_CALENDAR_SHEET, column: SCHOOL_CALENDAR_COL.DATE },
    { sheet: SEMESTER_SHEET, column: SEMESTER_COL.START }
  ];

  var ss = getSpreadsheet_();
  ss.getSheets().forEach(function(sheet) {
    var name = String(sheet.getName() || '');
    if (name.indexOf(ATTENDANCE_ARCHIVE_SHEET_PREFIX) === 0) {
      targets.push({ sheet: name, column: COL.ATTENDANCE.DATE });
    } else if (name.indexOf(ATTENDANCE_DAY_ARCHIVE_SHEET_PREFIX) === 0) {
      targets.push({ sheet: name, column: 1 });
    }
  });

  return targets.map(function(target) {
    var out = { sheet: target.sheet, rows: 0, type: '(ไม่มีชีต)', raw: '', via_format_date: '' };
    var sheet = getSheetByNameOrNull_(target.sheet);
    if (!sheet) return out;
    var lastRow = sheet.getLastRow();
    out.rows = Math.max(0, lastRow - 1);
    if (lastRow <= 1) {
      out.type = '(ไม่มีข้อมูล)';
      return out;
    }
    var value = sheet.getRange(2, target.column).getValue();
    out.type = Object.prototype.toString.call(value) === '[object Date]' ? 'Date' : (typeof value);
    out.raw = String(value);
    out.via_format_date = formatDate_(value);
    return out;
  });
}
