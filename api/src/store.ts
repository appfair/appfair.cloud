// Copyright © The Daybrite Project
// SPDX-License-Identifier: MPL-2.0

// What the marketplace remembers: the apps it distributes, each version's package files and where
// the App Fair Publisher put them, key blobs (encrypted), download records, and license ids. D1 in
// production (migrations/), a Map in the tests.

export interface Asset {
  /** The path iOS asks for under the package folder: `manifest.json`, `signature`, `variant/<id>.ipa`. */
  path: string;
  /** The variant's or delta's public id; empty for manifest.json and signature. */
  publicId: string;
  /** The release asset name the Publisher uploads it as. */
  name: string;
  /** The release asset URL, once published. */
  url?: string;
}

export interface Version {
  appleItemId: string;
  appleVersionId: string;
  bundleId: string;
  bundleVersion: string;
  shortVersion: string;
  minimumSystemVersion?: string;
  requiredDeviceCapabilities: string[];
  size: number;
  /** `pending` until the Publisher has attached every file to the app's release. */
  state: "pending" | "available";
  repo?: string;
  tag?: string;
  createdAt: number;
  assets: Asset[];
}

export interface Store {
  /** Every version of `item`, newest build first. */
  versions(item: string): Promise<Version[]>;
  /** The newest available version of each app. */
  latestAvailable(): Promise<Version[]>;
  putVersion(v: Version): Promise<void>;
  /** Record where the Publisher put a version's files, and make it available. */
  publish(item: string, version: string, repo: string, tag: string, urls: Record<string, string>): Promise<boolean>;
  setWithdrawn(item: string, withdrawn: boolean): Promise<void>;
  isWithdrawn(item: string): Promise<boolean>;
  /** The encrypted key blob for a variant or delta. */
  keyBlob(item: string, publicId: string): Promise<string | undefined>;
  putKeyBlob(item: string, publicId: string, sealed: string): Promise<void>;
  /** `download` the first time `account` gets `item`; records it. */
  downloadType(account: string, item: string): Promise<"download" | "redownload">;
  /** A fresh license id, remembered with what it licenses. */
  issueLicense(item: string, publicId: string): Promise<number>;
  license(id: number): Promise<{ item: string; publicId: string } | undefined>;
}

export function buildNumber(s: string): number {
  const m = /^\d+/.exec(s.trim());
  return m ? Number(m[0]) : 0;
}

export function newestFirst(a: Version, b: Version): number {
  return buildNumber(b.bundleVersion) - buildNumber(a.bundleVersion) || b.createdAt - a.createdAt;
}

export class D1Store implements Store {
  constructor(private db: D1Database) {}

  private static row(r: any): Version {
    return {
      appleItemId: r.apple_item_id,
      appleVersionId: r.apple_version_id,
      bundleId: r.bundle_id,
      bundleVersion: r.bundle_version,
      shortVersion: r.short_version,
      minimumSystemVersion: r.minimum_system_version ?? undefined,
      requiredDeviceCapabilities: JSON.parse(r.required_device_capabilities || "[]"),
      size: r.size,
      state: r.state,
      repo: r.repo ?? undefined,
      tag: r.tag ?? undefined,
      createdAt: r.created_at,
      assets: JSON.parse(r.assets || "[]"),
    };
  }

  async versions(item: string) {
    const { results } = await this.db.prepare("SELECT * FROM versions WHERE apple_item_id = ?").bind(item).all();
    return results.map(D1Store.row).sort(newestFirst);
  }

  async latestAvailable() {
    const { results } = await this.db
      .prepare(
        "SELECT v.* FROM versions v WHERE v.state = 'available' AND v.apple_item_id NOT IN " +
          "(SELECT apple_item_id FROM withdrawn)",
      )
      .all();
    const best = new Map<string, Version>();
    for (const v of results.map(D1Store.row)) {
      const have = best.get(v.appleItemId);
      if (!have || newestFirst(v, have) < 0) best.set(v.appleItemId, v);
    }
    return [...best.values()].sort((a, b) => a.appleItemId.localeCompare(b.appleItemId));
  }

  async putVersion(v: Version) {
    await this.db
      .prepare(
        "INSERT OR REPLACE INTO versions (apple_item_id, apple_version_id, bundle_id, bundle_version, " +
          "short_version, minimum_system_version, required_device_capabilities, size, state, repo, tag, " +
          "created_at, assets) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        v.appleItemId, v.appleVersionId, v.bundleId, v.bundleVersion, v.shortVersion,
        v.minimumSystemVersion ?? null, JSON.stringify(v.requiredDeviceCapabilities), v.size, v.state,
        v.repo ?? null, v.tag ?? null, v.createdAt, JSON.stringify(v.assets),
      )
      .run();
  }

