// ════════════════════════════════════════════════════════
//  PAVARA PAYROLL — SERVICE WORKER  v3.0
//  Uses Firebase Cloud Messaging (FCM) for background push.
//  This file MUST be named service-worker.js and served
//  from the ROOT of your site (same origin as the app).
// ════════════════════════════════════════════════════════

importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

const SW_VERSION  = '3.0.0';
const CACHE_NAME  = 'pavara-cache-v3';
const FIREBASE_DB = 'https://pavara-doc-system-default-rtdb.firebaseio.com';

// ── Firebase config (must match index.html exactly) ──
firebase.initializeApp({
  apiKey:            'AIzaSyDj33YYTQPNKw_gDwjYv4eWVZgo6uW29o4',
  authDomain:        'pavara-doc-system.firebaseapp.com',
  databaseURL:       'https://pavara-doc-system-default-rtdb.firebaseio.com',
  projectId:         'pavara-doc-system',
  storageBucket:     'pavara-doc-system.firebasestorage.app',
  messagingSenderId: '786092431378',
  appId:             '1:786092431378:web:a07c0a9756e011a95520cb'
});

const messagingSW = firebase.messaging();

// ════════════════════════════════════════════════════════
//  FCM BACKGROUND MESSAGE HANDLER
//  Fires when push arrives and app is closed / background.
//  Firebase shows the notification automatically if payload
//  has a "notification" block — we handle explicitly here
//  for full control over icon, badge, sound, actions.
// ════════════════════════════════════════════════════════
messagingSW.onBackgroundMessage(payload => {
  console.log('[SW FCM] Background message:', payload);

  const n     = payload.notification || {};
  const d     = payload.data         || {};

  const title = n.title || d.title || 'Pavara Alert';
  const body  = n.body  || d.body  || 'You have a new document alert.';
  const tag   = d.tag   || 'pavara-bg-' + Date.now();
  const url   = d.url   || n.click_action || '/';

  return self.registration.showNotification(title, {
    body,
    tag,
    renotify:           true,
    icon:               '/icons/icon-192.png',
    badge:              '/icons/badge-72.png',
    vibrate:            [200, 100, 200, 100, 200],
    requireInteraction: false,
    silent:             false,
    data:               { url, type: d.type || 'alert' },
    actions: [
      { action: 'open',    title: 'Open App' },
      { action: 'dismiss', title: 'Dismiss'  }
    ]
  });
});

