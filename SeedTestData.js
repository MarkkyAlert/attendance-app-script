/**
 * ═══════════════════════════════════════════════════════════════════════
 * ⚠️  SeedTestData.gs — สร้างข้อมูลจำลองสำหรับ "สำเนาทดสอบ" เท่านั้น
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ★★★ ห้ามไฟล์นี้ติดไปกับสำเนาที่ส่งให้ลูกค้าเด็ดขาด ★★★
 *
 * ก่อนส่งมอบทุกครั้งต้องลบสองอย่างคู่กัน:
 *   1. ไฟล์ SeedTestData.gs (ไฟล์นี้)
 *   2. รายการเมนู 🧪 [ทดสอบ] ทั้ง 4 รายการใน onOpen() ที่ Utils.gs
 *
 * ไฟล์นี้เขียนข้อมูลปลอมลงชีต นักเรียน / เช็คชื่อ / สถานะวัน / ปฏิทินวันเรียน
 * ถ้าเผลอรันบนสำเนาของครูจริง ข้อมูลจริงจะปนกับข้อมูลปลอมจนแยกไม่ออก
 * จึงมีด่านกันไว้ที่ SEED_MAX_EXISTING_ATTENDANCE_ROWS ด้านล่าง
 *
 * อีเมลผู้ปกครองทั้งหมดใช้โดเมน @example.invalid ซึ่งเป็นโดเมนสงวนตาม RFC 6761
 * ส่งอีเมลออกไม่ได้แน่นอน — ห้ามเปลี่ยนเป็นโดเมนจริง
 */

// ─── ค่าคงที่ ─────────────────────────────────────────────────────────

var SEED_DAYS_BACK = 90;                       // ย้อนหลังกี่วัน (ถึงเมื่อวาน ไม่รวมวันนี้)
var SEED_CONFIRM_CUTOFF_DAYS = 7;              // เกินกี่วันถึงถือว่า confirmed
var SEED_TOTAL_STUDENTS = 40;                  // เป้าหมายรวม (active 39 + inactive 1)
var SEED_MAX_EXISTING_ATTENDANCE_ROWS = 500;   // ด่านกันไม่ให้รันบนสำเนาลูกค้าจริง
var SEED_RANDOM_SEED = 20260815;               // คงที่ไว้ เพื่อให้รันซ้ำได้ข้อมูลชุดเดิม
var SEED_NOTE_CHANCE = 0.05;                   // สัดส่วนแถวที่จะมีหมายเหตุ

// เลขที่ 25-32 คือเคสพิเศษ ทั้งหมดถูกบังคับเป็นพฤติกรรม "เด็กปกติ"
// เพื่อไม่ให้ตัวแปรเรื่องการแสดงผลปนกับตัวแปรเรื่องสถิติ
var SEED_SPECIAL_NUMBER_FROM = 25;
var SEED_SPECIAL_NUMBER_TO = 32;

var SEED_NOTES = [
  'ไปหาหมอ',
  'รถติด',
  'ผู้ปกครองแจ้งแล้ว',
  'ไข้หวัด',
  'ธุระครอบครัว',
  'ตื่นสาย',
  'ฝนตกหนัก'
];

// ─── ด่านกันการเรียกจากภายนอก ─────────────────────────────────────────

/**
 * ทั้ง 4 ฟังก์ชันเมนูต้องเป็นชื่อ public (ไม่มี _ ต่อท้าย) เพราะช่องเลือกฟังก์ชัน
 * ของ Apps Script editor ไม่แสดงฟังก์ชันที่ลงท้ายด้วย _ จะกด Run ไม่ได้เลย
 * แต่ชื่อ public แปลว่าเรียกผ่าน google.script.run จากอินเทอร์เน็ตได้ด้วย
 * และฟังก์ชันชุดนี้ "เขียนและลบข้อมูล" จึงต้องมีด่านกันให้แน่น
 *
 * Web App ตั้งเป็น ANYONE_ANONYMOUS ผู้เรียกจากเน็ตจึงไม่มีอีเมลติดมา
 * ส่วนการรันจาก editor หรือเมนูในชีตจะได้อีเมลเจ้าของสคริปต์เสมอ
 *
 * หมายเหตุ: จงใจเขียนซ้ำกับ requireP0DiagnosticLocalContext_ ใน Diagnostics.gs
 * เพราะทั้งสองไฟล์เป็นของชั่วคราวที่ต้องลบทิ้งได้อิสระจากกัน
 */
function requireSeedLocalContext_() {
  var email = '';
  try {
    email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  } catch (e) {
    email = '';
  }
  if (!email) {
    throw new Error('ฟังก์ชันนี้เรียกได้จาก Apps Script editor หรือเมนูในชีตเท่านั้น');
  }

  var ownerEmail = '';
  try {
    ownerEmail = getTeacherOwnerEmail_();
  } catch (e2) {
    ownerEmail = '';
  }
  if (ownerEmail && ownerEmail !== email) {
    throw new Error('บัญชีนี้ไม่ใช่เจ้าของระบบ จึงใช้เครื่องมือทดสอบไม่ได้');
  }
  return email;
}

// ─── ตัวสุ่มแบบกำหนดเมล็ดได้ (Park-Miller) ────────────────────────────
// ใช้แทน Math.random เพื่อให้รันกี่ครั้งก็ได้ข้อมูลชุดเดิม เวลาไล่บั๊กจะเทียบผลได้

