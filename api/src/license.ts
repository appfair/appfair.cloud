// Copyright © The Daybrite Project
// SPDX-License-Identifier: MPL-2.0

// Licenses (Apple's "Licensing alternative distribution apps"). The App License Delivery SDK is a
// native library, so licensing runs in the license container (../license/), a Swift service the
// Worker calls through its binding. The container keeps nothing: the Worker hands it, per request,
// the key blobs of the variants iOS asked for and the license ids to issue them under.

import { toBase64 } from "./jwt";
import { unseal } from "./seal";
import { Store } from "./store";

export interface LicenseService {
  fetch(path: string, body: unknown): Promise<Response>;
}

interface LicenseRequest {
  licenseRequest: string;
  licenseKey: string;
  appsById: Record<string, { appleVersionId?: string; appleVersionID?: string; assetPublicId: string }>;
}

interface RenewalRequest {
  renewalRequest: string;
  licenseKey: string;
}

/** A license for each requested app the marketplace has the variant's key for. */
export async function issue(
  store: Store,
  service: LicenseService,
  secret: string,
  req: LicenseRequest,
): Promise<Response> {
  const keys: Record<string, { blob: string; licenseId: number }> = {};
  for (const [item, asset] of Object.entries(req.appsById ?? {})) {
    if (await store.isWithdrawn(item)) continue;
    const sealed = await store.keyBlob(item, asset.assetPublicId);
    if (!sealed) continue;
    keys[item] = {
      blob: toBase64(await unseal(secret, sealed)),
      licenseId: await store.issueLicense(item, asset.assetPublicId),
    };
  }
  const r = await service.fetch("/issue", { ...req, keys });
  return new Response(r.body, { status: r.status, headers: { "Content-Type": "application/json" } });
}

/** Reissue the licenses the marketplace issued and still stands behind. */
export async function renew(
  store: Store,
  service: LicenseService,
  secret: string,
  req: RenewalRequest,
): Promise<Response> {
  // The license ids are inside the encrypted request: the container reads them first.
  const ids = (await (await service.fetch("/renewal-ids", req)).json()) as { licenseIds?: number[] };
  const keys: Record<string, { item: string; blob: string }> = {};
  for (const id of ids.licenseIds ?? []) {
    const record = await store.license(id);
    if (!record || (await store.isWithdrawn(record.item))) continue;
    const sealed = await store.keyBlob(record.item, record.publicId);
    if (!sealed) continue;
    keys[String(id)] = { item: record.item, blob: toBase64(await unseal(secret, sealed)) };
  }
  const r = await service.fetch("/renew", { ...req, keys });
  return new Response(r.body, { status: r.status, headers: { "Content-Type": "application/json" } });
}
