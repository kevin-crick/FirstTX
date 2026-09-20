/* Base58 (Bitcoin alphabet) — used for Solana addresses and signatures. */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = new Map([...ALPHABET].map((c, i) => [c, i]));

export function decodeBase58(str) {
  if (typeof str !== 'string' || str.length === 0) throw new Error('empty base58 string');

  const bytes = [0];
  for (const char of str) {
    const value = MAP.get(char);
    if (value === undefined) throw new Error('invalid base58 character: ' + char);
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  /* Leading '1's are leading zero bytes. */
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);

  return Uint8Array.from(bytes.reverse());
}

export function encodeBase58(bytes) {
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

/** True when the string decodes to a 32 byte Solana public key. */
export function isValidAddress(str) {
  try {
    return decodeBase58(str).length === 32;
  } catch {
    return false;
  }
}