function createSeededRandom_(seed) {
  var state = parseInt(seed, 10) || 1;
  return function() {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

// ═══════════════════════════════════════════════════════════════════════
// เมนู 1: สร้างข้อมูลจำลอง
// ═══════════════════════════════════════════════════════════════════════

function seedTestData() {
  var ui = SpreadsheetApp.getUi();
  var startedAt = new Date().getTime();

  try {
    requireSeedLocalContext_();
  } catch (eGate) {
    ui.alert('เรียกใช้ไม่ได้', String(eGate && eGate.message ? eGate.message : eGate), ui.ButtonSet.OK);
    return;
  }

  var plan;
  try {
    plan = buildSeedPlanOrThrow_();
  } catch (e) {
    ui.alert('สร้างข้อมูลจำลองไม่ได้', String(e && e.message ? e.message : e), ui.ButtonSet.OK);
    return;
  }

  var confirmed = ui.alert(
    'สร้างข้อมูลจำลอง',
    'จะเขียนข้อมูลทดสอบลงชีตนี้:\n\n' +
      '• นักเรียน: ' + (plan.will_create_students ? 'เพิ่มอีก ' + plan.new_student_count + ' คน' : 'เลขที่ 25-40 มีครบแล้ว ข้ามขั้นนี้') + '\n' +
      (plan.taken_numbers.length ? '  ⚠️ เลขที่ ' + plan.taken_numbers.join(', ') + ' ถูกใช้อยู่แล้ว จะไม่สร้างทับ\n' : '') +
      '• ปฏิทินวันเรียน: ' + (plan.will_create_calendar ? 'สร้างใหม่ในช่วงที่ seed' : 'มีอยู่แล้ว ใช้ของเดิม') + '\n' +
      '• เช็คชื่อ: ' + plan.from + ' ถึง ' + plan.to + '\n\n' +
      '⚠️ ใช้กับสำเนาทดสอบเท่านั้น ดำเนินการต่อหรือไม่?',
    ui.ButtonSet.OK_CANCEL
  );
  if (confirmed !== ui.Button.OK) return;

  var result;
  try {
    result = withAttendanceMutationLock_(function() {
      return runSeedTestData_(plan);
    });
  } catch (e) {
    Logger.log('seedTestData_ ล้มเหลว: ' + (e && e.stack ? e.stack : e));
    ui.alert('สร้างข้อมูลจำลองไม่สำเร็จ', String(e && e.message ? e.message : e), ui.ButtonSet.OK);
    return;
  }

  var durationSec = Math.round((new Date().getTime() - startedAt) / 100) / 10;
  ui.alert(
    '✅ สร้างข้อมูลจำลองเรียบร้อย',
    'ใช้เวลา ' + durationSec + ' วินาที\n\n' +
      'นักเรียนที่เพิ่ม: ' + result.students_created + ' คน\n' +
      'แก้ ENROLLED_FROM ย้อนหลัง: ' + result.students_backfilled + ' คน\n' +
      'ปฏิทินวันเรียนที่สร้าง: ' + result.calendar_created + ' รายการ\n' +
      'วันเรียนที่ใช้สร้างข้อมูล: ' + result.school_day_count + ' วัน\n' +
      'แถวเช็คชื่อ: ' + result.attendance_rows + ' แถว\n' +
      'สถานะวัน: confirmed ' + result.confirmed_days + ' วัน / draft ' + result.draft_days + ' วัน',
    ui.ButtonSet.OK
  );
}

/**
 * ตรวจเงื่อนไขทั้งหมดก่อนลงมือ ถ้าไม่ผ่านให้ throw พร้อมข้อความที่บอกวิธีแก้
 * แยกออกมาเพื่อให้ตรวจได้ก่อนถามยืนยัน จะได้ไม่ถามแล้วค่อยมาแจ้งว่าทำไม่ได้
 */
function buildSeedPlanOrThrow_() {
  var today = todayString_();
  var from = shiftDate_(today, -SEED_DAYS_BACK);
  var to = shiftDate_(today, -1);

  // ด่านที่ 1 — ชีตนี้น่าจะเป็นของลูกค้าจริงหรือเปล่า
  var attendanceSheet = getSheet_(SHEET.ATTENDANCE);
  var existingRows = Math.max(0, attendanceSheet.getLastRow() - 1);
  if (existingRows > SEED_MAX_EXISTING_ATTENDANCE_ROWS) {
    throw new Error(
      'ชีตนี้มีข้อมูลเช็คชื่ออยู่แล้ว ' + existingRows + ' แถว ' +
      '(เกินเพดาน ' + SEED_MAX_EXISTING_ATTENDANCE_ROWS + ' แถวที่ตั้งไว้)\n\n' +
      'อาจเป็นสำเนาของครูจริง ไม่ใช่ชุดทดสอบ จึงหยุดไว้ก่อน\n' +
      'ถ้าแน่ใจว่าเป็นชุดทดสอบ ให้ใช้เมนู 🧪 [ทดสอบ] ล้างข้อมูลเช็คชื่อ ก่อน'
    );
  }

  // ด่านที่ 2 — ภาคเรียนที่ใช้งานอยู่ต้องครอบคลุมช่วงที่จะ seed
  var semester = getActiveSemesterRow_();
  if (!semester || !semester.start_date || !semester.end_date) {
    throw new Error(
      'ยังไม่มีภาคเรียนที่เปิดใช้งานอยู่\n\n' +
      'ต้องมีภาคเรียนที่ครอบคลุม ' + from + ' ถึง ' + to + '\n' +
      'ใช้เมนู 🧪 [ทดสอบ] เตรียมภาคเรียนทดสอบ เพื่อสร้างให้อัตโนมัติ'
    );
  }
  if (semester.start_date > from || semester.end_date < to) {
    throw new Error(
      'ภาคเรียนที่ใช้งานอยู่คือ "' + semester.name + '" ' +
      semester.start_date + ' ถึง ' + semester.end_date + '\n\n' +
      'แต่ข้อมูลทดสอบต้องการช่วง ' + from + ' ถึง ' + to + '\n' +
      'รายงานทุกหน้าถูกบีบให้อยู่ในภาคเรียนที่ active ถ้าไม่ครอบคลุมจะไม่เห็นข้อมูลเลย\n\n' +
      'ใช้เมนู 🧪 [ทดสอบ] เตรียมภาคเรียนทดสอบ เพื่อขยายช่วงให้อัตโนมัติ'
    );
  }

  // ด่านที่ 3 — กันการ seed ซ้อนทับของเดิม
  var overlapRows = countAttendanceRowsInRange_(attendanceSheet, from, to);
  if (overlapRows > 0) {
    throw new Error(
      'มีข้อมูลเช็คชื่ออยู่แล้ว ' + overlapRows + ' แถวในช่วง ' + from + ' ถึง ' + to + '\n\n' +
      'ถ้า seed ทับจะได้ข้อมูลซ้ำซ้อน\n' +
      'ใช้เมนู 🧪 [ทดสอบ] ล้างข้อมูลเช็คชื่อ ก่อนแล้วค่อยสร้างใหม่'
    );
  }

  // ตัดสินจาก "เลขที่ไหนยังไม่มี" ไม่ใช่จากจำนวนนักเรียนรวม
  // เพราะถ้าชีตมีนักเรียนขยะปนอยู่ การนับหัวจะทำให้ข้ามการสร้างเคสพิเศษไปทั้งชุด
  var studentData = getStudentListData_();
  var existingNumbers = {};
  (studentData.all_students || []).forEach(function(student) {
    existingNumbers[parseInt(student.student_number, 10) || 0] = true;
  });

  var specs = buildSeedStudentSpecs_(today, semester.start_date);
  var pendingSpecs = specs.filter(function(spec) {
    return !existingNumbers[spec.number];
  });
  var takenNumbers = specs.filter(function(spec) {
    return !!existingNumbers[spec.number];
  }).map(function(spec) {
    return spec.number;
  });

  return {
    from: from,
    to: to,
    today: today,
    semester: semester,
    existing_student_count: (studentData.all_students || []).length,
    pending_student_specs: pendingSpecs,
    will_create_students: pendingSpecs.length > 0,
    new_student_count: pendingSpecs.length,
    taken_numbers: takenNumbers,
    will_create_calendar: getSchoolCalendarEntriesForRange_({ from: from, to: to }).length === 0
  };
}

function runSeedTestData_(plan) {
  Logger.log('[seed] เริ่ม ช่วง ' + plan.from + ' ถึง ' + plan.to);

  var studentsCreated = 0;
  if (plan.will_create_students) {
    studentsCreated = insertSeedStudents_(plan);
    Logger.log('[seed] เพิ่มนักเรียนแล้ว ' + studentsCreated + ' คน');
  } else {
    Logger.log('[seed] มีนักเรียน ' + plan.existing_student_count + ' คนแล้ว ข้ามขั้นสร้างนักเรียน');
  }

  var backfilled = backfillEnrolledFrom_(plan.semester.start_date);
  Logger.log('[seed] เติม ENROLLED_FROM ย้อนหลัง ' + backfilled + ' คน');

  invalidateStudentCache_();

  var calendarResult = ensureSeedCalendar_(plan);
  Logger.log('[seed] ปฏิทิน: สร้างใหม่ ' + calendarResult.created + ' รายการ / วันเรียนที่ใช้ได้ ' + calendarResult.school_days.length + ' วัน');

  var roster = readSeedRoster_();
  Logger.log('[seed] อ่านรายชื่อได้ ' + roster.length + ' คน');

  var attendanceResult = insertSeedAttendance_(roster, calendarResult.school_days);
  Logger.log('[seed] เขียนเช็คชื่อ ' + attendanceResult.rows + ' แถว');

  var dayStatusResult = insertSeedDayStatus_(calendarResult.school_days, plan.today);
  Logger.log('[seed] เขียนสถานะวัน confirmed ' + dayStatusResult.confirmed + ' / draft ' + dayStatusResult.draft);

  clearSeedCaches_();
  Logger.log('[seed] ล้าง cache เรียบร้อย');

  return {
    students_created: studentsCreated,
    students_backfilled: backfilled,
    calendar_created: calendarResult.created,
    school_day_count: calendarResult.school_days.length,
    attendance_rows: attendanceResult.rows,
    confirmed_days: dayStatusResult.confirmed,
    draft_days: dayStatusResult.draft
  };
}

// ─── นักเรียน ─────────────────────────────────────────────────────────

/**
 * รายชื่อ 16 คนที่เติมเข้าไปให้ครบ 40
 * เลขที่ 25-32 คือเคสพิเศษสำหรับทดสอบการแสดงผล ไม่ใช่ทดสอบสถิติ
 */
function buildSeedStudentSpecs_(today, semesterStart) {
  return [
    // 25 — ชื่อยาวเกิน 60 ตัวอักษร ใช้ดูว่าตารางและใบรายงานล้นจอหรือไม่
    { number: 25, name: 'ด.ช.ปุณณกันต์ธนโชติวัฒนไพศาล สิริกุลเจริญรัตน์มหาวงศ์ตระกูลชัยมงคล', nick: 'ปุณณ์', gender: 'M', group: 'กลุ่ม A' },
    // 26-27 — วรรณยุกต์ซ้อน ใช้ดูการตัดบรรทัดและความสูงแถว
    { number: 26, name: 'ด.ช.ณัฐฐ์ ศรีสุวรรณ', nick: 'ณัฐฐ์', gender: 'M', group: 'กลุ่ม A' },
    { number: 27, name: 'ด.ญ.ปุ๊กกี้ วรรณศิลป์', nick: 'ปุ๊กกี้', gender: 'F', group: 'กลุ่ม B' },
    // 28 — ขึ้นต้นด้วย = ใช้ทดสอบ CSV injection ตอน export
    { number: 28, name: '=ด.ช.วีรภาพ สูตรทดสอบ', nick: 'วีร์', gender: 'M', group: 'กลุ่ม B' },
    // 29 — ย้ายเข้ากลางเทอม ต้องไม่มีข้อมูลเช็คชื่อก่อนวันนี้
    { number: 29, name: 'ด.ญ.กชกร ย้ายเข้ากลางเทอม', nick: 'กช', gender: 'F', group: 'กลุ่ม C', enrolled_from: shiftDate_(today, -30) },
    // 30 — ย้ายออกแล้ว ต้องไม่มีข้อมูลเช็คชื่อตั้งแต่วันที่พ้นสภาพเป็นต้นไป
    { number: 30, name: 'ด.ช.ธีรเดช ย้ายออกแล้ว', nick: 'ธีร์', gender: 'M', group: 'กลุ่ม C', inactive_at: shiftDate_(today, -14), is_active: false },
    // 31-32 — ติดธงจับตา
    { number: 31, name: 'ด.ญ.อริสา ทองแท้', nick: 'ริต้า', gender: 'F', group: 'กลุ่ม D', flagged: true },
    { number: 32, name: 'ด.ช.กรวิชญ์ พงศ์ภัค', nick: 'กร', gender: 'M', group: 'กลุ่ม D', flagged: true },
    // 33-40 — นักเรียนทั่วไป ใช้กระจายพฤติกรรม
    { number: 33, name: 'ด.ญ.พรนภา อินทโชติ', nick: 'พร', gender: 'F', group: 'กลุ่ม A' },
    { number: 34, name: 'ด.ช.ศุภวิชญ์ ตันติกุล', nick: 'ภูมิ', gender: 'M', group: 'กลุ่ม B' },
    { number: 35, name: 'ด.ญ.เขมิกา สุวรรณเลิศ', nick: 'เขม', gender: 'F', group: 'กลุ่ม C' },
    { number: 36, name: 'ด.ช.ปัณณธร โชติวิทย์', nick: 'ปัณณ์', gender: 'M', group: 'กลุ่ม D' },
    { number: 37, name: 'ด.ญ.ธัญชนก เรืองแสง', nick: 'ธัญ', gender: 'F', group: 'กลุ่ม E' },
    { number: 38, name: 'ด.ช.อติวิชญ์ คำแหง', nick: 'อติ', gender: 'M', group: 'กลุ่ม E' },
    { number: 39, name: 'ด.ญ.ศิรดา บวรชัย', nick: 'ศิ', gender: 'F', group: 'กลุ่ม E' },
    { number: 40, name: 'ด.ช.กันตพัฒน์ วิริยะกุล', nick: 'กันต์', gender: 'M', group: 'กลุ่ม A' }
  ].map(function(spec) {
    spec.enrolled_from = spec.enrolled_from || semesterStart;
    spec.is_active = spec.is_active === false ? false : true;
    spec.flagged = spec.flagged === true;
    spec.inactive_at = spec.inactive_at || '';
    return spec;
  });
}

function insertSeedStudents_(plan) {
  var sheet = getSheet_(SHEET.STUDENTS);
  var pending = plan.pending_student_specs || [];
  if (!pending.length) return 0;

  var nextId = getNextIdForSheet_(sheet);
  var createdAt = nowString_();
  var rows = pending.map(function(spec, index) {
    return [
      nextId + index,
      spec.number,
      spec.name,
      spec.nick,
      spec.gender,
      spec.group,
      spec.flagged,
      spec.is_active,
      createdAt,
      buildSeedParentEmail_(spec.number),
      spec.enrolled_from,
      spec.inactive_at
    ];
  });

  var startRow = sheet.getLastRow() + 1;
  // บังคับคอลัมน์ชื่อเป็นข้อความล้วน ไม่งั้นชื่อที่ขึ้นต้นด้วย = จะถูกตีความเป็นสูตร
  sheet.getRange(startRow, COL.STUDENTS.FULL_NAME, rows.length, 1).setNumberFormat('@');
  sheet.getRange(startRow, 1, rows.length, COL.STUDENTS.INACTIVE_AT).setValues(rows);
  return rows.length;
}

function buildSeedParentEmail_(studentNumber) {
  // .invalid เป็นโดเมนสงวนตาม RFC 6761 ส่งอีเมลออกไม่ได้แน่นอน
  return 'parent' + studentNumber + '@example.invalid';
}

/**
 * นักเรียนที่ insertSampleData_ สร้างไว้ไม่มี ENROLLED_FROM ทำให้ระบบคิดว่า
 * "เพิ่งเข้าห้องวันนี้" (ขอบเขตใช้ enrolled_from ก่อน ถ้าว่างจะ fallback ไป created_at)
 * ข้อมูลเช็คชื่อย้อนหลังของคนกลุ่มนี้จะถูกกรองทิ้งทั้งหมด จึงต้องเติมย้อนหลังให้
 */
function backfillEnrolledFrom_(semesterStart) {
  var sheet = getSheet_(SHEET.STUDENTS);
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 0;

  var range = sheet.getRange(2, COL.STUDENTS.ENROLLED_FROM, lastRow - 1, 1);
  var values = range.getValues();
  var changed = 0;

  for (var i = 0; i < values.length; i++) {
    var current = String(values[i][0] || '').trim();
    if (current) continue;
    values[i][0] = semesterStart;
    changed++;
  }

  if (changed) range.setValues(values);
  return changed;
}

/**
 * อ่านรายชื่อพร้อมขอบเขตวันที่ ใช้ตัดสินว่าวันไหนควรมีข้อมูลเช็คชื่อของใคร
 */
function readSeedRoster_() {
  var sheet = getSheet_(SHEET.STUDENTS);
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];

  var data = sheet.getRange(2, 1, lastRow - 1, COL.STUDENTS.INACTIVE_AT).getValues();
  return data.map(function(row) {
    return {
      id: parseInt(row[COL.STUDENTS.ID - 1], 10) || 0,
      student_number: parseInt(row[COL.STUDENTS.STUDENT_NUMBER - 1], 10) || 0,
      enrolled_from: normalizeStudentSheetDateValue_(row[COL.STUDENTS.ENROLLED_FROM - 1]),
      inactive_at: normalizeStudentSheetDateValue_(row[COL.STUDENTS.INACTIVE_AT - 1])
    };
  }).filter(function(student) {
    return student.student_number > 0;
  }).sort(function(a, b) {
    return a.student_number - b.student_number;
  });
}

// ─── ปฏิทินวันเรียน ───────────────────────────────────────────────────

/**
 * ถ้าปฏิทินมีข้อมูลในช่วงนี้อยู่แล้ว จะไม่เขียนทับ และจะ "อ่านของเดิมมาใช้"
 * กำหนดว่าวันไหนเป็นวันเรียน ไม่ใช้แผนของตัวเอง มิฉะนั้นถ้าปฏิทินเดิม
 * มีวันหยุดที่เราไม่รู้ เราจะไปสร้างข้อมูลเช็คชื่อทับวันหยุดนั้น
 */
function ensureSeedCalendar_(plan) {
  var existing = getSchoolCalendarEntriesForRange_({ from: plan.from, to: plan.to });
  if (existing.length) {
    var existingSchoolDays = existing.filter(function(entry) {
      return entry.type === 'school_day';
    }).map(function(entry) {
      return entry.date;
    }).sort();
    return { created: 0, school_days: existingSchoolDays };
  }

  var weekdays = generateDateList_(plan.from, plan.to).filter(function(date) {
    var weekday = getIsoWeekday_(date);
    return weekday >= 1 && weekday <= 5;
  });
  var holidaySet = pickSeedHolidays_(weekdays);

  var sheet = getOrCreateSchoolCalendarSheet_();
  var nextId = getNextSchoolCalendarId_(sheet);
  var rows = weekdays.map(function(date, index) {
    var isHoliday = !!holidaySet[date];
    return [
      nextId + index,
      date,
      isHoliday ? 'holiday' : 'school_day',
      isHoliday ? 'วันหยุด (ข้อมูลทดสอบ)' : 'วันเรียน'
    ];
  });

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, SCHOOL_CALENDAR_COL.LABEL).setValues(rows);
  sortSchoolCalendarSheet_(sheet);
  invalidateSchoolCalendarCaches_();

  return {
    created: rows.length,
    school_days: weekdays.filter(function(date) {
      return !holidaySet[date];
    })
  };
}

