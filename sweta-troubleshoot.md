# SWETA Background Notifications — Bug Analysis

## Architecture Recap

```
Google Apps Script trigger (every 15 min)
  → runScheduledCheck() → triggerScheduledNotifications()
    → shouldSendNotification() decides whether to send
      → sendPushNotification() POSTs to Cloudflare Worker
        → Cloudflare Worker encrypts + sends Web Push
          → Browser push service delivers to device
            → sw.js push event → shows OS notification
```

## 🔴 Bug #1: `shouldSendNotification()` timing logic is broken — notifications rarely fire

**File:** [Code.gs](file:///home/ishand/Projects/SWETA/Code.gs) — Lines 293–310

This is the **most critical bug** and the most likely reason notifications aren't working.

The function has two overlapping checks after the morning check, and the first one (`nextMark` check on line 301) is **almost always false** due to a logic error:

```javascript
// Lines 293-310 in Code.gs
const timeSinceStart = currentMins - startMins;
const interval = sub.interval || 60;

// Check if we're within 2 minutes of an interval mark
const intervalMark = Math.floor(timeSinceStart / interval) * interval;
const nextMark = intervalMark + interval;

if (timeSinceStart >= nextMark - 2 && timeSinceStart <= nextMark + 2) {  // LINE 301
  return { send: true, type: 'hourly', message: `⏰ Check-in time, ${name}! What have you been up to?` };
}

// Check for interval alignment (within 5 min window)                      // LINE 306
if (timeSinceStart > 0 && timeSinceStart % interval <= 5) {
  return { send: true, type: 'hourly', message: `💜 Hourly reminder! What did you accomplish?` };
}
```

### Analysis of Line 301 — The `nextMark` check

Consider interval = 60, start at 8:30.

- At 9:28 (58 min since start): `intervalMark = 0`, `nextMark = 60`. Check: `58 >= 58 && 58 <= 62` → ✅ **hits**
- At 9:30 (60 min since start): `intervalMark = 60`, `nextMark = 120`. Check: `60 >= 118 && 60 <= 122` → ❌ **misses!**
- At 9:31 (61 min since start): `intervalMark = 60`, `nextMark = 120`. Check: `61 >= 118` → ❌ **misses**

So line 301 only works if the trigger fires at **exactly** `nextMark - 2` or `nextMark - 1` minutes — i.e., 2 minutes *before* the interval mark. Once you're *at* or *past* the mark, `intervalMark` jumps forward by `interval`, making `nextMark` unreachable.

### Analysis of Line 306 — The fallback `%` check

```javascript
if (timeSinceStart > 0 && timeSinceStart % interval <= 5) {
```

With interval = 60:
- At 9:30 (60 min): `60 % 60 = 0` → `0 <= 5` ✅ **hits**  
- At 9:35 (65 min): `65 % 60 = 5` → `5 <= 5` ✅ **hits**
- At 9:36 (66 min): `66 % 60 = 6` → `6 <= 5` ❌ **misses**

This check actually works but has a **5-minute window** instead of the likely-intended few minutes. With the trigger running every 15 minutes, it should catch hits... **but only if the trigger fires within 5 minutes of an interval mark.**

### The real problem: trigger interval vs check-in interval misalignment

The Google Apps Script trigger runs every **15 minutes**, but the default check-in interval is **60 minutes**. The 15-minute trigger could fire at :00, :15, :30, :45 past each hour.

If start time is 8:30:
- Interval marks are at: 9:30, 10:30, 11:30, etc.
- Trigger fires at approximately: 8:30, 8:45, 9:00, 9:15, 9:30, 9:45, ...

At 9:30 → `timeSinceStart = 60`, `60 % 60 = 0 <= 5` ✅  
At 9:45 → `timeSinceStart = 75`, `75 % 60 = 15 > 5` ❌  
At 10:00 → `timeSinceStart = 90`, `90 % 60 = 30 > 5` ❌  
At 10:15 → `timeSinceStart = 105`, `105 % 60 = 45 > 5` ❌  
At 10:30 → `timeSinceStart = 120`, `120 % 60 = 0 <= 5` ✅  

**This actually works** for 60-minute intervals if the trigger aligns with the interval mark. But Google Apps Script's `everyMinutes(15)` does **not guarantee exact timing**. The trigger might fire at :02, :17, :32, :47 — which would miss the 5-minute window.

> [!WARNING]
> **Root cause**: The combination of approximate trigger timing and narrow interval-match windows means notifications are **silently skipped** most of the time. This is the primary reason background notifications don't work.

### Fix

Replace lines 293–310 in [Code.gs](file:///home/ishand/Projects/SWETA/Code.gs) with a simpler approach that tolerates the 15-minute trigger granularity:

```javascript
// Check if enough time has passed since last notification
// The Apps Script trigger runs ~every 15 min, so use a wider window
const timeSinceStart = currentMins - startMins;
const interval = sub.interval || 60;

if (timeSinceStart > 0) {
  // We're within working hours, past the morning window.
  // Check: is the current time within 15 min after an interval mark?
  const remainder = timeSinceStart % interval;
  if (remainder < 15) {
    return { send: true, type: 'hourly', message: `⏰ Check-in time, ${name}! What have you been up to?` };
  }
}
```

But this alone would cause **duplicate notifications** (the trigger might fire twice within the same 15-min window). To prevent that, you need to track the last sent notification time per user. See [Bug #3](#-bug-3-no-deduplication--notifications-can-fire-multiple-times-or-zero-times).

---

## 🔴 Bug #2: Morning notification has a 15-minute window but trigger runs every 15 minutes

**File:** [Code.gs](file:///home/ishand/Projects/SWETA/Code.gs) — Lines 289–291

```javascript
if (currentMins >= startMins && currentMins < startMins + 15) {
  return { send: true, type: 'morning', message: ... };
}
```

With start at 8:30 and trigger every 15 min — the trigger must fire between 8:30 and 8:44. Given Apps Script timing jitter, there's a decent chance this window is hit, but also a decent chance it's missed entirely. Should be widened to 20+ minutes or tracked with a "sent today" flag.

---

## 🔴 Bug #3: No deduplication — notifications can fire multiple times OR zero times

**File:** [Code.gs](file:///home/ishand/Projects/SWETA/Code.gs) — `triggerScheduledNotifications()`

There is **no tracking of whether a notification was already sent for a given interval**. If the trigger fires twice within the 5-minute `% interval` window (e.g., at :00 and :04), the user gets duplicate notifications. Conversely, if the trigger misses the window entirely, they get zero.

### Fix

Add a `Last Sent` column to the `_Subscriptions` sheet. Before sending, check if the last send was within the current interval window. After sending, write the timestamp.

---

## 🟡 Bug #4: `mode: 'no-cors'` on `saveSubscriptionToServer()` — can't verify success

**File:** [index.html](file:///home/ishand/Projects/SWETA/index.html) — Lines 808–813

```javascript
await fetch(state.scriptUrl, {
  method: 'POST',
  mode: 'no-cors',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data)
});
```

With `mode: 'no-cors'`, the response is opaque — you can't read the status code or body. If the subscription save fails (e.g., wrong URL, script error), the app will never know. The user sees "Push notifications enabled!" but the server never stored the subscription.

> [!IMPORTANT]
> This is a **silent failure mode** that could explain why notifications "look enabled" but never arrive. The subscription may never actually be saved to the `_Subscriptions` sheet.

This same issue applies to `sendServerTestPush()` (line 898) and `logWorkToSheet()` (line 1461).

### Why `no-cors` is used

Google Apps Script deployed as "Web App" redirects `POST` requests through a Google login redirect. With `cors` mode, the browser blocks cross-origin redirects. Using `no-cors` is a common workaround but sacrifices response visibility.

### Diagnostic step

Check the `_Subscriptions` sheet in Google Sheets — does it actually contain a row with your user name and a valid subscription JSON?

---

## 🟡 Bug #5: `VAPID_SUBJECT` is still placeholder

**File:** [cloudflare-worker.js](file:///home/ishand/Projects/SWETA/cloudflare-worker.js) — Line 9

```javascript
const VAPID_SUBJECT = 'mailto:your-email@example.com';
```

Some push services (notably Mozilla's) reject push requests with invalid/placeholder VAPID subjects. This might cause Cloudflare Worker push sends to fail silently on Firefox.

---

## 🟢 Things that look correct

- **Service worker `push` event handler** ([sw.js:131-191](file:///home/ishand/Projects/SWETA/sw.js#L131-L191)) — correctly shows notification and saves to IndexedDB
- **Cloudflare Worker encryption** ([cloudflare-worker.js](file:///home/ishand/Projects/SWETA/cloudflare-worker.js)) — aes128gcm implementation looks complete and correct  
- **VAPID JWT generation** — proper ES256 signing with DER-to-raw conversion
- **Push subscription flow** in the PWA — correctly uses `pushManager.subscribe()` with VAPID key

---

## Diagnostic Checklist

Before fixing code, verify these:

1. **Open Google Sheets** → Check if `_Subscriptions` sheet exists and has your row with valid subscription JSON
2. **In Apps Script** → Go to Triggers (⏰ icon) → Confirm `runScheduledCheck` trigger exists and runs every 15 min  
3. **In Apps Script** → Check execution log (Executions tab) → Look for recent `runScheduledCheck` runs and their output
4. **Run `testSendNotification()` manually** in Apps Script → Does it succeed or error?
5. **Check Cloudflare Worker URL** → Is `CLOUDFLARE_WORKER_URL` in Code.gs pointing to the correct worker?
6. **Visit `https://your-worker.workers.dev/health`** → Should return `{"status":"ok"}`

---

## Summary of Recommended Fixes

| Priority | Bug | Fix |
|----------|-----|-----|
| 🔴 P0 | Timing logic in `shouldSendNotification()` | Widen window + add dedup tracking |
| 🔴 P0 | No deduplication of sent notifications | Add `Last Sent` column to `_Subscriptions` |
| 🟡 P1 | `no-cors` hides save failures | Add error logging / verify sheet manually |
| 🟡 P1 | Placeholder VAPID subject | Update to real email |
| 🟡 P2 | Morning window too narrow | Widen to 20 min or track with flag |

> [!IMPORTANT]
> **I recommend first running the diagnostic checklist above to narrow down where the pipeline breaks.** The most impactful code fix is the timing logic in `shouldSendNotification()` — that's where most "not working" scenarios originate.
