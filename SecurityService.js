/**
 * Central security helpers for teacher auth, CSRF, rate limiting, and secret storage.
 */

var SECURITY_MIGRATION_PROP = 'security_migration_version';
var SECURITY_MIGRATION_VERSION = '2026-04-16-v1';

var SECURITY = {
  SESSION_TTL_SEC: 2 * 60 * 60,
  PARENT_SESSION_TTL_SEC: 60 * 60,
  LOGIN_RATE_LIMIT_ATTEMPTS: 10,
  LOGIN_RATE_LIMIT_WINDOW_SEC: 5 * 60,
  MUTATION_RATE_LIMIT_ATTEMPTS: 90,
  MUTATION_RATE_LIMIT_WINDOW_SEC: 60,
  PARENT_TOKEN_TTL_DAYS: 14,
  PARENT_TOKEN_TTL_MIN_DAYS: 7,
  PARENT_TOKEN_TTL_MAX_DAYS: 90,
  PRINT_TOKEN_TTL_SEC: 120,
  MAX_TRUSTED_TEACHER_DEVICES: 5,
  TEACHER_KEY_MIN_LENGTH: 12,
  TEACHER_KEY_MAX_LENGTH: 128
};

var SECURITY_PROP = {
  TEACHER_ACCESS_KEY: 'teacher_access_key',
  TEACHER_ACCESS_KEY_HASH: 'teacher_access_key_hash',
  TEACHER_ACCESS_KEY_SALT: 'teacher_access_key_salt',
  TEACHER_DEVICE_ID: 'teacher_device_id',
  TEACHER_TRUSTED_DEVICES: 'teacher_trusted_devices',
  TEACHER_OWNER_EMAIL: 'teacher_owner_email',
  TEACHER_SESSION_GENERATION: 'teacher_session_generation',
  PIN_HASH: 'pin_hash',
  PIN_SALT: 'pin_salt',
  PIN_FAILED_COUNT: 'pin_failed_count',
  PIN_LOCK_UNTIL: 'pin_lock_until'
};

var TEACHER_TRUST_STACK_ = [];

function getScriptProperties_() {
  return PropertiesService.getScriptProperties();
}

function getSecurityCache_() {
  return CacheService.getScriptCache();
}

function getSecureProperty_(key) {
  return String(getScriptProperties_().getProperty(key) || '');
}

function setSecureProperty_(key, value) {
  getScriptProperties_().setProperty(key, String(value == null ? '' : value));
}

function deleteSecureProperty_(key) {
  getScriptProperties_().deleteProperty(key);
}

function getTeacherOwnerDeviceId_() {
  return String(getSecureProperty_(SECURITY_PROP.TEACHER_DEVICE_ID) || '').trim();
}

function clearTeacherOwnerDeviceId_() {
  deleteSecureProperty_(SECURITY_PROP.TEACHER_DEVICE_ID);
}

