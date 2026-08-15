# CLAUDE.md

## ระบบนี้คืออะไร
ระบบเช็คชื่อนักเรียนสำหรับครูประจำชั้น 1 คน / 1 ห้อง เขียนด้วย Google Apps Script แบบ container-bound
ใช้ Google Sheets เป็นฐานข้อมูล เปิดใช้ผ่าน Web App 3 หน้า (ครู / ผู้ปกครอง / หน้าพิมพ์)
ขายแบบครูแต่ละคน copy Spreadsheet + Script ไปเป็นของตัวเอง ไม่ใช่ระบบกลางของโรงเรียน

## โครงสร้างไฟล์
### Server
- `Code.js` — doGet routing, bootstrap data รายหน้า, ตัวโหลด client module/style
- `SheetDB.js` — นิยามชื่อชีต/คอลัมน์/สถานะ + CRUD พื้นฐาน + settings helper
- `Utils.js` — วันที่ไทย, cache helper, timing log, `setupSystem_`, เมนู `onOpen`, เครื่องมือรีเซ็ตฉุกเฉิน
- `SecurityService.js` — teacher session, CSRF, rate limit, trusted device, print/parent session, migration
- `AttendanceService.js` — อ่าน/เขียนการเช็คชื่อ, สถานะวัน draft/confirmed, alert ขาดติดกัน, cache, archive
- `StudentService.js` — CRUD นักเรียน, roster ตามช่วงวันที่, student identity index, `saveSettings`
- `ReportService.js` — dashboard, ตารางสรุป, daily grid, helper ช่วงวันที่/เดือน/ภาคเรียน
- `AnalyticsService.js` — risk score, เทียบเดือน, pattern การขาด, สถิติแยกเพศ
- `PrintService.js` — payload รายงาน ปพ.6 / รายวัน / นักเรียนที่ต้องติดตาม + บังคับ scope ของ print token
- `SemesterService.js` — ภาคเรียน (สร้าง/แก้/สลับ/ลบ/archive)
- `CalendarService.js` — ปฏิทินวันเรียน/วันหยุด
- `ParentService.js` — ออก/เพิกถอนลิงก์ผู้ปกครอง + payload หน้าผู้ปกครอง
- `EmailService.js` — อีเมลแจ้งผู้ปกครองรายวัน + preview
- `WeeklySummaryService.js` — trigger สรุปสัปดาห์ + HTML อีเมล
- `ImportService.js` — นำเข้า CSV รายชื่อ (preview → confirm)
- `BackupService.js` — สร้าง ZIP backup / preview / restore
- `PinService.js` — PIN ล็อกหน้าจอ
- `PhotoService.js` — ผูก Drive folder รูปนักเรียน
- `ProfileService.js` — หน้าประวัตินักเรียนรายคน (ฝั่งครู)
- `AttendanceSummaryService.js` — ชั้นสรุปถาวรรายภาคเรียน **ไม่มีไฟล์ไหนเรียกใช้เลย = dead code ทั้งไฟล์**
- `Diagnostics.js` — ไฟล์ทดสอบชั่วคราวสำหรับงานแก้ P0 (`runP0Diagnostics`) ลบทิ้งได้เมื่อทดสอบผ่านแล้ว

### Client
- `Index.html` — shell ของ Web App ครู + inline CSS ทั้งชุด
- `JavaScript.html` — แอปหลักฝั่ง client: auth, routing, lazy loader, หน้าเช็คชื่อ/นักเรียน/ตั้งค่า, `serverCall`
- `JsDashboard` / `JsReports` / `JsAnalytics` / `JsImport` / `JsProfile` / `JsPhotoGrid` — โมดูลรายหน้า โหลด lazy · `JsPin` — UI PIN lock
- `ParentView.html` / `PrintReport.html` — หน้าผู้ปกครอง / หน้าพิมพ์ (standalone ไม่ใช้ `JavaScript.html`)
- `Stylesheet` / `StyleReport` / `StylePhase3` / `StylePhase4` / `StylePin` — CSS

## Entry points
- `doGet(e)` [Code.js] — Web App แยกหน้าตาม `?page=` (dashboard / parent / print)
  **ต้อง deploy เป็น Web App จาก Apps Script UI เอง ตัว deployment ไม่ได้อยู่ในโค้ด** และไม่ติดไปกับการ copy Spreadsheet
  ตั้งไว้เป็น Execute as: Me + Who has access: **Anyone (anonymous)**
