// =====================================================
// SWETA Google Apps Script v3.1.0
// With Push Notification Support + Invoice
// =====================================================

// =====================================================
// CONFIGURATION — UPDATE BEFORE DEPLOYING!
// =====================================================

// Your Cloudflare Worker URL (deploy cloudflare-worker.js first, then paste URL here)
const CLOUDFLARE_WORKER_URL = 'https://sweta-push.YOUR-SUBDOMAIN.workers.dev';  // ← REPLACE

// =====================================================
// Web App Entry Points
// =====================================================

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;

    switch (action) {
      case 'createSheet':
        return jsonResponse(createUserSheet(data.userName));
      case 'logWork':
        return jsonResponse(logWork(data));
      case 'saveSubscription':
        return jsonResponse(saveSubscription(data));
      case 'removeSubscription':
        return jsonResponse(removeSubscription(data.userName));
      case 'getStats':
        return jsonResponse(getStats(data.userName));
      case 'getTasks':
        return jsonResponse(getTasks(data.userName, data.date));
      case 'sendTestPush':
        return jsonResponse(sendTestPush(data));
      case 'sendInvoiceEmail':
        return jsonResponse(sendInvoiceEmail(data));
      default:
        return jsonResponse({ error: 'Unknown action' });
    }
  } catch (error) {
    return jsonResponse({ error: error.message });
  }
}

function doGet(e) {
  const action = e.parameter.action;

  if (action === 'triggerNotifications') {
    return jsonResponse(triggerScheduledNotifications());
  }

  if (action === 'getTasksInRange') {
    return jsonResponse(getTasksInRange(e.parameter.userName, e.parameter.startDate, e.parameter.endDate));
  }

  if (action === 'getSubscriptionStatus') {
    return jsonResponse(getSubscriptionStatus(e.parameter.userName));
  }

  return jsonResponse({ status: 'SWETA API v3.1.0', message: 'Use POST for actions' });
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// =====================================================
// Sheet Management
// =====================================================

function getOrCreateSheet(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
  }

  return sheet;
}

function createUserSheet(userName) {
  const sanitizedName = userName.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 30);
  const sheet = getOrCreateSheet(sanitizedName);

  const firstCell = sheet.getRange('A1').getValue();
  if (!firstCell) {
    const headers = ['Timestamp', 'Date', 'Time Slot', 'Work Done', 'Duration (min)', 'Logged At'];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setBackground('#ff6b9d');
    headerRange.setFontColor('#ffffff');
    headerRange.setFontWeight('bold');
    sheet.setFrozenRows(1);

    sheet.setColumnWidth(1, 180);
    sheet.setColumnWidth(2, 100);
    sheet.setColumnWidth(3, 150);
    sheet.setColumnWidth(4, 300);
    sheet.setColumnWidth(5, 100);
    sheet.setColumnWidth(6, 100);
  }

  return { success: true, sheetName: sanitizedName };
}

// =====================================================
// Work Logging
// =====================================================

function logWork(data) {
  const sanitizedName = data.userName.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 30);
  const sheet = getOrCreateSheet(sanitizedName);

  if (data.duration > 0) {
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      const lastRowData = sheet.getRange(lastRow, 1, 1, 6).getValues()[0];
      if (lastRowData[3] === data.workDone && !lastRowData[4]) {
        sheet.getRange(lastRow, 5).setValue(data.duration);
        return { success: true, updated: true };
      }
    }
  }

  const row = [
    data.timestamp,
    data.date,
    data.timeSlot,
    data.workDone,
    data.duration || '',
    data.loggedAt
  ];

  sheet.appendRow(row);
  return { success: true, added: true };
}

// =====================================================
// Push Subscription Management
// =====================================================