/**
 * เลือกวันหยุด 4 วันแบบกระจายทั่วช่วง
 * ใช้ตำแหน่งคงที่แทนชื่อวันหยุดจริง เพราะช่วง 90 วันเลื่อนไปตามวันที่รัน
 * ถ้าใส่ชื่อวันหยุดจริงจะกลายเป็นข้อมูลผิดเมื่อรันคนละวัน
 */
function pickSeedHolidays_(weekdays) {
  var holidaySet = {};
  if (!weekdays.length) return holidaySet;

  [0.15, 0.38, 0.62, 0.85].forEach(function(ratio) {
    var index = Math.floor(weekdays.length * ratio);
    if (index >= 0 && index < weekdays.length) {
      holidaySet[weekdays[index]] = true;
    }
  });
  return holidaySet;
}

// ─── ข้อมูลเช็คชื่อ ───────────────────────────────────────────────────

function insertSeedAttendance_(roster, schoolDays) {
  if (!roster.length || !schoolDays.length) return { rows: 0 };

  var rand = createSeededRandom_(SEED_RANDOM_SEED);
  var behaviorByNumber = assignSeedBehaviors_(roster);
  var sickBlocks = buildSeedSickBlocks_(roster, behaviorByNumber, schoolDays, rand);

  var sheet = getSheet_(SHEET.ATTENDANCE);
  var nextId = getNextIdForSheet_(sheet);
  var rows = [];

  for (var dayIndex = 0; dayIndex < schoolDays.length; dayIndex++) {
    var date = schoolDays[dayIndex];
    var weekday = getIsoWeekday_(date);
    var recordedAt = date + ' 08:30:00';

    for (var i = 0; i < roster.length; i++) {
      var student = roster[i];
      if (!isSeedStudentInRosterOnDate_(student, date)) continue;

      var behavior = behaviorByNumber[student.student_number] || 'normal';
      var sickKey = student.student_number + '|' + date;
      var statusCode = pickSeedStatus_(behavior, weekday, rand, !!sickBlocks[sickKey]);
      var note = '';
      if (statusCode !== 'present' && rand() < SEED_NOTE_CHANCE) {
        note = SEED_NOTES[Math.floor(rand() * SEED_NOTES.length) % SEED_NOTES.length];
      }

      rows.push([
        nextId + rows.length,
        student.student_number,
        date,
        statusCode,
        note,
        '',
        recordedAt,
        recordedAt,
        student.id
      ]);
    }

    if (dayIndex > 0 && dayIndex % 20 === 0) {
      Logger.log('[seed] เตรียมข้อมูลถึงวันที่ ' + date + ' แล้ว (' + rows.length + ' แถว)');
    }
  }

  if (!rows.length) return { rows: 0 };

  // เขียนครั้งเดียวทั้งก้อน ห้ามใช้ appendRow ในลูปเด็ดขาด จะเกิน 6 นาที
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, COL.ATTENDANCE.STUDENT_ID).setValues(rows);
  return { rows: rows.length };
}