  async publish(item: string, version: string, repo: string, tag: string, urls: Record<string, string>) {
    const v = (await this.versions(item)).find((x) => x.appleVersionId === version);
    if (!v) return false;
    const assets = v.assets.map((a) => ({ ...a, url: urls[a.path] ?? a.url }));
    if (assets.some((a) => !a.url)) return false;
    await this.putVersion({ ...v, assets, repo, tag, state: "available" });
    return true;
  }

  async setWithdrawn(item: string, withdrawn: boolean) {
    await this.db
      .prepare(withdrawn ? "INSERT OR IGNORE INTO withdrawn (apple_item_id) VALUES (?)" : "DELETE FROM withdrawn WHERE apple_item_id = ?")
      .bind(item)
      .run();
  }

  async isWithdrawn(item: string) {
    return !!(await this.db.prepare("SELECT 1 FROM withdrawn WHERE apple_item_id = ?").bind(item).first());
  }

  async keyBlob(item: string, publicId: string) {
    const r = await this.db
      .prepare("SELECT sealed FROM key_blobs WHERE apple_item_id = ? AND public_id = ?")
      .bind(item, publicId)
      .first<{ sealed: string }>();
    return r?.sealed;
  }

  async putKeyBlob(item: string, publicId: string, sealed: string) {
    await this.db
      .prepare("INSERT OR REPLACE INTO key_blobs (apple_item_id, public_id, sealed) VALUES (?, ?, ?)")
      .bind(item, publicId, sealed)
      .run();
  }

  async downloadType(account: string, item: string) {
    const r = await this.db
      .prepare("INSERT OR IGNORE INTO downloads (account, apple_item_id, first_at) VALUES (?, ?, ?)")
      .bind(account, item, Date.now())
      .run();
    return r.meta.changes > 0 ? "download" : "redownload";
  }

  async issueLicense(item: string, publicId: string) {
    const r = await this.db
      .prepare("INSERT INTO licenses (apple_item_id, public_id, issued_at) VALUES (?, ?, ?) RETURNING id")
      .bind(item, publicId, Date.now())
      .first<{ id: number }>();
    return r!.id;
  }

  async license(id: number) {
    const r = await this.db
      .prepare("SELECT apple_item_id, public_id FROM licenses WHERE id = ?")
      .bind(id)
      .first<{ apple_item_id: string; public_id: string }>();
    return r ? { item: r.apple_item_id, publicId: r.public_id } : undefined;
  }
}

/** The tests' store. */
export class MemoryStore implements Store {
  v = new Map<string, Version>();
  withdrawn = new Set<string>();
  blobs = new Map<string, string>();
  downloads = new Set<string>();
  licenses: { item: string; publicId: string }[] = [];

  async versions(item: string) {
    return [...this.v.values()].filter((x) => x.appleItemId === item).sort(newestFirst);
  }
  async latestAvailable() {
    const best = new Map<string, Version>();
    for (const x of this.v.values()) {
      if (x.state !== "available" || this.withdrawn.has(x.appleItemId)) continue;
      const have = best.get(x.appleItemId);
      if (!have || newestFirst(x, have) < 0) best.set(x.appleItemId, x);
    }
    return [...best.values()];
  }
  async putVersion(x: Version) {
    this.v.set(`${x.appleItemId}/${x.appleVersionId}`, structuredClone(x));
  }
  async publish(item: string, version: string, repo: string, tag: string, urls: Record<string, string>) {
    const x = this.v.get(`${item}/${version}`);
    if (!x) return false;
    const assets = x.assets.map((a) => ({ ...a, url: urls[a.path] ?? a.url }));
    if (assets.some((a) => !a.url)) return false;
    this.v.set(`${item}/${version}`, { ...x, assets, repo, tag, state: "available" });
    return true;
  }
  async setWithdrawn(item: string, w: boolean) {
    if (w) this.withdrawn.add(item);
    else this.withdrawn.delete(item);
  }
  async isWithdrawn(item: string) {
    return this.withdrawn.has(item);
  }
  async keyBlob(item: string, publicId: string) {
    return this.blobs.get(`${item}/${publicId}`);
  }
  async putKeyBlob(item: string, publicId: string, sealed: string) {
    this.blobs.set(`${item}/${publicId}`, sealed);
  }
  async downloadType(account: string, item: string) {
    const k = `${account}|${item}`;
    if (this.downloads.has(k)) return "redownload" as const;
    this.downloads.add(k);
    return "download" as const;
  }
  async issueLicense(item: string, publicId: string) {
    this.licenses.push({ item, publicId });
    return this.licenses.length;
  }
  async license(id: number) {
    return this.licenses[id - 1];
  }
}
