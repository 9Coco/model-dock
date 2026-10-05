import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';

/** Credentials stay in the main process. OS encryption is preferred; a private
 * local AES key also supports Linux desktops without a configured keyring. */
export function createVault(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const keyPath = join(dataDir, 'vault.key');
  function localKey() {
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(keyPath, 0o600);
    const key = readFileSync(keyPath);
    if (key.length !== 32) throw new Error('本机凭据密钥损坏，请从备份恢复。');
    return key;
  }
  return {
    encrypt(text: string): string {
      const insecureBackend = process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text';
      if (safeStorage.isEncryptionAvailable() && !insecureBackend) {
        return 'os:' + safeStorage.encryptString(text).toString('base64');
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', localKey(), iv);
      const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return 'local:' + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
    },
    decrypt(value: string): string {
      if (value.startsWith('os:')) return safeStorage.decryptString(Buffer.from(value.slice(3), 'base64'));
      if (!value.startsWith('local:')) throw new Error('凭据存储格式无法识别。');
      const bytes = Buffer.from(value.slice(6), 'base64');
      const decipher = createDecipheriv('aes-256-gcm', localKey(), bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}
