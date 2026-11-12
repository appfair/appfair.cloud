// Copyright © The Daybrite Project
// SPDX-License-Identifier: MPL-2.0

import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assetName, classify, ingestVersion } from "../src/ingest";
import { handle, marketplaceKit } from "../src/index";
import {
  verifyAppleSignature,
  appStoreConnectToken,
  base64url,
  decodeJWT,
  installToken,
  toBase64,
  verifyES256,
  verifyGitHubOIDC,
} from "../src/jwt";
import { Marketplace } from "../src/marketplace";
import { resolvePackage, servePackage } from "../src/packages";
import { seal, unseal } from "../src/seal";
import { MemoryStore, Version } from "../src/store";

const ITEM = "1640618584";
const VERSION = "869899373";
const PACKAGES = "https://packages.appfair.cloud";

async function p256() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const pem = `-----BEGIN PRIVATE KEY-----\n${toBase64(der)}\n-----END PRIVATE KEY-----\n`;
  return { pair, pem };
}

function version(over: Partial<Version> = {}): Version {
  const v = over.appleVersionId ?? VERSION;
  return {
    appleItemId: ITEM,
    appleVersionId: v,
    bundleId: "org.appfair.app.Net-Skip",
    bundleVersion: "236",
    shortVersion: "1.4.23",
    minimumSystemVersion: "17.0",
    requiredDeviceCapabilities: ["arm64"],
    size: 805788,
    state: "available",
    repo: "Net-Skip/Net-Skip",
    tag: "1.4.23",
    createdAt: 1,
    assets: [
      { path: "manifest.json", publicId: "", name: assetName(v, "manifest.json"), url: `https://github.com/Net-Skip/Net-Skip/releases/download/1.4.23/${assetName(v, "manifest.json")}` },
      { path: "signature", publicId: "", name: assetName(v, "signature"), url: "https://github.com/x/sig" },
      { path: "variant/a.ipa", publicId: "a", name: assetName(v, "variant/a.ipa"), url: "https://github.com/x/a.ipa" },
    ],
    ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("tokens", () => {
  it("signs install tokens with exactly Apple's claims", async () => {
    const { pair } = await p256();
    const token = await installToken({
      key: pair.privateKey,
      keyID: "b3818104-a7f6-4bd7-8af0-ee63bad3e348",
      marketplaceItemID: "6480579814",
      bundleID: "org.appfair.app.Net-Skip",
      type: "download",
      itemID: ITEM,
      versionID: VERSION,
      now: 1_762_000_000,
      nonce: "N",
    });
    expect(decodeJWT(token).header).toEqual({ alg: "ES256", kid: "b3818104-a7f6-4bd7-8af0-ee63bad3e348", typ: "JWT" });
    expect(await verifyES256(token, pair.publicKey)).toEqual({
      iss: "6480579814",
      iat: 1_762_000_000,
      exp: 1_762_000_000 + 1200,
      aud: "AppleDownloadVerification-v1",
      bid: "org.appfair.app.Net-Skip",
      dtype: "download",
      nonce: "N",
      iid: ITEM,
      vid: VERSION,
    });
    // The JWS signature is the raw 64-byte r || s.
    expect(decodeJWT(token).signature.length).toBe(64);
  });

  it("signs App Store Connect tokens for team and individual keys", async () => {
    const { pair } = await p256();
    expect((await verifyES256(await appStoreConnectToken(pair.privateKey, "K", "I"), pair.publicKey)).iss).toBe("I");
    expect((await verifyES256(await appStoreConnectToken(pair.privateKey, "K"), pair.publicKey)).sub).toBe("user");
  });

  it("accepts only the Publisher's GitHub OIDC tokens", async () => {
    const rsa = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = { ...(await crypto.subtle.exportKey("jwk", rsa.publicKey)), kid: "k1" } as JsonWebKey & { kid: string };
    const sign = async (claims: object) => {
      const enc = new TextEncoder();
      const input = `${base64url(enc.encode(JSON.stringify({ alg: "RS256", kid: "k1" })))}.${base64url(enc.encode(JSON.stringify(claims)))}`;
      return `${input}.${base64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rsa.privateKey, enc.encode(input)))}`;
    };
    const good = {
      iss: "https://token.actions.githubusercontent.com",
      aud: "https://api.appfair.cloud",
      repository: "appfair/appfair-apps",
      exp: 2_000_000_000,
    };
    const opts = { audience: "https://api.appfair.cloud", repository: "appfair/appfair-apps", now: 1_800_000_000, jwks: { keys: [jwk] } };
    expect((await verifyGitHubOIDC(await sign(good), opts)).repository).toBe("appfair/appfair-apps");
    await expect(verifyGitHubOIDC(await sign({ ...good, repository: "evil/fork" }), opts)).rejects.toThrow();
    await expect(verifyGitHubOIDC(await sign({ ...good, aud: "other" }), opts)).rejects.toThrow();
    await expect(verifyGitHubOIDC(await sign({ ...good, exp: 1 }), opts)).rejects.toThrow();
  });
});

describe("App Store Connect webhook", () => {
  it("checks the signature exactly as Apple's example computes it", async () => {
    const good = "hmacsha256=7f062172b01cb00b53ca068614674a3d982a34062a0f5d37687d5e3377e54657";
    expect(await verifyAppleSignature("This is my secret", "Hello, World!", good)).toBe(true);
    expect(await verifyAppleSignature("This is my secret", "Hello, World?", good)).toBe(false);
    expect(await verifyAppleSignature("another secret", "Hello, World!", good)).toBe(false);
    expect(await verifyAppleSignature("This is my secret", "Hello, World!", null)).toBe(false);
    expect(await verifyAppleSignature("", "Hello, World!", good)).toBe(false);
  });

  it("refuses unsigned notifications", async () => {
    const e = { MARKETPLACE_WEBHOOK_SECRET: "s" } as any;
    const ctx = { waitUntil() {} } as any;
    const r = await handle(
      new Request("https://api.appfair.cloud/v1/notifications", { method: "POST", body: "{}" }),
      e,
      ctx,
      new MemoryStore(),
    );
    expect(r.status).toBe(401);
  });
});

describe("key blobs", () => {
  it("seal and unseal under the secret", async () => {
    const secret = toBase64(crypto.getRandomValues(new Uint8Array(32)));
    const sealed = await seal(secret, new Uint8Array([1, 2, 3]));
    expect([...(await unseal(secret, sealed))]).toEqual([1, 2, 3]);
    const other = toBase64(crypto.getRandomValues(new Uint8Array(32)));
    await expect(unseal(other, sealed)).rejects.toThrow();
  });
});

describe("marketplace", () => {
  async function market() {
    const { pair } = await p256();
    const store = new MemoryStore();
    await store.putVersion(version());
    const m = new Marketplace(store, { key: pair.privateKey, keyID: "kid", marketplaceItemID: "6480579814" }, PACKAGES);
    return { m, store, pub: pair.publicKey };
  }

  it("issues install tokens only for apps it distributes, from its own domain", async () => {
    const { m, pub } = await market();
    const app = (over: object = {}) => ({
      appleItemId: ITEM,
      bundleId: "org.appfair.app.Net-Skip",
      alternativeDistributionPackage: `${PACKAGES}/${ITEM}/`,
      update: false,
      ...over,
    });
    const first = await m.installTokens({ account: "a1", apps: [app(), app({ appleItemId: "42" })] });
    expect(first.failures["42"]).toBe("App Fair does not distribute this app.");
    expect((await verifyES256(first.tokens[ITEM], pub)).dtype).toBe("download");
    const again = await m.installTokens({ account: "a1", apps: [app()] });
    expect((await verifyES256(again.tokens[ITEM], pub)).dtype).toBe("redownload");
    const impostor = await m.installTokens({ account: "a2", apps: [app({ bundleId: "com.example" })] });
    expect(impostor.failures[ITEM]).toMatch(/does not match/);
    const elsewhere = await m.installTokens({
      account: "a2",
      apps: [app({ alternativeDistributionPackage: "https://github.com/x/manifest.json" })],
    });
    expect(elsewhere.failures[ITEM]).toMatch(/not distributed by App Fair/);
  });

  it("answers restores and updates with the newest available version", async () => {
    const { m, store } = await market();
    const restore = await m.restore({ apps: [{ appleItemId: ITEM }, { appleItemId: "42" }] });
    expect(restore.restores[0].alternativeDistributionPackage).toBe(`${PACKAGES}/${ITEM}/${VERSION}/`);
    expect(restore.failures).toEqual([{ appleItemId: "42", failure: { code: 404, description: "App unavailable." } }]);
    expect((await m.updates({ apps: [{ appleItemId: ITEM, appleVersionId: VERSION }] })).updates).toEqual([]);
    // A pending version is not offered until the Publisher has attached it.
    await store.putVersion(version({ appleVersionId: "900", bundleVersion: "240", state: "pending" }));
    expect((await m.updates({ apps: [{ appleItemId: ITEM, appleVersionId: VERSION }] })).updates).toEqual([]);
    await store.putVersion(version({ appleVersionId: "900", bundleVersion: "240" }));
    const newer = await m.updates({ apps: [{ appleItemId: ITEM, appleVersionId: VERSION }] });
    expect(newer.updates[0]).toMatchObject({ appleVersionId: "900", bundleVersion: "240", shortVersionString: "1.4.23" });
    // A withdrawn app is gone everywhere.
    await store.setWithdrawn(ITEM, true);
    expect((await m.restore({ apps: [{ appleItemId: ITEM }] })).failures).toHaveLength(1);
    expect((await m.catalog()).apps).toEqual([]);
  });
});

describe("packages", () => {
  it("redirects to the release asset, newest or pinned, and refuses everything else", async () => {
    const store = new MemoryStore();
    await store.putVersion(version());
    expect(await resolvePackage(store, `/${ITEM}/manifest.json`)).toMatch(/releases\/download\/1\.4\.23\/adp-869899373-manifest\.json$/);
    expect(await resolvePackage(store, `/${ITEM}/${VERSION}/variant/a.ipa`)).toBe("https://github.com/x/a.ipa");
    expect(await resolvePackage(store, `/${ITEM}/../state`)).toBeUndefined();
    expect(await resolvePackage(store, `/${ITEM}/variant/missing.ipa`)).toBeUndefined();
    expect(await resolvePackage(store, `/42/manifest.json`)).toBeUndefined();
    const r = await servePackage(store, new Request(`${PACKAGES}/${ITEM}/signature`), "redirect");
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://github.com/x/sig");
  });

  it("streams instead when told to", async () => {
    const store = new MemoryStore();
    await store.putVersion(version());
    vi.stubGlobal("fetch", async (url: string) => {
      expect(url).toBe("https://github.com/x/a.ipa");
      return new Response("IPA", { headers: { "content-type": "application/octet-stream", "content-length": "3" } });
    });
    const r = await servePackage(store, new Request(`${PACKAGES}/${ITEM}/variant/a.ipa`), "stream");
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("IPA");
  });
});

describe("ingestion", () => {
  it("keeps the key blobs, sealed, and asks the Publisher for the files", async () => {
    const store = new MemoryStore();
    const secret = toBase64(crypto.getRandomValues(new Uint8Array(32)));
    const manifest = {
      appleItemId: ITEM,
      appleVersionId: VERSION,
      bundleId: "org.appfair.app.Net-Skip",
      bundleVersion: "236",
      shortVersionString: "1.4.23",
      minimumSystemVersions: { ios: "17.0" },
      requiredDeviceCapabilities: ["arm64"],
      variants: [{ publicId: "v1", assetPath: "variant/v1.ipa", variantDetails: { compressedSize: 805788 } }],
      deltas: [{ publicId: "d1", assetPath: "delta/d1.ipa" }, { publicId: "late", assetPath: "delta/late.ipa" }],
    };
    const zip = zipSync({ "manifest.json": strToU8(JSON.stringify(manifest)), signature: strToU8("SIG") });
    const asc = {
      async get(path: string) {
        if (path === "v1/alternativeDistributionPackageVersions/VER") return { data: { attributes: { url: "https://cdn/adp.zip" } } };
        if (path === "v1/alternativeDistributionPackageVariants/v1")
          return { data: { attributes: { url: "https://cdn/v1.ipa", alternativeDistributionKeyBlob: toBase64(strToU8("KEY1")) } } };
        if (path === "v1/alternativeDistributionPackageDeltas/d1")
          return { data: { attributes: { url: "https://cdn/d1.ipa", alternativeDistributionKeyBlob: toBase64(strToU8("KEY2")) } } };
        throw new Error(`404 ${path}`);
      },
    };
    const { version: v, publish } = await ingestVersion({
      asc,
      store,
      keyBlobSecret: secret,
      versionId: "VER",
      download: async (url) => {
        expect(url).toBe("https://cdn/adp.zip");
        return zip;
      },
    });
    expect(v.state).toBe("pending");
    expect(v.size).toBe(805788);
    expect(v.assets.map((a) => a.path)).toEqual(["manifest.json", "signature", "variant/v1.ipa", "delta/d1.ipa"]);
    expect(publish.files).toEqual([
      { name: "adp-869899373-manifest.json", source: "zip:manifest.json" },
      { name: "adp-869899373-signature", source: "zip:signature" },
      { name: "adp-869899373-variant-v1.ipa", source: "https://cdn/v1.ipa" },
      { name: "adp-869899373-delta-d1.ipa", source: "https://cdn/d1.ipa" },
    ]);
    // Key blobs never leave the marketplace: not in the request to GitHub, and sealed at rest.
    expect(JSON.stringify(publish)).not.toContain(toBase64(strToU8("KEY1")));
    const sealed = await store.keyBlob(ITEM, "v1");
    expect(new TextDecoder().decode(await unseal(secret, sealed!))).toBe("KEY1");

    // The Publisher's callback makes it installable.
    const urls = Object.fromEntries(v.assets.map((a) => [a.path, `https://github.com/r/releases/download/t/${a.name}`]));
    expect(await store.publish(ITEM, VERSION, "Net-Skip/Net-Skip", "1.4.23", urls)).toBe(true);
    expect(await resolvePackage(store, `/${ITEM}/delta/d1.ipa`)).toBe("https://github.com/r/releases/download/t/adp-869899373-delta-d1.ipa");
  });

  it("reads notifications as hints", () => {
    expect(
      classify({
        data: {
          type: "AlternativeDistributionPackageVersionAvailable",
          attributes: { alternativeDistributionPackageVersionId: "VER" },
        },
      }),
    ).toEqual({ kind: "ingest", versionId: "VER" });
    expect(classify({ data: { type: "AppTakeDown", attributes: { appId: ITEM } } })).toEqual({
      kind: "withdraw",
      appleItemId: ITEM,
    });
    expect(classify({ data: { type: "Something" } }).kind).toBe("ignore");
  });
});

describe("routes", () => {
  async function env() {
    const { pem } = await p256();
    return {
      MARKETPLACE_APPLE_ITEM_ID: "6480579814",
      DISTRIBUTION_KEY_ID: "kid",
      DISTRIBUTION_KEY: pem,
      API_BASE: "https://api.appfair.cloud",
      PACKAGES_BASE: PACKAGES,
      STATIC_BASE: "https://appfair.net/marketplace",
      DOWNLOADS: "redirect",
    } as any;
  }
  const ctx = { waitUntil() {}, passThroughOnException() {} } as any;

  it("serves the marketplace-kit file, tokens, and packages", async () => {
    const e = await env();
    const store = new MemoryStore();
    await store.putVersion(version());
    const kit = await handle(new Request("https://appfair.cloud/.well-known/marketplace-kit"), e, ctx, store);
    expect(await kit.json()).toEqual(marketplaceKit(e));
    expect(marketplaceKit(e).license.signingCertificateURL).toBe("https://appfair.net/marketplace/certs/signing.cer");

    const tokens = await handle(
      new Request("https://api.appfair.cloud/v1/install-tokens", {
        method: "POST",
        body: JSON.stringify({
          account: "a",
          apps: [{ appleItemId: ITEM, bundleId: "org.appfair.app.Net-Skip", alternativeDistributionPackage: `${PACKAGES}/${ITEM}/`, update: false }],
        }),
      }),
      e,
      ctx,
      store,
    );
    expect(Object.keys(((await tokens.json()) as any).tokens)).toEqual([ITEM]);

    const pkg = await handle(new Request(`${PACKAGES}/${ITEM}/variant/a.ipa`), e, ctx, store);
    expect(pkg.status).toBe(302);
    expect((await handle(new Request("https://api.appfair.cloud/v1/nope", { method: "POST" }), e, ctx, store)).status).toBe(404);
  });
});
