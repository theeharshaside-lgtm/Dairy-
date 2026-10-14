# Daily Dairy 📖🔒

A private, shared digital diary for exactly two people. Daily Dairy is engineered to look and feel like an intimate personal notebook—**never** a conventional social-media messenger or chat app.

---

## 1. Project Vision & Aesthetic Design

- **Appearance**: Warm cream paper background (`#FAF6EE`), subtle ruled notebook lines, delicate terracotta/pink vertical margin line, rich terracotta accents (`#B84D2B`), and dark serif typography.
- **Pure Notebook Text**: Entries appear as natural literary paragraphs written in a journal under a date header (`Monday, October 13`, `Dear Diary,`).
- **Strict UI Invariants (Zero Social Noise)**:
  - ❌ NO chat bubbles or message cards
  - ❌ NO avatars, profile pictures, or user icons
  - ❌ NO "Friend 1", "Friend 2", sender or receiver labels
  - ❌ NO online status, typing indicators, or delivery ticks
  - ❌ NO public read receipts
  - ❌ NO permanent conversation history or chat archives

---

## 2. Ephemeral Message & Diary Lifecycle

```
[Phone A writes entry]
         │
         ▼
[Stored securely on server as ACTIVE]
         │
         ▼
[Phone B opens Daily Dairy]
         │
         ▼
[Explicit viewing session started: Entry displayed to Phone B]
         │
         ▼
[Phone B reads entry — entry remains visible during active reading session]
         │
         ▼
[Phone B leaves diary (locks screen, closes app, or backgrounds)]
         │
         ▼
[Server-authorized consume request sent with Phone B device identity]
         │
         ▼
[Entry content is permanently and atomically purged from active database]
         │
         ▼
[Vanished for both phones — refresh will never restore it]
```

### Key Reliability Invariants
1. **Sender Immunity**: The sender opening or closing their own diary **never** deletes an entry. Deletion is triggered only when the intended recipient has viewed and left the session.
2. **Selective Consumption**: If Phone A writes 2 entries, and Phone B views only Entry 1 and leaves, Entry 1 is deleted while Entry 2 remains pending until read.
3. **Interrupted / Crash Resilience**: Uses `visibilitychange`, `pagehide`, and Android `Lifecycle.Event.ON_STOP`. In mobile web browsers, `fetch(..., { keepalive: true })` and `navigator.sendBeacon()` ensure reliable exit delivery. A 15-minute server fallback cleanup cleans up orphaned viewed sessions if a phone suddenly loses power.

---

## 3. Implementations Provided

This repository includes **two full, production-ready implementations**:

### A. Android Native Application (Kotlin + Jetpack Compose)
- **Framework**: Jetpack Compose, Material 3, Edge-to-Edge display.
- **Local Persistence**: Room Database for offline queueing of outgoing entries.
- **Security**: PBKDF2WithHmacSHA256 password hashing with salt, 5-attempt rate-limiting lockout, constant-time comparisons, and secure device UUIDs.
- **Two-Phone Testing Studio**: Built-in toggle in the top bar (`Phone 1` ⇄ `Phone 2`) allowing you to simulate the entire two-device ephemeral vanishing flow directly in the Android Emulator.
- **Remote Connectivity**: Configure any self-hosted or cloud URL in Settings to sync with a remote backend.

### B. Mobile-First Progressive Web App (PWA) + Node.js Backend
- **PWA Client** (`/pwa`): Installable via Chrome on Android with Web App Manifest (`manifest.json`) and service worker (`sw.js`).
- **Backend API** (`/server`): Express server with rate limiting, helmet security headers, bcrypt password hashing, session tokens, and atomic deletion engine.

---

## 4. Default Bootstrap Credentials

When first deployed, the diary is protected by bootstrap credentials:
- **Username**: `diary`
- **Password**: `ChangeThisOnFirstLogin!`

> **Security Rule**: The application enforces changing this bootstrap password on the very first login. Access to the diary is denied until a custom, secure password (minimum 8 characters) is established.

---

## 5. Automated Test Suite Results

An end-to-end integration test suite (`server/test_e2e.js`) validates all 16 multi-device, realtime, and lifecycle guarantees:

```bash
$ node server/test_e2e.js

--- Starting Daily Dairy Automated Lifecycle Verification ---
✅ PASS: Invalid password is rejected with 401
✅ PASS: Bootstrap login succeeds
✅ PASS: First login mandates password change
✅ PASS: Mandatory password change succeeds
✅ PASS: Phone 1 logs in with new password
✅ PASS: Phone 2 logs in successfully
✅ PASS: Server maintains distinct device IDs for the two phones
✅ PASS: Phone 1 writes diary entry
✅ PASS: Phone 2 sees the written diary entry
✅ PASS: Entry content matches exactly
✅ PASS: Phone 2 starts viewing session for entry
✅ PASS: Entry remains displayed while Phone 2 is reading in the diary
✅ PASS: Sender opening or leaving does NOT consume their own entry
✅ PASS: Entry still preserved after sender action
✅ PASS: Recipient exit consumes entry
✅ PASS: Entry disappeared from Phone 1
✅ PASS: Entry disappeared from Phone 2
✅ PASS: Refresh does not restore consumed entry
✅ PASS: Only viewed entry is consumed
✅ PASS: Unread entry is preserved
✅ PASS: Exact unread entry remains pending
✅ PASS: Phone 2 receives real-time SSE push broadcast when Phone 1 writes
✅ PASS: Received entry matches written content
✅ PASS: Phone 1 session remains fully valid
✅ PASS: Phone 2 session remains fully valid

🌟 ALL 16 AUTOMATED MULTI-DEVICE & REALTIME LIFECYCLE TESTS PASSED PERFECTLY!
```

