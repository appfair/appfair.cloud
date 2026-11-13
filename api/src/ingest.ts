// Copyright © The Daybrite Project
// SPDX-License-Identifier: MPL-2.0

// A notarized version arrives (Apple's "Ingesting an alternative distribution package"): App Store
// Connect notifies the marketplace, which reads the version's manifest and each variant's and
// delta's key blob from the App Store Connect API, keeps the key blobs (sealed), and asks the App
// Fair Publisher (appfair/appfair-apps, adp.yml) to attach the package files to the app's own
// GitHub release. The files are never stored here; the Publisher's callback (index.ts) records
// where they landed, and the version becomes installable.

import { unzipSync } from "fflate";
import { fromBase64 } from "./jwt";
import { seal } from "./seal";
import { Asset, Store, Version } from "./store";

export interface AppStoreConnect {
  get(path: string): Promise<any>;
}

export class AppStoreConnectAPI implements AppStoreConnect {
  constructor(private token: () => Promise<string>) {}

  async get(path: string): Promise<any> {
    const r = await fetch(`https://api.appstoreconnect.apple.com/${path}`, {
      headers: { Authorization: `Bearer ${await this.token()}` },
    });
    if (!r.ok) throw new Error(`App Store Connect ${path}: ${r.status} ${(await r.text()).slice(0, 300)}`);
    return r.json();
  }
}

interface Manifest {
  appleItemId: string;
  appleVersionId: string;
  bundleId: string;
  bundleVersion: string;
  shortVersionString: string;
  minimumSystemVersions?: Record<string, string>;
  requiredDeviceCapabilities?: string[];
  variants: { publicId: string; assetPath: string; variantDetails?: { compressedSize?: number } }[];
  deltas?: { publicId: string; assetPath: string }[];
}

/** What adp.yml in appfair/appfair-apps receives. */
export interface PublishRequest {
  appleItemId: string;
  appleVersionId: string;
  bundleId: string;
  shortVersion: string;
  bundleVersion: string;
  /** The package zip (manifest.json and signature), a short-lived App Store Connect URL. */
  zip: string;
  /** Every file to attach: `source` is `zip:<entry>` or a short-lived download URL. */
  files: { name: string; source: string }[];
}

/**
 * `variant/<id>.ipa` → `x-adp-<version>-variant-<id>.ipa`: release assets have flat names. The `x-`
 * sorts them after the app's own assets, which GitHub lists alphabetically.
 */
export function assetName(version: string, path: string): string {
  return `x-adp-${version}-${path.replace(/\//g, "-")}`;
}

