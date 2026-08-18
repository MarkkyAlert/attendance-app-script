/**
 * Utils.gs - Thai Date, Helpers, System Setup
 */

// Thai Date Formatting

var THAI_MONTHS_SHORT = [
  '', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'
];

var THAI_MONTHS_LONG = [
  '', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
];

var THAI_WEEKDAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
var APP_TIMEZONE = 'Asia/Bangkok';
var DERIVED_CACHE_VERSION_PROP = 'derived_cache_version';
// ★★ เวอร์ชันแยกสำหรับ "ข้อมูลที่เก็บถาวรแล้ว" ซึ่งไม่เปลี่ยนเมื่อครูเช็คชื่อ — ดู DECISIONS.md ข้อ 37
// จงใจไม่ผูกกับ derived_cache_version เพื่อให้การแตะสถานะ 1 ครั้ง ไม่ทิ้งผลสแกนชีต archive
var ATTENDANCE_ARCHIVE_VERSION_PROP = 'attendance_archive_version';
// ชีต archive ไม่เปลี่ยนระหว่างวัน จึงเก็บได้ยาวเท่าที่ CacheService ยอม (เพดาน 6 ชั่วโมง)
var ATTENDANCE_ARCHIVE_CACHE_TTL_SEC = 21600;
var LARGE_CACHE_CHUNK_SIZE = 80000;
var TIMING_LOG_SHEET = '_timing_log';
var TIMING_LOG_MAX_ROWS = 1000;
var TIMING_LOG_THRESHOLDS_MS = {
  attendance_load_ms: 1500,
  attendance_scan_ms: 2000,
  dashboard_build_ms: 2000,
  derived_cache_warm_ms: 1500,
  report_build_ms: 2500,
  analytics_build_ms: 3000,
  print_build_ms: 2500
};

function bytesToHex_(bytes) {
  return (bytes || []).map(function(b) {
    var value = b;
    if (value < 0) value += 256;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}

// ★ ถูกเรียกทุกครั้งที่สร้างคีย์ cache — หน้าเช็คชื่อ 1 ครั้งสร้าง ~10-15 คีย์
// ก่อนมี memo จึงจ่ายค่าอ่าน ScriptProperties ซ้ำ 10-15 รอบต่อคำขอ ปนอยู่ในทุกตัวเลขที่วัดได้
// ★ ยอมรับได้ที่ execution นี้จะไม่เห็น bump จาก execution อื่นที่เกิดระหว่างทาง
// เพราะ cache ปลายทางมีอายุ 180-300 วินาทีอยู่แล้ว และ mutation ทุกตัวผ่าน withAttendanceMutationLock_
var DERIVED_CACHE_VERSION_MEMO_ = '';

function getDerivedDataCacheVersion_() {
  if (DERIVED_CACHE_VERSION_MEMO_) return DERIVED_CACHE_VERSION_MEMO_;
  var props = PropertiesService.getScriptProperties();
  var version = String(props.getProperty(DERIVED_CACHE_VERSION_PROP) || '').trim();
  if (!version) {
    version = String(Date.now());
    props.setProperty(DERIVED_CACHE_VERSION_PROP, version);
  }
  DERIVED_CACHE_VERSION_MEMO_ = version;
  return version;
}

// ★ bump เฉพาะตอนที่ชีต archive เปลี่ยนจริง — เก็บถาวร / ยกเลิกเก็บถาวร / ลบภาคเรียน / restore backup / seed
// ทุกเส้นทางเหล่านั้นผ่าน invalidateSemesterCaches_ [SemesterService.js] ซึ่งเรียกตัวนี้ให้แล้ว
var ATTENDANCE_ARCHIVE_VERSION_MEMO_ = '';

function getAttendanceArchiveDataVersion_() {
  if (ATTENDANCE_ARCHIVE_VERSION_MEMO_) return ATTENDANCE_ARCHIVE_VERSION_MEMO_;
  var version = '';
  try {
    var props = PropertiesService.getScriptProperties();
    version = String(props.getProperty(ATTENDANCE_ARCHIVE_VERSION_PROP) || '').trim();
    if (!version) {
      version = String(Date.now());
      props.setProperty(ATTENDANCE_ARCHIVE_VERSION_PROP, version);
    }
  } catch (e) {
    version = 'na';
  }
  ATTENDANCE_ARCHIVE_VERSION_MEMO_ = version;
  return version;
}

function bumpAttendanceArchiveDataVersion_() {
  var version = String(Date.now());
  try {
    PropertiesService.getScriptProperties().setProperty(ATTENDANCE_ARCHIVE_VERSION_PROP, version);
  } catch (e) {}
  ATTENDANCE_ARCHIVE_VERSION_MEMO_ = version;
  return version;
}

// ★ ตั้งใจไม่เรียก buildDerivedCacheKey_ เพราะตัวนั้นฝัง derived_cache_version
// ซึ่งเปลี่ยนทุกครั้งที่ครูแตะสถานะ = สิ่งที่ทั้งหมดนี้พยายามหนี
function buildAttendanceArchiveCacheKey_(prefix, parts) {
  var serialized = JSON.stringify(parts || []);
  var hash = bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, serialized));
  return String(prefix || 'cache') + '|arch' + getAttendanceArchiveDataVersion_() + '|' + hash;
}

