# SWETA v3.0

**Shitty Work Executive Tracking Assistant**

A K-pop themed PWA that tracks your work with scheduled check-ins and push notifications.

## 🏗️ Architecture

```
┌─────────────────┐     Subscribe      ┌─────────────────┐
│   SWETA PWA     │ ──────────────────▶│  Google Sheets  │
│   (Your Phone)  │                    │  + Apps Script  │
└─────────────────┘                    └────────┬────────┘
        ▲                                       │
        │                                       │ Every 15 min
        │ Push Notification                     ▼
        │                              ┌─────────────────┐
        └──────────────────────────────│  Cloudflare     │
                                       │  Worker (FREE)  │
                                       └─────────────────┘
```

**Total Cost: $0** 🎉

---

## ⚙️ Configuration Checklist

Before deploying, you need to update placeholder values in **3 files**. Each file has a `CONFIGURATION — UPDATE BEFORE DEPLOYING!` header at the top. Look for lines marked with `← REPLACE`.

### `cloudflare-worker.js`

| Variable | What to set | Notes |
|----------|-------------|-------|
| `VAPID_PUBLIC_KEY` | Keep default OR regenerate | Only change if you run `npx web-push generate-vapid-keys` |
| `VAPID_PRIVATE_KEY` | Keep default OR regenerate | **Keep secret!** Must match the public key |
| `VAPID_SUBJECT` | `mailto:your-email@example.com` | Your real contact email (required by push services) |

### `Code.gs` (Google Apps Script)

| Variable | What to set | Notes |
|----------|-------------|-------|
| `CLOUDFLARE_WORKER_URL` | `https://sweta-push.YOUR-SUBDOMAIN.workers.dev` | Your Cloudflare Worker URL from Step 1 |

### `index.html`

| Variable | What to set | Notes |
|----------|-------------|-------|
| `VAPID_PUBLIC_KEY` | Must match `cloudflare-worker.js` | Only change if you regenerated VAPID keys |

### Generating New VAPID Keys (optional)

If you need fresh keys (e.g., for security), run:

```bash
npx web-push generate-vapid-keys
```

Then update `VAPID_PUBLIC_KEY` in **both** `cloudflare-worker.js` and `index.html`, and `VAPID_PRIVATE_KEY` in `cloudflare-worker.js` only.

---

## 📋 Deployment Guide

Deploy in this order: **Cloudflare Worker → Google Apps Script → GitHub Pages**

### Step 1: Deploy Cloudflare Worker