function saveSubscription(data) {
  const subsSheet = getOrCreateSheet('_Subscriptions');

  const firstCell = subsSheet.getRange('A1').getValue();
  if (!firstCell) {
    const headers = ['User Name', 'Subscription', 'Start Time', 'End Time', 'Interval', 'Timezone', 'Updated At', 'Last Sent'];
    subsSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    subsSheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    subsSheet.setFrozenRows(1);
  }

  const dataRange = subsSheet.getDataRange();
  const values = dataRange.getValues();
  let existingRow = -1;

  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === data.userName) {
      existingRow = i + 1;
      break;
    }
  }

  const settings = data.settings || {};
  const rowData = [
    data.userName,
    data.subscription,
    settings.startTime || '08:30',
    settings.endTime || '21:30',
    settings.interval || 60,
    settings.timezone || 'Asia/Kolkata',
    new Date().toISOString(),
    ''  // Last Sent — managed by triggerScheduledNotifications
  ];

  if (existingRow > 0) {
    // Update columns 1–7 but preserve Last Sent (column 8)
    subsSheet.getRange(existingRow, 1, 1, 7).setValues([rowData.slice(0, 7)]);
  } else {
    subsSheet.appendRow(rowData);
  }

  return { success: true };
}

function removeSubscription(userName) {
  const subsSheet = getOrCreateSheet('_Subscriptions');
  const dataRange = subsSheet.getDataRange();
  const values = dataRange.getValues();

  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === userName) {
      subsSheet.deleteRow(i + 1);
      return { success: true, removed: true };
    }
  }

  return { success: false, message: 'Subscription not found' };
}

function getAllSubscriptions() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const subsSheet = ss.getSheetByName('_Subscriptions');

  if (!subsSheet) {
    return [];
  }

  const dataRange = subsSheet.getDataRange();
  const values = dataRange.getValues();
  const subscriptions = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (row[0] && row[1]) {
      subscriptions.push({
        userName: row[0],
        subscription: row[1],
        startTime: row[2] || '08:30',
        endTime: row[3] || '21:30',
        interval: row[4] || 60,
        timezone: row[5] || 'Asia/Kolkata',
        lastSent: row[7] || null
      });
    }
  }

  return subscriptions;
}

// =====================================================
// Scheduled Notifications (called by trigger)
// =====================================================

function triggerScheduledNotifications() {
  const subscriptions = getAllSubscriptions();
  const results = [];

  for (const sub of subscriptions) {
    try {
      const shouldSend = shouldSendNotification(sub);

      if (shouldSend.send) {
        const response = sendPushNotification(sub, shouldSend.type, shouldSend.message);
        updateLastSent(sub.userName);
        results.push({ user: sub.userName, type: shouldSend.type, sent: true });
      } else {
        results.push({ user: sub.userName, skipped: true, reason: shouldSend.reason });
      }
    } catch (error) {
      results.push({ user: sub.userName, error: error.message });
    }
  }

  return { processed: subscriptions.length, results: results };
}

function shouldSendNotification(sub) {
  const now = new Date();
  const options = { timeZone: sub.timezone, hour: '2-digit', minute: '2-digit', hour12: false };
  const timeStr = now.toLocaleTimeString('en-US', options);
  const [hours, minutes] = timeStr.split(':').map(Number);

  const dayOptions = { timeZone: sub.timezone, weekday: 'short' };
  const day = now.toLocaleDateString('en-US', dayOptions);

  const name = sub.userName || 'Anji';

  // Deduplication: check time since last notification
  const lastSent = sub.lastSent ? new Date(sub.lastSent) : null;
  const minutesSinceLastSent = lastSent ? (now - lastSent) / (1000 * 60) : Infinity;

  // Sunday — only noon message (with dedup)
  if (day === 'Sun') {
    if (hours === 12 && minutes < 15) {
      if (minutesSinceLastSent > 30) {
        return { send: true, type: 'sunday', message: `🌟 Happy Sunday ${name}! Enjoy your day off! Give Ishan a kiss for me! 💜` };
      }
      return { send: false, reason: 'Sunday noon already sent' };
    }
    return { send: false, reason: 'Sunday, not noon' };
  }

  // Parse working hours
  const [startHour, startMin] = sub.startTime.split(':').map(Number);
  const [endHour, endMin] = sub.endTime.split(':').map(Number);

  const currentMins = hours * 60 + minutes;
  const startMins = startHour * 60 + startMin;
  const endMins = endHour * 60 + endMin;

  // Outside working hours
  if (currentMins < startMins || currentMins > endMins) {
    return { send: false, reason: 'Outside working hours' };
  }

  // Morning message — widened to 20 min window (was 15) to tolerate trigger jitter
  if (currentMins >= startMins && currentMins < startMins + 20) {
    if (minutesSinceLastSent > 30) {
      return { send: true, type: 'morning', message: `☀️ Good morning ${name}! Hope you have a productive day! 🌸 Anything from last night or this morning to document? 📝` };
    }
    return { send: false, reason: 'Morning already sent' };
  }

  // Hourly check-in — simplified: within 15 min of interval mark
  // (matches 15-min trigger granularity so we never miss a window)
  const timeSinceStart = currentMins - startMins;
  const interval = sub.interval || 60;

  if (timeSinceStart > 0) {
    const remainder = timeSinceStart % interval;
    if (remainder < 15) {
      // Dedup: only send if we haven't sent in this interval
      if (minutesSinceLastSent >= interval - 5) {
        return { send: true, type: 'hourly', message: `⏰ Check-in time, ${name}! What have you been up to?` };
      }
      return { send: false, reason: 'Already sent this interval' };
    }
  }

  return { send: false, reason: 'Not at interval mark' };
}