function bumpDerivedDataCacheVersion_() {
  var version = String(Date.now());
  try {
    PropertiesService.getScriptProperties().setProperty(DERIVED_CACHE_VERSION_PROP, version);
  } catch (e) {}
  DERIVED_CACHE_VERSION_MEMO_ = version;
  // ★ memo ที่ผูกกับสถานะข้อมูล ต้องล้างพร้อมกันที่จุดเดียวนี้ ซึ่งทุก mutation ผ่านอยู่แล้ว
  // ไม่งั้น execution ที่ทั้งเขียนและอ่าน จะอ่านต่อด้วยของเก่า
  try {
    if (typeof CACHED_ATTENDANCE_SOURCE_INFO_MEMO_ !== 'undefined') CACHED_ATTENDANCE_SOURCE_INFO_MEMO_ = null;
  } catch (e) {}
  return version;
}

function buildDerivedCacheKey_(prefix, parts) {
  var serialized = JSON.stringify(parts || []);
  var hash = bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, serialized));
  return String(prefix || 'cache') + '|' + getDerivedDataCacheVersion_() + '|' + hash;
}

function getCachedJsonByKey_(key) {
  var cached = '';
  try {
    cached = CacheService.getScriptCache().get(String(key || ''));
  } catch (e) {
    return null;
  }
  if (!cached) return null;
  try {
    return JSON.parse(cached);
  } catch (e2) {
    return null;
  }
}

function putCachedJsonByKey_(key, value, ttlSec) {
  try {
    CacheService.getScriptCache().put(String(key || ''), JSON.stringify(value), ttlSec || 300);
  } catch (e) {}
  return value;
}

function getOrBuildCachedJson_(prefix, parts, ttlSec, builder) {
  var key = buildDerivedCacheKey_(prefix, parts);
  var cached = getCachedJsonByKey_(key);
  if (cached !== null) return cached;
  var value = builder();
  putCachedJsonByKey_(key, value, ttlSec || 300);
  return value;
}

function getLargeCachedJsonByKey_(key) {
  key = String(key || '');
  if (!key) return null;
  var cache = CacheService.getScriptCache();
  var metaRaw = '';
  try {
    metaRaw = cache.get(key + '|meta') || '';
  } catch (e) {
    return null;
  }
  if (!metaRaw) return null;

  var meta = null;
  try {
    meta = JSON.parse(metaRaw);
  } catch (e2) {
    return null;
  }
  var chunkCount = parseInt(meta && meta.chunks, 10) || 0;
  if (chunkCount <= 0) return null;

  var chunkKeys = [];
  for (var i = 0; i < chunkCount; i++) {
    chunkKeys.push(key + '|c' + i);
  }

  var chunks = {};
  try {
    chunks = cache.getAll(chunkKeys) || {};
  } catch (e3) {
    return null;
  }

  var parts = [];
  for (var j = 0; j < chunkKeys.length; j++) {
    if (!chunks[chunkKeys[j]]) return null;
    parts.push(chunks[chunkKeys[j]]);
  }

  try {
    return JSON.parse(parts.join(''));
  } catch (e4) {
    return null;
  }
}

function putLargeCachedJsonByKey_(key, value, ttlSec) {
  key = String(key || '');
  if (!key) return value;

  var serialized = '';
  try {
    serialized = JSON.stringify(value);
  } catch (e) {
    return value;
  }
  if (!serialized) return value;

  var chunkCount = Math.max(1, Math.ceil(serialized.length / LARGE_CACHE_CHUNK_SIZE));
  var payload = {};
  for (var i = 0; i < chunkCount; i++) {
    payload[key + '|c' + i] = serialized.slice(i * LARGE_CACHE_CHUNK_SIZE, (i + 1) * LARGE_CACHE_CHUNK_SIZE);
  }
  payload[key + '|meta'] = JSON.stringify({ chunks: chunkCount });

  try {
    CacheService.getScriptCache().putAll(payload, ttlSec || 300);
  } catch (e2) {}
  return value;
}

function getOrBuildLargeCachedJson_(prefix, parts, ttlSec, builder) {
  var key = buildDerivedCacheKey_(prefix, parts);
  var cached = getLargeCachedJsonByKey_(key);
  if (cached !== null) return cached;
  var value = builder();
  putLargeCachedJsonByKey_(key, value, ttlSec || 300);
  return value;
}

function getTimingThresholdMs_(metric) {
  return parseInt((TIMING_LOG_THRESHOLDS_MS || {})[String(metric || '')], 10) || 0;
}