function normalizeTrustedTeacherDeviceEntries_(value) {
  var raw = value;
  if (!raw) return [];
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (e) {
      raw = [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.map(function(entry) {
    var deviceId = String(entry && entry.id || entry && entry.device_id || '').trim();
    if (!isValidTeacherDeviceId_(deviceId)) return null;
    var addedAt = String(entry && entry.added_at || entry && entry.created_at || '').trim() || new Date(0).toISOString();
    var lastSeenAt = String(entry && entry.last_seen_at || entry && entry.seen_at || '').trim() || addedAt;
    return {
      id: deviceId,
      added_at: addedAt,
      last_seen_at: lastSeenAt
    };
  }).filter(function(entry) { return !!entry; });
}

function getTrustedTeacherDevices_() {
  var entries = normalizeTrustedTeacherDeviceEntries_(getSecureProperty_(SECURITY_PROP.TEACHER_TRUSTED_DEVICES));
  if (!entries.length) {
    var legacyDeviceId = getTeacherOwnerDeviceId_();
    if (isValidTeacherDeviceId_(legacyDeviceId)) {
      return [{
        id: legacyDeviceId,
        added_at: new Date(0).toISOString(),
        last_seen_at: new Date(0).toISOString()
      }];
    }
  }
  return entries;
}

function saveTrustedTeacherDevices_(entries) {
  var normalized = normalizeTrustedTeacherDeviceEntries_(entries);
  setSecureProperty_(SECURITY_PROP.TEACHER_TRUSTED_DEVICES, JSON.stringify(normalized));
  clearTeacherOwnerDeviceId_();
  return normalized;
}

function getTrustedTeacherDeviceIds_() {
  return getTrustedTeacherDevices_().map(function(entry) {
    return String(entry.id || '').trim();
  }).filter(function(deviceId) {
    return !!deviceId;
  });
}

function hasTrustedTeacherDevice_(deviceId) {
  deviceId = String(deviceId || '').trim();
  if (!isValidTeacherDeviceId_(deviceId)) return false;
  return getTrustedTeacherDeviceIds_().indexOf(deviceId) !== -1;
}

/**
 * โควตาอุปกรณ์เต็มหรือยัง — เครื่องที่อยู่ในรายการแล้วไม่นับกินโควตาเพิ่ม
 * ใช้ปฏิเสธเครื่องใหม่แทนการเบียดเครื่องเก่าออกเงียบๆ ไม่งั้นคนที่รู้รหัสครู
 * จะแทรกตัวเข้ามาได้เสมอไม่ว่ารายการจะเต็มแค่ไหน
 */
function isTrustedTeacherDeviceQuotaFull_(deviceId) {
  deviceId = String(deviceId || '').trim();
  if (hasTrustedTeacherDevice_(deviceId)) return false;
  return getTrustedTeacherDevices_().length >= SECURITY.MAX_TRUSTED_TEACHER_DEVICES;
}

function rememberTrustedTeacherDevice_(deviceId) {
  deviceId = String(deviceId || '').trim();
  if (!isValidTeacherDeviceId_(deviceId)) return getTrustedTeacherDevices_();
  var nowIso = new Date().toISOString();
  var entries = getTrustedTeacherDevices_().filter(function(entry) {
    return String(entry.id || '').trim() !== deviceId;
  });
  entries.unshift({
    id: deviceId,
    added_at: nowIso,
    last_seen_at: nowIso
  });
  entries = entries.slice(0, SECURITY.MAX_TRUSTED_TEACHER_DEVICES);
  return saveTrustedTeacherDevices_(entries);
}

function clearTrustedTeacherDevices_() {
  deleteSecureProperty_(SECURITY_PROP.TEACHER_TRUSTED_DEVICES);
  clearTeacherOwnerDeviceId_();
}

function getTeacherOwnerEmail_() {
  return String(getSecureProperty_(SECURITY_PROP.TEACHER_OWNER_EMAIL) || '').trim().toLowerCase();
}

function setTeacherOwnerEmail_(email) {
  setSecureProperty_(SECURITY_PROP.TEACHER_OWNER_EMAIL, String(email || '').trim().toLowerCase());
}

function isValidTeacherDeviceId_(deviceId) {
  deviceId = String(deviceId || '').trim();
  return /^[A-Za-z0-9_-]{24,128}$/.test(deviceId);
}

function getTeacherSessionGeneration_() {
  var value = parseInt(getSecureProperty_(SECURITY_PROP.TEACHER_SESSION_GENERATION), 10);
  if (!(value > 0)) {
    value = 1;
    setSecureProperty_(SECURITY_PROP.TEACHER_SESSION_GENERATION, String(value));
  }
  return value;
}

function rotateTeacherSessionGeneration_() {
  var nextValue = getTeacherSessionGeneration_() + 1;
  setSecureProperty_(SECURITY_PROP.TEACHER_SESSION_GENERATION, String(nextValue));
  return nextValue;
}

function ensureSecurityMigration_() {
  var props = getScriptProperties_();
  if (props.getProperty(SECURITY_MIGRATION_PROP) === SECURITY_MIGRATION_VERSION) {
    return;
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    if (props.getProperty(SECURITY_MIGRATION_PROP) === SECURITY_MIGRATION_VERSION) {
      return;
    }

    ensureTeacherAccessKeyHash_();
    ensurePinSalt_();
    migrateLegacyPinStorage_();
    try { removeSetting_('parent_secret_key'); } catch (e) {}
    try { removeSetting_('teacher_auth_emails'); } catch (e) {}
    try { removeSetting_('teacher_key_login_enabled'); } catch (e) {}
    props.setProperty(SECURITY_MIGRATION_PROP, SECURITY_MIGRATION_VERSION);
  } finally {
    lock.releaseLock();
  }
}

function ensureTeacherAccessKeySalt_() {
  var salt = getSecureProperty_(SECURITY_PROP.TEACHER_ACCESS_KEY_SALT);
  if (!salt) {
    salt = generateSecureToken_(32);
    setSecureProperty_(SECURITY_PROP.TEACHER_ACCESS_KEY_SALT, salt);
  }
  return salt;
}

function hashTeacherAccessKey_(teacherKey, salt) {
  var raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(teacherKey || '') + ':' + String(salt || '')
  );
  return raw.map(function(b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('');
}

function ensureTeacherAccessKeyHash_() {
  var existingHash = getSecureProperty_(SECURITY_PROP.TEACHER_ACCESS_KEY_HASH);
  if (existingHash) return existingHash;

  var settings = getSettings_();
  var legacy = String(getSecureProperty_(SECURITY_PROP.TEACHER_ACCESS_KEY) || '').trim();
  if (!legacy) legacy = String(settings.teacher_key || '').trim();
  if (!legacy) return '';

  var salt = ensureTeacherAccessKeySalt_();
  var keyHash = hashTeacherAccessKey_(legacy, salt);
  setSecureProperty_(SECURITY_PROP.TEACHER_ACCESS_KEY_HASH, keyHash);
  deleteSecureProperty_(SECURITY_PROP.TEACHER_ACCESS_KEY);

  if (settings.teacher_key) {
    try { removeSetting_('teacher_key'); } catch (e) {}
  }
  return keyHash;
}

function getTeacherAccessKeyHash_() {
  ensureSecurityMigration_();
  return getSecureProperty_(SECURITY_PROP.TEACHER_ACCESS_KEY_HASH);
}

function getSingleTeacherEmail_() {
  var email = '';
  try {
    email = Session.getActiveUser().getEmail() || '';
  } catch (e) {
    email = '';
  }
  if (!email) {
    try {
      email = Session.getEffectiveUser().getEmail() || '';
    } catch (e2) {
      email = '';
    }
  }
  return String(email || '').trim().toLowerCase();
}

function getVerifiedTeacherPrincipalEmail_() {
  try {
    return String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  } catch (e) {
    return '';
  }
}

function getParentTokenTtlDays_() {
  return getParentTokenTtlDaysFromSettings_(getSettings_());
}

function getParentTokenTtlDaysFromSettings_(settings) {
  var raw = parseInt(settings && settings.parent_token_ttl_days, 10);
  if (!(raw >= SECURITY.PARENT_TOKEN_TTL_MIN_DAYS && raw <= SECURITY.PARENT_TOKEN_TTL_MAX_DAYS)) {
    return SECURITY.PARENT_TOKEN_TTL_DAYS;
  }
  return raw;
}

function isTeacherAccessKeyConfigured_() {
  return !!getTeacherAccessKeyHash_();
}

function isTeacherAccessKeyConfiguredFast_(settings) {
  settings = settings || {};
  return !!(
    getSecureProperty_(SECURITY_PROP.TEACHER_ACCESS_KEY_HASH) ||
    getSecureProperty_(SECURITY_PROP.TEACHER_ACCESS_KEY) ||
    String(settings.teacher_key || '').trim()
  );
}

function buildReadinessSettingsFromCachedSettings_(settings) {
  settings = settings || {};
  return {
    teacher_name: String(settings.teacher_name || ''),
    school_name: String(settings.school_name || ''),
    class_name: String(settings.class_name || ''),
    teacher_key_configured: isTeacherAccessKeyConfiguredFast_(settings)
  };
}

function validateTeacherAccessKey_(teacherKey) {
  teacherKey = String(teacherKey || '').trim();
  if (teacherKey.length < SECURITY.TEACHER_KEY_MIN_LENGTH) {
    throw new Error('รหัสครูต้องยาวอย่างน้อย ' + SECURITY.TEACHER_KEY_MIN_LENGTH + ' ตัวอักษร');
  }
  if (teacherKey.length > SECURITY.TEACHER_KEY_MAX_LENGTH) {
    throw new Error('รหัสครูยาวเกินกำหนด');
  }
  if (!/[A-Za-z]/.test(teacherKey) || !/[0-9]/.test(teacherKey)) {
    throw new Error('รหัสครูต้องมีทั้งตัวอักษรและตัวเลข');
  }
  return teacherKey;
}

function setTeacherAccessKey_(teacherKey) {
  teacherKey = validateTeacherAccessKey_(teacherKey);
  var salt = ensureTeacherAccessKeySalt_();
  setSecureProperty_(SECURITY_PROP.TEACHER_ACCESS_KEY_HASH, hashTeacherAccessKey_(teacherKey, salt));
  deleteSecureProperty_(SECURITY_PROP.TEACHER_ACCESS_KEY);
  rotateTeacherSessionGeneration_();
  try { removeSetting_('teacher_key'); } catch (e) {}
}

function verifyTeacherAccessKey_(teacherKey) {
  teacherKey = String(teacherKey || '').trim();
  if (!teacherKey) return false;
  return constantTimeEqual_(
    hashTeacherAccessKey_(teacherKey, ensureTeacherAccessKeySalt_()),
    getTeacherAccessKeyHash_()
  );
}

function getTeacherLoginOptions() {
  ensureSecurityMigration_();
  try {
    enforceRateLimit_(
      'teacher_login_options',
      60,
      60,
      'มีการโหลดหน้าล็อกอินถี่เกินไป กรุณารอสักครู่'
    );
  } catch (e) {
    return {
      key_login_enabled: true,
      teacher_key_configured: false,
      message: splitErrorCode_(e).message
    };
  }

  return {
    key_login_enabled: true,
    teacher_key_configured: isTeacherAccessKeyConfigured_(),
    setup_wizard_supported: true
  };
}

function runInitialSetup(payload, deviceId) {
  ensureSecurityMigration_();
  payload = payload || {};
  deviceId = String(deviceId || '').trim();

  if (!isValidTeacherDeviceId_(deviceId)) {
    return { success: false, message: 'ไม่พบอุปกรณ์ที่ได้รับอนุญาต กรุณารีโหลดหน้าแล้วลองใหม่' };
  }
  if (isTeacherAccessKeyConfigured_()) {
    return { success: false, message: 'ระบบนี้ตั้งค่ารหัสครูไว้แล้ว กรุณาเข้าสู่ระบบตามปกติ' };
  }

  try {
    enforceRateLimit_(
      'initial_setup',
      10,
      300,
      'มีการเริ่มตั้งค่าระบบถี่เกินไป กรุณารอสักครู่'
    );
  } catch (e) {
    return buildFailurePayload_(e);
  }

  var teacherName = '';
  var schoolName = '';
  var className = '';
  var semesterName = '';
  var semesterStart = '';
  var semesterEnd = '';
  var teacherKey = '';

  try {
    teacherName = normalizeLimitedText_(payload.teacher_name, 120, 'ชื่อครู');
    schoolName = normalizeLimitedText_(payload.school_name, 160, 'ชื่อโรงเรียน');
    className = normalizeLimitedText_(payload.class_name, 60, 'ระดับชั้นเรียน');
    semesterName = normalizeLimitedText_(payload.semester_name, 40, 'ชื่อภาคเรียน');
    semesterStart = normalizeDateStringStrict_(payload.semester_start_date, 'วันเริ่มภาคเรียน');
    semesterEnd = normalizeDateStringStrict_(payload.semester_end_date, 'วันสิ้นสุดภาคเรียน');
    teacherKey = validateTeacherAccessKey_(payload.teacher_access_key);
  } catch (e2) {
    return buildFailurePayload_(e2);
  }

  if (!teacherName || !schoolName || !className || !semesterName) {
    return { success: false, message: 'กรุณากรอกข้อมูลให้ครบทุกช่อง' };
  }
  if (semesterStart > semesterEnd) {
    return { success: false, message: 'วันเริ่มภาคเรียนต้องก่อนวันสิ้นสุดภาคเรียน' };
  }

  var principalEmail = getVerifiedTeacherPrincipalEmail_();
  var resolvedEmail = principalEmail || getSingleTeacherEmail_();
  if (!resolvedEmail) {
    return { success: false, message: 'ไม่สามารถยืนยันบัญชี Google ของครูได้ กรุณาเปิดระบบด้วยบัญชีครูที่ล็อกอินอยู่ในเบราว์เซอร์นี้' };
  }

  var absenceAlertDays = normalizeAbsenceAlertDays_(payload.absence_alert_days);
  var attentionThresholdDays = normalizeAttentionThresholdDays_(payload.attention_threshold_days);

  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);
  try {
    if (isTeacherAccessKeyConfigured_()) {
      return { success: false, message: 'ระบบนี้ถูกตั้งค่ารหัสครูแล้ว กรุณารีโหลดหน้าแล้วเข้าสู่ระบบ' };
    }

    var existingSemesters = getSemesterRows_();
    var overlap = findSemesterRangeOverlap_(existingSemesters, semesterStart, semesterEnd, 0);
    if (overlap) {
      return { success: false, message: 'ช่วงวันที่ภาคเรียนซ้อนกับ "' + overlap.name + '"' };
    }

    var semesterSheet = getOrCreateSemesterSheet_();
    deactivateAllSemesters_(semesterSheet);
    var semesterId = getNextSemesterId_(existingSemesters);
    semesterSheet.appendRow([semesterId, semesterName, semesterStart, semesterEnd, true]);
    invalidateSemesterCaches_();

    setTeacherAccessKey_(teacherKey);
      setTeacherOwnerEmail_(resolvedEmail);
      rememberTrustedTeacherDevice_(deviceId);

      var session = createTeacherSession_({
        method: 'initial_setup',
        teacher_email: resolvedEmail,
        teacher_device_id: deviceId
      });
      var uiSettings = null;
      TEACHER_TRUST_STACK_.push(session);
      try {
        uiSettings = getUiSettings_();
      } finally {
        TEACHER_TRUST_STACK_.pop();
      }
      saveSetting_('teacher_name', teacherName);
      saveSetting_('school_name', schoolName);
      saveSetting_('class_name', className);
      saveSetting_('absence_alert_days', absenceAlertDays);
      saveSetting_('attention_threshold_days', attentionThresholdDays);
      saveSetting_('setup_completed_at', nowString_());

      return {
        success: true,
        message: 'ตั้งค่าระบบครั้งแรกเรียบร้อย',
        auth: buildTeacherAuthPayload_(session),
        user: getTeacherSessionUser_(session),
        settings: uiSettings
      };
    } finally {
      lock.releaseLock();
    }
  }

function getUiSettings_(auth) {
  if (!isTeacherTrustedContext_()) {
    return runAsTeacher_(auth, {
      rate_limit_key: 'get_ui_settings',
      rate_limit_limit: 60,
      rate_limit_window_sec: 60
    }, function() {
      return getUiSettings_();
    });
  }

  ensureSecurityMigration_();
  var settings = getCachedSettings_();
  var trustedDeviceIds = getTrustedTeacherDeviceIds_();
  return {
    teacher_name: String(settings.teacher_name || ''),
    school_name: String(settings.school_name || ''),
    class_name: String(settings.class_name || ''),
    absence_alert_days: normalizeAbsenceAlertDays_(settings.absence_alert_days),
    attention_threshold_days: normalizeAttentionThresholdDays_(settings.attention_threshold_days),
    photo_folder_id: String(settings.photo_folder_id || ''),
    weekly_summary_enabled: settings.weekly_summary_enabled === true || settings.weekly_summary_enabled === 'true',
    pin_timeout_minutes: parseInt(settings.pin_timeout_minutes, 10) || 5,
    teacher_key_configured: isTeacherAccessKeyConfiguredFast_(settings),
    teacher_device_bound: trustedDeviceIds.length > 0,
    teacher_trusted_device_count: trustedDeviceIds.length,
    // ส่งเพดานไปด้วย ไม่งั้นหน้าตั้งค่าบอกได้แค่ "N อุปกรณ์" ซึ่งอ่านได้ว่าเป็นโควตาที่เหลือ
    teacher_trusted_device_max: SECURITY.MAX_TRUSTED_TEACHER_DEVICES,
    parent_token_ttl_days: getParentTokenTtlDaysFromSettings_(settings)
  };
}

function getPublicBrandingSettings_() {
  var settings = getSettings_();
  return {
    teacher_name: String(settings.teacher_name || ''),
    school_name: String(settings.school_name || ''),
    class_name: String(settings.class_name || '')
  };
}

function isValidEmailValue_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function normalizeLimitedText_(value, maxLen, label) {
  var normalized = String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\t\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (/[<>`]/.test(normalized)) {
    throw new Error((label || 'ข้อความ') + ' มีอักขระที่ไม่อนุญาต');
  }
  if (maxLen && normalized.length > maxLen) {
    throw new Error((label || 'ข้อความ') + ' ยาวเกิน ' + maxLen + ' ตัวอักษร');
  }
  return normalized;
}

function sanitizeCsvCell_(value) {
  var text = String(value == null ? '' : value);
  if (/^[=+\-@]/.test(text) || /^[\t\r]/.test(text)) {
    return "'" + text;
  }
  return text;
}

/**
 * กันข้อความของผู้ใช้ไม่ให้ Google Sheets ตีความเป็นสูตรตอนเขียนลงชีต
 *
 * Sheets แปลงค่าที่เขียนผ่าน setValue/setValues เหมือนผู้ใช้พิมพ์เอง ค่าที่ขึ้นต้นด้วย
 * = + - @ จึงกลายเป็นสูตร และแสดงเป็น #ERROR! ถ้าสูตรไม่ถูกต้อง ชื่อเด็กจะหายไปทั้งชื่อ
 * ทั้งในระบบและบนเอกสาร ปพ.6 (setNumberFormat('@') ก่อนเขียนกันไม่อยู่ ทดสอบแล้ว)
 *
 * ใช้ ' นำหน้าแบบเดียวกับ sanitizeCsvCell_ ซึ่งเป็นวิธีมาตรฐานที่บอก Sheets ว่า
 * "ค่านี้เป็นข้อความ" — ตัว ' จะถูกกลืนตอนเขียน ไม่ติดกลับมาตอน getValue()
 *
 * แตะเฉพาะ string เท่านั้น number / boolean / Date ส่งผ่านตามเดิม
 * ตัวเลขติดลบจึงไม่โดนด้วย เพราะถูกเขียนเป็น number ไม่ใช่สตริง '-5'
 */
function sanitizeSheetText_(value) {
  if (typeof value !== 'string' || !value) return value;
  if (/^[=+\-@]/.test(value) || /^[\t\r]/.test(value)) {
    return "'" + value;
  }
  return value;
}

/** ใช้ sanitizeSheetText_ กับทุกเซลล์ของอาร์เรย์ 2 มิติก่อนส่งเข้า setValues */
function sanitizeSheetRows_(rows) {
  if (!rows || !rows.length) return rows;
  return rows.map(function(row) {
    return (row || []).map(function(cell) {
      return sanitizeSheetText_(cell);
    });
  });
}

function generateSecureToken_(length) {
  var token = '';
  while (token.length < length) {
    token += Utilities.getUuid().replace(/-/g, '');
  }
  return token.substring(0, length);
}

function hashToken_(value) {
  var raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value == null ? '' : value)
  );
  return raw.map(function(b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('');
}

function constantTimeEqual_(left, right) {
  left = String(left == null ? '' : left);
  right = String(right == null ? '' : right);

  var diff = left.length ^ right.length;
  var maxLen = Math.max(left.length, right.length);
  for (var i = 0; i < maxLen; i++) {
    var leftCode = i < left.length ? left.charCodeAt(i) : 0;
    var rightCode = i < right.length ? right.charCodeAt(i) : 0;
    diff |= (leftCode ^ rightCode);
  }
  return diff === 0;
}

function enforceRateLimit_(bucket, limit, windowSec, message) {
  var cache = getSecurityCache_();
  var key = 'rl:' + bucket;
  var count = parseInt(cache.get(key) || '0', 10) + 1;
  try { cache.put(key, String(count), windowSec); } catch (e) {}
  if (count > limit) {
    throw new Error(message || 'ส่งคำขอถี่เกินไป กรุณาลองใหม่ภายหลัง');
  }
  return count;
}

function isTeacherTrustedContext_() {
  return TEACHER_TRUST_STACK_.length > 0;
}

function getTrustedTeacherSession_() {
  return TEACHER_TRUST_STACK_.length ? TEACHER_TRUST_STACK_[TEACHER_TRUST_STACK_.length - 1] : null;
}

function runAsTrustedTeacher_(fn) {
  if (typeof fn !== 'function') {
    throw new Error('Trusted teacher callback is required');
  }
  if (isTeacherTrustedContext_()) {
    return fn(getTrustedTeacherSession_());
  }

  var session = {
    session_token: 'trusted_script_editor',
    csrf_token: '',
    teacher_device_id: 'trusted_script_editor',
    teacher_email: getTeacherOwnerEmail_() || ''
  };

  TEACHER_TRUST_STACK_.push(session);
  try {
    return fn(session);
  } finally {
    TEACHER_TRUST_STACK_.pop();
  }
}

function buildTeacherAuthPayload_(session) {
  return {
    session_token: String(session.session_token || ''),
    csrf_token: String(session.csrf_token || ''),
    expires_at: parseInt(session.expires_at, 10) || 0,
    teacher_device_id: String(session.teacher_device_id || '')
  };
}

function buildPrintAuthPayload_(session) {
  return {
    print_session_token: String(session && session.print_session_token || ''),
    expires_at: parseInt(session && session.expires_at, 10) || 0,
    report_type: String(session && session.report_type || ''),
    date: String(session && session.date || ''),
    start_date: String(session && session.start_date || ''),
    end_date: String(session && session.end_date || ''),
    absent_threshold: parseInt(session && session.absent_threshold, 10) || 0
  };
}

function normalizePrintRequestContext_(context) {
  context = context || {};
  var reportType = String(context.type || context.report_type || '').trim();
  if (['pp6', 'daily', 'absent'].indexOf(reportType) < 0) {
    throw new Error('ประเภทรายงานไม่ถูกต้อง');
  }

  if (reportType === 'daily') {
    var date = normalizeAttendanceDate_(context.date, false);
    if (!date) {
      throw new Error('วันที่พิมพ์รายงานไม่ถูกต้อง');
    }
    return {
      report_type: reportType,
      date: date,
      start_date: '',
      end_date: '',
      absent_threshold: 0
    };
  }

  var range = normalizeDateRange_(context.start_date || context.start, context.end_date || context.end);
  return {
    report_type: reportType,
    date: '',
    start_date: range.from,
    end_date: range.to,
    absent_threshold: 0
  };
}

function getTeacherSessionCacheKey_(token) {
  return 'teacher_session:' + String(token || '');
}

function getPrintTokenCacheKey_(token) {
  return 'print_token:' + String(token || '');
}

function getPrintSessionCacheKey_(token) {
  return 'print_session:' + String(token || '');
}

function getParentSessionCacheKey_(token) {
  return 'parent_session:' + String(token || '');
}

function getTempDriveFileCacheKey_(fileId) {
  return 'temp_drive_file:' + String(fileId || '');
}

function registerTempDriveFile_(fileId, session, purpose, ttlSec) {
  fileId = String(fileId || '').trim();
  purpose = String(purpose || '').trim();
  if (!fileId || !purpose || !session || !session.session_token) return;
  try {
    getSecurityCache_().put(
      getTempDriveFileCacheKey_(fileId),
      JSON.stringify({
        session_token: String(session.session_token || ''),
        purpose: purpose,
        created_at: Date.now()
      }),
      Math.max(30, parseInt(ttlSec, 10) || 1800)
    );
  } catch (e) {}
}

function canCleanupTempDriveFile_(fileId, session, purpose) {
  fileId = String(fileId || '').trim();
  purpose = String(purpose || '').trim();
  if (!fileId || !purpose || !session || !session.session_token) return false;

  var raw = getSecurityCache_().get(getTempDriveFileCacheKey_(fileId));
  if (!raw) return false;

  try {
    var info = JSON.parse(raw);
    return info &&
      String(info.session_token || '') === String(session.session_token || '') &&
      String(info.purpose || '') === purpose;
  } catch (e) {
    return false;
  }
}

function clearTempDriveFileRegistration_(fileId) {
  try { getSecurityCache_().remove(getTempDriveFileCacheKey_(fileId)); } catch (e) {}
}

/**
 * เก็บ session ครูลง CacheService
 * ★ ปกติกลืน error เงียบโดยตั้งใจ เพราะ `touchTeacherSession_` เรียกตัวนี้ทุกคำขอ
 *   ถ้า cache สะดุดชั่วคราวแล้วโยน error ครูจะหลุดออกจากระบบทั้งที่ session ยังดีอยู่
 * ★ แต่ตอน**สร้าง** session ต้อง `verify` เสมอ — ดู `saveNewTeacherSessionOrThrow_`
 */
function saveTeacherSession_(session) {
  try {
    getSecurityCache_().put(
      getTeacherSessionCacheKey_(session.session_token),
      JSON.stringify(session),
      SECURITY.SESSION_TTL_SEC
    );
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * ใช้ตอนออก session ใหม่เท่านั้น — เขียนแล้วอ่านกลับมายืนยันว่าเก็บติดจริง
 * ★★ ทำไมต้องมี: เดิม `saveTeacherSession_` กลืน exception ทิ้งทั้งหมด ถ้า `put` พลาด
 *    ระบบจะ**ตอบว่าล็อกอินสำเร็จพร้อมส่ง token กลับไป** ทั้งที่ไม่มี session อยู่จริง
 *    ครูจึงเห็นป้ายเขียว "เข้าสู่ระบบสำเร็จ" แล้วโดนเด้งออกในคำขอถัดไป
 *    ด้วยข้อความ "เซสชันหมดอายุ" ซึ่ง**ชี้ไปผิดทางสนิท** เพราะไม่ใช่เรื่องหมดอายุเลย
 *    ล้มตั้งแต่ตอนล็อกอินพร้อมบอกเหตุผลตรงๆ ดีกว่าปล่อยให้ไปตายทีหลังแบบงงๆ
 */
function saveNewTeacherSessionOrThrow_(session) {
  saveTeacherSession_(session);

  var stored = null;
  try {
    stored = getSecurityCache_().get(getTeacherSessionCacheKey_(session.session_token));
  } catch (e) {
    stored = null;
  }

  if (!stored) {
    throw new Error(
      'SESSION_STORE_FAILED|ระบบเก็บเซสชันไม่สำเร็จ จึงยังเข้าใช้งานไม่ได้ ' +
      'กรุณาลองใหม่อีกครั้ง ถ้ายังไม่ได้ให้รอสัก 1-2 นาทีแล้วลองอีกครั้ง'
    );
  }
  return session;
}

function saveParentSession_(session) {
  try {
    getSecurityCache_().put(
      getParentSessionCacheKey_(session.session_token),
      JSON.stringify(session),
      SECURITY.PARENT_SESSION_TTL_SEC
    );
    return true;
  } catch (e) {
    return false;
  }
}

function savePrintSession_(session) {
  try {
    getSecurityCache_().put(
      getPrintSessionCacheKey_(session.print_session_token),
      JSON.stringify(session),
      Math.max(1, Math.ceil((parseInt(session.expires_at, 10) - Date.now()) / 1000))
    );
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * เขียน session ลง cache แล้วอ่านกลับมายืนยันว่าเก็บติดจริง
 * ★★ ทำไมต้องมี — บทเรียนจริงจาก 21 ส.ค. 2569
 *    ตอนนั้นตัวเก็บ session ครูกลืน exception ทิ้ง ระบบจึง**ตอบว่าสำเร็จพร้อมส่ง token กลับ**
 *    ทั้งที่ไม่มี session อยู่จริง อาการที่โผล่มาคือ "เซสชันหมดอายุ" ในคำขอถัดไป
 *    ซึ่งชี้ผิดทางสนิท เสียเวลาไล่ generation / อุปกรณ์ / oauthScopes ไปทั้งวัน
 *    → ออก token ให้ใครก็ตาม **ต้องยืนยันก่อนว่าอีกฝั่งเก็บได้จริง**
 * ★ ใช้เฉพาะตอน**สร้าง** session เท่านั้น — ตัวต่ออายุ (`touch*`) ต้องกลืน error ต่อไป
 *   เพราะมันรันทุกคำขอ ถ้าโยน error ตรงนั้น cache สะดุดแวบเดียวจะเตะคนใช้ออกทั้งที่ session ยังดี
 */
function verifyCachedSessionOrThrow_(cacheKey, errorCode, message) {
  var stored = null;
  try {
    stored = getSecurityCache_().get(cacheKey);
  } catch (e) {
    stored = null;
  }
  if (!stored) {
    throw new Error(errorCode + '|' + message);
  }
  return true;
}

function invalidateTeacherSession_(token) {
  try { getSecurityCache_().remove(getTeacherSessionCacheKey_(token)); } catch (e) {}
}

function invalidateParentSession_(token) {
  try { getSecurityCache_().remove(getParentSessionCacheKey_(token)); } catch (e) {}
}

function invalidatePrintSession_(token) {
  try { getSecurityCache_().remove(getPrintSessionCacheKey_(token)); } catch (e) {}
}

function getTeacherSession_(token) {
  if (!token) return null;
  var raw = getSecurityCache_().get(getTeacherSessionCacheKey_(token));
  if (!raw) return null;

  var session;
  try {
    session = JSON.parse(raw);
  } catch (e) {
    invalidateTeacherSession_(token);
    return null;
  }

  if (!session || !session.expires_at || parseInt(session.expires_at, 10) < Date.now()) {
    invalidateTeacherSession_(token);
    return null;
  }
  if ((parseInt(session.session_generation, 10) || 0) !== getTeacherSessionGeneration_()) {
    invalidateTeacherSession_(token);
    return null;
  }
  return session;
}

function getParentSession_(token) {
  if (!token) return null;
  var raw = getSecurityCache_().get(getParentSessionCacheKey_(token));
  if (!raw) return null;

  var session;
  try {
    session = JSON.parse(raw);
  } catch (e) {
    invalidateParentSession_(token);
    return null;
  }

  if (!session || !session.expires_at || parseInt(session.expires_at, 10) < Date.now()) {
    invalidateParentSession_(token);
    return null;
  }
  return session;
}

function getPrintSession_(token) {
  if (!token) return null;
  var raw = getSecurityCache_().get(getPrintSessionCacheKey_(token));
  if (!raw) return null;

  var session;
  try {
    session = JSON.parse(raw);
  } catch (e) {
    invalidatePrintSession_(token);
    return null;
  }

  if (!session || !session.expires_at || parseInt(session.expires_at, 10) < Date.now()) {
    invalidatePrintSession_(token);
    return null;
  }
  return session;
}

function touchTeacherSession_(session) {
  if (!session) return null;
  session.expires_at = Date.now() + (SECURITY.SESSION_TTL_SEC * 1000);
  saveTeacherSession_(session);
  return session;
}

function touchParentSession_(session) {
  if (!session) return null;
  session.expires_at = Date.now() + (SECURITY.PARENT_SESSION_TTL_SEC * 1000);
  saveParentSession_(session);
  return session;
}

function touchPrintSession_(session) {
  if (!session) return null;
  session.expires_at = Date.now() + (SECURITY.PRINT_TOKEN_TTL_SEC * 1000);
  savePrintSession_(session);
  return session;
}

function createTeacherSession_(meta) {
  ensureSecurityMigration_();

  var session = {
    session_token: generateSecureToken_(48),
    csrf_token: generateSecureToken_(36),
    teacher_email: String(meta && meta.teacher_email || getSingleTeacherEmail_() || '').toLowerCase(),
    teacher_device_id: String(meta && meta.teacher_device_id || ''),
    session_generation: getTeacherSessionGeneration_(),
    teacher_name: String((meta && meta.teacher_name) || getSettings_().teacher_name || ''),
    method: String(meta && meta.method || 'key'),
    created_at: Date.now(),
    expires_at: Date.now() + (SECURITY.SESSION_TTL_SEC * 1000)
  };

  // ★ ต้องยืนยันว่าเก็บติดจริง ห้ามใช้ `saveTeacherSession_` เปล่าๆ ตรงนี้
  return saveNewTeacherSessionOrThrow_(session);
}

function createParentSession_(studentNumber, meta) {
  var session = {
    session_token: generateSecureToken_(48),
    student_number: parseInt(studentNumber, 10) || 0,
    student_id: parseInt(meta && meta.student_id, 10) || 0,
    token_hash: String(meta && meta.token_hash || ''),
    created_at: Date.now(),
    expires_at: Date.now() + (SECURITY.PARENT_SESSION_TTL_SEC * 1000)
  };
  saveParentSession_(session);
  verifyCachedSessionOrThrow_(
    getParentSessionCacheKey_(session.session_token),
    'PARENT_SESSION_STORE_FAILED',
    'ระบบเปิดลิงก์ให้ไม่สำเร็จในขณะนี้ กรุณาลองกดลิงก์เดิมอีกครั้งในอีก 1-2 นาที'
  );
  return session;
}

function buildParentSessionPayload_(session) {
  return {
    session_token: String(session && session.session_token || ''),
    expires_at: parseInt(session && session.expires_at, 10) || 0
  };
}

function requirePrintSession_(auth) {
  var printSessionToken = String(auth && auth.print_session_token || '').trim();
  if (!printSessionToken) {
    throw new Error('PRINT_AUTH_REQUIRED|กรุณาเปิดหน้าพิมพ์จากระบบครูอีกครั้ง');
  }

  var printSession = getPrintSession_(printSessionToken);
  if (!printSession) {
    throw new Error('PRINT_AUTH_EXPIRED|ลิงก์พิมพ์หมดอายุ กรุณาเปิดใหม่จากระบบครู');
  }

  var teacherSession = getTeacherSession_(printSession.teacher_session_token);
  if (!teacherSession) {
    invalidatePrintSession_(printSessionToken);
    throw new Error('PRINT_AUTH_EXPIRED|เซสชันครูหมดอายุ กรุณาเปิดหน้าพิมพ์ใหม่จากระบบครู');
  }

  printSession.teacher_session_token = String(teacherSession.session_token || '');
  return touchPrintSession_(printSession);
}

function requireParentSession_(sessionToken) {
  sessionToken = String(sessionToken || '').trim();
  if (!sessionToken) {
    throw new Error('PARENT_AUTH_REQUIRED|กรุณาเปิดลิงก์ผู้ปกครองอีกครั้ง');
  }

  var session = getParentSession_(sessionToken);
  if (!session) {
    throw new Error('PARENT_AUTH_EXPIRED|ลิงก์สำหรับเปิดข้อมูลหมดอายุ กรุณาขอลิงก์ใหม่จากครู');
  }

  return touchParentSession_(session);
}

function runAsParentSession_(sessionToken, options, fn) {
  if (typeof options === 'function') {
    fn = options;
    options = {};
  }
  options = options || {};

  var session = requireParentSession_(sessionToken);

  if (options.rate_limit_key) {
    enforceRateLimit_(
      'parent_session:' + session.session_token + ':' + options.rate_limit_key,
      options.rate_limit_limit || 90,
      options.rate_limit_window_sec || 60,
      options.rate_limit_message || 'เปิดข้อมูลถี่เกินไป กรุณารอสักครู่แล้วลองใหม่'
    );
  }

  return fn(session);
}

function runAsPrintSession_(auth, options, fn) {
  if (typeof options === 'function') {
    fn = options;
    options = {};
  }
  options = options || {};

  var session = requirePrintSession_(auth);

  if (options.rate_limit_key) {
    enforceRateLimit_(
      'print:' + session.print_session_token + ':' + options.rate_limit_key,
      options.rate_limit_limit || 60,
      options.rate_limit_window_sec || 60,
      options.rate_limit_message || 'เปิดข้อมูลถี่เกินไป กรุณารอสักครู่แล้วลองใหม่'
    );
  }

  return fn(session);
}

function requireTeacherSession_(auth, options) {
  options = options || {};

  var sessionToken = String(auth && auth.session_token || '').trim();
  if (!sessionToken) {
    throw new Error('AUTH_REQUIRED|กรุณาเข้าสู่ระบบก่อนใช้งาน');
  }

  var session = getTeacherSession_(sessionToken);
  if (!session) {
    throw new Error('AUTH_EXPIRED|เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  }
  if ((parseInt(session.session_generation, 10) || 0) !== getTeacherSessionGeneration_()) {
    invalidateTeacherSession_(sessionToken);
    throw new Error('AUTH_EXPIRED|มีการเปลี่ยนข้อมูลความปลอดภัย กรุณาเข้าสู่ระบบใหม่');
  }

  var deviceId = String(auth && auth.teacher_device_id || '').trim();
  if (!isValidTeacherDeviceId_(deviceId) || deviceId !== String(session.teacher_device_id || '')) {
    invalidateTeacherSession_(sessionToken);
    throw new Error('AUTH_EXPIRED|อุปกรณ์นี้ไม่ได้รับอนุญาต กรุณาเข้าสู่ระบบใหม่');
  }
  var ownerDeviceId = hasTrustedTeacherDevice_(String(session.teacher_device_id || '')) ? String(session.teacher_device_id || '') : getTeacherOwnerDeviceId_();
  if (!ownerDeviceId || ownerDeviceId !== String(session.teacher_device_id || '')) {
    invalidateTeacherSession_(sessionToken);
    throw new Error('AUTH_EXPIRED|การผูกอุปกรณ์ครูถูกรีเซ็ตแล้ว กรุณาเข้าสู่ระบบใหม่');
  }

  if (options.require_csrf) {
    var csrfToken = String(auth && auth.csrf_token || '').trim();
    if (!csrfToken || csrfToken !== String(session.csrf_token || '')) {
      throw new Error('CSRF_INVALID|คำขอไม่ถูกต้อง กรุณารีโหลดหน้าแล้วลองใหม่');
    }
  }

  return touchTeacherSession_(session);
}

function runAsTeacher_(auth, options, fn) {
  if (typeof options === 'function') {
    fn = options;
    options = {};
  }
  options = options || {};

  if (isTeacherTrustedContext_()) {
    return fn(getTrustedTeacherSession_());
  }

  var session = requireTeacherSession_(auth, options);

  if (options.rate_limit_key) {
    enforceRateLimit_(
      'teacher:' + session.session_token + ':' + options.rate_limit_key,
      options.rate_limit_limit || SECURITY.MUTATION_RATE_LIMIT_ATTEMPTS,
      options.rate_limit_window_sec || SECURITY.MUTATION_RATE_LIMIT_WINDOW_SEC,
      options.rate_limit_message || 'ส่งคำขอถี่เกินไป กรุณารอสักครู่แล้วลองใหม่'
    );
  }

  TEACHER_TRUST_STACK_.push(session);
  try {
    return fn(session);
  } finally {
    TEACHER_TRUST_STACK_.pop();
  }
}

function getTeacherSessionUser_(session) {
  var settings = getCachedSettings_();
  var email = String(session && session.teacher_email || '').trim();
  var displayName = String(settings.teacher_name || '').trim();

  if (!displayName) {
    displayName = email ? email.split('@')[0] : 'ครูประจำชั้น';
  }

  return {
    email: email,
    displayName: displayName,
    schoolName: String(settings.school_name || ''),
    className: String(settings.class_name || '')
  };
}

function bootstrapTeacherSession(teacherKey, deviceId) {
  ensureSecurityMigration_();
  teacherKey = String(teacherKey || '').trim();
  deviceId = String(deviceId || '').trim();
  if (!isTeacherAccessKeyConfigured_()) {
    return { success: false, message: 'ยังไม่ได้ตั้งค่ารหัสเข้าใช้งานครู' };
  }
  if (!teacherKey) {
    return { success: false, message: 'กรุณากรอกรหัสเข้าใช้งาน' };
  }
  if (!isValidTeacherDeviceId_(deviceId)) {
    return { success: false, message: 'ไม่พบอุปกรณ์ที่ได้รับอนุญาต กรุณารีโหลดหน้าแล้วลองใหม่' };
  }

  try {
    enforceRateLimit_(
      'login_global',
      SECURITY.LOGIN_RATE_LIMIT_ATTEMPTS * 4,
      SECURITY.LOGIN_RATE_LIMIT_WINDOW_SEC,
      'มีการพยายามเข้าสู่ระบบมากเกินไป กรุณารอสักครู่'
    );
    enforceRateLimit_(
      'login:' + hashToken_(teacherKey).substring(0, 24),
      SECURITY.LOGIN_RATE_LIMIT_ATTEMPTS,
      SECURITY.LOGIN_RATE_LIMIT_WINDOW_SEC,
      'ลองเข้าสู่ระบบบ่อยเกินไป กรุณารอสักครู่'
    );
  } catch (e) {
    return buildFailurePayload_(e);
  }

  if (!verifyTeacherAccessKey_(teacherKey)) {
    return { success: false, message: 'รหัสเข้าใช้งานไม่ถูกต้อง' };
  }

  if (isTrustedTeacherDeviceQuotaFull_(deviceId)) {
    return {
      success: false,
      message: 'อนุญาตอุปกรณ์ครบ ' + SECURITY.MAX_TRUSTED_TEACHER_DEVICES + ' เครื่องแล้ว ' +
        'ถ้าต้องการใช้จากเครื่องใหม่ กรุณาเปิด Google Sheets แล้วใช้เมนู ' +
        '🎓 ระบบเช็คชื่อ > 📱 รีเซ็ตอุปกรณ์ครูทั้งหมด (ฉุกเฉิน) ก่อน'
    };
  }

  var principalEmail = getVerifiedTeacherPrincipalEmail_();
  var resolvedEmail = principalEmail || getSingleTeacherEmail_();
  var ownerEmail = getTeacherOwnerEmail_();
  if (!resolvedEmail) {
    return { success: false, message: 'ไม่สามารถยืนยันบัญชี Google ของครูได้ กรุณาเปิดระบบด้วยบัญชีครูที่ล็อกอินอยู่ในเบราว์เซอร์นี้' };
  }
  if (ownerEmail && ownerEmail !== resolvedEmail) {
    return { success: false, message: 'บัญชี Google นี้ไม่ได้รับอนุญาตให้ใช้ระบบครู' };
  }
  if (!ownerEmail) {
    setTeacherOwnerEmail_(resolvedEmail);
  }
  rememberTrustedTeacherDevice_(deviceId);

  var session = createTeacherSession_({
    method: 'key',
    teacher_email: resolvedEmail,
    teacher_device_id: deviceId
  });
  return {
    success: true,
    auth: buildTeacherAuthPayload_(session),
    user: getTeacherSessionUser_(session)
  };
}

function logoutTeacherSession(auth) {
  return runAsTeacher_(auth, {
    require_csrf: true
  }, function(session) {
    invalidateTeacherSession_(session.session_token);
    return { success: true, message: 'ออกจากระบบแล้ว' };
  });
}

function resetTeacherDeviceBinding(auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'reset_teacher_device_binding',
    rate_limit_limit: 5,
    rate_limit_window_sec: 300
  }, function(session) {
    clearTrustedTeacherDevices_();
    rotateTeacherSessionGeneration_();
    return {
      success: true,
      message: 'รีเซ็ตอุปกรณ์ครูทั้งหมดแล้ว กรุณาเข้าสู่ระบบใหม่บนอุปกรณ์ที่ต้องการใช้งาน',
      logged_out: true
    };
  });
}

function createPrintSession(context, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'create_print_session',
    rate_limit_limit: 20,
    rate_limit_window_sec: 60
  }, function(session) {
    var printContext;
    try {
      printContext = normalizePrintRequestContext_(context);
      if (printContext.report_type === 'absent') {
        printContext.absent_threshold = normalizeAttentionThresholdDays_(getSettings_().attention_threshold_days);
      }
    } catch (e) {
      return buildFailurePayload_(e);
    }
    var token = generateSecureToken_(32);
    try {
      getSecurityCache_().put(
        getPrintTokenCacheKey_(token),
        JSON.stringify({
          teacher_session_token: String(session.session_token || ''),
          report_type: printContext.report_type,
          date: printContext.date,
          start_date: printContext.start_date,
          end_date: printContext.end_date,
          absent_threshold: parseInt(printContext.absent_threshold, 10) || 0,
          created_at: Date.now()
        }),
        SECURITY.PRINT_TOKEN_TTL_SEC
      );
    } catch (e) {}

    return {
      success: true,
      token: token,
      expires_in_sec: SECURITY.PRINT_TOKEN_TTL_SEC
    };
  });
}

function resolvePrintSession(printToken) {
  printToken = String(printToken || '').trim();
  if (!printToken) {
    return { success: false, message: 'ลิงก์พิมพ์ไม่ถูกต้อง' };
  }

  var raw = getSecurityCache_().get(getPrintTokenCacheKey_(printToken));
  if (!raw) {
    return { success: false, message: 'ลิงก์พิมพ์หมดอายุ กรุณาเปิดใหม่จากระบบครู' };
  }

  var exchange;
  try {
    exchange = JSON.parse(raw);
  } catch (e) {
    try { getSecurityCache_().remove(getPrintTokenCacheKey_(printToken)); } catch (ignore) {}
    return { success: false, message: 'ลิงก์พิมพ์ไม่ถูกต้อง' };
  }

  var session = getTeacherSession_(exchange.teacher_session_token);
  try { getSecurityCache_().remove(getPrintTokenCacheKey_(printToken)); } catch (e) {}

  if (!session) {
    return { success: false, message: 'เซสชันหมดอายุ กรุณาเปิดใหม่จากระบบครู' };
  }

  var printSession = {
    print_session_token: generateSecureToken_(40),
    teacher_session_token: String(session.session_token || ''),
    report_type: String(exchange.report_type || ''),
    date: String(exchange.date || ''),
    start_date: String(exchange.start_date || ''),
    end_date: String(exchange.end_date || ''),
    absent_threshold: parseInt(exchange.absent_threshold, 10) || 0,
    created_at: Date.now(),
    expires_at: Date.now() + (SECURITY.PRINT_TOKEN_TTL_SEC * 1000)
  };
  savePrintSession_(printSession);
  verifyCachedSessionOrThrow_(
    getPrintSessionCacheKey_(printSession.print_session_token),
    'PRINT_SESSION_STORE_FAILED',
    'ระบบเตรียมหน้าพิมพ์ไม่สำเร็จในขณะนี้ กรุณากดพิมพ์ใหม่อีกครั้งในอีก 1-2 นาที'
  );

  return {
    success: true,
    auth: buildPrintAuthPayload_(printSession)
  };
}

function ensurePinSalt_() {
  var salt = getSecureProperty_(SECURITY_PROP.PIN_SALT);
  if (!salt) {
    salt = generateSecureToken_(32);
    setSecureProperty_(SECURITY_PROP.PIN_SALT, salt);
  }
  return salt;
}

function migrateLegacyPinStorage_() {
  var settings = getSettings_();

  if (!getSecureProperty_(SECURITY_PROP.PIN_HASH) && settings.pin_hash) {
    setSecureProperty_(SECURITY_PROP.PIN_HASH, settings.pin_hash);
  }
  if (!getSecureProperty_(SECURITY_PROP.PIN_FAILED_COUNT) && settings.pin_failed_count) {
    setSecureProperty_(SECURITY_PROP.PIN_FAILED_COUNT, settings.pin_failed_count);
  }
  if (!getSecureProperty_(SECURITY_PROP.PIN_LOCK_UNTIL) && settings.pin_lock_until) {
    setSecureProperty_(SECURITY_PROP.PIN_LOCK_UNTIL, settings.pin_lock_until);
  }

  try { removeSetting_('pin_hash'); } catch (e) {}
  try { removeSetting_('pin_failed_count'); } catch (e) {}
  try { removeSetting_('pin_lock_until'); } catch (e) {}
}

function getStoredPinHash_() {
  ensureSecurityMigration_();
  return getSecureProperty_(SECURITY_PROP.PIN_HASH);
}

function setStoredPinHash_(hash) {
  if (hash) setSecureProperty_(SECURITY_PROP.PIN_HASH, hash);
  else deleteSecureProperty_(SECURITY_PROP.PIN_HASH);
}

function getStoredPinFailedCount_() {
  ensureSecurityMigration_();
  return parseInt(getSecureProperty_(SECURITY_PROP.PIN_FAILED_COUNT) || '0', 10) || 0;
}

function setStoredPinFailedCount_(count) {
  setSecureProperty_(SECURITY_PROP.PIN_FAILED_COUNT, String(parseInt(count, 10) || 0));
}

function getStoredPinLockUntil_() {
  ensureSecurityMigration_();
  return getSecureProperty_(SECURITY_PROP.PIN_LOCK_UNTIL);
}

function setStoredPinLockUntil_(value) {
  if (value) setSecureProperty_(SECURITY_PROP.PIN_LOCK_UNTIL, value);
  else deleteSecureProperty_(SECURITY_PROP.PIN_LOCK_UNTIL);
}