1. **Create Cloudflare Account**
   - Go to [workers.cloudflare.com](https://workers.cloudflare.com)
   - Sign up for free

2. **Create New Worker**
   - Click "Create a Service"
   - Name it `sweta-push`
   - Click "Create Service"

3. **Add the Code**
   - Click "Quick Edit"
   - Delete the default code
   - Copy the entire contents of `cloudflare-worker.js`
   - Paste into the editor
   - **Update the config section** at the top (see [Configuration Checklist](#%EF%B8%8F-configuration-checklist)):
     - Set `VAPID_SUBJECT` to your real email
   - Click "Save and Deploy"

4. **Note Your Worker URL**
   - It will be like: `https://sweta-push.YOUR-SUBDOMAIN.workers.dev`
   - Copy this URL — you'll need it for Step 2

5. **Verify It Works**
   - Visit `https://your-worker.workers.dev/health`
   - Should show `{"status":"ok"}`

### Step 2: Set Up Google Apps Script

1. **Create Google Sheet**
   - Go to [sheets.google.com](https://sheets.google.com)
   - Create a new blank spreadsheet
   - Name it "SWETA Work Log"

2. **Open Apps Script**
   - Go to Extensions → Apps Script
   - Delete any default code

3. **Add the Script**
   - Copy the entire contents of `Code.gs`
   - Paste into the editor
   - **Update the config section** at the top:
     - Set `CLOUDFLARE_WORKER_URL` to your worker URL from Step 1

4. **Deploy as Web App**
   - Click "Deploy" → "New deployment"
   - Type: "Web app"
   - Execute as: "Me"
   - Who has access: "Anyone"
   - Click "Deploy"
   - **Authorize** when prompted
   - Copy the Web App URL (you'll paste this into the app later)

5. **Set Up the 15-Minute Trigger**
   - In Apps Script, select the function `setupHourlyTrigger`
   - Click the Run button (▶)
   - Authorize when prompted
   - This creates a trigger that runs `runScheduledCheck` every 15 minutes

### Step 3: Deploy PWA to GitHub Pages

1. **Create a GitHub Repository**
   - Create a new repository (public or private)
   - Upload these files:
     - `index.html`
     - `sw.js`
     - `manifest.json`
     - All `icon-*.png` files
   - **Make sure** `VAPID_PUBLIC_KEY` in `index.html` matches the one in `cloudflare-worker.js`

2. **Enable GitHub Pages**
   - Go to Settings → Pages
   - Source: Deploy from a branch
   - Branch: `main`, folder: `/` (root)
   - Save

3. **Access Your App**
   - Wait 1–2 minutes for deployment
   - Go to `https://YOUR-USERNAME.github.io/YOUR-REPO/`

---

## 🚀 First-Time Setup in App

1. **Open the App** on your phone (Chrome recommended)
2. **Complete Setup**:
   - Enter your name
   - Create a security question
   - Paste your Google Apps Script Web App URL (from Step 2)
3. **Enable Push Notifications**
   - Tap the notification banner or go to Settings
   - Tap "Enable Push Notifications"
   - Allow when prompted
4. **Test Notifications**
   - Go to Settings
   - Tap "Start Test Mode"
   - You should receive notifications every 15 seconds
   - Tap "Stop Test Mode" when done (clears test messages)
5. **Install as PWA** (recommended)
   - Chrome will show an install banner
   - Or tap menu → "Add to Home Screen"

---

## 🔔 Notification Schedule

| Time | Message |
|------|---------|
| Start Time | Good morning greeting |
| Every [interval] min | Hourly check-in |
| Sunday 12 PM | Sunday greeting |

## ⚙️ In-App Settings

- **Working Hours**: When to send notifications (default: 8:30 AM – 9:30 PM)
- **Interval**: Minutes between check-ins (default: 60)
- **Target Hours**: Monthly goal (default: 175)

## 📊 Google Sheets Structure

### Main User Sheet (one per user)
| Timestamp | Date | Time Slot | Work Done | Duration (min) | Logged At |
|-----------|------|-----------|-----------|----------------|-----------|

### _Subscriptions Sheet (auto-created)
| User Name | Subscription | Start Time | End Time | Interval | Timezone | Updated At | Last Sent |
|-----------|--------------|------------|----------|----------|----------|------------|-----------|

---

## 🛠️ Troubleshooting

### Notifications not working in background?

1. **Check subscription is saved**:
   - Open your Google Sheet
   - Look for the `_Subscriptions` sheet
   - Your entry should be there with a recent `Updated At` timestamp

2. **Check trigger is running**:
   - In Apps Script, go to Triggers (clock icon on left)
   - You should see `runScheduledCheck` running every 15 minutes

3. **Check Cloudflare Worker**:
   - Visit `https://your-worker.workers.dev/health`
   - Should show `{"status":"ok"}`

4. **Check browser permissions**:
   - On Android: Settings → Apps → Chrome → Notifications → Enable
   - Make sure battery optimization is disabled for Chrome

### Test mode not sending notifications?

1. Make sure you allowed notification permission
2. Check browser console for errors (F12 → Console)
3. Try the manual test in Google Apps Script (run `testSendNotification`)

### Push subscription failing?

1. Make sure you're on HTTPS (GitHub Pages provides this)
2. Try clearing site data and re-subscribing
3. Check that service worker is registered (DevTools → Application → Service Workers)

---

## 📱 Supported Platforms

| Platform | Background Notifications |
|----------|--------------------------|
| Android Chrome | ✅ Full support |
| Android Firefox | ✅ Full support |
| iOS Safari | ⚠️ Limited (iOS 16.4+, must be installed PWA) |
| Desktop Chrome | ✅ Full support |
| Desktop Firefox | ✅ Full support |
| Desktop Safari | ⚠️ Limited |

## 🆓 Free Tier Limits

| Service | Limit | SWETA Usage |
|---------|-------|-------------|
| Cloudflare Workers | 100,000 requests/day | ~100/day per user |
| Google Apps Script | 90 min/day runtime | ~5 min/day |
| GitHub Pages | 100GB bandwidth/month | Minimal |

You'd need 1000+ active users to approach any limits!

## 📄 Files Included

| File | Description |
|------|-------------|
| `index.html` | Main PWA application |
| `sw.js` | Service Worker with push handling |
| `manifest.json` | PWA manifest |
| `Code.gs` | Google Apps Script backend |
| `cloudflare-worker.js` | Push notification sender |
| `icon-*.png` | App icons (8 sizes) |
| `README.md` | This file |

화이팅! 💪