/**
 * ★ กฎสำคัญ: ห้ามสร้างข้อมูลให้นักเรียนในวันที่เขายังไม่เข้าหรือออกไปแล้ว
 * ใช้กติกาเดียวกับ isStudentInRosterOnDate_ คือ inactive_at เป็นแบบ exclusive
 */
function isSeedStudentInRosterOnDate_(student, date) {
  if (student.enrolled_from && date < student.enrolled_from) return false;
  if (student.inactive_at && date >= student.inactive_at) return false;
  return true;
}

/**
 * กระจายพฤติกรรม 60/20/15/5 ให้เฉพาะนักเรียนที่ไม่ใช่เคสพิเศษ
 * เคสพิเศษ (เลขที่ 25-32) บังคับเป็น normal ทั้งหมด เพื่อไม่ให้ตัวแปรปนกัน
 */
function assignSeedBehaviors_(roster) {
  var behaviorByNumber = {};
  var pool = [];

  roster.forEach(function(student) {
    var isSpecial = student.student_number >= SEED_SPECIAL_NUMBER_FROM &&
      student.student_number <= SEED_SPECIAL_NUMBER_TO;
    if (isSpecial) {
      behaviorByNumber[student.student_number] = 'normal';
    } else {
      pool.push(student.student_number);
    }
  });

  var total = pool.length;
  var normalCount = Math.round(total * 0.60);
  var lateCount = Math.round(total * 0.20);
  var sickCount = Math.round(total * 0.15);

  pool.forEach(function(studentNumber, index) {
    if (index < normalCount) behaviorByNumber[studentNumber] = 'normal';
    else if (index < normalCount + lateCount) behaviorByNumber[studentNumber] = 'late';
    else if (index < normalCount + lateCount + sickCount) behaviorByNumber[studentNumber] = 'sick';
    else behaviorByNumber[studentNumber] = 'chronic';
  });

  return behaviorByNumber;
}