function shouldWriteTimingLog_(metric, durationMs, status) {
  if (String(status || '') === 'error') return true;
  var threshold = getTimingThresholdMs_(metric);
  if (!(threshold > 0)) return false;
  return (parseInt(durationMs, 10) || 0) >= threshold;
}

function getOrCreateTimingLogSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(TIMING_LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(TIMING_LOG_SHEET);
    sheet.getRange(1, 1, 1, 13).setValues([[
      'timestamp',
      'metric',
      'duration_ms',
      'status',
      'page',
      'function',
      'date',
      'range_from',
      'range_to',
      'month',
      'semester_id',
      'semester_name',
      'detail'
    ]]);
    sheet.getRange(1, 1, 1, 13).setFontWeight('bold').setBackground('#f5f0eb');
    sheet.setFrozenRows(1);
    sheet.hideSheet();
    sheet.setColumnWidth(1, 160);
    sheet.setColumnWidth(2, 160);
    sheet.setColumnWidth(3, 100);
    sheet.setColumnWidth(4, 90);
    sheet.setColumnWidth(5, 110);
    sheet.setColumnWidth(6, 180);
    sheet.setColumnWidth(7, 110);
    sheet.setColumnWidth(8, 110);
    sheet.setColumnWidth(9, 110);
    sheet.setColumnWidth(10, 90);
    sheet.setColumnWidth(11, 90);
    sheet.setColumnWidth(12, 140);
    sheet.setColumnWidth(13, 360);
  }
  return sheet;
}

function trimTimingLogSheet_(sheet) {
  sheet = sheet || getOrCreateTimingLogSheet_();
  var lastRow = sheet.getLastRow();
  var overflow = lastRow - (TIMING_LOG_MAX_ROWS + 1);
  if (overflow > 0) {
    sheet.deleteRows(2, overflow);
  }
}

function appendTimingLog_(entry) {
  entry = entry || {};
  var sheet = getOrCreateTimingLogSheet_();
  var row = [[
    nowString_(),
    String(entry.metric || ''),
    parseInt(entry.duration_ms, 10) || 0,
    String(entry.status || ''),
    String(entry.page || ''),
    String(entry.fn_name || ''),
    String(entry.date || ''),
    String(entry.range_from || ''),
    String(entry.range_to || ''),
    String(entry.month || ''),
    String(entry.semester_id || ''),
    String(entry.semester_name || ''),
    String(entry.detail || '')
  ]];
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, row[0].length).setValues(row);
  trimTimingLogSheet_(sheet);
}

function measureTiming_(metric, meta, fn) {
  var startedAt = new Date().getTime();
  meta = meta || {};
  try {
    var result = fn();
    var durationMs = new Date().getTime() - startedAt;
    if (shouldWriteTimingLog_(metric, durationMs, 'slow')) {
      try {
        appendTimingLog_({
          metric: metric,
          duration_ms: durationMs,
          status: 'slow',
          page: meta.page || '',
          fn_name: meta.fn_name || '',
          date: meta.date || '',
          range_from: meta.range_from || '',
          range_to: meta.range_to || '',
          month: meta.month || '',
          semester_id: meta.semester_id || '',
          semester_name: meta.semester_name || '',
          detail: meta.detail || ''
        });
      } catch (eLog) {}
    }
    return result;
  } catch (e) {
    var errorDurationMs = new Date().getTime() - startedAt;
    try {
      appendTimingLog_({
        metric: metric,
        duration_ms: errorDurationMs,
        status: 'error',
        page: meta.page || '',
        fn_name: meta.fn_name || '',
        date: meta.date || '',
        range_from: meta.range_from || '',
        range_to: meta.range_to || '',
        month: meta.month || '',
        semester_id: meta.semester_id || '',
        semester_name: meta.semester_name || '',
        detail: String((meta.detail ? meta.detail + ' | ' : '') + (e && e.message ? e.message : e))
      });
    } catch (eLog2) {}
    throw e;
  }
}

/**
 * Format date to Thai format
 * @param {string} dateStr - yyyy-MM-dd
 * @param {string} format - 'short' or 'long'
 * @param {boolean} withWeekday
 * @returns {string}
 */
function thaiDate(dateStr, format, withWeekday) {
  if (!dateStr) return '';
  format = format || 'short';
  withWeekday = withWeekday || false;

  var parts = String(dateStr).split('-');
  if (parts.length !== 3) return dateStr;

  var year = parseInt(parts[0], 10);
  var month = parseInt(parts[1], 10);
  var day = parseInt(parts[2], 10);
  var buddhistYear = year + 543;

  var monthName = format === 'long' ? THAI_MONTHS_LONG[month] : THAI_MONTHS_SHORT[month];
  var result = day + ' ' + monthName + ' ' + buddhistYear;

  if (withWeekday) {
    var weekday = THAI_WEEKDAYS[getIsoWeekday_(matchDatePartsToIso_(year, month, day))];
    result = weekday + ' ' + result;
  }

  return result;
}