- `onOpen()` [Utils.js] — simple trigger สร้างเมนู 🎓 ในชีต (อยู่ในโค้ด ไม่ต้องตั้งเอง)
- เมนูในชีตเรียก: `setupSystem_`, `insertSampleData_`, `resetTeacherAccessKeyFromSheet_`,
  `resetTeacherDeviceBindingFromSheet_`, `openWebApp_`
- `sendWeeklySummary_(e)` [WeeklySummaryService.js] — time-driven trigger ทุกศุกร์ 16:00
  **ไม่อยู่ใน appsscript.json** ถูกสร้างตอน runtime โดย `enableWeeklySummary` จึงมีเฉพาะ copy ที่ครูกดเปิดเท่านั้น
- ฟังก์ชัน global ที่ไม่มี `_` ต่อท้าย ถูก expose ให้ `google.script.run` ทั้งหมด (~95 ตัว)
  client เรียกผ่าน `serverCall` / `serverCallQuiet` ใน `JavaScript.html` ซึ่งแนบ auth เป็น argument ตัวสุดท้ายเสมอ
- ด่านตรวจสิทธิ์กลางคือ `runAsTeacher_` → `requireTeacherSession_` [SecurityService.js]
- เรียกได้โดยไม่ต้องล็อกอิน: `getTeacherLoginOptions`, `bootstrapTeacherSession`, `runInitialSetup`,
  `resolvePrintSession`, `openParentSession`, `getParentViewDataBySession`, `logoutParentSession`
- ไม่มี `onEdit` / `onFormSubmit` / `doPost` และไม่มี library / advanced service / `UrlFetchApp` ในโปรเจกต์นี้
- Script Properties + OAuth authorization + trigger **ไม่ติดไปกับการ copy** ครูต้องกดเมนูติดตั้งและอนุญาตสิทธิ์เองทุกครั้ง

## โครงสร้างข้อมูล
| ชีต | คอลัมน์ |
|---|---|
| `นักเรียน` | A ID, B เลขที่, C ชื่อ-สกุล, D ชื่อเล่น, E เพศ, F กลุ่ม, G จับตา, H ใช้งาน, I วันที่สร้าง, J อีเมลผู้ปกครอง, K เริ่มอยู่ในห้อง, L พ้นจากห้อง (exclusive) |
| `เช็คชื่อ` | A ID, B เลขที่, C วันที่, D สถานะ, E หมายเหตุ, F Batch ID, G บันทึกเมื่อ, H แก้ไขเมื่อ, I student_id |
| `สถานะวัน` | A วันที่, B สถานะ (draft/confirmed), C ยืนยันเมื่อ |
| `ประวัติแก้ไข` | A ID, B เลขที่, C วันที่, D สถานะเดิม, E สถานะใหม่, F หมายเหตุเดิม, G หมายเหตุใหม่, H การกระทำ, I แก้ไขเมื่อ, J student_id |
| `ตั้งค่า` | A Key, B Value (key-value store) |
| `ปฏิทินวันเรียน` | A id, B วันที่, C ประเภท (school_day/holiday), D รายละเอียด |
| `ภาคเรียน` | A id, B ชื่อภาคเรียน, C วันเริ่มต้น, D วันสิ้นสุด, E ใช้งาน |
| `ลิงก์ผู้ปกครอง` | A student_number, B token (ล้างทิ้งเสมอ), C token_hash, D created_at, E expires_at, F revoked, G student_id |
| `_att_archive_<semesterId>` / `_att_day_archive_<semesterId>` | ชีตซ่อน โครงเดียวกับ `เช็คชื่อ` / `สถานะวัน` |
| `_timing_log` | ชีตซ่อน สำหรับ dev เท่านั้น จำกัด 1000 แถว |

- สถานะการเช็คชื่อมี 5 แบบ: `present` `late` `absent` `sick_leave` `personal_leave`
- **ของลับทั้งหมดอยู่ใน Script Properties ไม่อยู่ในชีตและไม่อยู่ในโค้ด** key: `teacher_access_key_hash`,
  `teacher_access_key_salt`, `teacher_trusted_devices`, `teacher_owner_email`, `teacher_session_generation`,
  `pin_hash`, `pin_salt`, `pin_failed_count`, `pin_lock_until` + flag เวอร์ชัน migration และ `derived_cache_version`
