/**
 * Teacher PIN lock screen helpers.
 */

function getPinState(auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_pin_state',
    rate_limit_limit: 120,
    rate_limit_window_sec: 60
  }, function() {
    return getPinStateData_();
  });
}

function getPinStateData_() {
  var settings = getCachedSettings_();
  return {
    pin_enabled: settings.pin_enabled === 'true' || settings.pin_enabled === true,
    pin_set: !!getStoredPinHash_(),
    pin_timeout_minutes: parseInt(settings.pin_timeout_minutes, 10) || 5
  };
}

function setPin(payload, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'set_pin'
  }, function() {
    payload = payload || {};

    var newPin = String(payload.new_pin || '').trim();
    var currentPin = String(payload.current_pin || '').trim();
    var currentHash = getStoredPinHash_();

    if (!/^\d{4,6}$/.test(newPin)) {
      return { success: false, message: 'PIN ต้องเป็นตัวเลข 4-6 หลัก' };
    }

    if (currentHash) {
      if (!currentPin) return { success: false, message: 'กรุณากรอก PIN เดิม' };
      if (!verifyAndUpgradePinHash_(currentPin, currentHash)) {
        return { success: false, message: 'PIN เดิมไม่ถูกต้อง' };
      }
    }

    setStoredPinHash_(hashPin_(newPin));
    setStoredPinFailedCount_(0);
    setStoredPinLockUntil_('');
    saveSetting_('pin_enabled', 'true');

    return { success: true, message: 'ตั้ง PIN สำเร็จ' };
  });
}

function verifyPin(pin, auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'verify_pin',
    rate_limit_limit: 12,
    rate_limit_window_sec: 60
  }, function() {
    pin = String(pin || '').trim();
    var pinHash = getStoredPinHash_();

    if (!pinHash) {
      return { success: false, message: 'ยังไม่ได้ตั้ง PIN' };
    }

    var lockUntil = getStoredPinLockUntil_();
    if (lockUntil) {
      var lockTime = new Date(lockUntil).getTime();
      if (lockTime > Date.now()) {
        var remaining = Math.ceil((lockTime - Date.now()) / 60000);
        return { success: false, message: 'ถูกล็อก กรุณารอ ' + remaining + ' นาที', locked: true };
      }
      setStoredPinFailedCount_(0);
      setStoredPinLockUntil_('');
    }

    if (verifyAndUpgradePinHash_(pin, pinHash)) {
      setStoredPinFailedCount_(0);
      setStoredPinLockUntil_('');
      return { success: true, message: 'ปลดล็อกสำเร็จ' };
    }

    var failedCount = getStoredPinFailedCount_() + 1;
    setStoredPinFailedCount_(failedCount);

    if (failedCount >= 5) {
      var lockMinutes = 15;
      var lockUntilDate = new Date(Date.now() + (lockMinutes * 60000));
      setStoredPinLockUntil_(lockUntilDate.toISOString());
      return { success: false, message: 'PIN ผิด 5 ครั้ง ล็อก ' + lockMinutes + ' นาที', locked: true };
    }

    return { success: false, message: 'PIN ไม่ถูกต้อง (เหลือ ' + (5 - failedCount) + ' ครั้ง)' };
  });
}

function togglePin(payload, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'toggle_pin'
  }, function() {
    payload = payload || {};

    var enabled = payload.enabled === true || payload.enabled === 'true';
    var pin = String(payload.pin || '').trim();
    var currentHash = getStoredPinHash_();

    if (enabled && !currentHash) {
      return { success: false, message: 'กรุณาตั้ง PIN ก่อน' };
    }

    if (currentHash) {
      if (!pin) return { success: false, message: 'กรุณากรอก PIN ปัจจุบัน' };
      if (!verifyAndUpgradePinHash_(pin, currentHash)) {
        return { success: false, message: 'PIN ไม่ถูกต้อง' };
      }
    }

    saveSetting_('pin_enabled', String(enabled));
    return {
      success: true,
      message: enabled ? 'เปิดใช้งาน PIN แล้ว' : 'ปิดใช้งาน PIN แล้ว'
    };
  });
}

function setPinTimeout(minutes, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'set_pin_timeout'
  }, function() {
    minutes = parseInt(minutes, 10);
    if (!(minutes >= 1 && minutes <= 60)) {
      return { success: false, message: 'Timeout ต้องอยู่ระหว่าง 1-60 นาที' };
    }
    saveSetting_('pin_timeout_minutes', String(minutes));
    return { success: true, message: 'ตั้ง timeout ' + minutes + ' นาที' };
  });
}

function removePin(currentPin, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'remove_pin'
  }, function() {
    currentPin = String(currentPin || '').trim();
    var currentHash = getStoredPinHash_();

    if (currentHash) {
      if (!currentPin) return { success: false, message: 'กรุณากรอก PIN เดิม' };
      if (!verifyAndUpgradePinHash_(currentPin, currentHash)) {
        return { success: false, message: 'PIN ไม่ถูกต้อง' };
      }
    }

    setStoredPinHash_('');
    setStoredPinFailedCount_(0);
    setStoredPinLockUntil_('');
    saveSetting_('pin_enabled', 'false');

    return { success: true, message: 'ลบ PIN สำเร็จ' };
  });
}

function hashPin_(pin) {
  var raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(pin || '') + ':' + ensurePinSalt_()
  );
  return raw.map(function(b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('');
}

function verifyPinHash_(pin, hash) {
  return constantTimeEqual_(hashPin_(pin), String(hash || ''));
}

function verifyAndUpgradePinHash_(pin, storedHash) {
  pin = String(pin || '').trim();
  storedHash = String(storedHash || '').trim();
  if (!pin || !storedHash) return false;

  if (verifyPinHash_(pin, storedHash)) {
    return true;
  }

  var legacyUnsaltedHash = hashLegacyPin_(pin);
  if (constantTimeEqual_(legacyUnsaltedHash, storedHash) || constantTimeEqual_(pin, storedHash)) {
    setStoredPinHash_(hashPin_(pin));
    setStoredPinFailedCount_(0);
    setStoredPinLockUntil_('');
    return true;
  }

  return false;
}

function hashLegacyPin_(pin) {
  var raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(pin || '')
  );
  return raw.map(function(b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('');
}