/** Ingest one package version: returns the pending version and what to ask the Publisher. */
export async function ingestVersion(opts: {
  asc: AppStoreConnect;
  store: Store;
  keyBlobSecret: string;
  versionId: string;
  download?: (url: string) => Promise<Uint8Array>;
  now?: number;
}): Promise<{ version: Version; publish: PublishRequest }> {
  const download =
    opts.download ??
    (async (url: string) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`package download: ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    });
  const meta = await opts.asc.get(`v1/alternativeDistributionPackageVersions/${opts.versionId}`);
  const zipURL: string | undefined = meta?.data?.attributes?.url;
  if (!zipURL) throw new Error(`package version ${opts.versionId} has no download yet`);
  const entries = unzipSync(await download(zipURL));
  const manifestBytes = entries["manifest.json"];
  if (!manifestBytes || !entries["signature"]) throw new Error("the package has no manifest.json or signature");
  const m: Manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  const v = m.appleVersionId;

  const assets: Asset[] = [
    { path: "manifest.json", publicId: "", name: assetName(v, "manifest.json") },
    { path: "signature", publicId: "", name: assetName(v, "signature") },
  ];
  const files: PublishRequest["files"] = [
    { name: assetName(v, "manifest.json"), source: "zip:manifest.json" },
    { name: assetName(v, "signature"), source: "zip:signature" },
  ];
  const take = async (kind: string, a: { publicId: string; assetPath: string }, required: boolean) => {
    if (a.assetPath.includes("..") || a.assetPath.startsWith("/")) throw new Error(`unsafe path ${a.assetPath}`);
    let detail: any;
    try {
      detail = (await opts.asc.get(`v1/${kind}/${a.publicId}`))?.data?.attributes;
    } catch (e) {
      // Deltas can arrive after the variants; without one, iOS downloads the whole variant.
      if (required) throw e;
      return;
    }
    if (!detail?.url || !detail?.alternativeDistributionKeyBlob) {
      if (required) throw new Error(`${kind}/${a.publicId} has no URL or key blob`);
      return;
    }
    await opts.store.putKeyBlob(
      m.appleItemId,
      a.publicId,
      await seal(opts.keyBlobSecret, fromBase64(detail.alternativeDistributionKeyBlob)),
    );
    assets.push({ path: a.assetPath, publicId: a.publicId, name: assetName(v, a.assetPath) });
    files.push({ name: assetName(v, a.assetPath), source: detail.url });
  };
  for (const variant of m.variants) await take("alternativeDistributionPackageVariants", variant, true);
  for (const delta of m.deltas ?? []) await take("alternativeDistributionPackageDeltas", delta, false);

  const version: Version = {
    appleItemId: m.appleItemId,
    appleVersionId: v,
    bundleId: m.bundleId,
    bundleVersion: m.bundleVersion,
    shortVersion: m.shortVersionString,
    minimumSystemVersion: m.minimumSystemVersions?.ios,
    requiredDeviceCapabilities: m.requiredDeviceCapabilities ?? [],
    size: Math.max(0, ...m.variants.map((x) => x.variantDetails?.compressedSize ?? 0)),
    state: "pending",
    createdAt: opts.now ?? Date.now(),
    assets,
  };
  // A re-ingested version keeps where it was published, if it was.
  const before = (await opts.store.versions(m.appleItemId)).find((x) => x.appleVersionId === v);
  await opts.store.putVersion(before?.state === "available" ? { ...version, ...before, assets: before.assets } : version);
  return {
    version,
    publish: {
      appleItemId: m.appleItemId,
      appleVersionId: v,
      bundleId: m.bundleId,
      shortVersion: m.shortVersionString,
      bundleVersion: m.bundleVersion,
      zip: zipURL,
      files,
    },
  };
}

/** Ask the App Fair Publisher workflow to attach the files to the app's release. */
export async function requestPublish(repo: string, token: string, publish: PublishRequest): Promise<void> {
  const r = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "appfair-cloud-api",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ event_type: "adp-available", client_payload: { adp: publish } }),
  });
  if (!r.ok) throw new Error(`dispatch to ${repo}: ${r.status} ${(await r.text()).slice(0, 300)}`);
}

/** An App Store Connect marketplace notification. */
export interface Notification {
  data: { type: string; id?: string; attributes?: Record<string, string> };
}

export type NotificationAction =
  | { kind: "ingest"; versionId: string }
  | { kind: "withdraw"; appleItemId: string }
  | { kind: "ignore"; reason: string };

/** What a notification asks for. It is only a hint: ingestion reads everything from the API. */
export function classify(n: Notification): NotificationAction {
  const type = n?.data?.type ?? "";
  const attrs = n?.data?.attributes ?? {};
  if (type === "AlternativeDistributionPackageVersionAvailable") {
    const versionId = attrs.alternativeDistributionPackageVersionId;
    return versionId ? { kind: "ingest", versionId } : { kind: "ignore", reason: "no package version" };
  }
  if (/Removed|TakeDown|Unavailable/.test(type)) {
    return attrs.appId ? { kind: "withdraw", appleItemId: attrs.appId } : { kind: "ignore", reason: "no appId" };
  }
  return { kind: "ignore", reason: type || "empty" };
}