/**
 * Format month to Thai (e.g., "มีนาคม 2569")
 */
function thaiMonthLabel(monthStr) {
  if (!monthStr) return '';
  var parts = String(monthStr).split('-');
  if (parts.length < 2) return monthStr;

  var year = parseInt(parts[0], 10) + 543;
  var month = parseInt(parts[1], 10);
  return THAI_MONTHS_LONG[month] + ' ' + year;
}

// Date Helpers

function todayString_() {
  return Utilities.formatDate(new Date(), APP_TIMEZONE, 'yyyy-MM-dd');
}

function formatDate_(date) {
  if (!date) return '';
  // Try to use Utilities if it's a valid Date
  if (Object.prototype.toString.call(date) === '[object Date]' && !isNaN(date)) {
    return Utilities.formatDate(date, APP_TIMEZONE, 'yyyy-MM-dd');
  }
  return String(date).slice(0, 10);
}

function nowString_() {
  return Utilities.formatDate(new Date(), APP_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
}

/**
 * อ่านค่าคอลัมน์เวลากลับมาให้เป็นรูปแบบเดียวเสมอ
 *
 * เราเขียนเวลาลงชีตเป็นข้อความ 'yyyy-MM-dd HH:mm:ss' แต่ Sheets แปลงเป็น Date object
 * ให้เอง พออ่านกลับด้วย String() จึงได้ค่า default ของ JS ทั้งดุ้น เช่น
 * 'Sat Aug 15 2026 13:03:59 GMT+0700 (Indochina Time)' ซึ่งขึ้นไปโชว์บนหน้าจอครู
 *
 * นอกจากทำให้อ่านรู้เรื่องแล้ว ยังทำให้เรียงลำดับแบบข้อความได้ถูกต้อง
 * เพราะที่ผ่านมาแถวที่เป็น Date กับแถวที่เป็นข้อความปนกันแล้วเทียบกันไม่ได้
 */
function normalizeTimestampValue_(value) {
  if (value == null || value === '') return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, APP_TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  }
  return String(value);
}

function matchDatePartsToIso_(year, month, day) {
  return String(year) + '-' + ('0' + parseInt(month, 10)).slice(-2) + '-' + ('0' + parseInt(day, 10)).slice(-2);
}

function createDateFromParts_(year, month, day) {
  return new Date(Date.UTC(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10), 5, 0, 0));
}

function getBangkokDateParts_(date) {
  var iso = Utilities.formatDate(date, APP_TIMEZONE, 'yyyy-MM-dd');
  var parts = String(iso || '').split('-');
  return {
    year: parseInt(parts[0], 10) || 0,
    month: parseInt(parts[1], 10) || 0,
    day: parseInt(parts[2], 10) || 0
  };
}

function getMonthLastDay_(year, month) {
  return new Date(Date.UTC(parseInt(year, 10), parseInt(month, 10), 0, 5, 0, 0)).getUTCDate();
}

function getIsoWeekday_(dateStr) {
  return parseDateStringLocal_(dateStr).getUTCDay();
}

function getIsoDayOfMonth_(dateStr) {
  return parseDateStringLocal_(dateStr).getUTCDate();
}

function getMonthCalendarInfo_(monthStr) {
  var parts = String(normalizeMonth_(monthStr)).split('-');
  var year = parseInt(parts[0], 10);
  var month = parseInt(parts[1], 10);
  var firstDay = createDateFromParts_(year, month, 1);
  return {
    first_day: firstDay,
    first_weekday: firstDay.getUTCDay(),
    days_in_month: getMonthLastDay_(year, month)
  };
}

function parseDateStringLocal_(dateStr) {
  if (Object.prototype.toString.call(dateStr) === '[object Date]' && !isNaN(dateStr)) {
    var bangkokParts = getBangkokDateParts_(dateStr);
    return createDateFromParts_(bangkokParts.year, bangkokParts.month, bangkokParts.day);
  }

  var text = String(dateStr || '').trim();
  var match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return createDateFromParts_(match[1], match[2], match[3]);
  }

  var fallback = new Date(text);
  if (Object.prototype.toString.call(fallback) === '[object Date]' && !isNaN(fallback)) {
    var fallbackParts = getBangkokDateParts_(fallback);
    return createDateFromParts_(fallbackParts.year, fallbackParts.month, fallbackParts.day);
  }
  return fallback;
}

function isValidDateParts_(year, month, day) {
  year = parseInt(year, 10);
  month = parseInt(month, 10);
  day = parseInt(day, 10);
  if (!(year > 0 && month >= 1 && month <= 12 && day >= 1)) return false;
  return day <= getMonthLastDay_(year, month);
}