- Session ทุกชนิด (ครู / ผู้ปกครอง / print) เก็บใน CacheService ไม่ใช่ที่ถาวร ถูก evict ได้ตลอดเวลา
- ขนาดข้อมูล: 50 คน/ห้อง, 2 ภาคเรียน/ปี, เก็บหลายปี → `เช็คชื่อ` +~10,000 แถว/ปี, `ประวัติแก้ไข` +~10,000–20,000 แถว/ปี โดยไม่มีการตัดทิ้ง

## กติกาก่อนแก้โค้ด
- `clasp push` / `pull` **เขียนทับทั้งไฟล์ ไม่ merge แบบ git** → `clasp pull` ก่อนเริ่มงานทุกครั้ง
  และห้ามแก้บน Apps Script editor บนเว็บพร้อมกับแก้ในเครื่อง
- อ่าน/เขียน Sheet ต้องทำเป็น batch (`getValues` / `setValues`) **ห้ามวนลูป `getValue` / `setValue` ทีละเซลล์**
- ฟังก์ชันเดียวรันได้ไม่เกิน 6 นาที ระวังงานที่สแกนทั้งชีต, restore backup, และ migration
- ทดสอบในเครื่องไม่ได้ ต้อง `clasp push` แล้วไปกด Run บน Apps Script เสมอ
- ฟังก์ชัน global ที่ไม่มี `_` ต่อท้าย = เปิดให้เรียกจากอินเทอร์เน็ตทันที (web app เป็น anonymous)
  ฟังก์ชันภายในต้องเติม `_` ต่อท้ายเสมอ
- เขียน mutation ใหม่ต้องครอบด้วย `withAttendanceMutationLock_` หรือ `LockService.getDocumentLock()` และ `require_csrf: true`

## จุดที่ห้ามแตะโดยไม่ถามก่อน
- `deleteSheetRowsByIndexes_` [SheetDB.js] — ลบแถวโดยจัดกลุ่มแถวติดกันแล้วไล่จากล่างขึ้นบน ใช้ร่วมกันทั้ง
  archive ภาคเรียน / ล้างข้อมูลวันหยุด / ปฏิทินวันเรียน ถ้าแก้ลำดับการลบผิด แถวจะเลื่อนและลบผิดแถวแบบเงียบๆ
- `access: ANYONE_ANONYMOUS` ใน `appsscript.json` — **ห้ามเปลี่ยนเป็นบังคับล็อกอิน Google** เพราะหน้าผู้ปกครอง
  อยู่ใน deployment เดียวกันและจะเปิดไม่ได้ ผลคือ "รหัสครู" เป็นปราการเดียวจริงๆ
- `runAsTeacher_` / `requireTeacherSession_` / trusted device / session generation — แตะแล้วครูหลุดออกจากระบบทั้งหมด
- student identity key (`id:` / `num:`), roster bounds, `getUniqueLatestRecords_` — ตรรกะกลางที่ทุกรายงานใช้ร่วมกัน
- `calculateAttendancePercent_` / `basis_days` — ตัวเลขนี้ขึ้นเอกสารทางการ ปพ.6
- `ensureStudentIdentityMigration_` / `ensureSecurityMigration_` และสตริงเวอร์ชันของมัน — แก้แล้ว migration
  จะรันใหม่กับข้อมูลจริงของครู
- `restoreBackup` — เป็นช่องทางเดียวที่ครูซึ่งซื้อไปแล้วจะได้รับโค้ดเวอร์ชันใหม่
  `setupSystem_` ใช้ `getUi()` จึงเรียกได้จากเมนูในชีตเท่านั้น โค้ดฝั่ง Web App ต้องเรียก `ensureSystemSheets_` เสมอ
- `Utils.js` มี `onOpen`, `resetTeacherAccessKeyFromSheet_`, `resetTeacherDeviceBindingFromSheet_` อย่างละ 2 ชุด
  **ชุดหลังคือตัวที่ทำงานจริง** ชุดแรกเป็น dead code