function sendPushNotification(sub, type, message) {
  const payload = {
    subscription: JSON.parse(sub.subscription),
    notification: {
      title: type === 'morning' ? 'Good Morning! ☀️' : 'SWETA 💜',
      body: message,
      type: type
    }
  };

  const options = {
    method: 'POST',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(CLOUDFLARE_WORKER_URL + '/send', options);
  return JSON.parse(response.getContentText());
}

// =====================================================
// Deduplication & Verification Helpers
// =====================================================

function updateLastSent(userName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const subsSheet = ss.getSheetByName('_Subscriptions');
  if (!subsSheet) return;

  const dataRange = subsSheet.getDataRange();
  const values = dataRange.getValues();

  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === userName) {
      subsSheet.getRange(i + 1, 8).setValue(new Date().toISOString());
      break;
    }
  }
}

function getSubscriptionStatus(userName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const subsSheet = ss.getSheetByName('_Subscriptions');
  if (!subsSheet) return { found: false };

  const values = subsSheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (values[i][0] === userName) {
      return { found: true, hasSubscription: !!values[i][1], updatedAt: values[i][6] };
    }
  }
  return { found: false };
}

// =====================================================
// Stats & Reports
// =====================================================

function getStats(userName) {
  const sanitizedName = userName.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 30);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sanitizedName);

  if (!sheet) {
    return { todayMinutes: 0, monthlyMinutes: 0 };
  }

  const data = sheet.getDataRange().getValues();
  const today = new Date().toLocaleDateString('en-IN');
  const thisMonth = new Date().getMonth();
  const thisYear = new Date().getFullYear();

  let todayMinutes = 0;
  let monthlyMinutes = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const duration = parseInt(row[4]) || 0;
    const date = row[1];

    if (date) {
      const parts = date.split('/');
      if (parts.length === 3) {
        const rowMonth = parseInt(parts[1]) - 1;
        const rowYear = parseInt(parts[2]);

        if (date === today) {
          todayMinutes += duration;
        }

        if (rowMonth === thisMonth && rowYear === thisYear) {
          monthlyMinutes += duration;
        }
      }
    }
  }

  return { todayMinutes, monthlyMinutes };
}

function getTasks(userName, date) {
  const sanitizedName = userName.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 30);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sanitizedName);

  if (!sheet) {
    return { tasks: [] };
  }

  const data = sheet.getDataRange().getValues();
  const tasks = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[1] === date) {
      tasks.push({
        timeSlot: row[2],
        workDone: row[3],
        duration: row[4]
      });
    }
  }

  return { tasks };
}

// =====================================================
// Invoice: Get tasks in a date range (deduped)
// =====================================================

