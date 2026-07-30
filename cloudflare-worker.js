// =====================================================
// SWETA Push Notification Worker v2.0
// Corrected Web Push implementation for Cloudflare Workers
// =====================================================

// =====================================================
// CONFIGURATION — UPDATE BEFORE DEPLOYING!
// =====================================================
// VAPID keys: to generate new ones, run `npx web-push generate-vapid-keys`
// If you regenerate, update VAPID_PUBLIC_KEY in BOTH this file AND index.html
const VAPID_PUBLIC_KEY = 'BI6m8q9TjhDGC1FH1kTKkHxwiR1lLKMv-sqkXLForZ4y4QdQ5vJk1-F3hBRKCjfxPr00Io4QLB9Y2MEpG2zddlQ';  // ← REPLACE if regenerating
const VAPID_PRIVATE_KEY = 's6YfCfI7NbRAwRvCdLhjRBLrvE-pbMll7UDybwjV-B8';  // ← REPLACE if regenerating — KEEP SECRET!
const VAPID_SUBJECT = 'mailto:your-email@example.com';  // ← REPLACE with your real email (e.g. mailto:anjali@adhyayan.asia)

export default {
  async fetch(request, env, ctx) {
    // Handle CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/send' && request.method === 'POST') {
        return await handleSend(request);
      }

      if (url.pathname === '/health') {
        return jsonResponse({ status: 'ok', version: '2.0.0' });
      }

      return jsonResponse({ error: 'Not found', endpoints: ['POST /send', 'GET /health'] }, 404);
    } catch (error) {
      console.error('Worker error:', error);
      return jsonResponse({ error: error.message, stack: error.stack }, 500);
    }
  }
};

async function handleSend(request) {
  const body = await request.json();
  const { subscription, notification } = body;

  if (!subscription || !notification) {
    return jsonResponse({ error: 'Missing subscription or notification' }, 400);
  }

  console.log('Sending push to:', subscription.endpoint);
  console.log('Notification:', notification);

  try {
    const result = await sendPushNotification(subscription, notification);
    return jsonResponse(result);
  } catch (error) {
    console.error('Push failed:', error);
    return jsonResponse({ error: error.message, details: error.stack }, 500);
  }
}

async function sendPushNotification(subscription, notification) {
  const endpoint = subscription.endpoint;
  const p256dh = subscription.keys.p256dh;
  const auth = subscription.keys.auth;

  // Create payload
  const payload = JSON.stringify({
    title: notification.title || 'SWETA 💜',
    body: notification.body || 'Check in time!',
    type: notification.type || 'reminder'
  });

  // Generate VAPID JWT
  const jwt = await createVapidJwt(endpoint);
  
  // Encrypt the payload
  const encrypted = await encryptPayload(p256dh, auth, payload);

  // Send to push service
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400'
    },
    body: encrypted
  });

  const status = response.status;
  const responseText = await response.text();

  console.log('Push service response:', status, responseText);

  if (status === 201 || status === 200) {
    return { success: true, status };
  } else if (status === 410) {
    return { success: false, expired: true, status, message: 'Subscription expired' };
  } else {
    return { success: false, status, message: responseText };
  }
}

// =====================================================
// VAPID JWT Generation
// =====================================================

async function createVapidJwt(endpoint) {
  const url = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;
  
  const header = { typ: 'JWT', alg: 'ES256' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: audience,
    exp: now + 86400, // 24 hours
    sub: VAPID_SUBJECT
  };

  const headerB64 = base64urlEncode(JSON.stringify(header));
  const payloadB64 = base64urlEncode(JSON.stringify(payload));
  const unsignedToken = `${headerB64}.${payloadB64}`;

  // Import private key for signing
  const privateKeyBytes = base64urlDecode(VAPID_PRIVATE_KEY);
  const publicKeyBytes = base64urlDecode(VAPID_PUBLIC_KEY);
  
  // Create JWK from raw keys
  // Public key is 65 bytes: 0x04 || x (32 bytes) || y (32 bytes)
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: base64urlEncode(publicKeyBytes.slice(1, 33)),
    y: base64urlEncode(publicKeyBytes.slice(33, 65)),
    d: base64urlEncode(privateKeyBytes)
  };

  const privateKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  // Sign the token
  const signatureBuffer = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(unsignedToken)
  );

  // Convert DER signature to raw format (r || s)
  const signature = derToRaw(new Uint8Array(signatureBuffer));
  const signatureB64 = base64urlEncode(signature);

  return `${unsignedToken}.${signatureB64}`;
}