/**
 * เด็กกลุ่มลาป่วยเป็นช่วง: ล็อกวันลาป่วยติดกัน 2-3 วัน จำนวน 2 ครั้งต่อคน
 * ทำเป็นแผนล่วงหน้าเพราะต้องติดกันจริง สุ่มรายวันจะไม่ได้ช่วงต่อเนื่อง
 */
function buildSeedSickBlocks_(roster, behaviorByNumber, schoolDays, rand) {
  var blocks = {};
  if (schoolDays.length < 6) return blocks;

  roster.forEach(function(student) {
    if (behaviorByNumber[student.student_number] !== 'sick') return;

    for (var round = 0; round < 2; round++) {
      var blockLength = 2 + Math.floor(rand() * 2);
      var maxStart = schoolDays.length - blockLength;
      if (maxStart <= 0) continue;
      var start = Math.floor(rand() * maxStart);

      for (var offset = 0; offset < blockLength; offset++) {
        var date = schoolDays[start + offset];
        if (!isSeedStudentInRosterOnDate_(student, date)) continue;
        blocks[student.student_number + '|' + date] = true;
      }
    }
  });

  return blocks;
}

/**
 * วันจันทร์กับวันศุกร์ให้ขาด/สายมากกว่ากลางสัปดาห์เล็กน้อย
 * เด็กขาดเรื้อรังให้ขาดวันจันทร์หนักเป็นพิเศษ
 */
