import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export class SecretStore {
  private secret: string;

  constructor(secretFilePath?: string) {
    const defaultDir = path.join(process.env.APPDATA || process.cwd(), 'StreamDockBridge');
    const targetFile = secretFilePath || path.join(defaultDir, 'secret.key');

    if (fs.existsSync(targetFile)) {
      this.secret = fs.readFileSync(targetFile, 'utf8').trim();
    } else {
      if (!fs.existsSync(path.dirname(targetFile))) {
        fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      }
      this.secret = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(targetFile, this.secret, { encoding: 'utf8', mode: 0o600 });
    }
  }

  public getSecret(): string {
    return this.secret;
  }

  public verifySecret(token: string | undefined): boolean {
    if (!token) return false;
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(this.secret));
  }
}
