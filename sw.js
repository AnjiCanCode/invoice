// =====================================================
// SWETA PWA Service Worker v3.3.0
// With Push Notification Support + Message Persistence
// =====================================================

const CACHE_NAME = 'sweta-v3.3.0';
const DB_NAME = 'sweta-push-db';
const STORE_NAME = 'pending-messages';

const STATIC_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './icon-72.png',
    './icon-96.png',
    './icon-128.png',
    './icon-144.png',
    './icon-152.png',
    './icon-192.png',
    './icon-384.png',
    './icon-512.png'
];

// =====================================================
// Install Event
// =====================================================

self.addEventListener('install', event => {
    console.log('🔧 SW: Installing v3.3.0...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

// =====================================================
// Activate Event
// =====================================================

self.addEventListener('activate', event => {
    console.log('✅ SW: Activated');
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.filter(key => key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            );
        }).then(() => self.clients.claim())
    );
});

// =====================================================
// Fetch Event - Cache First Strategy
// =====================================================

self.addEventListener('fetch', event => {
    // Skip non-GET requests
    if (event.request.method !== 'GET') return;
    
    // Skip external requests
    if (!event.request.url.startsWith(self.location.origin)) return;

    event.respondWith(
        caches.match(event.request)
            .then(cached => {
                if (cached) {
                    // Return cached, but update in background
                    event.waitUntil(
                        fetch(event.request)
                            .then(response => {
                                if (response.ok) {
                                    caches.open(CACHE_NAME)
                                        .then(cache => cache.put(event.request, response));
                                }
                            })
                            .catch(() => {})
                    );
                    return cached;
                }
                
                return fetch(event.request)
                    .then(response => {
                        if (response.ok) {
                            const clone = response.clone();
                            caches.open(CACHE_NAME)
                                .then(cache => cache.put(event.request, clone));
                        }
                        return response;
                    })
                    .catch(() => {
                        if (event.request.mode === 'navigate') {
                            return caches.match('./index.html');
                        }
                    });
            })
    );
});

// =====================================================
// Push Event - Handle incoming push notifications
// =====================================================

// IndexedDB helpers for storing messages when app is closed
function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
        };
    });
}

function savePendingMessage(message) {
    return openDB().then(db => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.add(message);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    });
}

self.addEventListener('push', event => {
    console.log('📬 SW: Push received');
    
    let data = {
        title: 'SWETA 💜',
        body: 'Time to check in!',
        type: 'hourly'
    };
    
    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            data.body = event.data.text();
        }
    }
    
    const options = {
        body: data.body,
        icon: './icon-192.png',
        badge: './icon-72.png',
        tag: 'sweta-' + (data.type || 'notification') + '-' + Date.now(),
        vibrate: [200, 100, 200],
        requireInteraction: true,
        renotify: true,
        actions: [
            { action: 'open', title: 'Open SWETA' },
            { action: 'dismiss', title: 'Later' }
        ],
        data: {
            url: './',
            type: data.type,
            timestamp: Date.now()
        }
    };
    
    // Save the message to IndexedDB so it appears in chat when app opens
    const pendingMessage = {
        text: data.body,
        sender: 'bot',
        timestamp: new Date().toISOString(),
        type: data.type
    };
    
    event.waitUntil(
        Promise.all([
            self.registration.showNotification(data.title, options),
            savePendingMessage(pendingMessage)
        ]).then(() => {
            // Also try to notify app if it's open
            return self.clients.matchAll({ type: 'window' });
        }).then(clients => {
            clients.forEach(client => {
                client.postMessage({
                    type: 'PUSH_RECEIVED',
                    payload: data
                });
            });
        })
    );
});

// =====================================================
// Notification Click Event
// =====================================================

self.addEventListener('notificationclick', event => {
    console.log('🖱️ SW: Notification clicked');
    
    event.notification.close();
    
    if (event.action === 'dismiss') {
        return;
    }
    
    // Open or focus the app
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then(clients => {
                // Try to find an existing window
                for (const client of clients) {
                    if (client.url.includes(self.location.origin) && 'focus' in client) {
                        return client.focus();
                    }
                }
                // Open new window if none exists
                if (self.clients.openWindow) {
                    return self.clients.openWindow('./');
                }
            })
    );
});

// =====================================================
// Notification Close Event
// =====================================================

self.addEventListener('notificationclose', event => {
    console.log('❌ SW: Notification closed');
});

// =====================================================
// Message Event - Communication with main app
// =====================================================

function getPendingMessages() {
    return openDB().then(db => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    });
}

function clearPendingMessages() {
    return openDB().then(db => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    });
}

self.addEventListener('message', event => {
    console.log('📨 SW: Message received:', event.data);
    
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    
    if (event.data && event.data.type === 'GET_PENDING_MESSAGES') {
        event.waitUntil(
            getPendingMessages().then(messages => {
                console.log('📬 SW: Returning', messages.length, 'pending messages');
                event.source.postMessage({
                    type: 'PENDING_MESSAGES',
                    messages: messages
                });
                // Clear after sending
                return clearPendingMessages();
            }).catch(err => {
                console.error('Error getting pending messages:', err);
            })
        );
    }
});

// =====================================================
// Push Subscription Change Event
// =====================================================

self.addEventListener('pushsubscriptionchange', event => {
    console.log('🔄 SW: Push subscription changed');
    
    event.waitUntil(
        self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: event.oldSubscription.options.applicationServerKey
        })
        .then(subscription => {
            // TODO: Send new subscription to server
            console.log('New subscription:', subscription);
        })
    );
});