function normalizeDateStringStrict_(value, label) {
  label = label || 'วันที่';
  if (value == null || value === '') return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return formatDate_(value);
  }

  var text = String(value).trim();
  var match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match || !isValidDateParts_(match[1], match[2], match[3])) {
    throw new Error(label + 'ไม่ถูกต้อง');
  }

  return match[1] + '-' + match[2] + '-' + match[3];
}

function shiftDate_(dateStr, days) {
  var d = parseDateStringLocal_(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return matchDatePartsToIso_(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function normalizeAbsenceAlertDays_(value) {
  value = parseInt(value, 10);
  if (!(value > 0 && value <= 30)) return 3;
  return value;
}

function normalizeAttentionThresholdDays_(value) {
  value = parseInt(value, 10);
  if (!(value > 0 && value <= 30)) return 3;
  return value;
}

// System Setup

/**
 * Run this once to create all required sheets (menu entry point).
 * แสดงผลผ่าน SpreadsheetApp.getUi() จึงเรียกได้จากเมนูในชีตเท่านั้น
 * ถ้าเรียกจาก Web App ให้ใช้ ensureSystemSheets_() แทน
 */
function setupSystem_() {
  var result = ensureSystemSheets_();
  var initialTeacherKey = result.initial_teacher_key;

  SpreadsheetApp.getUi().alert('✅ ติดตั้งระบบเสร็จเรียบร้อย!\n\nขั้นตอนถัดไป:\n1. Deploy > New deployment > Web app\n2. Execute as: Me\n3. Who has access: Anyone with Google account\n4. ' + (initialTeacherKey ? ('รหัสครูเริ่มต้น: ' + initialTeacherKey + '\n5. เข้าระบบครั้งแรกแล้วเปลี่ยนรหัสครูทันที') : 'รหัสครูมีอยู่แล้วในระบบ — ถ้าลืมรหัส ใช้เมนู 🎓 ระบบเช็คชื่อ > 🔑 รีเซ็ตรหัสครู (ลืมรหัส / ฉุกเฉิน)') + '\n6. Deploy แล้วเปิด URL');
}

/**
 * สร้างชีตและค่าตั้งต้นทั้งหมด โดยไม่แตะ UI — ปลอดภัยที่จะเรียกจาก Web App
 * @returns {{initial_teacher_key: string}} รหัสครูที่เพิ่งสร้าง ('' ถ้ามีอยู่แล้ว)
 */
function ensureSystemSheets_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. นักเรียน
  createSheetIfNotExists_(ss, SHEET.STUDENTS, [
    'ID', 'เลขที่', 'ชื่อ-สกุล', 'ชื่อเล่น', 'เพศ', 'กลุ่ม', 'จับตา', 'ใช้งาน', 'วันที่สร้าง', 'อีเมลผู้ปกครอง', 'เริ่มใช้งานเมื่อ', 'พ้นสภาพเมื่อ'
  ]);

  // 2. เช็คชื่อ
  createSheetIfNotExists_(ss, SHEET.ATTENDANCE, [
    'ID', 'เลขที่', 'วันที่', 'สถานะ', 'หมายเหตุ', 'Batch ID', 'บันทึกเมื่อ', 'แก้ไขเมื่อ', 'student_id'
  ]);

  // 3. สถานะวัน
  createSheetIfNotExists_(ss, SHEET.ATTENDANCE_DAYS, [
    'วันที่', 'สถานะ', 'ยืนยันเมื่อ'
  ]);

  // 4. ประวัติแก้ไข
  createSheetIfNotExists_(ss, SHEET.CHANGE_LOG, [
    'ID', 'เลขที่', 'วันที่', 'สถานะเดิม', 'สถานะใหม่', 'หมายเหตุเดิม', 'หมายเหตุใหม่', 'การกระทำ', 'แก้ไขเมื่อ', 'student_id'
  ]);

  // 5. ตั้งค่า
  createSheetIfNotExists_(ss, SHEET.SETTINGS, ['Key', 'Value']);

  // 6. ปฏิทินวันเรียน
  createSheetIfNotExists_(ss, SCHOOL_CALENDAR_SHEET, ['id', 'วันที่', 'ประเภท', 'รายละเอียด']);

  // Set default settings
  // Set default settings
  var settings = getSettings_();

  if (!settings.teacher_name) {
    var defaultTeacherName = 'ครูประจำชั้น';
    try {
      var setupEmail = Session.getActiveUser().getEmail() || '';
      if (setupEmail) {
        defaultTeacherName = setupEmail.split('@')[0];
      }
    } catch (e) { }
    saveSetting_('teacher_name', defaultTeacherName);
  }

  if (!settings.school_name) saveSetting_('school_name', '');
  if (!settings.class_name) saveSetting_('class_name', '');
  if (!settings.absence_alert_days) saveSetting_('absence_alert_days', 3);
  if (!settings.attention_threshold_days) saveSetting_('attention_threshold_days', 3);
  var initialTeacherKey = '';
  if (!isTeacherAccessKeyConfigured_()) {
    initialTeacherKey = generateSecureToken_(16);
    setTeacherAccessKey_(initialTeacherKey);
  }
  // Format sheets
  formatStudentSheet_();
  formatAttendanceSheet_();

  return { initial_teacher_key: initialTeacherKey };
}

function createSheetIfNotExists_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    // Format header
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#f5f0eb');
    headerRange.setFontColor('#5b4a3f');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function formatStudentSheet_() {
  var sheet = getSheet_(SHEET.STUDENTS);
  sheet.setColumnWidth(1, 50);   // ID
  sheet.setColumnWidth(2, 60);   // เลขที่
  sheet.setColumnWidth(3, 200);  // ชื่อ-สกุล
  sheet.setColumnWidth(4, 100);  // ชื่อเล่น
  sheet.setColumnWidth(5, 50);   // เพศ
  sheet.setColumnWidth(6, 100);  // กลุ่ม
  sheet.setColumnWidth(7, 60);   // จับตา
  sheet.setColumnWidth(8, 60);   // ใช้งาน
  sheet.setColumnWidth(9, 150);  // วันที่สร้าง
  sheet.setColumnWidth(10, 220); // อีเมลผู้ปกครอง
  sheet.setColumnWidth(11, 120); // เริ่มใช้งานเมื่อ
  sheet.setColumnWidth(12, 120); // พ้นสภาพเมื่อ
}

function formatAttendanceSheet_() {
  var sheet = getSheet_(SHEET.ATTENDANCE);
  sheet.setColumnWidth(1, 50);   // ID
  sheet.setColumnWidth(2, 60);   // เลขที่
  sheet.setColumnWidth(3, 100);  // วันที่
  sheet.setColumnWidth(4, 120);  // สถานะ
  sheet.setColumnWidth(5, 200);  // หมายเหตุ
  sheet.setColumnWidth(6, 200);  // Batch ID
  sheet.setColumnWidth(7, 150);  // บันทึกเมื่อ
  sheet.setColumnWidth(8, 150);  // แก้ไขเมื่อ
  sheet.setColumnWidth(9, 90);   // student_id
}

// Insert Sample Data

function insertSampleData_() {
  var sheet;
  try {
    sheet = getSheet_(SHEET.STUDENTS);
  } catch (e) {
    SpreadsheetApp.getUi().alert('กรุณารัน setupSystem() ก่อน');
    return;
  }

  if (sheet.getLastRow() > 1) {
    var ui = SpreadsheetApp.getUi();
    var resp = ui.alert('มีข้อมูลนักเรียนอยู่แล้ว', 'ต้องการเพิ่มข้อมูลตัวอย่างเพิ่มหรือไม่?', ui.ButtonSet.YES_NO);
    if (resp !== ui.Button.YES) return;
  }

  var samples = [
    [1, 1, 'ด.ช.กิตติพงศ์ ใจดี', 'กิต', 'M', 'กลุ่ม A', false, true, nowString_()],
    [2, 2, 'ด.ญ.ณิชาภัทร แก้วตา', 'นุ่น', 'F', 'กลุ่ม A', false, true, nowString_()],
    [3, 3, 'ด.ช.ธนวัฒน์ ศรีทอง', 'วัฒน์', 'M', 'กลุ่ม A', false, true, nowString_()],
    [4, 4, 'ด.ญ.พิมพ์ชนก แซ่ลิ้ม', 'พิม', 'F', 'กลุ่ม A', false, true, nowString_()],
    [5, 5, 'ด.ช.ภูวดล อินทร์แก้ว', 'โอม', 'M', 'กลุ่ม B', false, true, nowString_()],
    [6, 6, 'ด.ญ.กัญญาวีร์ สุขใจ', 'วี', 'F', 'กลุ่ม B', true, true, nowString_()],
    [7, 7, 'ด.ช.สิรวิชญ์ สายชล', 'ไมค์', 'M', 'กลุ่ม B', false, true, nowString_()],
    [8, 8, 'ด.ญ.ปาริฉัตร ดวงดี', 'แพร', 'F', 'กลุ่ม B', false, true, nowString_()],
    [9, 9, 'ด.ช.ภัทรพล บุญมาก', 'นัท', 'M', 'กลุ่ม C', false, true, nowString_()],
    [10, 10, 'ด.ญ.ญาณิศา พูลทรัพย์', 'หยก', 'F', 'กลุ่ม C', false, true, nowString_()],
    [11, 11, 'ด.ช.นนทกร วงศ์คำ', 'ต้น', 'M', 'กลุ่ม C', true, true, nowString_()],
    [12, 12, 'ด.ญ.ชลธิชา ประเสริฐ', 'มิ้น', 'F', 'กลุ่ม C', false, true, nowString_()],
    [13, 13, 'ด.ช.ภาคิน เมืองแก้ว', 'คิน', 'M', '', false, true, nowString_()],
    [14, 14, 'ด.ญ.รวิสรา จันทรา', 'ฝน', 'F', '', false, true, nowString_()],
    [15, 15, 'ด.ช.พชรพล พูนสุข', 'เพชร', 'M', 'กลุ่ม D', false, true, nowString_()],
    [16, 16, 'ด.ญ.สุภัสสร นาคทอง', 'ออม', 'F', 'กลุ่ม D', false, true, nowString_()],
    [17, 17, 'ด.ช.อภิสิทธิ์ อินทรเดช', 'บอส', 'M', 'กลุ่ม D', false, true, nowString_()],
    [18, 18, 'ด.ญ.ฑิฆัมพร ศรีสุวรรณ', 'ใบเฟิร์น', 'F', 'กลุ่ม D', false, true, nowString_()],
    [19, 19, 'ด.ช.ธนกฤต กาญจนา', 'เต้', 'M', 'กลุ่ม E', false, true, nowString_()],
    [20, 20, 'ด.ญ.วิภาวี เชิดชู', 'แบม', 'F', 'กลุ่ม E', false, true, nowString_()],
    [21, 21, 'ด.ช.กวินทร์ แสงทอง', 'วิน', 'M', 'กลุ่ม E', false, true, nowString_()],
    [22, 22, 'ด.ญ.ชุติกาญจน์ โพธิ์ศรี', 'จูน', 'F', 'กลุ่ม E', false, true, nowString_()],
    [23, 23, 'ด.ช.อชิระ พูลสมบัติ', 'อาร์ม', 'M', '', false, true, nowString_()],
    [24, 24, 'ด.ญ.นภัสสร วรรณดี', 'นภา', 'F', '', false, true, nowString_()]
  ];

  var nextId = getNextId_(SHEET.STUDENTS);
  samples.forEach(function (row, i) {
    row[0] = nextId + i;
  });

  sheet.getRange(sheet.getLastRow() + 1, 1, samples.length, samples[0].length).setValues(samples);

  // Default settings
  saveSetting_('teacher_name', 'ครูประจำชั้น');
  saveSetting_('school_name', 'โรงเรียนตัวอย่าง');
  saveSetting_('class_name', 'ป.3/1');

  SpreadsheetApp.getUi().alert('✅ เพิ่มข้อมูลตัวอย่าง 24 คนเรียบร้อย!');
}

// Add Custom Menu

function openWebApp_() {
  var url = ScriptApp.getService().getUrl();
  if (!url) {
    SpreadsheetApp.getUi().alert('กรุณา Deploy เป็น Web App ก่อน\n\nDeploy > New deployment > Web app');
    return;
  }
  var html = HtmlService.createHtmlOutput('<script>window.open("' + url + '");google.script.host.close();</script>');
  SpreadsheetApp.getUi().showModalDialog(html, 'กำลังเปิด Web App...');
}

function resetTeacherAccessKeyFromSheet_() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.alert(
    'รีเซ็ตรหัสครู',
    'จะสร้างรหัสครูใหม่ รหัสเดิมจะใช้ไม่ได้ และ session ที่ล็อกอินอยู่จะหมดอายุ\n' +
      'จะล้างรายการอุปกรณ์ที่อนุญาตทั้งหมดด้วย เพื่อให้ครูเข้าสู่ระบบใหม่ได้จากเครื่องหรือเบราว์เซอร์ที่ต้องการ\n\n' +
      'ดำเนินการต่อหรือไม่?',
    ui.ButtonSet.OK_CANCEL
  );
  if (response !== ui.Button.OK) {
    return;
  }

  ensureSecurityMigration_();
  var newKey = generateSecureToken_(16);
  setTeacherAccessKey_(newKey);
  clearTrustedTeacherDevices_();
  rotateTeacherSessionGeneration_();

  ui.alert(
    '✅ สร้างรหัสครูใหม่แล้ว\n\nรหัสใหม่: ' + newKey + '\n\nกรุณาบันทึกรหัสนี้ไว้ในที่ปลอดภัย แล้วเข้าสู่ Web App ใหม่บนอุปกรณ์ที่ต้องการใช้งาน'
  );
}

function resetTeacherDeviceBindingFromSheet_() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.alert(
    'รีเซ็ตอุปกรณ์ครูทั้งหมด',
    'ใช้เมื่อครูต้องการออกจากระบบทุกเครื่องพร้อมกัน เช่น ทำเครื่องหาย ใช้ incognito แล้วค้าง session หรือเปลี่ยนมือถือ/คอมพิวเตอร์\n\n' +
      'ระบบจะล้างรายการอุปกรณ์ที่อนุญาตทั้งหมดและบังคับให้อุปกรณ์ที่ล็อกอินค้างอยู่ต้องเข้าสู่ระบบใหม่\n\n' +
      'รหัสครูจะไม่ถูกเปลี่ยน\n\n' +
      'ดำเนินการต่อหรือไม่?',
    ui.ButtonSet.OK_CANCEL
  );
  if (response !== ui.Button.OK) {
    return;
  }

  ensureSecurityMigration_();
  clearTrustedTeacherDevices_();
  rotateTeacherSessionGeneration_();

  ui.alert(
    '✅ รีเซ็ตอุปกรณ์ครูทั้งหมดแล้ว\n\n' +
      'ขั้นต่อไป:\n' +
      '1. กลับไปเปิด Web App\n' +
      '2. เข้าสู่ระบบด้วยรหัสครูเดิม\n' +
      '3. อุปกรณ์ที่ครูล็อกอินครั้งถัดไปจะถูกเพิ่มกลับเข้าในรายการอุปกรณ์ที่อนุญาต'
  );
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🎓 ระบบเช็คชื่อ')
    .addItem('⚙️ ติดตั้งระบบ (ครั้งแรก)', 'setupSystem_')
    .addItem('📋 เพิ่มข้อมูลตัวอย่าง', 'insertSampleData_')
    .addSeparator()
    .addItem('📱 รีเซ็ตอุปกรณ์ครูทั้งหมด (ฉุกเฉิน)', 'resetTeacherDeviceBindingFromSheet_')
    .addItem('🔑 รีเซ็ตรหัสครู (ลืมรหัส / ฉุกเฉิน)', 'resetTeacherAccessKeyFromSheet_')
    .addSeparator()
    .addItem('🌐 เปิด Web App', 'openWebApp_')
    .addSeparator()
    // ชั่วคราว — ลบบรรทัดนี้พร้อมไฟล์ Diagnostics.gs เมื่อทดสอบงานแก้ P0 ผ่านแล้ว
    .addItem('🧪 ตรวจงานแก้ P0 (dev)', 'runP0Diagnostics')
    .addSeparator()
    // ★ ชุดทดสอบ — ลบ 4 บรรทัดนี้พร้อมไฟล์ SeedTestData.gs ก่อนส่งมอบให้ลูกค้าทุกครั้ง
    .addItem('🧪 [ทดสอบ] เตรียมภาคเรียนทดสอบ', 'prepareTestSemester')
    .addItem('🧪 [ทดสอบ] สร้างข้อมูลจำลอง', 'seedTestData')
    .addItem('🧪 [ทดสอบ] ดูสถานะข้อมูล', 'seedTestDataStatus')
    .addItem('🧪 [ทดสอบ] ล้างข้อมูลเช็คชื่อ', 'clearTestData')
    .addToUi();
}

