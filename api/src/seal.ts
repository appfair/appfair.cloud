// Copyright © The Daybrite Project
// SPDX-License-Identifier: MPL-2.0

// Key blobs at rest: AES-256-GCM under KEY_BLOB_SECRET (32 random bytes, base64), so a copy of the
// database alone licenses nothing. Each value is `base64(iv || ciphertext)`.

import { fromBase64, toBase64 } from "./jwt";

async function key(secret: string): Promise<CryptoKey> {
  const raw = fromBase64(secret);
  if (raw.length !== 32) throw new Error("KEY_BLOB_SECRET must be 32 bytes, base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(secret: string, plain: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secret), plain));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return toBase64(out);
}

export async function unseal(secret: string, sealed: string): Promise<Uint8Array> {
  const all = fromBase64(sealed);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: all.slice(0, 12) },
    await key(secret),
    all.slice(12),
  );
  return new Uint8Array(plain);
}