function pickSeedStatus_(behavior, weekday, rand, isSickBlockDay) {
  if (isSickBlockDay) return 'sick_leave';

  var edgeOfWeekBump = (weekday === 1 || weekday === 5) ? 0.03 : 0;
  var roll = rand();

  if (behavior === 'chronic') {
    var absentChance = 0.25 + edgeOfWeekBump + (weekday === 1 ? 0.15 : 0);
    if (roll < absentChance) return 'absent';
    if (roll < absentChance + 0.10) return 'late';
    return 'present';
  }

  if (behavior === 'late') {
    var lateChance = 0.15 + edgeOfWeekBump;
    if (roll < lateChance) return 'late';
    if (roll < lateChance + 0.04) return 'absent';
    return 'present';
  }

  // normal และ sick (วันที่อยู่นอกช่วงลาป่วย)
  var absentBase = 0.03 + edgeOfWeekBump;
  if (roll < absentBase) return 'absent';
  if (roll < absentBase + 0.02) return 'late';
  if (roll < absentBase + 0.03) return 'personal_leave';
  return 'present';
}

// ─── สถานะวัน ─────────────────────────────────────────────────────────

function insertSeedDayStatus_(schoolDays, today) {
  if (!schoolDays.length) return { confirmed: 0, draft: 0 };

  var sheet = getSheet_(SHEET.ATTENDANCE_DAYS);
  var existingDates = {};
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, COL.ATT_DAYS.DATE, lastRow - 1, 1).getValues().forEach(function(row) {
      var date = normalizeStudentSheetDateValue_(row[0]);
      if (date) existingDates[date] = true;
    });
  }

  var cutoff = shiftDate_(today, -SEED_CONFIRM_CUTOFF_DAYS);
  var rows = [];
  var confirmed = 0;
  var draft = 0;

  schoolDays.forEach(function(date) {
    if (existingDates[date]) return;
    // เกิน 7 วัน = confirmed ให้รายงานนับ, 7 วันล่าสุด = draft ให้เห็นว่ายังไม่เข้ารายงาน
    var isConfirmed = date < cutoff;
    if (isConfirmed) confirmed++;
    else draft++;
    rows.push([date, isConfirmed ? 'confirmed' : 'draft', isConfirmed ? (date + ' 16:00:00') : '']);
  });

  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, COL.ATT_DAYS.CONFIRMED_AT).setValues(rows);
  }
  return { confirmed: confirmed, draft: draft };
}

// ═══════════════════════════════════════════════════════════════════════
// เมนู 2: ดูสถานะข้อมูล
// ═══════════════════════════════════════════════════════════════════════

function seedTestDataStatus() {
  var ui = SpreadsheetApp.getUi();
  var report;
  try {
    requireSeedLocalContext_();
    report = buildSeedStatusReport_();
  } catch (e) {
    ui.alert('อ่านสถานะไม่ได้', String(e && e.message ? e.message : e), ui.ButtonSet.OK);
    return;
  }
  Logger.log(JSON.stringify(report, null, 2));
  ui.alert('สถานะข้อมูลในชีตนี้', formatSeedStatusText_(report), ui.ButtonSet.OK);
}

