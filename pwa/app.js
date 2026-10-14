// Daily Dairy - High-Reliability Shared Private Journal with Two-Person Presence & Push Notifications
(function () {
  'use strict';

  // Persistent Unique Device Identifier for this physical device
  let deviceId = localStorage.getItem('daily_dairy_device_id');
  if (!deviceId) {
    deviceId = 'phone_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now().toString(36);
    localStorage.setItem('daily_dairy_device_id', deviceId);
  }

  // Authentication & Configuration State
  let authToken = localStorage.getItem('daily_dairy_token') || '';
  let serverUrl = localStorage.getItem('daily_dairy_server_url') || '';
  let recipientName = localStorage.getItem('daily_dairy_recipient_name') || '';
  let entriesList = [];
  let activeViewingIds = new Set();
  let viewedTimerMap = new Map(); // entryId -> setTimeout
  let sseSource = null;
  let pollingInterval = null;
  let presenceHeartbeatInterval = null;
  let isSaving = false;
  let swRegistration = null;

  // Media Attachment & Voice Recording State
  let pendingAttachment = null; // { type: 'voice' | 'image' | 'video' | 'file', dataUrl: string, name: string }
  let mediaRecorder = null;
  let audioChunks = [];
  let recordingStartTime = 0;
  let recordingTimerInterval = null;

  function getApiBase() {
    let base = serverUrl.trim();
    if (!base) {
      return window.location.origin;
    }
    return base.endsWith('/') ? base.slice(0, -1) : base;
  }

  // DOM Elements
  const diaryPage = document.getElementById('diaryPage');
  const btnLock = document.getElementById('btnLock');
  const btnRefresh = document.getElementById('btnRefresh');
  const btnSettings = document.getElementById('btnSettings');
  const dateText = document.getElementById('dateText');
  const entriesContainer = document.getElementById('entriesContainer');
  const emptyState = document.getElementById('emptyState');
  const entryInput = document.getElementById('entryInput');
  const btnSave = document.getElementById('btnSave');

  // Presence Elements
  const presenceBadge = document.getElementById('presenceBadge');
  const presenceDot = document.getElementById('presenceDot');
  const presenceLabel = document.getElementById('presenceLabel');

  // Push Banner Elements
  const pushPromptBanner = document.getElementById('pushPromptBanner');
  const btnPromptEnablePush = document.getElementById('btnPromptEnablePush');
  const btnPromptDismissPush = document.getElementById('btnPromptDismissPush');

  // Media & Voice Elements
  const btnAttachMedia = document.getElementById('btnAttachMedia');
  const btnVoiceRecord = document.getElementById('btnVoiceRecord');
  const mediaFileInput = document.getElementById('mediaFileInput');
  const attachmentPreview = document.getElementById('attachmentPreview');
  const attachmentIcon = document.getElementById('attachmentIcon');
  const attachmentLabel = document.getElementById('attachmentLabel');
  const btnRemoveAttachment = document.getElementById('btnRemoveAttachment');
  const recordingBar = document.getElementById('recordingBar');
  const recordingTimer = document.getElementById('recordingTimer');
  const btnCancelVoice = document.getElementById('btnCancelVoice');
  const btnStopVoice = document.getElementById('btnStopVoice');

  // Auth Modals
  const loginModal = document.getElementById('loginModal');
  const loginUsername = document.getElementById('loginUsername');
  const loginPassword = document.getElementById('loginPassword');
  const loginError = document.getElementById('loginError');
  const btnLoginSubmit = document.getElementById('btnLoginSubmit');

  const changePasswordModal = document.getElementById('changePasswordModal');
  const newPassword = document.getElementById('newPassword');
  const confirmPassword = document.getElementById('confirmPassword');
  const changePassError = document.getElementById('changePassError');
  const btnChangePassSubmit = document.getElementById('btnChangePassSubmit');

  // Settings Modal Elements
  const settingsModal = document.getElementById('settingsModal');
  const serverUrlInput = document.getElementById('serverUrlInput');
  const pushStatusBadge = document.getElementById('pushStatusBadge');
  const pushRecipientInput = document.getElementById('pushRecipientInput');
  const btnTogglePush = document.getElementById('btnTogglePush');
  const btnTestPush = document.getElementById('btnTestPush');
  const btnSaveSettings = document.getElementById('btnSaveSettings');
  const btnSettingsLock = document.getElementById('btnSettingsLock');
  const btnCloseSettings = document.getElementById('btnCloseSettings');

  // Format today's date
  function updateDateHeader() {
    const now = new Date();
    const options = { weekday: 'long', month: 'long', day: 'numeric' };
    dateText.textContent = now.toLocaleDateString('en-US', options);
  }

  // Register PWA Service Worker & capture registration
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').then((reg) => {
        swRegistration = reg;
        checkPushSubscriptionState();
      }).catch(err => {
        console.warn('[Daily Dairy] SW registration notice:', err);
      });
    });
  }

  // Generic API Helper
  async function apiRequest(endpoint, method = 'GET', body = null) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Device-Id': deviceId
    };
    if (authToken) {
      headers['Authorization'] = 'Bearer ' + authToken;
    }

    const options = {
      method: method,
      headers: headers
    };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(getApiBase() + endpoint, options);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data };
  }

  // --- Two-Person Online Presence Management ---
  function updatePresenceUI(presence) {
    if (!presenceDot || !presenceLabel) return;

    if (!navigator.onLine || !sseSource) {
      presenceDot.className = 'presence-dot connecting';
      presenceLabel.textContent = 'Connecting...';
      if (presenceBadge) presenceBadge.title = 'Establishing connection...';
      return;
    }

    if (presence && (presence.bothOnline || presence.status === 'both_online')) {
      presenceDot.className = 'presence-dot both';
      presenceLabel.textContent = 'Both here';
      if (presenceBadge) presenceBadge.title = 'Both authorized users are online in the diary';
    } else if (presence && (presence.status === 'one_online' || presence.onlineCount === 1)) {
      presenceDot.className = 'presence-dot one';
      presenceLabel.textContent = 'One offline';
      if (presenceBadge) presenceBadge.title = 'You are online; your partner is away';
    } else {
      presenceDot.className = 'presence-dot connecting';
      presenceLabel.textContent = 'Connecting...';
      if (presenceBadge) presenceBadge.title = 'Connecting to presence server...';
    }
  }

  async function sendPresenceHeartbeat() {
    if (!authToken || document.visibilityState !== 'visible') return;
    try {
      const res = await apiRequest('/api/presence/heartbeat', 'POST', { deviceId });
      if (res.ok && res.data && res.data.presence) {
        updatePresenceUI(res.data.presence);
      }
    } catch (e) {
      // Offline or network glitch
    }
  }

  function sendPresenceLeave() {
    if (!authToken) return;
    const url = getApiBase() + '/api/presence/leave?token=' + encodeURIComponent(authToken) + '&deviceId=' + encodeURIComponent(deviceId);
    const payload = JSON.stringify({ token: authToken, deviceId: deviceId });

    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(url, blob);
    } else {
      try {
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken, 'X-Device-Id': deviceId },
          body: payload,
          keepalive: true
        }).catch(() => {});
      } catch (e) {}
    }
  }

  function startPresenceHeartbeat() {
    stopPresenceHeartbeat();
    sendPresenceHeartbeat();
    presenceHeartbeatInterval = setInterval(() => {
      sendPresenceHeartbeat();
    }, 10000);
  }

  function stopPresenceHeartbeat() {
    if (presenceHeartbeatInterval) {
      clearInterval(presenceHeartbeatInterval);
      presenceHeartbeatInterval = null;
    }
  }

  // Base64 helper for VAPID applicationServerKey
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  // --- Push Notifications Management ---
  async function checkPushSubscriptionState() {
    if (!('PushManager' in window) || !('serviceWorker' in navigator)) {
      if (pushStatusBadge) {
        pushStatusBadge.textContent = 'Unsupported';
        pushStatusBadge.className = 'push-status-badge';
      }
      if (btnTogglePush) btnTogglePush.disabled = true;
      if (btnTestPush) btnTestPush.disabled = true;
      return;
    }

    try {
      const reg = swRegistration || await navigator.serviceWorker.ready;
      swRegistration = reg;
      const sub = await reg.pushManager.getSubscription();
      const permission = Notification.permission;

      if (permission === 'denied') {
        if (pushStatusBadge) {
          pushStatusBadge.textContent = 'Blocked';
          pushStatusBadge.className = 'push-status-badge inactive';
        }
        if (btnTogglePush) {
          btnTogglePush.textContent = 'Blocked in Browser';
          btnTogglePush.disabled = true;
        }
        if (btnTestPush) btnTestPush.disabled = true;
        if (pushPromptBanner) pushPromptBanner.classList.add('hidden');
        return;
      }

      if (sub) {
        if (pushStatusBadge) {
          pushStatusBadge.textContent = 'Active on this phone';
          pushStatusBadge.className = 'push-status-badge active';
        }
        if (btnTogglePush) {
          btnTogglePush.textContent = 'Disable Notifications';
          btnTogglePush.disabled = false;
        }
        if (btnTestPush) btnTestPush.disabled = false;
        if (pushPromptBanner) pushPromptBanner.classList.add('hidden');
      } else {
        if (pushStatusBadge) {
          pushStatusBadge.textContent = 'Not Enabled';
          pushStatusBadge.className = 'push-status-badge inactive';
        }
        if (btnTogglePush) {
          btnTogglePush.textContent = 'Enable Notifications';
          btnTogglePush.disabled = false;
        }
        if (btnTestPush) btnTestPush.disabled = true;

        // Show banner if permission is default and user hasn't explicitly dismissed
        const dismissed = localStorage.getItem('daily_dairy_push_dismissed');
        if (permission === 'default' && !dismissed && authToken && pushPromptBanner) {
          pushPromptBanner.classList.remove('hidden');
        }
      }
    } catch (err) {
      console.warn('[Push] Error checking subscription:', err);
    }
  }

  async function enablePushNotifications() {
    if (!('PushManager' in window) || !('serviceWorker' in navigator)) {
      alert('Push notifications are not supported in this browser.');
      return;
    }

    try {
      const permResult = await Notification.requestPermission();
      if (permResult !== 'granted') {
        alert('Notification permission was not granted. You can re-enable it anytime in your browser site settings.');
        checkPushSubscriptionState();
        return;
      }

      btnTogglePush.disabled = true;
      btnTogglePush.textContent = 'Enabling...';

      const reg = swRegistration || await navigator.serviceWorker.ready;
      swRegistration = reg;

      // 1. Fetch public VAPID key from server
      const keyRes = await apiRequest('/api/push/public-key', 'GET');
      if (!keyRes.ok || !keyRes.data.publicKey) {
        throw new Error(keyRes.data.error || 'Failed to retrieve server push key');
      }

      const applicationServerKey = urlBase64ToUint8Array(keyRes.data.publicKey);

      // 2. Subscribe via Web Push Manager
      const newSub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey
      });

      // 3. Register subscription on the server with deviceId and recipient greeting name
      const subJson = newSub.toJSON();
      const regRes = await apiRequest('/api/push/subscribe', 'POST', {
        subscription: subJson,
        deviceId: deviceId,
        recipientName: recipientName.trim()
      });

      if (!regRes.ok) {
        throw new Error(regRes.data.error || 'Server failed to save push registration');
      }

      if (pushPromptBanner) pushPromptBanner.classList.add('hidden');
      await checkPushSubscriptionState();
      alert('Private push notifications are now active on this phone!');
    } catch (err) {
      console.error('[Push] Enable failure:', err);
      alert('Could not enable push notifications: ' + err.message);
      checkPushSubscriptionState();
    }
  }

  async function disablePushNotifications() {
    try {
      btnTogglePush.disabled = true;
      btnTogglePush.textContent = 'Disabling...';

      const reg = swRegistration || await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();

      if (sub) {
        await apiRequest('/api/push/unsubscribe', 'POST', {
          endpoint: sub.endpoint
        });
        await sub.unsubscribe();
      }

      await checkPushSubscriptionState();
    } catch (err) {
      console.warn('[Push] Error disabling:', err);
      checkPushSubscriptionState();
    }
  }

  async function sendTestPushNotification() {
    if (!btnTestPush) return;
    btnTestPush.disabled = true;
    btnTestPush.textContent = 'Sending...';

    try {
      const res = await apiRequest('/api/push/test', 'POST', {
        deviceId: deviceId,
        recipientName: recipientName.trim()
      });

      if (res.ok && res.data.success) {
        alert('Test notification sent! Check your notification shade / lock screen.');
      } else {
        alert(res.data.error || 'Failed to dispatch test notification.');
      }
    } catch (err) {
      alert('Error sending test notification: ' + err.message);
    } finally {
      btnTestPush.disabled = false;
      btnTestPush.textContent = 'Send Test Push';
    }
  }

  // --- Realtime Server-Sent Events (SSE) Stream ---
  function connectRealtimeSSE() {
    if (!authToken) return;
    if (sseSource) {
      sseSource.close();
      sseSource = null;
    }

    const sseUrl = getApiBase() + '/api/events?token=' + encodeURIComponent(authToken) + '&deviceId=' + encodeURIComponent(deviceId);

    try {
      sseSource = new EventSource(sseUrl);

      sseSource.addEventListener('init', (e) => {
        try {
          const remoteEntries = JSON.parse(e.data);
          updateEntriesState(remoteEntries);
        } catch (err) {
          console.error('[SSE] Failed to parse init:', err);
        }
      });

      sseSource.addEventListener('presence', (e) => {
        try {
          const presence = JSON.parse(e.data);
          updatePresenceUI(presence);
        } catch (err) {}
      });

      sseSource.addEventListener('presence_change', (e) => {
        try {
          const presence = JSON.parse(e.data);
          updatePresenceUI(presence);
        } catch (err) {}
      });

      sseSource.addEventListener('entry_created', (e) => {
        try {
          const newEntry = JSON.parse(e.data);
          if (!entriesList.some(item => item.id === newEntry.id)) {
            entriesList.push(newEntry);
            entriesList.sort((a, b) => a.createdAt - b.createdAt);
            incrementalRender(entriesList);
            checkViewingForEntry(newEntry);
          }
        } catch (err) {
          console.error('[SSE] Failed to parse entry_created:', err);
        }
      });

      sseSource.addEventListener('entry_consumed', (e) => {
        try {
          const data = JSON.parse(e.data);
          const consumedIds = new Set(data.consumedIds || []);
          if (consumedIds.size > 0) {
            entriesList = entriesList.filter(item => !consumedIds.has(item.id));
            incrementalRender(entriesList);
          }
        } catch (err) {
          console.error('[SSE] Failed to parse entry_consumed:', err);
        }
      });

      sseSource.onopen = () => {
        sendPresenceHeartbeat();
      };

      sseSource.onerror = () => {
        if (sseSource) {
          sseSource.close();
          sseSource = null;
        }
        updatePresenceUI({ status: 'connecting' });
        // Reconnect after 3.5 seconds
        setTimeout(() => {
          if (authToken && document.visibilityState === 'visible') {
            connectRealtimeSSE();
          }
        }, 3500);
      };
    } catch (err) {
      console.warn('[SSE] Connection error:', err);
    }
  }

  // --- Background Sync Polling (Gentle Fallback, 0 Screen Flicker) ---
  function startPolling() {
    stopPolling();
    loadAuthoritativeEntries();
    // Non-disruptive gentle poll every 15s to reconcile in case of dropped connection
    pollingInterval = setInterval(() => {
      if (authToken && document.visibilityState === 'visible') {
        loadAuthoritativeEntries();
      }
    }, 15000);
  }

  function stopPolling() {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
  }

  // Fetch Authoritative Entries from Server
  async function loadAuthoritativeEntries() {
    if (!authToken) return;

    try {
      const res = await apiRequest('/api/entries', 'GET');
      if (res.ok && Array.isArray(res.data)) {
        updateEntriesState(res.data);
      } else if (res.status === 401) {
        authToken = '';
        localStorage.removeItem('daily_dairy_token');
        showLoginModal();
      }
    } catch (err) {
      console.warn('[Daily Dairy] Sync notice:', err);
    }
  }

  // Reconcile and Diff entries to prevent screen refreshes and DOM flickering
  function updateEntriesState(newEntries) {
    if (!Array.isArray(newEntries)) return;

    // Quick identity check: if unchanged, do nothing (stops flickering completely)
    if (entriesList.length === newEntries.length) {
      let isIdentical = true;
      for (let i = 0; i < entriesList.length; i++) {
        if (entriesList[i].id !== newEntries[i].id ||
            entriesList[i].status !== newEntries[i].status ||
            entriesList[i].content !== newEntries[i].content) {
          isIdentical = false;
          break;
        }
      }
      if (isIdentical) {
        return; // ZERO re-renders!
      }
    }

    const newIds = new Set(newEntries.map(e => e.id));
    for (const [id, timer] of viewedTimerMap.entries()) {
      if (!newIds.has(id)) {
        clearTimeout(timer);
        viewedTimerMap.delete(id);
      }
    }

    entriesList = newEntries;
    incrementalRender(entriesList);

    entriesList.forEach(entry => {
      checkViewingForEntry(entry);
    });
  }

  // Incremental DOM renderer: preserves existing audio, video, and text elements
  function incrementalRender(list) {
    if (!list || list.length === 0) {
      entriesContainer.innerHTML = '';
      emptyState.classList.remove('hidden');
      entriesContainer.appendChild(emptyState);
      return;
    }

    emptyState.classList.add('hidden');

    const desiredIds = new Set(list.map(item => item.id));

    // Remove DOM nodes no longer in list
    const existingNodes = Array.from(entriesContainer.children);
    existingNodes.forEach(node => {
      if (node === emptyState) return;
      const entryId = node.getAttribute('data-entry-id');
      if (entryId && !desiredIds.has(entryId)) {
        node.remove();
      }
    });

    // Add or verify presence of each entry in order
    list.forEach(item => {
      let existingElement = entriesContainer.querySelector(`[data-entry-id="${item.id}"]`);
      if (!existingElement) {
        existingElement = createEntryElement(item);
        entriesContainer.appendChild(existingElement);
      }
    });

    // Keep scroll smooth at bottom when new entry arrives
    entriesContainer.scrollTop = entriesContainer.scrollHeight;
  }

  function createEntryElement(item) {
    const p = document.createElement('div');
    p.className = 'diary-paragraph';
    p.setAttribute('data-entry-id', item.id);

    // Text content (if not a pure placeholder)
    if (item.content && item.content !== '[Voice Note]' && item.content !== '[Photo Attached]' && item.content !== '[Photo attached]') {
      const textSpan = document.createElement('div');
      textSpan.textContent = item.content;
      p.appendChild(textSpan);
    }

    // Voice note audio player
    if (item.entryType === 'voice' || (item.mediaUrl && item.mediaUrl.startsWith('data:audio'))) {
      const card = document.createElement('div');
      card.className = 'diary-audio-card';

      const header = document.createElement('div');
      header.className = 'diary-audio-card-header';
      header.innerHTML = '<span>🎙️</span><span>Voice Note</span>';
      card.appendChild(header);

      const audio = document.createElement('audio');
      audio.controls = true;
      audio.className = 'diary-audio';
      audio.src = item.mediaUrl;
      audio.preload = 'metadata';
      card.appendChild(audio);

      p.appendChild(card);
    } else if (item.mediaUrl && (item.entryType === 'attachment' || item.entryType === 'photo' || item.mediaUrl.startsWith('data:image'))) {
      // Photo image attachment
      const img = document.createElement('img');
      img.className = 'diary-photo';
      img.src = item.mediaUrl;
      img.alt = 'Attached photo';
      img.loading = 'lazy';
      p.appendChild(img);
    } else if (item.mediaUrl && (item.entryType === 'video' || item.mediaUrl.startsWith('data:video'))) {
      // Video attachment
      const video = document.createElement('video');
      video.className = 'diary-video';
      video.controls = true;
      video.src = item.mediaUrl;
      video.preload = 'metadata';
      p.appendChild(video);
    }

    return p;
  }

  // Track explicit viewing session for entries from OTHER device
  function checkViewingForEntry(entry) {
    if (entry.authorDeviceId === deviceId) return;
    if (activeViewingIds.has(entry.id)) return;
    if (viewedTimerMap.has(entry.id)) return;

    // Confirm visibility: mark viewed after 1.2 seconds of display
    const timer = setTimeout(() => {
      viewedTimerMap.delete(entry.id);
      if (document.visibilityState === 'visible') {
        activeViewingIds.add(entry.id);
        // Persist to localStorage in case of sudden app closure
        persistPendingConsumeIds();

        apiRequest('/api/entries/view-session/start', 'POST', {
          deviceId: deviceId,
          entryIds: [entry.id]
        }).catch(() => {});
      }
    }, 1200);

    viewedTimerMap.set(entry.id, timer);
  }

  function persistPendingConsumeIds() {
    try {
      localStorage.setItem('daily_dairy_pending_consume', JSON.stringify(Array.from(activeViewingIds)));
    } catch (e) {}
  }

  // --- Strict Read-and-Leave Deletion ---
  function consumeViewedEntriesAndLeave() {
    if (activeViewingIds.size === 0) return;

    const idsToConsume = Array.from(activeViewingIds);
    activeViewingIds.clear();
    localStorage.removeItem('daily_dairy_pending_consume');

    // Optimistically remove from local view immediately
    entriesList = entriesList.filter(e => !idsToConsume.includes(e.id));
    incrementalRender(entriesList);

    const endpoint = getApiBase() + '/api/entries/consume?token=' + encodeURIComponent(authToken) + '&deviceId=' + encodeURIComponent(deviceId);
    const payload = JSON.stringify({
      token: authToken,
      deviceId: deviceId,
      entryIds: idsToConsume
    });

    // 1. Guaranteed delivery via sendBeacon on unload/background
    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(endpoint, blob);
    }

    // 2. Fetch with keepalive fallback
    try {
      fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + authToken,
          'X-Device-Id': deviceId
        },
        body: payload,
        keepalive: true
      }).catch(() => {});
    } catch (e) {}
  }

  // Reconcile any unconsumed entries from an abruptly terminated session
  async function reconcilePendingConsumeFromStorage() {
    try {
      const raw = localStorage.getItem('daily_dairy_pending_consume');
      if (!raw) return;
      const ids = JSON.parse(raw);
      if (Array.isArray(ids) && ids.length > 0 && authToken) {
        await apiRequest('/api/entries/consume', 'POST', {
          deviceId: deviceId,
          entryIds: ids
        });
        localStorage.removeItem('daily_dairy_pending_consume');
      }
    } catch (e) {}
  }

  // Mobile Lifecycle Listeners
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      consumeViewedEntriesAndLeave();
      sendPresenceLeave();
      stopPresenceHeartbeat();
    } else if (document.visibilityState === 'visible') {
      reconcilePendingConsumeFromStorage();
      loadAuthoritativeEntries();
      startPresenceHeartbeat();
      if (!sseSource) {
        connectRealtimeSSE();
      }
      checkPushSubscriptionState();
    }
  });

  window.addEventListener('pagehide', () => {
    consumeViewedEntriesAndLeave();
    sendPresenceLeave();
  });

  window.addEventListener('beforeunload', () => {
    consumeViewedEntriesAndLeave();
    sendPresenceLeave();
  });

  window.addEventListener('online', () => {
    connectRealtimeSSE();
    startPresenceHeartbeat();
    loadAuthoritativeEntries();
  });

  window.addEventListener('offline', () => {
    updatePresenceUI({ status: 'connecting' });
  });

  // --- Authentication Modal Handling ---
  function checkAuth() {
    if (!authToken) {
      showLoginModal();
    } else {
      hideModals();
      reconcilePendingConsumeFromStorage();
      connectRealtimeSSE();
      startPolling();
      startPresenceHeartbeat();
      checkPushSubscriptionState();
    }
  }

  function showLoginModal() {
    loginModal.classList.remove('hidden');
    loginPassword.value = '';
    loginError.classList.add('hidden');
    stopPolling();
    stopPresenceHeartbeat();
    if (sseSource) {
      sseSource.close();
      sseSource = null;
    }
    updatePresenceUI({ status: 'connecting' });
  }

  function hideModals() {
    loginModal.classList.add('hidden');
    changePasswordModal.classList.add('hidden');
    settingsModal.classList.add('hidden');
  }

  btnLoginSubmit.addEventListener('click', async () => {
    const user = loginUsername.value.trim();
    const pass = loginPassword.value;
    if (!user || !pass) return;

    btnLoginSubmit.textContent = 'Unlocking...';
    btnLoginSubmit.disabled = true;

    try {
      const res = await apiRequest('/api/auth/login', 'POST', {
        username: user,
        password: pass,
        deviceId: deviceId
      });

      if (res.ok && res.data.success) {
        authToken = res.data.token;
        localStorage.setItem('daily_dairy_token', authToken);

        if (res.data.mustChangePassword) {
          loginModal.classList.add('hidden');
          changePasswordModal.classList.remove('hidden');
        } else {
          hideModals();
          connectRealtimeSSE();
          startPolling();
          startPresenceHeartbeat();
          checkPushSubscriptionState();
        }
      } else {
        loginError.textContent = res.data.error || 'Authentication failed';
        loginError.classList.remove('hidden');
      }
    } catch (e) {
      loginError.textContent = 'Connection error. Check network.';
      loginError.classList.remove('hidden');
    } finally {
      btnLoginSubmit.textContent = 'Unlock Diary';
      btnLoginSubmit.disabled = false;
    }
  });

  btnChangePassSubmit.addEventListener('click', async () => {
    const np = newPassword.value;
    const cp = confirmPassword.value;
    if (np.length < 8) {
      changePassError.textContent = 'Password must be at least 8 characters long.';
      changePassError.classList.remove('hidden');
      return;
    }
    if (np !== cp) {
      changePassError.textContent = 'Passwords do not match.';
      changePassError.classList.remove('hidden');
      return;
    }

    btnChangePassSubmit.textContent = 'Updating...';
    btnChangePassSubmit.disabled = true;

    try {
      const res = await apiRequest('/api/auth/change-password', 'POST', {
        newPassword: np
      });
      if (res.ok && res.data.success) {
        hideModals();
        connectRealtimeSSE();
        startPolling();
        startPresenceHeartbeat();
        checkPushSubscriptionState();
      } else {
        changePassError.textContent = res.data.error || 'Failed to update password';
        changePassError.classList.remove('hidden');
      }
    } catch (e) {
      changePassError.textContent = 'Connection error';
      changePassError.classList.remove('hidden');
    } finally {
      btnChangePassSubmit.textContent = 'Set Password & Open';
      btnChangePassSubmit.disabled = false;
    }
  });

  // Manual Privacy Lock & Exit
  btnLock.addEventListener('click', () => {
    consumeViewedEntriesAndLeave();
    sendPresenceLeave();
    authToken = '';
    localStorage.removeItem('daily_dairy_token');
    showLoginModal();
  });

  btnSettingsLock.addEventListener('click', () => {
    consumeViewedEntriesAndLeave();
    sendPresenceLeave();
    authToken = '';
    localStorage.removeItem('daily_dairy_token');
    hideModals();
    showLoginModal();
  });

  // --- Voice Note Recording Flow ---
  btnVoiceRecord.addEventListener('click', async () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert('Voice recording is not supported in this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunks.push(e.data);
        }
      };

      mediaRecorder.onstop = () => {
        clearInterval(recordingTimerInterval);
        recordingBar.classList.add('hidden');
        stream.getTracks().forEach(track => track.stop());

        if (audioChunks.length === 0) return;

        const audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = () => {
          pendingAttachment = {
            type: 'voice',
            dataUrl: reader.result,
            name: 'Voice Note'
          };
          attachmentIcon.textContent = '🎙️';
          attachmentLabel.textContent = 'Voice Note attached';
          attachmentPreview.classList.remove('hidden');
          btnSave.disabled = false;
        };
        reader.readAsDataURL(audioBlob);
      };

      mediaRecorder.start();
      recordingStartTime = Date.now();
      recordingBar.classList.remove('hidden');

      recordingTimerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        recordingTimer.textContent = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
      }, 500);

    } catch (err) {
      console.warn('[Voice] Microphone notice:', err);
      alert('Could not access microphone: ' + err.message);
    }
  });

  btnStopVoice.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
  });

  btnCancelVoice.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      audioChunks = [];
      mediaRecorder.stop();
      clearInterval(recordingTimerInterval);
      recordingBar.classList.add('hidden');
    }
  });

  // --- File / Media Attachment Flow ---
  btnAttachMedia.addEventListener('click', () => {
    mediaFileInput.click();
  });

  mediaFileInput.addEventListener('change', () => {
    const file = mediaFileInput.files && mediaFileInput.files[0];
    if (!file) return;

    if (file.size > 12 * 1024 * 1024) {
      alert('Attachment size exceeds 12MB limit.');
      mediaFileInput.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      let attachmentType = 'attachment';
      if (file.type.startsWith('image/')) attachmentType = 'photo';
      else if (file.type.startsWith('video/')) attachmentType = 'video';
      else if (file.type.startsWith('audio/')) attachmentType = 'voice';

      pendingAttachment = {
        type: attachmentType,
        dataUrl: reader.result,
        name: file.name
      };

      attachmentIcon.textContent = attachmentType === 'photo' ? '🖼️' : attachmentType === 'video' ? '🎬' : '📎';
      attachmentLabel.textContent = file.name;
      attachmentPreview.classList.remove('hidden');
      btnSave.disabled = false;
    };
    reader.readAsDataURL(file);
    mediaFileInput.value = '';
  });

  btnRemoveAttachment.addEventListener('click', () => {
    pendingAttachment = null;
    attachmentPreview.classList.add('hidden');
    btnSave.disabled = !entryInput.value.trim();
  });

  // Editor Input Action
  entryInput.addEventListener('input', () => {
    btnSave.disabled = (!entryInput.value.trim() && !pendingAttachment) || isSaving;
  });

  // Save Entry Action (Text, Voice Note, or Attachment)
  btnSave.addEventListener('click', async () => {
    const text = entryInput.value.trim();
    if ((!text && !pendingAttachment) || !authToken || isSaving) return;

    isSaving = true;
    btnSave.disabled = true;
    btnSave.textContent = 'Saving...';

    const clientEntryId = 'entry_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 7);
    const entryType = pendingAttachment ? pendingAttachment.type : 'text';
    const mediaUrl = pendingAttachment ? pendingAttachment.dataUrl : null;
    const content = text || (pendingAttachment ? (entryType === 'voice' ? '[Voice Note]' : `[${pendingAttachment.name}]`) : '');

    try {
      const res = await apiRequest('/api/entries', 'POST', {
        id: clientEntryId,
        authorDeviceId: deviceId,
        content: content,
        entryType: entryType,
        mediaUrl: mediaUrl,
        createdAt: Date.now()
      });

      if (res.ok && res.data.success) {
        entryInput.value = '';
        pendingAttachment = null;
        attachmentPreview.classList.add('hidden');
        btnSave.textContent = 'Saved';
        setTimeout(() => {
          btnSave.textContent = 'Save';
          btnSave.disabled = !entryInput.value.trim() && !pendingAttachment;
        }, 1200);

        // Optimistically show on sender screen
        if (res.data.entry && !entriesList.some(e => e.id === res.data.entry.id)) {
          entriesList.push(res.data.entry);
          incrementalRender(entriesList);
        }
      } else {
        alert(res.data.error || 'Failed to save entry to shared diary. Please retry.');
        btnSave.textContent = 'Save';
        btnSave.disabled = false;
      }
    } catch (err) {
      alert('Could not reach diary server. Entry was not saved.');
      btnSave.textContent = 'Save';
      btnSave.disabled = false;
    } finally {
      isSaving = false;
    }
  });

  btnRefresh.addEventListener('click', () => {
    loadAuthoritativeEntries();
    sendPresenceHeartbeat();
  });

  // Push Permission Prompt Banner Listeners
  btnPromptEnablePush.addEventListener('click', async () => {
    await enablePushNotifications();
  });

  btnPromptDismissPush.addEventListener('click', () => {
    pushPromptBanner.classList.add('hidden');
    localStorage.setItem('daily_dairy_push_dismissed', 'true');
  });

  // Settings & Identity Diagnostics
  btnSettings.addEventListener('click', () => {
    serverUrlInput.value = serverUrl;
    pushRecipientInput.value = recipientName;
    settingsModal.classList.remove('hidden');
    checkPushSubscriptionState();
  });

  btnCloseSettings.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  btnTogglePush.addEventListener('click', async () => {
    const reg = swRegistration || await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await disablePushNotifications();
    } else {
      await enablePushNotifications();
    }
  });

  btnTestPush.addEventListener('click', async () => {
    await sendTestPushNotification();
  });

  btnSaveSettings.addEventListener('click', async () => {
    serverUrl = serverUrlInput.value.trim();
    localStorage.setItem('daily_dairy_server_url', serverUrl);

    const oldName = recipientName;
    recipientName = pushRecipientInput.value.trim();
    localStorage.setItem('daily_dairy_recipient_name', recipientName);

    // If recipient name changed and push is active, re-sync subscription with server
    if (oldName !== recipientName && swRegistration) {
      const sub = await swRegistration.pushManager.getSubscription();
      if (sub) {
        await apiRequest('/api/push/subscribe', 'POST', {
          subscription: sub.toJSON(),
          deviceId: deviceId,
          recipientName: recipientName
        }).catch(() => {});
      }
    }

    settingsModal.classList.add('hidden');
    connectRealtimeSSE();
    loadAuthoritativeEntries();
  });

  // Initial Boot
  updateDateHeader();
  checkAuth();
})();
