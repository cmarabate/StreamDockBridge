import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SecretStore } from './secretStore';

describe('SecretStore', () => {
  let tmpFile: string;
  let store: SecretStore;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `secret-test-${Date.now()}-${Math.random()}.key`);
    store = new SecretStore(tmpFile);
  });

  afterEach(() => {
    if (fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  it('generates a 64-char hex secret if file does not exist', () => {
    const secret = store.getSecret();
    expect(secret).toBeDefined();
    expect(secret.length).toBe(64);
  });

  it('verifies correct secret token', () => {
    const secret = store.getSecret();
    expect(store.verifySecret(secret)).toBe(true);
  });

  it('safely handles undefined token without error', () => {
    expect(store.verifySecret(undefined)).toBe(false);
  });

  it('safely handles empty string token without error', () => {
    expect(store.verifySecret('')).toBe(false);
  });

  it('safely handles short token without throwing length mismatch RangeError', () => {
    expect(store.verifySecret('short')).toBe(false);
  });

  it('safely handles long token without throwing length mismatch RangeError', () => {
    expect(store.verifySecret('a'.repeat(200))).toBe(false);
  });

  it('returns false for wrong token of same length', () => {
    const secret = store.getSecret();
    const wrong = secret.substring(0, secret.length - 1) + (secret.endsWith('0') ? '1' : '0');
    expect(store.verifySecret(wrong)).toBe(false);
  });
});