function buildSeedStatusReport_() {
  var studentData = getStudentListData_();
  var allStudents = studentData.all_students || [];
  var activeStudents = studentData.students || [];

  var attendanceSheet = getSheet_(SHEET.ATTENDANCE);
  var lastRow = attendanceSheet.getLastRow();
  var attendanceRows = Math.max(0, lastRow - 1);
  var minDate = '';
  var maxDate = '';

  if (attendanceRows > 0) {
    attendanceSheet.getRange(2, COL.ATTENDANCE.DATE, attendanceRows, 1).getValues().forEach(function(row) {
      var date = normalizeStudentSheetDateValue_(row[0]);
      if (!date) return;
      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;
    });
  }

  var dayStatusSheet = getSheet_(SHEET.ATTENDANCE_DAYS);
  var dayLastRow = dayStatusSheet.getLastRow();
  var confirmedDays = 0;
  var draftDays = 0;
  if (dayLastRow > 1) {
    dayStatusSheet.getRange(2, COL.ATT_DAYS.STATUS, dayLastRow - 1, 1).getValues().forEach(function(row) {
      if (String(row[0] || '').trim() === 'confirmed') confirmedDays++;
      else draftDays++;
    });
  }

  var semester = getActiveSemesterRow_();
  var changeLogSheet = getSheet_(SHEET.CHANGE_LOG);

  return {
    students_total: allStudents.length,
    students_active: activeStudents.length,
    students_inactive: Math.max(0, allStudents.length - activeStudents.length),
    attendance_rows: attendanceRows,
    attendance_from: minDate,
    attendance_to: maxDate,
    confirmed_days: confirmedDays,
    draft_days: draftDays,
    change_log_rows: Math.max(0, changeLogSheet.getLastRow() - 1),
    calendar_entries: getSchoolCalendarEntriesForRange_(
      semester ? { from: semester.start_date, to: semester.end_date } : null
    ).length,
    active_semester: semester ? (semester.name + ' (' + semester.start_date + ' ถึง ' + semester.end_date + ')') : 'ไม่มี'
  };
}

function formatSeedStatusText_(report) {
  return 'ภาคเรียนที่ใช้งาน: ' + report.active_semester + '\n\n' +
    'นักเรียนทั้งหมด: ' + report.students_total + ' คน\n' +
    '  • ใช้งานอยู่: ' + report.students_active + ' คน\n' +
    '  • พ้นสภาพแล้ว: ' + report.students_inactive + ' คน\n\n' +
    'ข้อมูลเช็คชื่อ: ' + report.attendance_rows + ' แถว\n' +
    (report.attendance_rows ? '  • ช่วงวันที่: ' + report.attendance_from + ' ถึง ' + report.attendance_to + '\n' : '') +
    '\nสถานะวัน:\n' +
    '  • ยืนยันแล้ว: ' + report.confirmed_days + ' วัน (ขึ้นรายงาน)\n' +
    '  • ฉบับร่าง: ' + report.draft_days + ' วัน (ยังไม่ขึ้นรายงาน)\n\n' +
    'ปฏิทินวันเรียนในภาคเรียน: ' + report.calendar_entries + ' รายการ\n' +
    'ประวัติแก้ไข: ' + report.change_log_rows + ' แถว';
}

// ═══════════════════════════════════════════════════════════════════════
// เมนู 3: ล้างข้อมูลเช็คชื่อ
// ═══════════════════════════════════════════════════════════════════════

/**
 * ลบเฉพาะข้อมูลใน เช็คชื่อ / สถานะวัน / ประวัติแก้ไข
 * ★ ไม่แตะรายชื่อนักเรียน ไม่แตะชีตตั้งค่า ไม่แตะปฏิทิน ไม่ลบชีต ไม่ลบหัวตาราง
 */
function clearTestData() {
  var ui = SpreadsheetApp.getUi();
  var targets = [SHEET.ATTENDANCE, SHEET.ATTENDANCE_DAYS, SHEET.CHANGE_LOG];

  try {
    requireSeedLocalContext_();
  } catch (eGate) {
    ui.alert('เรียกใช้ไม่ได้', String(eGate && eGate.message ? eGate.message : eGate), ui.ButtonSet.OK);
    return;
  }

  var counts = targets.map(function(name) {
    return name + ': ' + Math.max(0, getSheet_(name).getLastRow() - 1) + ' แถว';
  }).join('\n');

  var confirmed = ui.alert(
    'ล้างข้อมูลเช็คชื่อ',
    'จะลบข้อมูลทั้งหมดในชีตต่อไปนี้ (เก็บหัวตารางไว้):\n\n' + counts + '\n\n' +
      'รายชื่อนักเรียน ปฏิทินวันเรียน และการตั้งค่า จะไม่ถูกแตะ\n' +
      'การลบนี้กู้คืนไม่ได้ ดำเนินการต่อหรือไม่?',
    ui.ButtonSet.OK_CANCEL
  );
  if (confirmed !== ui.Button.OK) return;

  var removed = withAttendanceMutationLock_(function() {
    var total = 0;
    targets.forEach(function(name) {
      var sheet = getSheet_(name);
      var lastRow = sheet.getLastRow();
      if (lastRow > 1) {
        // Sheets ปฏิเสธการลบแถวที่ไม่ถูกตรึงจนไม่เหลือสักแถว ("Sorry, it is not
        // possible to delete all non-frozen rows.") และทุกชีตในระบบนี้ตรึงหัวตาราง
        // ไว้แถวเดียว การสั่ง deleteRows(2, lastRow-1) จึงพังเสมอเมื่อล้างทั้งชีต
        // จึงเหลือแถวสุดท้ายไว้ 1 แถวแล้วล้างเนื้อหาแทน — พอไม่มีเนื้อหา
        // getLastRow() จะคืน 1 ระบบจึงมองว่าชีตว่างเหมือนเดิม
        if (lastRow > 2) sheet.deleteRows(2, lastRow - 2);
        sheet.getRange(2, 1, 1, sheet.getMaxColumns()).clearContent();
        total += lastRow - 1;
        Logger.log('[clear] ลบ ' + name + ' ' + (lastRow - 1) + ' แถว');
      }
    });
    clearSeedCaches_();
    return total;
  });

  ui.alert('✅ ล้างข้อมูลแล้ว', 'ลบไปทั้งหมด ' + removed + ' แถว และล้าง cache เรียบร้อย', ui.ButtonSet.OK);
}

