// Copyright © The Daybrite Project
// SPDX-License-Identifier: MPL-2.0

// JSON Web Tokens with WebCrypto: ES256 for the install verification tokens iOS checks and for
// App Store Connect API bearer tokens, and RS256 verification of GitHub Actions' OIDC tokens.

const encoder = new TextEncoder();

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(s: string): Uint8Array {
  const b = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
}

export function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
}

/** The DER inside a PEM block. */
export function pemBody(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return fromBase64(body);
}

/**
 * A P-256 signing key from a PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`), the form App Store
 * Connect's `.p8` files use. A SEC1 key (`-----BEGIN EC PRIVATE KEY-----`, what `openssl ecparam
 * -genkey` writes) converts with `openssl pkcs8 -topk8 -nocrypt`.
 */
export async function importP256(pem: string): Promise<CryptoKey> {
  if (pem.includes("EC PRIVATE KEY")) {
    throw new Error("convert the key to PKCS#8 first: openssl pkcs8 -topk8 -nocrypt -in key.pem");
  }
  return crypto.subtle.importKey(
    "pkcs8",
    pemBody(pem),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/** `header.payload.signature`, ES256: WebCrypto's ECDSA signature is already the raw `r || s`. */
export async function signES256(header: object, claims: object, key: CryptoKey): Promise<string> {
  const input = `${base64url(encoder.encode(JSON.stringify(header)))}.${base64url(
    encoder.encode(JSON.stringify(claims)),
  )}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(input));
  return `${input}.${base64url(sig)}`;
}

export type DownloadType = "download" | "redownload";

export const INSTALL_AUDIENCE = "AppleDownloadVerification-v1";

/**
 * An install verification token (Apple's "Supplying an install verification token"), the same
 * claims as App-Fair/marketplace-token.
 */
export async function installToken(opts: {
  key: CryptoKey;
  keyID: string;
  marketplaceItemID: string;
  bundleID: string;
  type: DownloadType;
  itemID?: string;
  versionID?: string;
  now?: number;
  lifetime?: number;
  nonce?: string;
}): Promise<string> {
  if (!/^\d+$/.test(opts.marketplaceItemID)) throw new Error("the marketplace Apple ID is not numeric");
  if (!opts.bundleID) throw new Error("no bundle id");
  const iat = opts.now ?? Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: opts.marketplaceItemID,
    iat,
    exp: iat + (opts.lifetime ?? 20 * 60),
    aud: INSTALL_AUDIENCE,
    bid: opts.bundleID,
    dtype: opts.type,
    nonce: opts.nonce ?? crypto.randomUUID().toUpperCase(),
  };
  if (opts.itemID) claims.iid = opts.itemID;
  if (opts.versionID) claims.vid = opts.versionID;
  return signES256({ alg: "ES256", kid: opts.keyID, typ: "JWT" }, claims, opts.key);
}

/** A bearer token for the App Store Connect API (team key with an issuer, or an individual key). */
export async function appStoreConnectToken(key: CryptoKey, keyID: string, issuer?: string, now?: number) {
  const iat = now ?? Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { iat, exp: iat + 15 * 60, aud: "appstoreconnect-v1" };
  if (issuer) claims.iss = issuer;
  else claims.sub = "user";
  return signES256({ alg: "ES256", kid: keyID, typ: "JWT" }, claims, key);
}

export function decodeJWT(token: string): { header: any; claims: any; input: string; signature: Uint8Array } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("not a JWT");
  const json = (s: string) => JSON.parse(new TextDecoder().decode(fromBase64url(s)));
  return {
    header: json(parts[0]),
    claims: json(parts[1]),
    input: `${parts[0]}.${parts[1]}`,
    signature: fromBase64url(parts[2]),
  };
}

/** Verify an ES256 token against a public key; for tests and diagnosis. */
export async function verifyES256(token: string, publicKey: CryptoKey): Promise<any | null> {
  const t = decodeJWT(token);
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    t.signature,
    encoder.encode(t.input),
  );
  return ok ? t.claims : null;
}

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";

/**
 * Verify a GitHub Actions OIDC token: RS256 against GitHub's published keys, the expected
 * audience, unexpired, and from `repository`. Returns its claims.
 */
export async function verifyGitHubOIDC(
  token: string,
  opts: { audience: string; repository: string; now?: number; jwks?: { keys: JsonWebKey[] } },
): Promise<Record<string, any>> {
  const t = decodeJWT(token);
  if (t.header.alg !== "RS256") throw new Error("unexpected algorithm");
  const jwks =
    opts.jwks ??
    ((await (await fetch(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`)).json()) as { keys: JsonWebKey[] });
  const jwk = jwks.keys.find((k: any) => k.kid === t.header.kid);
  if (!jwk) throw new Error("unknown signing key");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, t.signature, encoder.encode(t.input));
  if (!ok) throw new Error("bad signature");
  const c = t.claims;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (c.iss !== GITHUB_OIDC_ISSUER) throw new Error("wrong issuer");
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(opts.audience)) throw new Error("wrong audience");
  if (typeof c.exp !== "number" || c.exp < now) throw new Error("expired");
  if (c.repository !== opts.repository) throw new Error(`token is from ${c.repository}`);
  return c;
}

/**
 * Check App Store Connect's webhook signature: `x-apple-signature: hmacsha256=<hex>`, the
 * HMAC-SHA256 of the raw body under the secret registered with the webhook (Apple's "Processing
 * alternative marketplace notifications").
 */
export async function verifyAppleSignature(secret: string, body: string, header: string | null): Promise<boolean> {
  const m = /^hmacsha256=([0-9a-f]{64})$/i.exec((header ?? "").trim());
  if (!m || !secret) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  const given = m[1].toLowerCase();
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  // Constant time: compare every character.
  let diff = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
