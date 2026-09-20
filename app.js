/* Shared frontend helpers: where the API lives, plus formatting and the
   base58 encoder used when a wallet signs the registration message. */

window.FIRSTTX = (function () {
  /* Point this at your backend. Localhost while testing; your own domain
     once the server is deployed. */
  const API_BASE =
    location.hostname === 'localhost' || location.hostname === '127.0.0.1'
      ? 'http://localhost:8787'
      : 'https://api.firsttx.com';

  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  function encodeBase58(bytes) {
    const digits = [0];
    for (const byte of bytes) {
      let carry = byte;
      for (let i = 0; i < digits.length; i++) {
        carry += digits[i] << 8;
        digits[i] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }
    let out = '';
    for (const byte of bytes) {
      if (byte === 0) out += '1';
      else break;
    }
    for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
    return out;
  }

  async function api(path, options) {
    const res = await fetch(API_BASE + path, options);
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON response */
    }
    if (!res.ok) throw new Error(body?.error || `request failed (${res.status})`);
    return body;
  }

  const money = (n, withSign) => {
    const rounded = Math.round(Number(n) || 0);
    const text = '$' + Math.abs(rounded).toLocaleString('en-US');
    if (!withSign) return text;
    return (rounded < 0 ? '−' : '+') + text;
  };

  const pct = (n) => {
    const value = Math.round(Number(n) || 0);
    return (value < 0 ? '−' : '+') + Math.abs(value) + '%';
  };

  const shortAddr = (a) => (a && a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : a || '');

  function countdown(toUnixSeconds) {
    const left = Math.max(0, Math.floor(toUnixSeconds - Date.now() / 1000));
    const h = String(Math.floor(left / 3600)).padStart(2, '0');
    const m = String(Math.floor((left % 3600) / 60)).padStart(2, '0');
    const s = String(left % 60).padStart(2, '0');
    return h + ':' + m + ':' + s;
  }

  /* Phantom (and other wallets that expose the same interface). */
  function getProvider() {
    const provider = window.phantom?.solana || window.solana;
    return provider?.isPhantom || provider?.signMessage ? provider : null;
  }

  return { API_BASE, api, encodeBase58, money, pct, shortAddr, countdown, getProvider, SOLSCAN: 'https://solscan.io/account/' };
})();
