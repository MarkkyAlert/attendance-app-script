# ARCHITECTURE — ระบบทำงานยังไง

เอกสารนี้อธิบาย**กลไก** สำหรับคนที่ต้องแก้โค้ดต่อ
เหตุผลเบื้องหลังการตัดสินใจอยู่ที่ [DECISIONS.md](DECISIONS.md) · กติกาและจุดห้ามแตะอยู่ที่ [CLAUDE.md](CLAUDE.md)

อ้างอิงถึงระดับ **ชื่อไฟล์ + ชื่อฟังก์ชัน** ไม่ลงเลขบรรทัด (เลขบรรทัดผิดทันทีที่แก้โค้ด และไม่มีใครไล่อัปเดต)
ทุกชื่อในเอกสารนี้ `grep` เจอได้จริง

---

## สารบัญ

1. [ข้อจำกัดที่กำหนดรูปร่างทุกอย่าง](#1-ข้อจำกัดที่กำหนดรูปร่างทุกอย่าง)
2. [3 หน้าที่แยกขาดจากกัน](#2-3-หน้าที่แยกขาดจากกัน)
3. [ด่านตรวจสิทธิ์ — กฎข้อ 1](#3-ด่านตรวจสิทธิ์--กฎข้อ-1)
4. [Session 3 ชนิด](#4-session-3-ชนิด)
5. [เส้นทางของหนึ่งคำขอ](#5-เส้นทางของหนึ่งคำขอ)
6. [ฝั่ง client](#6-ฝั่ง-client)
7. [ตรรกะกลางที่ทุกรายงานใช้ร่วมกัน](#7-ตรรกะกลางที่ทุกรายงานใช้ร่วมกัน)
8. [Cache](#8-cache)
9. [วงจรชีวิตข้อมูล](#9-วงจรชีวิตข้อมูล)
10. [กับดักที่รู้ได้จากของจริงเท่านั้น](#10-กับดักที่รู้ได้จากของจริงเท่านั้น)
11. [ทดสอบและ deploy](#11-ทดสอบและ-deploy)
12. [Checklist เพิ่มหน้าใหม่](#12-checklist-เพิ่มหน้าใหม่)

---

## 1. ข้อจำกัดที่กำหนดรูปร่างทุกอย่าง

| ข้อจำกัด | ผลต่อโค้ด |
|---|---|
| ฟังก์ชันเดียวรันได้ไม่เกิน **6 นาที** | migration / restore / archive ต้องระวังชีตใหญ่ |
| **ไม่มี build step ไม่มี transpiler** | ต้องเป็น ES5 (`var`, `function`) ทั้งโปรเจกต์ ไม่มี arrow function ไม่มี `let/const` |
| **ทดสอบในเครื่องไม่ได้** | ต้อง `clasp push` → deploy → ทดสอบบนของจริงเสมอ ดูข้อ 11 |
| **Sheets ไม่มี transaction** | ต้องใช้ `LockService` เอง และเขียนแบบ batch (`getValues`/`setValues`) ห้ามวนลูปทีละเซลล์ |
| **CacheService ถูก evict ได้ตลอด** | session ทุกชนิดอยู่บนนี้ → ครูหลุดออกจากระบบแบบสุ่มได้ ไม่ใช่บั๊ก |
| **`ANYONE_ANONYMOUS`** | ทุกฟังก์ชัน global ที่ไม่มี `_` ต่อท้าย = endpoint สาธารณะ ดูข้อ 3 |
| **`executeAs: USER_DEPLOYING`** | โค้ดรันด้วยสิทธิ์เต็มของครูเสมอ ไม่ว่าใครเรียก |

สองบรรทัดสุดท้ายอยู่ใน `appsscript.json` และเป็นที่มาของงานความปลอดภัยทั้งหมดใน `SecurityService.js`
ระบบต้องสร้างชั้นสิทธิ์ของตัวเองขึ้นมาใหม่ทั้งหมดในระดับแอปพลิเคชัน

---

## 2. 3 หน้าที่แยกขาดจากกัน

`doGet` ใน `Code.js` แยกด้วย `?page=`:

| หน้า | ไฟล์ | สถาปัตยกรรม |
|---|---|---|
| ครู (default) | `Index.html` + `JavaScript.html` + `Js*.html` | SPA มี state กลาง มี lazy module |
| ผู้ปกครอง (`?page=parent`) | `ParentView.html` | standalone IIFE ก้อนเดียว CSS inline |
| พิมพ์ (`?page=print`) | `PrintReport.html` | standalone IIFE ก้อนเดียว CSS inline |

**ทำไมไม่แชร์โค้ดกัน** — เป็นการตัดสินใจ ไม่ใช่ความมักง่าย:

1. **คนละ auth model** — ครูใช้ teacher session + CSRF + device, ผู้ปกครองใช้ parent session,
   หน้าพิมพ์ใช้ print session ที่ล็อก scope ถ้าใช้ `serverCall` ร่วมกันจะแนบ auth ผิดชนิด
2. **ผู้ปกครองไม่ควรได้โค้ดของครู** — `JavaScript.html` มีตรรกะแก้ไขข้อมูลและชื่อ RPC ทั้งหมด
   ส่งไปให้ผู้ปกครองคือแจกแผนที่ระบบฟรี ทั้งที่ deployment เป็น anonymous
3. **2 หน้านี้ไม่ผ่าน template engine** — `doGet` คืน `createHtmlOutputFromFile` ไม่ใช่ `createTemplateFromFile`
   จึงใช้ `include_` ไม่ได้ ต้อง self-contained โดยบังคับ

**ราคาที่จ่าย**: โค้ดซ้ำหลายชุด (`esc`, `formatPercentLabel`, icon renderer, การหาวันที่ Bangkok) ดูข้อ 10

---

## 3. ด่านตรวจสิทธิ์ — กฎข้อ 1

> **ฟังก์ชัน global ที่ไม่มี `_` ต่อท้าย = เปิดรับจากอินเทอร์เน็ตทันที**
> **ไม่มีการบังคับด่านที่ระดับ framework** เขียนฟังก์ชันใหม่แล้วลืมครอบด่าน ก็ไม่มีอะไรเตือน
> ฟังก์ชันภายในต้องเติม `_` ต่อท้ายเสมอ

ฟังก์ชัน public ทุกตัวต้องผ่านด่าน และด่านมี **4 แบบ** ไม่ใช่แบบเดียว — เลือกให้ตรงกับผู้เรียก:

| ด่าน | ใช้กับ | อยู่ที่ |
|---|---|---|
| `runAsTeacher_` | งานฝั่งครูทั้งหมด (ส่วนใหญ่ของระบบ) | `SecurityService.js` |
| `runAsPrintViewer_` | หน้าพิมพ์ | `PrintService.js` |
| `runAsParentSession_` | หน้าผู้ปกครอง | `SecurityService.js` |
| `issueParentLinkForTeacher_` | ออกลิงก์ผู้ปกครอง (ห่อด่านครูอีกที) | `ParentService.js` |
| `requireSeedLocalContext_` / `requireP0DiagnosticLocalContext_` | เครื่องมือ dev | `SeedTestData.js` / `Diagnostics.js` |
| **ไม่มีด่าน (ตั้งใจ)** | ดูตารางถัดไป | |

### ฟังก์ชันที่เรียกได้โดยไม่มีด่านเลย

| ฟังก์ชัน | ทำอะไรได้ |
|---|---|
| `doGet` `onOpen` | จุดเข้าของ Web App / เมนูชีต |
| `getTeacherLoginOptions` | บอกว่าตั้งรหัสครูแล้วหรือยัง |
| `bootstrapTeacherSession` | แลกรหัสครูเป็น session |
| `runInitialSetup` | ตั้งค่าครั้งแรก — **ยึดครองระบบได้ถ้ายังไม่มีรหัสครู** |
| `openParentSession` `resolvePrintSession` | แลก token เป็น session (ตรวจ token ด้วยตัวเอง) |
| `thaiDate` `thaiMonthLabel` | จัดรูปแบบวันที่ล้วน ไม่มีข้อมูล |

> `getParentViewDataBySession` และ `logoutParentSession` **ไม่ต้องล็อกอินครู** แต่มีด่าน `runAsParentSession_`
> — "ไม่มีด่าน" กับ "ด่านคนละชนิด" ไม่เหมือนกัน

### ด่าน local context — แพทเทิร์นสำหรับเครื่องมือ dev

`Session.getActiveUser().getEmail()` **คืนค่าว่างเสมอเมื่อถูกเรียกผ่าน `google.script.run`
บน deployment แบบ anonymous** แต่คืนอีเมลจริงเมื่อรันจาก Apps Script editor หรือเมนูในชีต
จึงใช้ "มีอีเมลไหม" เป็นด่านได้

ต้องเป็นแบบนี้เพราะ **ช่องเลือกฟังก์ชันของ Apps Script editor ไม่แสดงฟังก์ชันที่ลงท้ายด้วย `_`**
ประตูเข้าจึงต้องเป็น public แล้วกันด้วยด่านนี้แทน
(`SpreadsheetApp.getUi()` ใช้เป็นด่านไม่ได้ เพราะ throw ตอนรันจาก editor ด้วย ไม่ใช่เฉพาะจาก Web App)

`requireSeedLocalContext_` เข้มกว่าอีกชั้น — ต้องตรงกับ `getTeacherOwnerEmail_()` ด้วย

### Trust stack — จุดที่ต้องระวังที่สุด

`runAsTeacher_` เช็ค `isTeacherTrustedContext_()` ก่อน ถ้า `TEACHER_TRUST_STACK_` ไม่ว่างจะ
**ข้ามการตรวจทั้งหมด** — ทำให้ฟังก์ชัน public เรียกซ้อนกันเองได้โดยไม่ต้องส่ง auth ต่อ
(เช่น `getInitialData` เรียก `getPinState()` เปล่าๆ ได้)

ทุกจุดที่ push ใช้ `try/finally` ถูกต้องแล้ว และ GAS ให้ context ใหม่ทุก execution จึงไม่รั่วข้าม request
**แต่สมมติฐานนี้พังทันทีถ้ามีใครเพิ่ม push โดยไม่มี `finally`**

`runAsTrustedTeacher_` ให้สิทธิ์เต็มโดยไม่ตรวจอะไรเลย ปัจจุบันถูกเรียกจาก 2 จุดที่เข้าถึงได้จาก
editor/เมนูเท่านั้น — **ห้ามให้ฟังก์ชัน public เรียกเด็ดขาด**

### CSRF

สร้างพร้อม session ส่งกลับผ่าน `buildTeacherAuthPayload_` client เก็บคู่กับ session token
ตรวจใน `requireTeacherSession_` เมื่อผู้เรียกส่ง `options.require_csrf: true`

**mutating endpoint สาธารณะทุกตัวมี `require_csrf: true` ครบ** ส่วน read-only ไม่ตรวจโดยตั้งใจ
เขียน mutation ใหม่ต้องใส่ด้วยเสมอ

> `google.script.run` ไม่ส่ง ambient cookie อยู่แล้ว CSRF แบบคลาสสิกจึงเกิดไม่ได้เชิงโครงสร้าง
> ค่าจริงของ `csrf_token` คือ **ความลับชั้นที่สองสำหรับการเขียนข้อมูล** ไม่ได้ช่วยถ้าโดน XSS เพราะเก็บที่เดียวกัน

### ⚠️ ด่านตรวจอีเมลเจ้าของไม่ทำงาน — อย่าพึ่ง

`bootstrapTeacherSession` มีโค้ดที่ *ดูเหมือน* บังคับว่าต้องเป็นบัญชี Google ของครู:

```
resolvedEmail = getVerifiedTeacherPrincipalEmail_() || getSingleTeacherEmail_()
if (ownerEmail && ownerEmail !== resolvedEmail) → ปฏิเสธ
```

แต่ `getSingleTeacherEmail_` fallback ไป `Session.getEffectiveUser()` ซึ่งภายใต้ `executeAs: USER_DEPLOYING`
**คืนอีเมลเจ้าของสคริปต์เสมอไม่ว่าใครเรียก** → ผู้เรียกนิรนามได้ค่าเท่ากับ `ownerEmail` เป๊ะทุกครั้ง
→ **ทั้งสองเงื่อนไขไม่มีทางปฏิเสธ**

**สิ่งที่กันจริงคือรหัสครู + โควตาอุปกรณ์ 5 เครื่อง เท่านั้น** เขียนไว้ตรงนี้เพราะคนอ่านโค้ดจะคิดว่ามีชั้นป้องกัน
ที่ไม่มีอยู่จริง — ตรงกับที่ `CLAUDE.md` เขียนว่า "รหัสครูเป็นปราการเดียวจริงๆ"

---

## 4. Session 3 ชนิด

ทุกชนิดอยู่บน **CacheService เท่านั้น ไม่มีที่เก็บถาวร**

| ชนิด | อายุ | ต่ออายุ | ที่เก็บฝั่ง client |
|---|---|---|---|
| ครู | **2 ชม.** (`SECURITY.SESSION_TTL_SEC`) | `touchTeacherSession_` ทุกครั้งที่ผ่านด่าน (sliding) | `sessionStorage` — ตายเมื่อปิดแท็บ |
| ผู้ปกครอง | **1 ชม.** | `touchParentSession_` | `sessionStorage` |
| print | **120 วิ** | `touchPrintSession_` | ไม่เก็บ (ใช้แล้วทิ้ง) |

`device_id` เก็บ **`localStorage`** ต่างหาก เพราะต้องอยู่ข้ามการปิดแท็บ

### `requireTeacherSession_` ตรวจ 5 ด่านเรียงกัน

1. มี `session_token` → ไม่มี = `AUTH_REQUIRED|...`
2. หา session ในแคชได้ + ยังไม่หมดอายุ → `AUTH_EXPIRED|...`
3. `session_generation` ตรงกับค่าปัจจุบัน → ไม่ตรง = ลบ session + `AUTH_EXPIRED`
4. `device_id` ตรง regex **และ** ตรงกับที่ผูกใน session **และ** ยังอยู่ในรายการ trusted
5. `require_csrf` → `csrf_token` ตรง → ไม่ตรง = `CSRF_INVALID|...`

ฝั่ง client แยกทางด้วย prefix เหล่านี้ผ่าน `parseServerError_` — **แก้ข้อความ error ได้ แต่ห้ามแก้ code นำหน้า**

### `teacher_session_generation` — kill switch

เก็บใน Script Properties ฝังลงใน session ตอนสร้าง `rotateTeacherSessionGeneration_` เพิ่มค่าเมื่อ:
เปลี่ยนรหัสครู · `resetTeacherDeviceBinding` · เมนูรีเซ็ตรหัสในชีต · เมนูรีเซ็ตอุปกรณ์ในชีต

ผลคือ **ล้าง session ทุกเครื่องพร้อมกันในคำสั่งเดียว** โดยไม่ต้องไล่ลบ cache

### Trusted device — ชื่อชวนเข้าใจผิด

`device_id` เป็นสตริงที่ **browser สุ่มเอง** (`crypto.getRandomValues` 24 ตัว) เก็บใน localStorage
ฝั่ง server ตรวจแค่ regex `^[A-Za-z0-9_-]{24,128}$` ไม่มี fingerprint ไม่มี IP ไม่มี signature

สิ่งที่มันกันได้จริงคือ **session token ที่หลุดไปเฉยๆ ใช้ไม่ได้ถ้าไม่มี device id คู่กัน** + **เพดาน 5 เครื่อง**
อธิบายให้ถูกคือ *"ความลับชั้นที่สอง + โควตา"* ไม่ใช่ *"device binding"*

`isTrustedTeacherDeviceQuotaFull_` **ปฏิเสธเครื่องที่ 6 (fail-closed)** ไม่เบียดเครื่องเก่าออก
ผลข้างเคียงที่ต้องรู้: คนที่รู้รหัสครูยิง 5 ครั้งด้วย device id สุ่ม จะ**ล็อกครูออกจากระบบถาวร**
กู้ได้ทางเมนูในชีตเท่านั้น (`resetTeacherDeviceBindingFromSheet_`) ซึ่งเป็น out-of-band channel
ที่คนจากอินเทอร์เน็ตเข้าไม่ถึง

### Print session — token exchange แบบใช้ครั้งเดียว

หน้าพิมพ์เปิดเป็นแท็บใหม่ ซึ่งเข้าไม่ถึง `sessionStorage` ของแท็บเดิม จึงไม่ส่ง session ครูไปใน URL
(จะไปโผล่ใน address bar / history) แต่ใช้ handshake 2 จังหวะแทน:

1. `createPrintSession` (ด่านครู + CSRF) → `normalizePrintRequestContext_` whitelist type ∈ `{pp6, daily, absent}`
   → คืน exchange token อายุ 120 วิ
2. `resolvePrintSession(token)` (ไม่ต้องล็อกอิน) → **ลบ exchange token ทิ้งทันทีไม่ว่าผลจะเป็นอย่างไร**
   → ออก print session ที่ scope ล็อกไว้แล้ว

`enforcePrintRequestScope_` บังคับว่า `report_type` ต้องตรงเป๊ะ และวันที่/ช่วงวันต้องตรงเป๊ะ
**ต่อให้ print token หลุด ก็เอาไปดึงรายงานอื่นหรือช่วงเวลาอื่นไม่ได้**

ฝั่ง client มี fallback ผ่าน `localStorage` (`consumePendingPrintToken_`) เพราะบาง browser
ตัด query param ตอนเปิดแท็บใหม่จากใน iframe ของ Apps Script — ตรวจว่า type/date ตรงกันก่อนยอมใช้

### PIN ไม่ใช่ security boundary

`verifyPin` อยู่ **ข้างใน** `runAsTeacher_` แปลว่าต้องมี session ครูที่ใช้ได้อยู่แล้วถึงจะเรียกได้
**ตอนที่ UI ขึ้นหน้าล็อก PIN ทุก endpoint ครูยังเรียกได้ปกติด้วย session เดิม**

PIN คือ UI lock ล้วนๆ กันคนหยิบเครื่องที่ล็อกอินค้างไปใช้ — **ห้ามเอาไปกันข้อมูลอ่อนไหวใดๆ**

| | รหัสครู | PIN |
|---|---|---|
| หน้าที่ | **สร้าง** session | ไม่สร้างอะไรเลย |
| ข้อกำหนด | ≥12 ตัว มีทั้งอักษรและตัวเลข | ตัวเลข 4-6 หลัก |
| lockout | rate limit อย่างเดียว | ผิด 5 ครั้ง → ล็อก 15 นาที (เก็บใน Script Properties จึงถาวร **และ global ทั้งระบบ**) |

### Rate limit — best-effort ไม่ใช่การรับประกัน

`enforceRateLimit_` เก็บ counter บน CacheService (evict ได้) และ `cache.put` รีเซ็ต TTL ทุกครั้ง
→ เป็น **sliding window** ยิงต่อเนื่องจะโดนแบนยาวขึ้นเรื่อยๆ

bucket ที่เป็น **ทั้งระบบ** (ไม่มีมิติผู้เรียก เพราะ anonymous จึงแยกผู้เรียกไม่ได้) เป็นช่อง DoS:
`teacher_login_options` · `initial_setup` · `login_global`
ใครยิงรัวๆ ก็ทำให้ครูตัวจริงล็อกอินไม่ได้ — เป็น known limitation ของ `ANYONE_ANONYMOUS` ไม่มีทางแก้สมบูรณ์

---

## 5. เส้นทางของหนึ่งคำขอ

```
[client] ครูกดปุ่ม
  → serverCall('recordAttendance', [args])          JavaScript.html
      push(getTeacherAuth())  ← auth เป็น argument ตัวสุดท้ายเสมอ
  → google.script.run.recordAttendance(...)
      ↓
[server] recordAttendance(..., auth)                AttendanceService.js
  → runAsTeacher_(auth, {require_csrf: true, rate_limit_key: ...}, fn)
      → requireTeacherSession_  (5 ด่าน)
      → enforceRateLimit_
      → TEACHER_TRUST_STACK_.push
  → withAttendanceMutationLock_(fn)                 LockService document lock 30 วิ
      → อ่าน/เขียนชีตแบบ batch
      → logAsync_                                   ประวัติแก้ไข (try/catch เงียบ)
      → invalidateAttendanceCaches_                 bump derived_cache_version
      ↓
[client] callback → เขียน state → render → toast
```

**ข้อยกเว้นเดียว**: `bootstrapTeacherSession` เรียก `google.script.run` ตรงๆ ไม่ผ่าน `serverCall`
เพราะยังไม่มี auth จะแนบ

---

## 6. ฝั่ง client

### State

`var state` ใน `JavaScript.html` ถูก export เป็น `window.AppState` — **เป็น object เดียวกัน ไม่ใช่ copy**
โมดูล `Js*` รับมาเป็นตัวแปรชื่อ `S` และ**เขียนทับได้อิสระ** ไม่มี setter ไม่มี event ไม่มี subscription

⚠️ มี key ที่ **ไม่อยู่ใน object literal เริ่มต้น** แต่ถูกยัดเข้าไปตอน runtime เท่าที่พบ —
`semesters`, `activeSemester`, `pinState`, `studentSummary`, `calendarFilter`
อ่านจาก declaration จะไม่เห็น ต้อง `|| {}` ป้องกันเสมอ (ดู `getSchoolCalendarFilter_` เป็นตัวอย่างการป้องกัน)

### Render — full replace ไม่ใช่ partial

ไม่มีฟังก์ชัน `render()` ตัวเดียว มี render ต่อหน้า (`renderAttendancePage`, `renderStudentsPage`,
`renderSettingsPage`, และ `window.XxxPage.render(state)` ในโมดูล) ทุกตัวจบด้วย `panel.innerHTML = html`

ผลคือ **focus, scroll position และค่าใน `<input>` ที่ยังไม่ commit หายหมด**
จึงมี partial render เป็นข้อยกเว้นเฉพาะจุดที่เคยเจอปัญหาจริง:
`refreshAttendanceList_` · `recalcSummary_` · `refreshSchoolCalendarList_`
รวมเป็น `syncAttendanceViewAfterStateChange_` ใช้หลัง optimistic update

### Optimistic UI

`markStatus` / `undoStatus` / `saveNote` deep-clone ค่าเดิม เขียน state ทันที render แล้วค่อยยิง server
ล้มเหลวก็ rollback

⚠️ rollback ถือ **reference** เข้า `state.attendance.students[i]` — ถ้าระหว่างรอ server ผู้ใช้เปลี่ยนวันที่
(`loadAttendance` แทน `state.attendance` ทั้งก้อน) rollback จะเขียนลง object เก่าที่หลุดจาก state แล้ว เงียบสนิท

### Routing

`navigateTo(page, options)` เช็ค allowlist `VALID_PAGES` → เขียน `state.page` → sync URL ด้วย
`pushState`/`replaceState` → `loadPage(page)`

`loadPage` ยิง 2 promise **ขนานกัน** แล้ว `Promise.all`:
- `fetchPageInitialData_(page)` — bootstrap data 1 round-trip
- `ensurePageStylesLoaded` + `ensurePageModuleLoaded` — โหลด deps แล้ว render skeleton

**ไม่มี timeout ไม่มี retry ไม่มี request queue** — ถ้า Apps Script ค้าง callback ไม่ถูกเรียกก็ค้างตลอดกาล
มีแค่ `schedulePageLoadTimeout_` 30 วิ ที่เปลี่ยน**ข้อความ**เป็น "กำลังโหลดนานกว่าปกติ" ไม่ยกเลิกอะไร

กัน race ด้วย **load token** แทน cancellation: `beginPageLoad_` เพิ่ม counter คืน token
ทุก callback เช็ค `isActivePageLoad_(token)` ผลของ request เก่าถูก**ทิ้งเงียบๆ** ไม่ใช่ยกเลิกจริง

`switchTab` ไม่ใช่ routing ระดับ core — เป็น tab ภายในหน้ารายงานใน `JsReports.html` เท่านั้น
`preserveView` แปลว่า **"อย่า re-render ก่อนยิง request"** เคยใช้ผิดที่จนสถานะ "กำลังโหลด" ไม่ถูก render
ครูเลยเห็น "ยังไม่มีรายงานรายวัน" ค้าง — อ่านเหมือน "ไม่มีข้อมูล" มีคอมเมนต์เตือนไว้ในไฟล์แล้ว

### Lazy loader

โมดูล `Js*` ไม่ได้ inline — ถูกดึงจาก server เป็น **JS ดิบเป็น string** ผ่าน `getClientModuleContent`
(ซึ่งอยู่หลังด่านครู) แล้ว `injectClientModuleScript_` สร้าง `<script>` ใส่ `.text` แล้ว `appendChild`
การรัน IIFE ในไฟล์นั้นคือการ "ติดตั้ง" `window.XxxPage` ตัวจริง

- dedupe/cache ด้วย `clientModulePromises[name]` — เรียกซ้ำระหว่างโหลดได้ promise เดิม
- ล้มเหลวแล้ว set เป็น `null` เพื่อให้ retry ได้
- ฝั่ง server มี allowlist ของตัวเอง (`moduleMap` ใน `Code.js`)
- `ProfilePage` มี **lazy stub** ที่มี `__isLazyStub: true` เพื่อให้ `onclick="ProfilePage.open(...)"`
  ใน HTML string ทำงานได้โดยไม่ต้องรู้ว่าโหลดหรือยัง
- `JsPin` **ไม่ lazy** — inline ใน `Index.html` เพราะ PIN lock ต้องพร้อมทุกหน้า

### สัญญาระหว่าง core กับโมดูล

ไม่มี module system ไม่มี event bus — **ทางเดียวคือ global บน `window`**

- core → โมดูล: `window.XxxPage.render(state)` (**บังคับ**) และ `renderLoading(state)` (ไม่บังคับ)
- โมดูล → core: `window.AppShared` — surface กลาง (`serverCall`, `navigateTo`, `toast`,
  `showModal`, `esc`, `ensureClientModuleLoaded`, ... — ดูรายการเต็มที่ท้าย `JavaScript.html`)
- โมดูล → state: เขียน `S.xxx = ...` ตรงๆ
- HTML → ทุกคน: `onclick="ReportsPage.switchTab('daily')"` ในสตริง — **สัญญาที่มองไม่เห็นจาก static analysis**

⚠️ โมดูลต้องเรียก `init()` ซ้ำที่ต้นทุก public method เพราะไม่รับประกันลำดับการโหลด — เป็น defensive pattern
ที่ต้องทำตาม ถ้าลืมใน method ไหน `S`/`E` จะเป็น `undefined` เฉพาะ path นั้น

### CSS

| ไฟล์ | ขอบเขต |
|---|---|
| `Stylesheet.html` | **base + design token ทั้งหมด** มี `:root` ตัวเดียวของโปรเจกต์ + nav + ปุ่ม + card + modal + หน้าเช็คชื่อ + หน้านักเรียน |
| `StyleReport.html` | dashboard + reports + analytics · `.rpt-*` · daily grid · `@media print` |
| `StylePhase3.html` | Profile modal, Import, Settings |
| `StylePhase4.html` | Photo grid, risk score, analytics เชิงลึก |
| `StylePin.html` | PIN overlay |

**"Phase3 / Phase4" คือชื่อตาม *เฟสการพัฒนา* ไม่ใช่ตามโดเมน** — comment หัวไฟล์บอกไว้ว่าคืออะไร
ชื่อนี้ไม่บอกอะไรกับคนที่มาทีหลัง แต่ตอนนี้ชื่อไปผูกอยู่ที่เดียวคือ `include_` ใน `Index.html`
(เดิมต้องตรงกัน 4 ที่ เพราะมีเส้นทาง lazy ซ้อนอยู่ — ตัดทิ้งแล้ว ดูหัวข้อถัดไป)

### ★ CSS ส่งทางเดียวคือ inline — ไม่มีเส้นทาง lazy แล้ว

ทั้ง 5 ไฟล์ถูก `include_` ใน `Index.html` ตั้งแต่ `doGet` **จบแค่นั้น**

เดิมมีเส้นทางที่สองซ้อนอยู่: `ensureClientStyleLoaded` ยิง `getClientStyleContent` มาแปะเป็น
`<style id="client-style-X">` อีกชุด · `isClientStyleLoaded_` เช็คจาก `id` ซึ่ง**ตัวจาก `include_` ไม่มี**
จึงมองไม่เห็นของเดิมแล้วโหลดซ้ำเสมอ ผลคือ
- เสีย round-trip ต่อการเปลี่ยนหน้าโดยไม่ได้อะไรเพิ่ม (ขนาดหน้าแรกเท่าเดิมอยู่แล้ว)
- มี CSS สองชุดซ้อนกันใน DOM
- **ตัวจาก cache (เก่าได้ถึง 15 นาที) ถูก `appendChild` ทีหลังจึงชนะ cascade**
  → แก้ CSS แล้วเห็นของใหม่แวบหนึ่งก่อนโดนของเก่าทับ ซึ่ง debug ยากมาก

ตัดออกในรอบที่ 4 · `getClientStyleContent` และ `extractClientStyleContent_` ถูกลบทิ้ง
(ฟังก์ชัน public ลดไป 1 ตัว) · **ถ้าจะกลับมาทำ lazy CSS ต้องเอา `include_` ออกจาก `Index.html`
พร้อมกัน** ไม่งั้นกลับไปมีสองทางเหมือนเดิม

`StyleReport` / `StylePhase3` / `StylePhase4` **ใช้ `var(--...)` แต่ไม่นิยามเอง** → พึ่ง `Stylesheet` ที่ต้องมาก่อนเสมอ
ส่วน `ParentView.html` / `PrintReport.html` **ไม่ใช้ CSS variable เลย** hardcode hex ตรงๆ → เปลี่ยนธีมต้องไล่แก้ 3 ที่

---

## 7. ตรรกะกลางที่ทุกรายงานใช้ร่วมกัน

ส่วนนี้คือหัวใจ **`CLAUDE.md` ระบุว่าห้ามแตะโดยไม่ถามก่อน** — ด้านล่างคือเหตุผลว่าทำไม

### `getUniqueLatestRecords_` (`StudentService.js`)

**ปัญหาที่แก้**: ชีต `เช็คชื่อ` เป็น append-only และ**มีหลายแถวต่อ (นักเรียน, วัน) ได้จริง** —
`recordAttendance` เขียนทับได้เฉพาะเมื่อหาแถวเจอ ส่วน `bulkMarkPresent` ต่อท้ายอย่างเดียว
race / เขียนแทรก / import ซ้ำ จะได้แถวซ้ำ

**วิธี**: ทำ dict `latestByKey[studentKey|date]` ไล่จากบนลงล่าง แถวล่างชนะ (= ล่าสุด) คงลำดับที่พบครั้งแรกไว้

**ถ้าไม่มี**: นักเรียนที่มี 2 แถวถูกนับ 2 ครั้ง → `present_count` เกินจำนวนวัน → **เปอร์เซ็นต์ ปพ.6 ผิด**

⚠️ **escape hatch**: `opts.records_are_unique === true` ข้าม dedupe แล้ว `slice()` เฉยๆ
ผู้เรียกที่ dedupe มาแล้วส่ง flag นี้เพื่อไม่จ่ายค่าซ้ำ **ส่งผิด = ตัวเลขซ้ำแบบไม่มี error**

### Student identity key — `id:` / `num:`

`getRecordStudentKey_`: มี `student_id` ใช้ `'id:' + id` ไม่มีก็ `'num:' + เลขที่`

**ทำไมมีสองแบบ**: ข้อมูลรุ่นเก่ามีแค่ "เลขที่" ซึ่ง **ไม่เสถียร** — ครูสลับเลขที่กันได้,
นักเรียนออกแล้วมีคนใหม่ใช้เลขที่เดิม, เลขที่ซ้ำได้ระหว่าง active/inactive
จึงเพิ่ม `student_id` (immutable) เป็น key หลัก และเก็บ `num:` เป็น fallback สำหรับแถวที่ backfill ไม่สำเร็จ

เมื่อ key เป็น `num:` ต้องแก้กำกวมด้วย `pickBestStudentCandidate_` เรียงลำดับ:
อยู่ใน roster วันนั้น → `is_active` → `enrolled_from` ใหม่กว่า → `id` มากกว่า
(`resolveRecordStudent_` memo ผลไว้กัน N² ตอนสแกนพันแถว)

### Roster bounds — half-open `[start, end)`

คอลัมน์ K `เริ่มอยู่ในห้อง` / L `พ้นจากห้อง` อ่านผ่าน `getStudentRosterBounds_`
`isStudentInRosterOnDate_` ตัดสินแบบนี้:

```js
if (startDate && date <  startDate) return false;   // start inclusive
if (endDate   && date >= endDate)   return false;   // end EXCLUSIVE
```

**`inactive_at` เองถือว่าไม่อยู่ในห้องแล้ว** — ครูกรอก "พ้นจากห้อง 1 ก.ย." หมายถึง 31 ส.ค. เป็นวันสุดท้ายที่นับ
ตรงกับความรู้สึกของครู และทำให้ย้ายเข้า-ออกวันเดียวกันไม่นับซ้อน
เวลาแปลงกลับเป็น inclusive ต้อง `shiftDate_(endDate, -1)` (ดู `doesStudentRosterOverlapRange_`)

ใช้ที่ `getStudentsForAttendanceDate_` · `buildStudentRecordBuckets_` · `getOfficialStudentsForRange_` ·
`pickBestStudentCandidate_` · `getStudentSchoolDayCountForContext_` — **ทุกรายงานมาบรรจบที่นี่**

### `calculateAttendancePercent_` / `basis_days` — ตัวเลขที่ขึ้นเอกสารราชการ

```
basis_days  = max(0, school_days − (sick_leave + personal_leave))
attend_days = min(present + late, basis_days)
percent     = round(attend_days / basis_days × 1000) / 10
ถ้า basis_days <= 0 → return null   ← ไม่ใช่ 0
```

**`percent === null` แปลว่า "ยังวัดไม่ได้" ต่างจาก 0% — ฝั่ง client ต้องแยกสองกรณีนี้**

`school_days` ไม่ใช่ "จำนวนวันในช่วง" แต่คือ **จำนวน `measurement_day_dates` ที่ตกอยู่ในช่วง roster
ของเด็กคนนั้น** (binary search ใน `getStudentSchoolDayCountForContext_`) → เด็กที่ย้ายเข้ากลางเทอม
ได้ตัวหารเล็กกว่าเพื่อน ถูกต้องตามความจริง

`measurement_day_dates` มาจาก `buildAttendanceComputationContext_`:

| | นับ | ไม่นับ |
|---|---|---|
| มีปฏิทิน | วัน `school_day` **∩** วันที่ confirmed แล้ว | `holiday` · วันที่ยัง draft · วันเรียนที่ครูยังไม่ยืนยัน · วันที่ยืนยันแล้วแต่ไม่ใช่วันเรียน · วันนอก roster |
| ไม่มีปฏิทิน | ทุกวันที่ confirmed | — |

- **ลาป่วย/ลากิจถูกหักออกจากตัวหาร ไม่ใช่นับเป็นขาด** — เด็กที่ลาป่วยทั้งเดือนได้ 100% ไม่ใช่ 0%
- **`late` นับเป็นมา** (อยู่ในตัวเศษ)
- วันเรียนที่ครูยังไม่ยืนยัน → ไปโผล่เป็น `missing_confirmed_dates` เตือนบนหน้าจอ **ไม่ถูกนับเป็นตัวหาร**
  เจตนาชัด: ไม่ลงโทษเด็กเพราะครูยังเช็คไม่เสร็จ
- วันที่ยืนยันแล้วแต่ไม่ใช่วันเรียนตามปฏิทิน → `extra_confirmed_dates` เตือน และถูกกรองออกจาก `filtered_records`

`basis_days` ถูกส่งไปให้ client ด้วย เพราะใช้กันไม่ให้ต้นเทอม (ตัวหารน้อย) ติดเกณฑ์ "ต้องติดตาม" กันทั้งห้อง
เกณฑ์คือ `SUMMARY_ATTENDANCE_ALERT_PCT = 80` ใน `ReportService.js` และ `is_below_threshold` ต้องมี `basis_days > 0`

---

## 8. Cache

### 4 ชั้น

| ชั้น | ตัวอย่าง | อายุ | ล้างยังไง |
|---|---|---|---|
| **A. Execution memo** (ตัวแปร global) | `CACHED_STUDENT_LIST_MEMO_`, `ATTENDANCE_DAY_STATUS_MAP_MEMO_` | จบ execution | เซ็ตเป็น `{}` |
| **B. Fixed-key** (ไม่มีเวอร์ชัน) | `'sl'` (รายชื่อ), `'st'` (settings), `'semester_rows_base'` | 300 วิ | `cache.remove()` ตรงๆ |
| **C. Derived** (คีย์ฝังเวอร์ชัน) | `getOrBuildCachedJson_` / `getOrBuildLargeCachedJson_` | 120–300 วิ | bump `derived_cache_version` |
| **D. Session / rate limit** | `teacher_session:<t>`, `rl:<bucket>` | ตาม TTL | remove ตอน logout / rotate generation |

รูปแบบคีย์ชั้น C — `buildDerivedCacheKey_` ใน `Utils.js`:
```
<prefix> | <derived_cache_version> | MD5(JSON.stringify(parts))
```
`parts` เกือบทุกที่ขึ้นต้นด้วย `sourceInfo.key` = `'live|<semId>'` หรือ `'archive|<semId>'` ซึ่งแยก live/archive

### `derived_cache_version`

เก็บใน Script Properties `bumpDerivedDataCacheVersion_` เขียน `Date.now()` ทับ →
**คีย์เก่าทั้งชุดเข้าไม่ถึงพร้อมกัน** (ไม่ได้ลบ ปล่อยหมดอายุเอง) = global invalidation ทีเดียวหมด
ไม่มี invalidate รายคีย์

เรียก bump จาก: `invalidateAttendanceCaches_` · `invalidateStudentCache_` · `invalidateSemesterCaches_` ·
`invalidateSchoolCalendarCaches_` · `saveSettings` / `saveTeacherSecuritySettings` · `clearSeedCaches_`

### ⚠️ จุดที่ invalidate ไม่ถึง

1. **โค้ด client ถูก cache 15 นาทีโดยไม่มีทางล้าง** — `getCachedClientAssetContent_` ใน `Code.js`
   ใช้คีย์ดิบ `client_module_asset|<ชื่อ>` TTL 900 วิ **ไม่มีเวอร์ชันฝัง**
   และ `bumpDerivedDataCacheVersion_` แตะไม่ถึงเพราะไม่ได้ผ่าน `buildDerivedCacheKey_`

   → **หลัง `clasp push` + deploy ตัว `JsDashboard` / `JsReports` / `JsAnalytics` / `JsImport` /
   `JsProfile` / `JsPhotoGrid` ยังเสิร์ฟของเก่าได้ถึง 15 นาที**
   `Index.html` / `JavaScript.html` และ **CSS ทั้ง 5 ไฟล์ไม่โดน** เพราะ inline ตอน `doGet` ทางเดียว
   (คีย์ `client_style_asset|<ชื่อ>` เลิกใช้แล้วตั้งแต่รอบที่ 4)

   ถ้าแก้โมดูลแล้วทดสอบไม่เห็นผล ให้สงสัยข้อนี้ก่อนสงสัยว่าแก้ผิด

2. `saveSetting_` / `removeSetting_` ใน `SheetDB.js` ลบแค่คีย์ `'st'` **ไม่ bump** ขณะที่ `saveSettings`
   ใน `StudentService.js` bump ให้ — พฤติกรรมไม่สม่ำเสมอระหว่างสองทาง

3. `repairParentEmailNotifications` เป็น mutation แต่ไม่มี lock และไม่ invalidate อะไรเลย

### ข้อจำกัด CacheService

**100 KB/คีย์** — จัดการด้วย `putLargeCachedJsonByKey_` หั่นเป็นชิ้นละ `LARGE_CACHE_CHUNK_SIZE = 80000`
เขียน `key|c0..cN` + `key|meta` ตอนอ่านต้องได้ครบทุก chunk ไม่งั้นคืน `null` (treat as miss ซึ่งถูกต้อง
เพราะ chunk ถูก evict แยกกันได้)

⚠️ **80,000 นับเป็น *chars* ไม่ใช่ bytes** — ข้อความไทยเป็น UTF-8 3 ไบต์/ตัว chunk ที่เป็นไทยหนาแน่น
จะเกิน 100 KB → `put` throw → ถูกกลืนใน `catch` เงียบๆ → กลายเป็น cache miss ตลอดกาล
อาการที่เห็นคือ **"รายงานช้าลงเรื่อยๆ โดยไม่มี error"**

`putCachedJsonByKey_` (ตัวเล็ก) ไม่เช็คขนาดเลย ถ้า `daily_grid` หรือ `summary_table` โตเกิน 100 KB
จะล้มเงียบแบบเดียวกัน

### Lock

`withAttendanceMutationLock_` (`AttendanceService.js`) = `LockService.getDocumentLock()` + `waitLock(30000)`
+ `releaseLock()` ใน `finally` — **document lock ไม่ใช่ script lock** เหมาะกับ 1 ครู 1 สเปรดชีต

- ครอบด้วย helper: `recordAttendance` `undoAttendance` `bulkMarkPresent` `undoBulkPresent`
  `confirmDay` `unconfirmDay` `clearHolidayAttendance` `archiveSemesterAttendance` + เครื่องมือ seed
- ใช้ `getDocumentLock()` ตรงๆ: CRUD นักเรียน · ปฏิทิน · import · backup · email · parent link · semester
- ใช้ `getScriptLock()`: migration ทั้ง 2 ตัว + `sendWeeklySummary_` (ถูกแล้ว เพราะเขียน Script Properties)
- **ไม่มี lock ทั้งที่เป็น mutation**: `repairParentEmailNotifications` · `toggleStudentFlag` ·
  `saveSettings` / `saveTeacherSecuritySettings`

⚠️ `warmLikelyDerivedCachesForDate_` ถูกเรียก **ข้างใน** lock สำหรับ mode `confirm` และ `clear_holiday`
การอุ่นแคชสร้าง dashboard + summary + daily grid ใหม่ทั้งชุด = ถือ lock ยาวในจังหวะที่ครูกด "ยืนยันวัน"
(mode `record`/`undo`/`bulk`/`save_note`/`draft` ถูกกันออกไปแล้ว)

---

## 9. วงจรชีวิตข้อมูล

### Archive ภาคเรียน

`archiveSemesterAttendance` — ภาคเรียนต้อง **ไม่ active** ขั้นตอนในล็อก:
copy ไปชีตซ่อน `_att_archive_<id>` / `_att_day_archive_<id>` **ก่อน** (idempotent ข้ามแถวที่มีแล้ว)
→ แล้วค่อยลบจากชีตหลักด้วย `deleteSheetRowsByIndexes_` → `invalidateSemesterCaches_`

**ไม่มีฟังก์ชัน unarchive** แต่ข้อมูลไม่หาย — **ระบบยังอ่านได้ปกติ** ผ่าน `sourceInfo` routing
(`getAttendanceSourceInfoForSemester_`) พอสลับไปภาคเรียนที่ archive แล้ว `attendance_sheet_name`
จะชี้ไปชีต archive อัตโนมัติ reader ตัวเดียวกันทำงานได้เลย

`deleteSemester` **ปฏิเสธถ้ายังมีข้อมูล** (นับ archive ด้วย) → ลบภาคเรียนที่มีข้อมูลไม่ได้เลย

### ★★ คอลัมน์วันที่เก็บเป็น Date object **ทุกชีต** — `createTextFinder` จึงเชื่อไม่ได้

**วัดจริงแล้ว** 17 ส.ค. 2569 ด้วย `calendar:date_lookup_vs_scan` [Diagnostics.js]
ซึ่งรายงานชนิดของค่าในคอลัมน์วันที่ของทุกชีต

| ชีต | ชนิดของค่า | ค่าดิบ |
|---|---|---|
| `สถานะวัน` | **Date** | `Mon May 18 2026 00:00:00 GMT+0700` |
| `ปฏิทินวันเรียน` | **Date** | `Mon Nov 03 2025 00:00:00 GMT+0700` |
| `ภาคเรียน` | **Date** | `Sat Nov 01 2025 00:00:00 GMT+0700` |
| `_att_archive_1` | **Date** | `Mon May 18 2026 00:00:00 GMT+0700` |
| `_att_day_archive_1` | **Date** | `Mon May 18 2026 00:00:00 GMT+0700` |

**เอกสารฉบับก่อนเขียนว่า "ชีตหลักเก็บเป็นข้อความ ชีต archive เก็บเป็น Date" ซึ่งไม่จริง**
โค้ดเขียนสตริง `2026-05-18` ลงไป แต่ `setValues` ให้ Sheets แปลงเป็นวันที่เหมือนคนพิมพ์เอง
→ **ทุกชีตเป็น Date object เหมือนกันหมด** (`เช็คชื่อ` ตอนวัดมี 0 แถวจึงยังไม่มีข้อมูลยืนยัน
แต่ไม่มีเหตุให้ต่างจากชีตอื่น)

**ตัวที่ตัดสินว่า `createTextFinder` เจอหรือไม่เจอ คือ number format ของเซลล์ ไม่ใช่ชนิดของค่า**
TextFinder จับจาก**ข้อความที่แสดง** ดังนั้น

- `ปฏิทินวันเรียน` — Sheets เก็บรูปแบบ `yyyy-mm-dd` ตามที่โค้ดพิมพ์ลงไป จึงแสดง `2025-11-03`
  → `createTextFinder('2025-11-03')` **เจอ** · ยืนยันแล้วว่า `readSchoolCalendarEntryByDate_`
  ยังทำงานได้ (`lookup_found: true`)
- `_att_archive_1` — ค่าที่เขียนลงมาเป็น Date object (มาจาก `getValues()` ของชีตหลัก)
  Sheets จึงใส่ format เริ่มต้นให้ แสดงเป็น `18/5/2026`
  → `createTextFinder('2026-05-18')` **หาไม่เจอสักแถว และไม่ throw** คืน 0 แถวเงียบๆ

**นี่คือความเปราะที่แท้จริง**: ผลลัพธ์ขึ้นกับ format ที่**มองไม่เห็นจากโค้ด** ครูแก้ชีตด้วยมือ
หรือกู้คืนจากไฟล์สำรองก็เปลี่ยนได้ → `createTextFinder` กับคอลัมน์วันที่คือการโยนหัวก้อย

- `getValues()` + `formatDate_()` → **ถูกทุกกรณี** เพราะ `formatDate_` รับทั้ง Date และสตริง
  (`String(date).slice(0, 10)` สำหรับสตริง) เป็นเหตุผลที่ fix รอบ 1 และรอบ 3 รอดจากการกู้คืน

**เจอจริง** 17 ส.ค. 2569: หน้าเช็คชื่อเปิดวันเก่าของภาคเรียนที่ archive แล้ว ขึ้นหัวข้อ
"ยืนยันแล้ว" (สถานะวันอ่านผ่าน `getValues()`) แต่ทุกคนเป็น "ยังไม่เช็ค" (เรคอร์ดอ่านผ่าน TextFinder)
ตรวจด้วย `runP0Diagnostics` ได้ `readAttendanceRecordsByDate_` คืน **0** แถว
ขณะที่ `getCachedAttendanceDateBuckets_` เห็น **39** แถวในวันเดียวกัน

**กฎ**: อ่านคอลัมน์วันที่จากชีตไหนก็ตาม **ห้ามใช้ `createTextFinder`**
ให้ `getValues()` แล้วเทียบผ่าน `formatDate_` เสมอ
⚠️ `readSchoolCalendarEntryByDate_` [CalendarService.js:296] ยังใช้ `createTextFinder` อยู่ —
**ตอนนี้ยังทำงานได้ แต่ได้เพราะ format ของเซลล์บังเอิญตรง ไม่ใช่เพราะโค้ดถูก**
(มีตาข่ายรองอยู่บ้าง เพราะเทียบ `entry.date !== date` ซ้ำอีกชั้น จึงผิดได้เฉพาะแบบ "หาไม่เจอ")

### ตัดชีตประวัติแก้ไข

`CHANGE_LOG_MAX_ROWS = 5000` + `CHANGE_LOG_TRIM_SLACK_ROWS = 500` — **hysteresis**:
ยอมให้ล้นถึง 5,500 แถวแล้วค่อยตัดทีเดียว แทนที่จะ `deleteRows` ทุกครั้งที่เช็คชื่อ
ตัดจากบน = เก่าสุดออกก่อน (จึงใช้ `getNextChangeLogId_` ที่อ่านแค่แถวล่างสุดได้)

`logAsync_` ห่อ try/catch ทั้งก้อนแบบเงียบ — log พังไม่ทำให้การเช็คชื่อพัง แลกกับการที่ไม่มีใครรู้ว่าพัง
`_timing_log` ใช้แพทเทิร์นเดียวกันแต่ไม่มี slack (`TIMING_LOG_MAX_ROWS = 1000`)

### `setupSystem_` vs `ensureSystemSheets_`

| | `setupSystem_` | `ensureSystemSheets_` |
|---|---|---|
| แตะ UI | ✅ `getUi().alert()` | ❌ ไม่แตะเลย |
| เรียกจาก | **เมนูในชีตเท่านั้น** | ที่ไหนก็ได้ รวม Web App |
| ตรรกะ | wrapper บาง มีค่าแค่ตรง alert | **ตรรกะทั้งหมดอยู่ที่นี่** |

โค้ดฝั่ง Web App ต้องเรียก `ensureSystemSheets_` เสมอ — `setupSystem_` จะ throw เพราะ `getUi()` ไม่มี context

> 📌 หมายเหตุที่ขัดกับ `CLAUDE.md`: ปัจจุบันมีแค่ `restoreBackup` และ `Diagnostics.js` ที่เรียก
> `ensureSystemSheets_` — **`runInitialSetup` ไม่ได้เรียก** มันสร้างแค่ชีตภาคเรียนแล้ว `saveSetting_` ตรงๆ
> ถ้าครูเปิด Web App ก่อนกดเมนูติดตั้ง จะเจอ error `'ไม่พบ Sheet: ตั้งค่า'`

### Migration — 2 ตัว

| | `ensureStudentIdentityMigration_` | `ensureSecurityMigration_` |
|---|---|---|
| ไฟล์ | `StudentService.js` | `SecurityService.js` |
| Property | `student_identity_migration_version` | `security_migration_version` |
| Lock | `getScriptLock()` + double-check ในล็อก | เหมือนกัน |
| Fast path | global var → CacheService 6 ชม. → Property | Property อย่างเดียว |
| ทำอะไร | เพิ่มคอลัมน์ `student_id` (ชีตเช็คชื่อ + ลิงก์ผู้ปกครอง) และ K/L (ชีตนักเรียน) แล้ว backfill ทั้ง 3 ชุด | hash รหัสครูเดิม, สร้าง PIN salt, ย้าย PIN เก่า, **ลบ setting ที่เป็นความลับออกจากชีต** |
| เรียกเมื่อ | lazy หัวฟังก์ชันที่อ่าน/เขียนการเช็คชื่อ → **request แรกหลัง copy สเปรดชีตเป็นตัวจ่ายค่า** | ตอนล็อกอิน + เมนูรีเซ็ต |

### ⚠️ อันตรายของการขยับสตริงเวอร์ชัน

สตริงเวอร์ชันคือ**ค่าเดียวที่บอกว่า migration รันไปแล้วหรือยัง** เปลี่ยนเมื่อไหร่ = **รันใหม่ทั้งชุด
กับข้อมูลจริงของครูทุกคนที่ได้โค้ดนี้ไป** ผลกระทบเป็นรูปธรรม:

1. `backfillStudentRosterDates_` **เขียนทับคอลัมน์ K/L ทั้งคอลัมน์** ถ้าครูเคยแก้ `enrolled_from` ด้วยมือ
   แล้วบางช่องว่าง ค่าจะถูกเดาใหม่จากเรคคอร์ดเช็คชื่อ → **ตัวหาร `school_days` เปลี่ยน →
   เปอร์เซ็นต์ใน ปพ.6 ที่พิมพ์ไปแล้วไม่ตรงกับที่พิมพ์ใหม่**
2. อ่าน+เขียนชีต `เช็คชื่อ` 2 รอบกับ 10,000+ แถว = **เสี่ยงชน 6 นาทีในจังหวะที่ครูแค่เปิดหน้าเช็คชื่อ**
   และ **ไม่มี checkpoint** — timeout กลางคันแล้ว property ไม่ถูกเซ็ต → รอบหน้าเริ่มใหม่ตั้งแต่ต้น →
   ล็อกตัวเองอยู่ในลูปพังตลอดไป

**ถ้าจำเป็นต้องเพิ่ม migration ใหม่ ให้ทำเป็น property ตัวใหม่แยก ไม่ใช่ขยับตัวเดิม**

### ขีดจำกัดที่ใกล้ชนที่สุด

1. **Migration บนชีตใหญ่** (ข้างบน) — เสี่ยงสุด
2. **`restoreBackup`** — สร้าง snapshot ปัจจุบันไว้ใน memory เพื่อ rollback แล้วเขียนทับ 7 ชีต +
   ชีต archive ทั้งหมด ถ้าพังต้อง restore กลับอีกรอบ = อาจเขียนทั้งสเปรดชีต 2 รอบใน 1 execution
3. **`attendance_date_buckets`** — 10,000 แถว ≈ 1.5 MB → ~19 chunk ต้องอยู่ครบถึงจะ hit
   **ยิ่งข้อมูลโตยิ่ง hit rate ต่ำ** archive ภาคเรียนคือทางระบายเดียว
4. **โควตาอีเมล** `MailApp` 100 ฉบับ/วัน (บัญชีฟรี) ห้อง 50 คนส่งวันเดียวก็เกินครึ่ง —
   มี `getRemainingDailyQuota()` แสดงให้ครูดู แต่**ไม่ได้เอามาบล็อกก่อนส่ง**
5. **ไฟล์ค้างใน Drive** — CSV / backup / import พึ่งให้ client เรียก `cleanupCSVFile` ลบทีหลัง
   ถ้าปิดแท็บก่อน ไฟล์ค้างสะสม

---

## 10. กับดักที่รู้ได้จากของจริงเท่านั้น

ทุกข้อในนี้พิสูจน์บน deployment จริง ไม่ใช่จากการอ่านโค้ด — และแต่ละข้อเคยกินเวลาไปแล้วจริงๆ

### Google Sheets

**1. ข้อความที่ขึ้นต้นด้วย `= + - @` กลายเป็นสูตร**
Sheets ตีความค่าที่เขียนผ่าน `setValue/setValues` เหมือนผู้ใช้พิมพ์เอง — `=1+1` → `2`,
`=ด.ช.สมชาย` → `#ERROR!` **ชื่อเด็กหายทั้งจากระบบและจากเอกสาร ปพ.6**
เป็น data-integrity bug ก่อนจะเป็นเรื่อง security

วิธีแก้คือเติม `'` นำหน้า (`sanitizeSheetText_`) ซึ่ง Sheets กลืนตอนเขียนและไม่ติดกลับมาตอนอ่าน
**`setNumberFormat('@')` ทดสอบแล้วกันไม่อยู่**

> 📌 **ห้ามเรียก `sheet.setValue/setValues/appendRow` ตรงๆ กับข้อความจากผู้ใช้**
> ให้ใช้ `appendRow_` / `updateCells_` จาก `SheetDB.js` (sanitize ให้แล้ว) หรือครอบ `sanitizeSheetRows_` เอง
> ชั้นกันที่ 2 คือ `normalizeLimitedText_` ที่ throw เมื่อเจอ `< > \``

**2. สตริงที่หน้าตาเหมือนวันเวลาถูกแปลงเป็น `Date` object**
อ่านกลับมาแล้ว `String(cell)` ได้ `toString()` แบบ JS = ภาษาอังกฤษ ใช้ `normalizeTimestampValue_` แปลงกลับ

**3. `getLastColumn()` คืน 0 บนชีตที่เพิ่งสร้าง** แล้ว `insertColumnsAfter(0, n)` throw
→ ใช้ `getMaxColumns()` แทน (บั๊กนี้ทำให้ archive ภาคเรียนไม่เคยทำงานได้เลยตั้งแต่แรก)

### Apps Script

**4. ช่องเลือกฟังก์ชันของ editor ไม่แสดงฟังก์ชันที่ลงท้ายด้วย `_`** → เครื่องมือ dev ต้องเป็น public
แล้วกันด้วยด่าน local context (ดูข้อ 3)

**5. `SpreadsheetApp.getUi()` throw ตอนรันจาก editor ด้วย** ไม่ใช่เฉพาะจาก Web App → ใช้เป็นด่านไม่ได้

**6. session ถูกล้างทุกครั้งที่ deploy version ใหม่** — ครูต้องกรอกรหัสใหม่ทุกรอบทดสอบ
เป็นพฤติกรรมปกติ ไม่ใช่บั๊ก

**7. โค้ดโมดูล client ถูก cache 15 นาที** — ดูข้อ 8 นี่คือกับดักที่จะกัดคนมาพัฒนาต่อแน่นอน

**7.5 ★ เมนูในชีตกับเว็บแอปรันโค้ดคนละเวอร์ชันกัน**

- **เมนู 🎓 ในชีต และ Apps Script editor** → รัน**โค้ดล่าสุดในโปรเจกต์** (ได้ผลทันทีหลัง `clasp push`)
- **เว็บแอป** (`?page=...` และทุกอย่างที่ผ่าน `google.script.run`) → รัน**โค้ดของ deployment version**
  ซึ่ง**ไม่ขยับจนกว่าจะสร้าง version ใหม่จาก Apps Script UI**

`clasp push` อย่างเดียว**ไม่พอ** ต้อง Deploy → Manage deployments → แก้ version เป็น New version ด้วย

**ผลที่ทำให้ตีความผิดได้ทั้งรอบ**: `runP0Diagnostics` ถูกเรียกจากเมนูในชีต จึงเห็นโค้ดใหม่เสมอ
→ **ผลตรวจเขียวไม่ได้แปลว่าเว็บแอปได้โค้ดใหม่แล้ว** เคยเกิดจริง: เช็ค `delete_rows:all_data_rows_frozen_header`
เขียว แต่กดปุ่มเก็บถาวรบนเว็บแอปยังพังด้วย error เดิม เพราะ deployment ยังเป็นเวอร์ชันก่อนแก้
(ยืนยันจาก stack trace ที่ชี้เลขบรรทัดของโค้ดเก่า)

→ เวลาทดสอบอะไรที่เรียกผ่านเว็บแอป ให้ยืนยันก่อนว่าสร้าง deployment version ใหม่แล้ว
และถ้าผลไม่ตรงกับที่คาด ให้เทียบเลขบรรทัดใน stack trace กับโค้ดปัจจุบัน — ถ้าไม่ตรง แปลว่า deployment เก่า

### เบราว์เซอร์ / CSS

**8. `table-layout: auto` ทำให้ `width` / `max-width` บนเซลล์เป็นแค่ข้อเสนอ**
ตารางรายวันมีคอลัมน์ตรึง 2 คอลัมน์ที่ต้องใช้ `left` = ความกว้างของคอลัมน์แรก
**ลองมาแล้ว 3 ทางที่ไม่ได้ผล**: แก้ `z-index` ของ `thead` · เปลี่ยน `border-collapse` ·
ล็อกความกว้างด้วยตัวแปร CSS อย่างเดียว
ทางที่ได้ผลคือเปลี่ยนเป็น **`table-layout: fixed` ก่อน** แล้วค่อยล็อกความกว้าง — มี comment อธิบายใน `StyleReport.html`

**9. `input[type=date]` ยิง `input`/`change` ตอนพิมพ์ปียังไม่ครบ**
พิมพ์ `13/08/2026` จะได้ event ที่ `0002` → `0020` → `0202` → `2026` ทุกค่าเป็นวันที่ถูกต้องตามรูปแบบ
ระบบเลยเด้งไปวันอื่นและขึ้น error "อยู่นอกภาคเรียน" ระหว่างพิมพ์
แก้ด้วยการให้ **ทั้ง `oninput` และ `onchange` เดินผ่านตัวหน่วงตัวเดียวกัน** (`ATTENDANCE_DATE_TYPING_DEBOUNCE_MS`)

**10. หน้าเว็บอยู่ใน cross-origin iframe ของ Apps Script**
เครื่องมือ automation ที่อ่าน DOM / รัน JS / ขับ `<select>` เข้าไม่ถึง —
ทดสอบตรรกะที่ขับผ่าน UI ไม่ได้ ต้องแยกออกมาเป็นฟังก์ชันแล้วทดสอบผ่าน `Diagnostics.js` แทน
(ตัวอย่าง: `shouldBlockSchoolCalendarChange_` ถูกแยกออกมาด้วยเหตุผลนี้)

### ความไม่สม่ำเสมอในโค้ดเบส

รายการความไม่สม่ำเสมอที่รู้อยู่แล้ว (ยังไม่แก้) ดู **`TODO.md`** — เป็นงานค้าง ไม่ใช่คำอธิบายสถาปัตยกรรม
จึงเก็บไว้ที่เดียวที่จะถูกลบเองตอนปิดงาน

---

## 11. ทดสอบและ deploy

### วงรอบจริง

```bash
clasp pull    # ก่อนเริ่มงานทุกครั้ง — push/pull เขียนทับทั้งไฟล์ ไม่ merge
# แก้โค้ด
clasp push
```
แล้วสร้าง **deployment version ใหม่** จาก Apps Script UI (ไม่ใช่แค่ push) แล้วทดสอบบนของจริง

ห้ามแก้บน Apps Script editor บนเว็บพร้อมกับแก้ในเครื่อง

**หลัง deploy ต้องรู้ 2 อย่าง**: session ครูถูกล้าง (กรอกรหัสใหม่) และโมดูล client อาจเป็นของเก่าได้ 15 นาที

### แพทเทิร์น `Diagnostics.js`

เป็นไฟล์ชั่วคราวสำหรับตรวจงานแก้ P0 — แต่**แพทเทิร์นของมันควรลอกไปใช้ซ้ำ**เพราะเป็นวิธีเดียวที่จะ
ทดสอบตรรกะบนของจริงได้โดยไม่ต้องขับ UI:

- entry point เป็น public (`runP0Diagnostics`) เพราะ editor ไม่แสดงฟังก์ชันที่ลงท้าย `_`
- กันด้วย `requireP0DiagnosticLocalContext_`
- แต่ละเช็คตั้งชื่อแบบ `หมวด:สิ่งที่ตรวจ` แล้วคืน JSON ที่ก๊อปส่งกลับได้
- **สร้างชีตทดสอบของตัวเองแล้วลบทิ้ง ไม่แตะข้อมูลจริง** และผลลัพธ์ไม่มีชื่อนักเรียนติดออกมา
- เปิดจากเมนู 🎓 → 🧪 หรือเลือกฟังก์ชันใน editor แล้วกด Run

`SeedTestData.js` สร้างข้อมูลจำลอง 40 คน ย้อนหลัง 90 วัน — สุ่มแบบ **deterministic** (LCG seed คงที่)
รันกี่ครั้งก็ได้ข้อมูลชุดเดิม เทียบผลได้ และมีด่านกัน 3 ชั้น ชั้นที่สำคัญที่สุดคือ
**`SEED_MAX_EXISTING_ATTENDANCE_ROWS = 500`** — ถ้าชีตมีเกิน 500 แถวอยู่แล้วจะปฏิเสธ
เพื่อกันไม่ให้รันทับสำเนาของลูกค้าจริง

**ทั้งสองไฟล์ + เมนู 🧪 ทั้ง 5 รายการต้องถอดก่อนส่งมอบลูกค้าทุกครั้ง** (มี comment กำกับใน `onOpen`)

---

## 12. Checklist เพิ่มหน้าใหม่

> ⚠️ **ก่อนใช้ checklist นี้ ให้ `grep` ยืนยันว่าชื่อ registry ในตารางยังตรงกับโค้ดอยู่**
> ตารางนี้ผูกกับชื่อตัวแปรโดยตรง ถ้ามีใครรีแฟกเตอร์แล้วไม่ได้แก้ที่นี่ ทำตามแล้วจะพังโดยไม่รู้สาเหตุ

เพิ่มหน้า 1 หน้าต้องแตะหลายจุดใน 4 ไฟล์ **และไม่มี compile-time check สักจุด** ลืมที่ไหนรู้ตอน runtime:

| # | ไฟล์ | ทำอะไร | ลืมแล้วเป็นยังไง |
|---|---|---|---|
| 1 | `JsXxx.html` (ใหม่) | IIFE + `init()` + `render(state)` + `renderLoading(state)` + `window.XxxPage = {...}` | — |
| 2 | `Code.js` | เพิ่มใน `moduleMap` ของ `getClientModuleContent` | error "ไม่พบโมดูลหน้าที่ร้องขอ" |
| 3 | `Code.js` | เพิ่ม `case` ใน `getInitialData` | ได้ payload เปล่า **ไม่มี error** |
| 4 | `JavaScript.html` | `CLIENT_MODULE_REGISTRY` + `PAGE_MODULE_MAP` + `VALID_PAGES` + `PAGE_IDENTITY_LABELS` | หน้าไม่ถูกรู้จัก / โมดูลไม่ถูกโหลด |
| 5 | `JavaScript.html` | เพิ่ม `case` ใน `applyPageDataAndRender_` | โหลดข้อมูลได้แต่ไม่ render |
| 6 | `Index.html` | `<div id="page-xxx" class="page-panel">` + ลิงก์ `data-page` ใน nav บน / drawer / bottom nav | panel ไม่มีที่ลง / เข้าไม่ถึง |

ถ้ามี CSS ใหม่ต้องเพิ่มอีกใน `CLIENT_STYLE_REGISTRY` + `PAGE_STYLE_MAP` + `styleMap` ใน `Code.js` + `include_`

**เพิ่มฟังก์ชัน server ใหม่** — สั้นกว่ามาก แต่พลาดแล้วอันตรายกว่า:
1. ตั้งชื่อ **ลงท้าย `_` ถ้าเป็นฟังก์ชันภายใน** (ไม่งั้นเปิดสู่อินเทอร์เน็ตทันที)
2. ครอบด้วยด่านที่ถูกชนิด (ดูข้อ 3)
3. ถ้าเป็น mutation: ใส่ `require_csrf: true` + ครอบ lock + invalidate cache
4. เขียนชีตผ่าน `SheetDB.js` หรือครอบ `sanitizeSheetRows_` เอง
5. อ่าน/เขียนแบบ batch เสมอ

### ⚠️ ฟังก์ชันที่ลงท้าย `_` กด Run จาก editor ไม่ได้ — แล้วจะทดสอบยังไง

**ช่องเลือกฟังก์ชันของ Apps Script editor ไม่แสดงฟังก์ชันที่ลงท้ายด้วย `_`**
และเราทดสอบในเครื่องไม่ได้ ดังนั้นวิธีเดียวที่จะรันโค้ดฝั่ง server ตรงๆ คือกด Run จาก editor
กฎ "ฟังก์ชันภายในต้องเติม `_`" จึงชนกับความต้องการทดสอบเสมอ

**อย่าแก้ด้วยการถอด `_` ออก** — นั่นคือการเปิด endpoint สู่อินเทอร์เน็ตเพื่อแลกกับความสะดวกในการทดสอบ
(เคยเกิดขึ้นจริงแล้วกับ `runPreReleaseSmokeChecks` ซึ่งเป็น global ไม่มี `_` และตัวมันข้าม auth
ด้วย `runAsTrustedTeacher_` — ต้องเปลี่ยนกลับเป็น `runPreReleaseSmokeChecks_` ทีหลัง)

**วิธีที่ถูก: ทำ public เป็นเปลือกบางๆ ที่ผ่านด่าน local context แล้วเรียกตัว `_` จริง**
ตรรกะทั้งหมดยังอยู่ในฟังก์ชัน `_` มีแค่ประตูที่เป็น public — แพทเทิร์นเดียวกับ `runP0Diagnostics`:

```js
// ประตูสำหรับกด Run — เห็นใน editor เพราะไม่มี _ แต่คนจากเน็ตเรียกไม่ได้
function runMyCheck() {
  requireP0DiagnosticLocalContext_();   // ว่างเสมอเมื่อถูกเรียกผ่าน google.script.run
  return runMyCheck_();                 // ตรรกะจริงอยู่ในตัวนี้
}

function runMyCheck_() { /* ... */ }
```

ด่านที่ใช้ได้มี 2 ตัว — `requireP0DiagnosticLocalContext_` (แค่ต้องมีอีเมล) และ
`requireSeedLocalContext_` (ต้องตรงกับ `getTeacherOwnerEmail_()` ด้วย ใช้กับของที่เขียนข้อมูล)

**ห้ามใช้ `SpreadsheetApp.getUi()` เป็นด่าน** — มัน throw ตอนรันจาก editor ด้วย ไม่ใช่เฉพาะจาก Web App

ประตูแบบนี้เป็นของชั่วคราวสำหรับ dev — **ต้องถอดออกพร้อมไฟล์ทดสอบก่อนส่งมอบลูกค้าทุกครั้ง**
ถ้าลืมถอด อย่างน้อยยังมีด่าน local context กันอยู่ แต่ก็ไม่ควรอยู่ในมือลูกค้า

> 💡 เช็ค `deploy:functions_present` ใน `Diagnostics.js` **assert ว่า `runPreReleaseSmokeChecks`
> (ชื่อที่ไม่มี `_`) ต้องเป็น `undefined`** — คือมี regression test กันการเผลอเปิด endpoint ทิ้งไว้อยู่แล้ว
> เพิ่มประตูชั่วคราวตัวใหม่ ให้เพิ่มบรรทัดทำนองเดียวกันด้วย จะได้รู้ตอนตรวจ ไม่ใช่ตอนลูกค้าใช้