function getTasksInRange(userName, startDate, endDate) {
  const sanitizedName = (userName || '').replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 30);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sanitizedName);

  if (!sheet) return { tasks: [] };

  function parseIndianDate(dateStr) {
    if (!dateStr) return null;
    const str = String(dateStr).trim();
    const parts = str.split('/');
    if (parts.length !== 3) return null;
    return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
  }

  const start = startDate ? parseIndianDate(startDate) : null;
  const end = endDate ? parseIndianDate(endDate) : null;
  if (end) end.setHours(23, 59, 59, 999);

  const data = sheet.getDataRange().getValues();
  const seen = new Set();
  const tasks = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const workDone = String(row[3] || '').trim();
    if (!workDone) continue;

    const rowDate = parseIndianDate(row[1]);
    if (start && rowDate && rowDate < start) continue;
    if (end && rowDate && rowDate > end) continue;

    if (!seen.has(workDone)) {
      seen.add(workDone);
      tasks.push({
        date: String(row[1]),
        timeSlot: String(row[2] || ''),
        workDone: workDone,
        duration: row[4]
      });
    }
  }

  return { tasks };
}

// =====================================================
// Invoice: Send PDF via email
// =====================================================

function sendInvoiceEmail(data) {
  const toEmail = data.email;
  const subject = data.subject || 'Invoice from Anjali Ramesh';
  const body = data.body || 'Please find the attached invoice.';
  const pdfBase64 = data.pdfBase64;
  const fileName = data.fileName || 'invoice.pdf';

  if (!toEmail) return { success: false, error: 'No email address provided' };
  if (!pdfBase64) return { success: false, error: 'No PDF data provided' };

  try {
    const pdfBlob = Utilities.newBlob(
      Utilities.base64Decode(pdfBase64),
      'application/pdf',
      fileName
    );

    GmailApp.sendEmail(toEmail, subject, body, {
      attachments: [pdfBlob],
      name: 'Anjali Ramesh'
    });

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// =====================================================
// Time-Based Triggers Setup
// =====================================================

function setupHourlyTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === 'runScheduledCheck') {
      ScriptApp.deleteTrigger(trigger);
    }
  }

  ScriptApp.newTrigger('runScheduledCheck')
    .timeBased()
    .everyMinutes(15)
    .create();

  return { success: true, message: 'Trigger created to run every 15 minutes' };
}

function runScheduledCheck() {
  console.log('Running scheduled check at', new Date().toISOString());
  const result = triggerScheduledNotifications();
  console.log('Result:', JSON.stringify(result));
  return result;
}

// =====================================================
// Test Push Notifications
// =====================================================

function sendTestPush(data) {
  const subscription = JSON.parse(data.subscription);
  const testNum = data.testNum || 1;
  const timestamp = data.timestamp || new Date().toLocaleTimeString();

  const payload = {
    subscription: subscription,
    notification: {
      title: 'SWETA Test 🧪',
      body: `Test #${testNum} at ${timestamp} - Background push works!`,
      type: 'test'
    }
  };

  const options = {
    method: 'POST',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(CLOUDFLARE_WORKER_URL + '/send', options);
    const result = JSON.parse(response.getContentText());
    console.log('Test push result:', JSON.stringify(result));
    return { success: true, result: result };
  } catch (error) {
    console.error('Test push error:', error);
    return { success: false, error: error.message };
  }
}

// =====================================================
// Manual Test Functions
// =====================================================

function testSendNotification() {
  const subscriptions = getAllSubscriptions();

  if (subscriptions.length === 0) {
    console.log('No subscriptions found');
    return;
  }

  const sub = subscriptions[0];
  console.log('Testing notification for:', sub.userName);

  const result = sendPushNotification(sub, 'test', 'This is a test notification from SWETA! 🧪');
  console.log('Result:', JSON.stringify(result));
}

function listSubscriptions() {
  const subs = getAllSubscriptions();
  console.log('Found', subs.length, 'subscriptions:');
  subs.forEach(s => console.log('-', s.userName, s.startTime, '-', s.endTime));
  return subs;
}