// Convert DER encoded ECDSA signature to raw format
function derToRaw(derSig) {
  // If already 64 bytes, assume it's raw format
  if (derSig.length === 64) {
    return derSig;
  }

  // DER format: 0x30 [total-length] 0x02 [r-length] [r] 0x02 [s-length] [s]
  let offset = 2; // Skip 0x30 and total length
  
  // Read R
  if (derSig[offset] !== 0x02) throw new Error('Invalid DER signature');
  offset++;
  const rLen = derSig[offset++];
  let r = derSig.slice(offset, offset + rLen);
  offset += rLen;
  
  // Read S
  if (derSig[offset] !== 0x02) throw new Error('Invalid DER signature');
  offset++;
  const sLen = derSig[offset++];
  let s = derSig.slice(offset, offset + sLen);

  // Remove leading zeros and pad to 32 bytes
  r = padTo32Bytes(r);
  s = padTo32Bytes(s);

  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

function padTo32Bytes(arr) {
  // Remove leading zeros
  while (arr.length > 32 && arr[0] === 0) {
    arr = arr.slice(1);
  }
  // Pad to 32 bytes
  if (arr.length < 32) {
    const padded = new Uint8Array(32);
    padded.set(arr, 32 - arr.length);
    return padded;
  }
  return arr.slice(0, 32);
}

// =====================================================
// Payload Encryption (aes128gcm)
// =====================================================

async function encryptPayload(p256dhKey, authSecret, payload) {
  const payloadBytes = new TextEncoder().encode(payload);
  
  // Decode subscription keys
  const clientPublicKey = base64urlDecode(p256dhKey);
  const authBytes = base64urlDecode(authSecret);

  // Generate server ECDH key pair
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );

  // Export server public key as raw bytes
  const serverPublicKeyBuffer = await crypto.subtle.exportKey('raw', serverKeyPair.publicKey);
  const serverPublicKey = new Uint8Array(serverPublicKeyBuffer);

  // Import client public key
  const clientKey = await crypto.subtle.importKey(
    'raw',
    clientPublicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  // Derive shared secret via ECDH
  const sharedSecretBuffer = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientKey },
    serverKeyPair.privateKey,
    256
  );
  const sharedSecret = new Uint8Array(sharedSecretBuffer);

  // Generate random salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Derive IKM using HKDF with auth secret
  const ikmInfo = concatBytes(
    new TextEncoder().encode('WebPush: info\x00'),
    clientPublicKey,
    serverPublicKey
  );
  
  const ikm = await hkdf(authBytes, sharedSecret, ikmInfo, 32);

  // Derive content encryption key and nonce
  const contentInfo = new TextEncoder().encode('Content-Encoding: aes128gcm\x00');
  const nonceInfo = new TextEncoder().encode('Content-Encoding: nonce\x00');

  const prk = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk, contentInfo, 16);
  const nonce = await hkdfExpand(prk, nonceInfo, 12);

  // Import CEK for AES-GCM
  const aesKey = await crypto.subtle.importKey(
    'raw',
    cek,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  // Add padding delimiter (0x02 means "last record")
  const paddedPayload = concatBytes(
    payloadBytes,
    new Uint8Array([2]) // Record delimiter
  );

  // Encrypt with AES-128-GCM
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    aesKey,
    paddedPayload
  );
  const ciphertext = new Uint8Array(ciphertextBuffer);

  // Build aes128gcm message
  // Header: salt (16) + rs (4) + idlen (1) + keyid (65)
  const rs = 4096;
  const header = new Uint8Array(86);
  header.set(salt, 0);
  header[16] = (rs >> 24) & 0xff;
  header[17] = (rs >> 16) & 0xff;
  header[18] = (rs >> 8) & 0xff;
  header[19] = rs & 0xff;
  header[20] = 65; // Length of server public key
  header.set(serverPublicKey, 21);

  return concatBytes(header, ciphertext);
}

// =====================================================
// HKDF Implementation
// =====================================================

async function hkdf(salt, ikm, info, length) {
  const prk = await hkdfExtract(salt, ikm);
  return hkdfExpand(prk, info, length);
}

async function hkdfExtract(salt, ikm) {
  const key = await crypto.subtle.importKey(
    'raw',
    salt.length ? salt : new Uint8Array(32),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const prk = await crypto.subtle.sign('HMAC', key, ikm);
  return new Uint8Array(prk);
}

async function hkdfExpand(prk, info, length) {
  const key = await crypto.subtle.importKey(
    'raw',
    prk,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  let output = new Uint8Array(0);
  let counter = 1;
  let prev = new Uint8Array(0);

  while (output.length < length) {
    const input = concatBytes(prev, info, new Uint8Array([counter]));
    const hmac = await crypto.subtle.sign('HMAC', key, input);
    prev = new Uint8Array(hmac);
    output = concatBytes(output, prev);
    counter++;
  }

  return output.slice(0, length);
}

// =====================================================
// Utility Functions
// =====================================================

function base64urlEncode(input) {
  const bytes = typeof input === 'string' 
    ? new TextEncoder().encode(input) 
    : input;
  
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function concatBytes(...arrays) {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...extra
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json' })
  });
}
