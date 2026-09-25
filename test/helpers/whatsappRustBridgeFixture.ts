import { createHash, createHmac, hkdfSync } from 'node:crypto';

export class LTHashAntiTampering {
  subtractThenAdd(current: Uint8Array, subtract: Uint8Array[], add: Uint8Array[]): Uint8Array {
    const result = Buffer.from(current);
    for (const value of subtract) {
      for (let index = 0; index < result.length; index += 1) result[index] = (result[index] - value[index % value.length] + 256) % 256;
    }
    for (const value of add) {
      for (let index = 0; index < result.length; index += 1) result[index] = (result[index] + value[index % value.length]) % 256;
    }
    return result;
  }
}

export function expandAppStateKeys(value: { indexKey?: Uint8Array; indexValue?: Uint8Array }): { indexKey: Uint8Array; indexValue: Uint8Array } {
  return { indexKey: value.indexKey ?? new Uint8Array(), indexValue: value.indexValue ?? new Uint8Array() };
}

export function md5(value: Uint8Array): Buffer {
  return createHash('md5').update(value).digest();
}

export function hkdf(value: Uint8Array, length: number, options: { salt?: Uint8Array | string; info?: Uint8Array | string } = {}): Buffer {
  const salt = options.salt === undefined ? undefined : Buffer.from(options.salt);
  const info = options.info === undefined ? Buffer.alloc(0) : Buffer.from(options.info);
  return Buffer.from(hkdfSync('sha256', value, salt ?? Buffer.alloc(0), info, length));
}

export function hmacSha256(value: Uint8Array, key: Uint8Array): Buffer {
  return createHmac('sha256', key).update(value).digest();
}
