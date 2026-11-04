import sodium, { type StateAddress } from 'libsodium-wrappers';

// The Worker authenticates the ephemeral public-key binding. Secrets and ordered
// secretstream states exist only at endpoints; no application fields are exposed.
export class SecureChannel {
  static async create(client: boolean, binding: string) {
    await sodium.ready;
    return new SecureChannel(client, binding);
  }
  private keys = sodium.crypto_kx_keypair();
  private push?: StateAddress;
  private pull?: StateAddress;
  private rx?: Uint8Array;
  private failed = false;
  private exchanged = false;
  private constructor(
    private client: boolean,
    private bindingValue: string,
  ) {
    if (!bindingValue || new TextEncoder().encode(bindingValue).length > 4096)
      this.fail();
  }
  binding(value: string) {
    if (
      this.exchanged ||
      !value ||
      new TextEncoder().encode(value).length > 4096
    )
      this.fail();
    this.bindingValue = value;
  }
  get publicKey() {
    return sodium.to_base64(
      this.keys.publicKey,
      sodium.base64_variants.ORIGINAL,
    );
  }
  private fail(): never {
    this.close();
    throw new Error('SECURE_CHANNEL_FAILED');
  }
  private decode(text: string, limit: number) {
    if (text.length > 4 * Math.ceil(limit / 3)) return this.fail();
    const bytes = sodium.from_base64(text, sodium.base64_variants.ORIGINAL);
    if (bytes.length > limit) return this.fail();
    return bytes;
  }
  exchange(peer: string) {
    try {
      if (this.failed || this.exchanged) return this.fail();
      const publicKey = this.decode(peer, 32);
      if (publicKey.length !== 32) return this.fail();
      const keys = this.client
        ? sodium.crypto_kx_client_session_keys(
            this.keys.publicKey,
            this.keys.privateKey,
            publicKey,
          )
        : sodium.crypto_kx_server_session_keys(
            this.keys.publicKey,
            this.keys.privateKey,
            publicKey,
          );
      this.rx = keys.sharedRx;
      const result = sodium.crypto_secretstream_xchacha20poly1305_init_push(
        keys.sharedTx,
      );
      this.push = result.state;
      this.exchanged = true;
      sodium.memzero(this.keys.privateKey);
      sodium.memzero(keys.sharedTx);
      return sodium.to_base64(result.header, sodium.base64_variants.ORIGINAL);
    } catch {
      return this.fail();
    }
  }
  accept(header: string) {
    try {
      if (this.failed || !this.rx || this.pull !== undefined)
        return this.fail();
      const bytes = this.decode(header, 24);
      if (bytes.length !== 24) return this.fail();
      this.pull = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
        bytes,
        this.rx,
      );
      sodium.memzero(this.rx);
      this.rx = undefined;
    } catch {
      this.fail();
    }
  }
  get ready() {
    return !this.failed && this.push !== undefined && this.pull !== undefined;
  }
  seal(plain: string) {
    try {
      const bytes = sodium.from_string(plain);
      if (!this.ready || bytes.length > 128 * 1024) return this.fail();
      return sodium.to_base64(
        sodium.crypto_secretstream_xchacha20poly1305_push(
          this.push!,
          bytes,
          this.bindingValue,
          sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
        ),
        sodium.base64_variants.ORIGINAL,
      );
    } catch {
      return this.fail();
    }
  }
  open(cipher: string) {
    try {
      if (!this.ready) return this.fail();
      const result = sodium.crypto_secretstream_xchacha20poly1305_pull(
        this.pull!,
        this.decode(cipher, 128 * 1024 + 17),
        this.bindingValue,
      );
      if (
        !result ||
        result.tag !== sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
      )
        return this.fail();
      return sodium.to_string(result.message);
    } catch {
      return this.fail();
    }
  }
  close() {
    this.failed = true;
    sodium.memzero(this.keys.privateKey);
    if (this.rx) sodium.memzero(this.rx);
    this.rx = undefined;
    if (this.push !== undefined) release(this.push);
    if (this.pull !== undefined) release(this.pull);
    this.push = this.pull = undefined;
  }
}

// 0.8.4 returns a WASM address for secretstream states. The wrapper exposes
// allocation through libsodium; release it explicitly on link retirement.
function release(state: StateAddress) {
  const raw = (
    sodium as unknown as {
      libsodium: {
        HEAPU8: Uint8Array;
        _crypto_secretstream_xchacha20poly1305_statebytes: () => number;
        _free: (p: number) => void;
      };
    }
  ).libsodium;
  const address = state as unknown as number;
  raw.HEAPU8.fill(
    0,
    address,
    address + raw._crypto_secretstream_xchacha20poly1305_statebytes(),
  );
  raw._free(address);
}