/**
 * ★ แยก CODE| ออกจากข้อความ error ก่อนส่งกลับไปให้หน้าจอ
 *
 * ทำไมต้องมี: ฝั่ง server หลายจุดจับ error แล้วก๊อป `e.message` ใส่ payload ตรงๆ
 * ถ้าข้อความนั้นมี `CODE|` นำหน้า **ผู้ใช้จะเห็นโค้ดดิบบนจอ** เพราะฝั่ง client
 * เอา `data.message` ไป toast ตรงๆ ไม่ได้ผ่าน `parseServerError_` (ตัวนั้นใช้กับ error
 * ที่ throw ออกไปเท่านั้น) — เกิดขึ้นจริงมาแล้วในหน้าผู้ปกครอง ดู `DECISIONS.md` ข้อ 29
 *
 * คืน `code` มาด้วย เพื่อให้หน้าจอแยกประเภทได้โดยไม่ต้องค้นคำไทยในข้อความ
 * ★ เงื่อนไขว่าเป็น code คือ A-Z ตัวใหญ่ ตัวเลข และ _ เท่านั้น เพื่อไม่ให้ข้อความ
 *   ที่มี `|` อยู่ตามธรรมชาติถูกตัดหัวทิ้งโดยไม่ได้ตั้งใจ
 */
function splitErrorCode_(e) {
  var text = String(e && e.message ? e.message : (e || ''));
  text = text.replace(/^(Exception|Error):\s*/i, '');
  var pipeIndex = text.indexOf('|');
  if (pipeIndex > 0) {
    var candidate = text.substring(0, pipeIndex);
    if (/^[A-Z][A-Z0-9_]*$/.test(candidate)) {
      return { code: candidate, message: text.substring(pipeIndex + 1) };
    }
  }
  return { code: '', message: text };
}

/**
 * payload มาตรฐานของความล้มเหลว — ใช้แทน `{ success: false, message: e.message }`
 * ทุกจุด เพื่อไม่ให้ `CODE|` หลุดขึ้นจอ และให้หน้าจอมี `code` ให้เทียบ
 */
function buildFailurePayload_(e, fallbackMessage) {
  var parts = splitErrorCode_(e);
  var payload = { success: false, message: parts.message || String(fallbackMessage || '') };
  if (parts.code) payload.code = parts.code;
  return payload;
}