// ═══════════════════════════════════════════════════════════════════════
// เมนู 4: เตรียมภาคเรียนทดสอบ
// ═══════════════════════════════════════════════════════════════════════

/**
 * แยกออกมาเป็นเมนูต่างหากโดยตั้งใจ — seedTestData_ จะไม่แก้ config เอง
 * เพราะถ้าการสร้างภาคเรียน/ปฏิทินมีบั๊ก การที่ seed สร้างให้จะกลบบั๊กนั้นพอดี
 */
function prepareTestSemester() {
  var ui = SpreadsheetApp.getUi();

  try {
    requireSeedLocalContext_();
  } catch (eGate) {
    ui.alert('เรียกใช้ไม่ได้', String(eGate && eGate.message ? eGate.message : eGate), ui.ButtonSet.OK);
    return;
  }

  var today = todayString_();
  var needFrom = shiftDate_(today, -SEED_DAYS_BACK);
  var needTo = today;

  var semester = getActiveSemesterRow_();
  var rows = getSemesterRows_();
  var message;
  var action;

  if (semester) {
    var newStart = semester.start_date && semester.start_date < needFrom ? semester.start_date : needFrom;
    var newEnd = semester.end_date && semester.end_date > needTo ? semester.end_date : needTo;
    if (newStart === semester.start_date && newEnd === semester.end_date) {
      ui.alert('ไม่ต้องแก้อะไร', 'ภาคเรียน "' + semester.name + '" ครอบคลุม ' + needFrom + ' ถึง ' + needTo + ' อยู่แล้ว', ui.ButtonSet.OK);
      return;
    }
    var overlap = findSemesterRangeOverlap_(rows, newStart, newEnd, semester.id);
    if (overlap) {
      ui.alert('ขยายภาคเรียนไม่ได้', 'ช่วงใหม่จะซ้อนกับภาคเรียน "' + overlap.name + '"\nกรุณาแก้ช่วงของภาคเรียนนั้นก่อน', ui.ButtonSet.OK);
      return;
    }
    action = 'extend';
    message = 'ขยายภาคเรียน "' + semester.name + '"\nจาก ' + semester.start_date + ' - ' + semester.end_date +
      '\nเป็น ' + newStart + ' - ' + newEnd;
  } else {
    var overlapNew = findSemesterRangeOverlap_(rows, needFrom, needTo, 0);
    if (overlapNew) {
      ui.alert('สร้างภาคเรียนไม่ได้', 'ช่วง ' + needFrom + ' ถึง ' + needTo + ' ซ้อนกับภาคเรียน "' + overlapNew.name + '"', ui.ButtonSet.OK);
      return;
    }
    action = 'create';
    message = 'สร้างภาคเรียนทดสอบใหม่\n' + needFrom + ' ถึง ' + needTo + '\nและตั้งเป็นภาคเรียนที่ใช้งานอยู่';
  }

  if (ui.alert('เตรียมภาคเรียนทดสอบ', message + '\n\nดำเนินการต่อหรือไม่?', ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) {
    return;
  }

  var sheet = getOrCreateSemesterSheet_();
  if (action === 'extend') {
    var startValue = semester.start_date < needFrom ? semester.start_date : needFrom;
    var endValue = semester.end_date > needTo ? semester.end_date : needTo;
    sheet.getRange(semester.row_index, SEMESTER_COL.START, 1, 2).setValues([[startValue, endValue]]);
  } else {
    deactivateAllSemesters_(sheet);
    sheet.appendRow([getNextSemesterId_(rows), 'ทดสอบ ' + today.slice(0, 4), needFrom, needTo, true]);
  }
  invalidateSemesterCaches_();

  var updated = getActiveSemesterRow_();
  ui.alert(
    '✅ เตรียมภาคเรียนแล้ว',
    'ภาคเรียนที่ใช้งานอยู่: ' + (updated ? updated.name + '\n' + updated.start_date + ' ถึง ' + updated.end_date : 'ไม่ทราบ') +
      '\n\nตอนนี้ใช้เมนู 🧪 [ทดสอบ] สร้างข้อมูลจำลอง ต่อได้',
    ui.ButtonSet.OK
  );
}

// ─── ล้าง cache ───────────────────────────────────────────────────────

/**
 * ใช้ชุดเดียวกับที่โค้ดจริงใช้ ไม่ได้เขียนวิธีล้างขึ้นมาใหม่
 * ถ้าไม่ล้าง หน้าเว็บจะยังเห็นข้อมูลเก่าจนกว่า cache จะหมดอายุเอง
 */
function clearSeedCaches_() {
  try { invalidateStudentCache_(); } catch (e) {}
  try { invalidateAttendanceCaches_(); } catch (e2) {}
  try { invalidateSchoolCalendarCaches_(); } catch (e3) {}
  try { invalidateSemesterCaches_(); } catch (e4) {}
  try { clearAttendanceDayStatusExecutionCache_(); } catch (e5) {}
  try { bumpDerivedDataCacheVersion_(); } catch (e6) {}
  try { CacheService.getScriptCache().remove('st'); } catch (e7) {}
}

// ─── ตัวช่วยเล็กๆ ─────────────────────────────────────────────────────

function countAttendanceRowsInRange_(sheet, from, to) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return 0;

  var count = 0;
  sheet.getRange(2, COL.ATTENDANCE.DATE, lastRow - 1, 1).getValues().forEach(function(row) {
    var date = normalizeStudentSheetDateValue_(row[0]);
    if (date && date >= from && date <= to) count++;
  });
  return count;
}
