const emptyBuffer = (): Buffer => Buffer.alloc(0);

export class SessionCipher {
  constructor(..._args: unknown[]) {}

  async decryptPreKeyWhisperMessage(_data: unknown): Promise<Buffer> {
    return emptyBuffer();
  }

  async decryptWhisperMessage(_data: unknown): Promise<Buffer> {
    return emptyBuffer();
  }

  async encrypt(_data: unknown): Promise<{ type: number; body: Buffer }> {
    return { type: 1, body: emptyBuffer() };
  }

  getRecord(): null {
    return null;
  }

  hasOpenSession(): boolean {
    return false;
  }

  deleteAllSessionsForDevice(_deviceId: number): void {}

  async processPreKeyWhisperMessage(_data: unknown): Promise<Buffer> {
    return emptyBuffer();
  }
}

export class SessionBuilder {
  constructor(..._args: unknown[]) {}

  async initOutgoing(_session: unknown): Promise<void> {}

  async processPreKey(_data: unknown): Promise<void> {}
}

export class SessionRecord {
  static deserialize(): SessionRecord {
    return new SessionRecord();
  }

  serialize(): Buffer {
    return emptyBuffer();
  }

  haveOpenSession(): boolean {
    return false;
  }
}

export class ProtocolAddress {
  constructor(public readonly name = '', public readonly deviceId = 0) {}

  getName(): string {
    return this.name;
  }

  getDeviceId(): number {
    return this.deviceId;
  }

  toString(): string {
    return `${this.name}.${this.deviceId}`;
  }
}

export const curve = {
  generateKeyPair(): { pubKey: Buffer; privKey: Buffer } {
    return { pubKey: Buffer.alloc(33), privKey: Buffer.alloc(32) };
  },
  calculateAgreement(): Buffer {
    return Buffer.alloc(32);
  },
  calculateSignature(): Buffer {
    return Buffer.alloc(64);
  },
  verifySignature(): boolean {
    return true;
  },
  createKeyPair(privateKey?: Buffer): { pubKey: Buffer; privKey: Buffer } {
    return { pubKey: Buffer.alloc(33), privKey: privateKey ?? Buffer.alloc(32) };
  },
};

export const crypto = {
  calculateMAC(): Buffer {
    return Buffer.alloc(32);
  },
  deriveSecrets(_input: unknown, _salt: unknown, _chain: unknown, chunks = 3): Buffer[] {
    return Array.from({ length: chunks }, () => Buffer.alloc(32));
  },
  decrypt(): Buffer {
    return Buffer.alloc(0);
  },
  encrypt(): Buffer {
    return Buffer.alloc(0);
  },
  hmacSha256(): Buffer {
    return Buffer.alloc(32);
  },
};

export const keyhelper = {
  generateSenderKey(): Buffer {
    return Buffer.alloc(32);
  },
};

export const PreKeyWhisperMessage = {
  decode(): { identityKey: Uint8Array } {
    return { identityKey: new Uint8Array() };
  },
  fromObject(value: unknown): unknown {
    return value;
  },
};

export const libsignal = {
  SessionCipher,
  SessionBuilder,
  SessionRecord,
  ProtocolAddress,
  curve,
  crypto,
  keyhelper,
  PreKeyWhisperMessage,
};

export default libsignal;
