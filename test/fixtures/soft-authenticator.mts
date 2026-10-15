/**
 * A software passkey (WebAuthn authenticator) for unit tests: makes the same
 * registration and sign-in answers a phone would, signed with a real P-256
 * key, so the server's checks run for real (signature, origin, RP ID,
 * challenge, user verification, counter).
 */
import crypto from 'node:crypto';

type Cbor = number | string | Buffer | Cbor[] | Map<number | string, Cbor> | { [k: string]: Cbor };

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const b = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)]);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

const b64 = (b: Buffer) => b.toString('base64url');
const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest();

export class SoftAuthenticator {
  readonly credentialId = crypto.randomBytes(32);
  private readonly keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  counter = 0;
  userHandle = '';
  /** Answer with user verification (fingerprint/PIN) done. */
  verifyUser = true;

  constructor(private readonly options: { countsUses?: boolean } = {}) {}

  get id(): string {
    return b64(this.credentialId);
  }

  private coseKey(): Buffer {
    const jwk = this.keys.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return cbor(new Map<number, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  }

  private flags(attested: boolean): number {
    return 0x01 | (this.verifyUser ? 0x04 : 0) | 0x08 | 0x10 | (attested ? 0x40 : 0);
  }

  private counterBytes(): Buffer {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(this.counter);
    return c;
  }

  /** navigator.credentials.create() for these options, as the browser library would send it. */
  register(options: { challenge: string; rp: { id?: string }; user: { id: string } }, origin: string) {
    this.userHandle = options.user.id;
    const rpId = options.rp.id!;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([this.flags(true)]), this.counterBytes(), Buffer.alloc(16), idLen, this.credentialId, this.coseKey()]);
    const attestationObject = cbor({ fmt: 'none', attStmt: {}, authData });
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject), transports: ['internal', 'hybrid'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** navigator.credentials.get() for these options. */
  signIn(options: { challenge: string; rpId?: string }, origin: string, rpId = options.rpId!) {
    if (this.options.countsUses) this.counter += 1;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
    const authData = Buffer.concat([sha256(rpId), Buffer.from([this.flags(false)]), this.counterBytes()]);
    const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.keys.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: { clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authData), signature: b64(signature), userHandle: this.userHandle },
      clientExtensionResults: {},
    };
  }
}