// ════════════════════════════════════════════════════════
//  INSTALL
// ════════════════════════════════════════════════════════
self.addEventListener('install', event => {
  console.log('[SW] Installing v' + SW_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(['/', '/index.html', '/manifest.json']).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

// ════════════════════════════════════════════════════════
//  ACTIVATE
// ════════════════════════════════════════════════════════
self.addEventListener('activate', event => {
  console.log('[SW] Activating v' + SW_VERSION);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ════════════════════════════════════════════════════════
//  FETCH — network-first, cache fallback
// ════════════════════════════════════════════════════════
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    fetch(event.request)
      .then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ════════════════════════════════════════════════════════
//  NOTIFICATION CLICK
// ════════════════════════════════════════════════════════
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

// ════════════════════════════════════════════════════════
//  MESSAGE — commands from the main app
// ════════════════════════════════════════════════════════
self.addEventListener('message', event => {
  const msg = event.data || {};

  if (msg.type === 'SHOW_NOTIFICATION') {
    self.registration.showNotification(msg.title || 'Pavara', {
      body:               msg.body || 'Pavara alert',
      tag:                msg.tag  || 'pavara-msg-' + Date.now(),
      renotify:           true,
      icon:               '/icons/icon-192.png',
      badge:              '/icons/badge-72.png',
      vibrate:            [200, 100, 200],
      requireInteraction: false,
      silent:             false,
      data:               { url: '/', type: msg.notifType || 'alert' },
      actions: [
        { action: 'open',    title: 'Open App' },
        { action: 'dismiss', title: 'Dismiss'  }
      ]
    });
  }

  if (msg.type === 'SKIP_WAITING') self.skipWaiting();

  if (msg.type === 'BACKGROUND_CHECK') {
    event.waitUntil(runBackgroundExpiryCheck(msg.userKey, msg.officialName));
  }
});

// ════════════════════════════════════════════════════════
//  PERIODIC BACKGROUND SYNC (Android Chrome PWA)
// ════════════════════════════════════════════════════════
self.addEventListener('periodicsync', event => {
  if (event.tag === 'pavara-expiry-check') {
    event.waitUntil(runBackgroundExpiryCheckAll());
  }
});

// ════════════════════════════════════════════════════════
//  BACKGROUND EXPIRY CHECK
// ════════════════════════════════════════════════════════
async function runBackgroundExpiryCheck(userKey, officialName) {
  try {
    if (!officialName) return;
    const res = await fetch(FIREBASE_DB + '/safetyRecords.json');
    if (!res.ok) return;
    const sfData = await res.json();
    if (!sfData) return;

    const today = new Date(); today.setHours(0, 0, 0, 0);
    let rec = null;
    Object.values(sfData).forEach(r => {
      if (r && r.name && r.name.toLowerCase() === officialName.toLowerCase()) rec = r;
    });
    if (!rec) return;

    const sce = computeExpiry(rec.sc_issue, rec.emptype, rec.sc_expiry);
    const pre = computePRExpiry(rec.pr_issue, rec.pr_expiry);
    const msgs = [];
    const scD = daysDiff(sce, today);
    const prD = daysDiff(pre, today);

    if (scD !== null) {
      if (scD < 0)        msgs.push('Safety Card expired ' + Math.abs(scD) + ' days ago!');
      else if (scD <= 30) msgs.push('Safety Card expires in ' + scD + ' days.');
    }
    if (prD !== null) {
      if (prD < 0)         msgs.push('Police Report expired ' + Math.abs(prD) + ' days ago!');
      else if (prD <= 365) msgs.push('Police Report expires in ' + prD + ' days.');
    }
    if (!msgs.length) return;

    await self.registration.showNotification('Pavara — Document Alert', {
      body:               msgs.join(' · '),
      tag:                'pavara-bg-' + userKey,
      renotify:           true,
      icon:               '/icons/icon-192.png',
      badge:              '/icons/badge-72.png',
      vibrate:            [200, 100, 200, 100, 200],
      requireInteraction: false,
      data:               { url: '/', type: 'expiry' }
    });
  } catch (e) { console.warn('[SW] Background check error:', e); }
}

async function runBackgroundExpiryCheckAll() {
  try {
    const swState = await getIdbValue('pavara_sw_state');
    if (!swState) return;
    const state = JSON.parse(swState);
    if (state && state.officialName) {
      await runBackgroundExpiryCheck(state.userKey, state.officialName);
    }
  } catch (e) {}
}

// ════════════════════════════════════════════════════════
//  EXPIRY HELPERS
// ════════════════════════════════════════════════════════
function computeExpiry(issueDate, emptype, stored) {
  if (emptype === 'Annual' && issueDate) {
    const d = new Date(issueDate); d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().split('T')[0];
  }
  return stored || null;
}
function computePRExpiry(issueDate, stored) {
  if (issueDate) {
    const d = new Date(issueDate); d.setFullYear(d.getFullYear() + 3);
    return d.toISOString().split('T')[0];
  }
  return stored || null;
}
function daysDiff(dateStr, today) {
  if (!dateStr) return null;
  const d = new Date(dateStr); d.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
}

// ════════════════════════════════════════════════════════
//  INDEXEDDB HELPER
// ════════════════════════════════════════════════════════
function getIdbValue(key) {
  return new Promise(resolve => {
    const req = indexedDB.open('pavara-sw-store', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
    req.onerror   = () => resolve(null);
    req.onsuccess = e => {
      const tx  = e.target.result.transaction('kv', 'readonly');
      const get = tx.objectStore('kv').get(key);
      get.onsuccess = () => resolve(get.result || null);
      get.onerror   = () => resolve(null);
    };
  });
}

console.log('[Pavara SW] v' + SW_VERSION + ' loaded');