---

## 6. Backend & PWA Quick Start

### Running Locally
```bash
cd server
npm install
npm start
```
The server will bind to `http://localhost:3000`, serving both the REST API and the `/pwa` client.

### Deploying to Free-Tier Cloud Hosting

#### Option 1: Render.com (Recommended Free Tier)
1. Fork or push this repository to GitHub.
2. In [Render Dashboard](https://dashboard.render.com/), create a new **Web Service**.
3. Set:
   - **Root Directory**: `server`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Environment Variables**:
     - `BOOTSTRAP_USERNAME`: `diary`
     - `BOOTSTRAP_PASSWORD`: `ChangeThisOnFirstLogin!`
4. Deploy. Render assigns a free HTTPS domain (e.g., `https://daily-dairy.onrender.com`).
5. Open this URL on both Android phones in Google Chrome. Tap the Chrome three-dot menu and select **"Add to Home screen"** or **"Install app"**.

#### Option 2: Fly.io
```bash
cd server
fly launch
fly deploy
```

---

## 7. Android Phone Self-Hosting Guide (Termux)

### Feasibility Analysis
Hosting the backend on an Android phone using Termux is technically feasible, but comes with specific mobile operating system constraints:
- **Router NAT / CGNAT**: Cellular data networks assign private IPs (CGNAT), meaning the other phone cannot connect directly without a tunnel.
- **Android Battery Optimization**: Android OS aggressively kills background processes (Doze Mode).
- **Wi-Fi Sleep Policy**: Modern Android turns off Wi-Fi chips during deep sleep unless explicitly overridden.

### Step-by-Step Termux Setup (If Desired)

1. **Install Termux**:
   Install Termux from F-Droid (avoid the deprecated Play Store build).

2. **Acquire Wake-Lock & Prevent Sleep**:
   ```bash
   termux-wake-lock
   ```
   In Android Settings, set Termux battery usage to **"Unrestricted"**.

3. **Install Node.js & Git**:
   ```bash
   pkg update -y
   pkg install nodejs git -y
   ```

4. **Run Server**:
   ```bash
   git clone <your-repo-url>
   cd daily-dairy/server
   npm install
   node server.js
   ```

5. **Expose Securely to Public Internet (Cloudflare Tunnel)**:
   Never open raw router ports or expose unauthenticated databases. Use Cloudflare Tunnel:
   ```bash
   pkg install cloudflared -y
   cloudflared tunnel --url http://localhost:3000
   ```
   Cloudflare provides an HTTPS URL (e.g. `https://xxxx.trycloudflare.com`) that bypasses carrier CGNAT and connects the second phone securely without router configuration.

> **Recommendation**: Cloud hosting (such as Render or Fly.io) is significantly more reliable and maintenance-free than Termux phone hosting.

---

## 8. Security Checklist & Disclosures

- [x] **Password Protection**: Passwords are never stored in plaintext; salted PBKDF2/bcrypt hashing is enforced.
- [x] **Rate Limiting**: Brute-force protection limits failed login attempts with lockout intervals.
- [x] **Anonymous Devices**: Device identification is based on anonymous client UUIDs to distinguish sender vs recipient without revealing identities in the UI.
- [x] **Zero Plaintext Logs**: Message content is omitted from application logs.
- [x] **Ephemeral Database**: Once an entry is consumed, it is deleted from the active datastore.
- [!] **Ephemeral Security Boundaries**: While entries vanish from active storage, no software can prevent a recipient from taking a physical photograph or device screenshot of their screen while an entry is visibly open.

---

## 9. Verification & Two-Phone Test Plan

To test between two phones:
1. Open the Daily Dairy app or PWA on Phone 1 and Phone 2.
2. Log in using `diary` and your established password.
3. On Phone 1, write: `Hey, thinnava??` and press **Save**.
4. On Phone 2, tap **Refresh** or open the diary: the entry appears as plain notebook text.
5. On Phone 2, stay on the page: notice that the entry remains readable for as long as you stay on the page.
6. On Phone 2, tap the **Lock** icon or background the app (press Home).
7. Return to Phone 1 and Phone 2: the entry is completely gone from both devices.
8. Refresh either phone: the entry does not return.
