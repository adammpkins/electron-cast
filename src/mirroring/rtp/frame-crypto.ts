/**
 * Frame encryption, ported from openscreen `cast/streaming/impl/frame_crypto.cc` (`FrameCrypto::Crypt`).
 *
 * The nonce is 16 zero bytes with the frame id's lower 32 bits as a big-endian uint32 at offset 8, XORed with the
 * IV mask. `AES_ctr128_encrypt` then counts the whole 128-bit block big-endian, which is what OpenSSL's AES-128-CTR
 * (Node's `aes-128-ctr`) does too. The key stream is continuous across the chunks of one frame.
 */
import { createCipheriv } from "node:crypto";
import type { EncodedFrame, EncryptedFrame } from "./frame.ts";

export class FrameCrypto {
  private readonly key: Buffer;
  private readonly ivMask: Buffer;

  constructor(aesKey: Uint8Array, castIvMask: Uint8Array) {
    if (aesKey.length !== 16 || castIvMask.length !== 16) throw new RangeError("AES key and IV mask must be 16 bytes");
    this.key = Buffer.from(aesKey);
    this.ivMask = Buffer.from(castIvMask);
  }

  /** `FrameCrypto::Encrypt`: a copy of the metadata with the payload encrypted. */
  encrypt(frame: EncodedFrame): EncryptedFrame {
    return { ...frame, data: this.crypt(frame.frameId, frame.data) };
  }

  /** `FrameCrypto::Decrypt`; CTR is symmetric. Chunks are decrypted as one continuous stream. */
  decrypt(frameId: number, chunks: Uint8Array[]): Buffer {
    return this.crypt(frameId, chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks));
  }

  private crypt(frameId: number, data: Uint8Array): Buffer {
    const nonce = Buffer.alloc(16);
    nonce.writeUInt32BE(frameId >>> 0, 8);
    for (let i = 0; i < 16; i++) nonce[i] = nonce[i]! ^ this.ivMask[i]!;
    const cipher = createCipheriv("aes-128-ctr", this.key, nonce);
    return Buffer.concat([cipher.update(data), cipher.final()]);
  }
}
