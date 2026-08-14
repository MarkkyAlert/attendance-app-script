/**
 * Teacher-only student photo folder integration.
 */

function getStudentPhotos(auth) {
  return runAsTeacher_(auth, {
    rate_limit_key: 'get_student_photos',
    rate_limit_limit: 60,
    rate_limit_window_sec: 60
  }, function() {
    var cache = CacheService.getScriptCache();
    var cached = cache.get('student_photos');
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
    }

    var folderId = String(getCachedSettings_().photo_folder_id || '').trim();
    if (!folderId) return {};

    var photoMap = {};
    try {
      var folder = DriveApp.getFolderById(folderId);
      var files = folder.getFiles();

      while (files.hasNext()) {
        var file = files.next();
        var name = file.getName();
        if (String(file.getMimeType() || '').indexOf('image/') !== 0) continue;

        var match = name.match(/^(\d+)\./);
        if (!match) continue;

        var studentNumber = parseInt(match[1], 10);
        if (!studentNumber) continue;
        photoMap[studentNumber] = 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w200';
      }
    } catch (e) {
      Logger.log('PhotoService error: ' + e.message);
      return {};
    }

    try { cache.put('student_photos', JSON.stringify(photoMap), 600); } catch (e) {}
    return photoMap;
  });
}

function setPhotoFolder(folderUrl, auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'set_photo_folder'
  }, function() {
    folderUrl = String(folderUrl || '').trim();

    if (!folderUrl) {
      saveSetting_('photo_folder_id', '');
      clearPhotoCache_();
      return { success: true, message: 'ลบ folder รูปนักเรียนแล้ว' };
    }

    var folderId = extractFolderId_(folderUrl);
    if (!folderId) {
      return { success: false, message: 'URL ไม่ถูกต้อง กรุณาใช้ลิงก์ Google Drive folder' };
    }

    try {
      var folder = DriveApp.getFolderById(folderId);
      var fileCount = 0;
      var imageCount = 0;
      var files = folder.getFiles();

      while (files.hasNext()) {
        fileCount++;
        var file = files.next();
        if (String(file.getMimeType() || '').indexOf('image/') === 0 && file.getName().match(/^\d+\./)) {
          imageCount++;
        }
      }

      saveSetting_('photo_folder_id', folderId);
      clearPhotoCache_();

      return {
        success: true,
        message: 'เชื่อมต่อ folder "' + folder.getName() + '" สำเร็จ - พบรูปนักเรียน ' + imageCount + ' รูป (ไฟล์ทั้งหมด ' + fileCount + ')'
      };
    } catch (e) {
      return { success: false, message: 'เข้าถึง folder ไม่ได้: ' + e.message };
    }
  });
}

function refreshPhotoCache(auth) {
  return runAsTeacher_(auth, {
    require_csrf: true,
    rate_limit_key: 'refresh_photo_cache'
  }, function() {
    clearPhotoCache_();
    var photos = getStudentPhotos();
    return { success: true, message: 'โหลดรูปใหม่ พบ ' + Object.keys(photos).length + ' รูป' };
  });
}

function extractFolderId_(input) {
  if (!input) return '';
  if (/^[a-zA-Z0-9_-]{10,}$/.test(input)) return input;

  var patterns = [
    /\/folders\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/,
    /\/d\/([a-zA-Z0-9_-]+)/
  ];

  for (var i = 0; i < patterns.length; i++) {
    var match = String(input).match(patterns[i]);
    if (match) return match[1];
  }
  return '';
}

function clearPhotoCache_() {
  try { CacheService.getScriptCache().remove('student_photos'); } catch (e) {}
}
