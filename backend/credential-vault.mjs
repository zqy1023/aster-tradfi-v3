import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

export class CredentialVault {
  constructor(secret) {
    if (!secret || String(secret).length < 24) throw new Error('V3_CREDENTIAL_KEY 至少需要 24 个字符');
    this.key = scryptSync(String(secret), 'aster-tradfi-v3-credential-vault', 32);
  }

  seal(credentials) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(credentials), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
  }

  open(value) {
    const [version, iv, tag, encrypted] = String(value || '').split('.');
    if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('凭证密文格式无效');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  }
}
