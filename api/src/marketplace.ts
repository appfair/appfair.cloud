// Copyright © The Daybrite Project
// SPDX-License-Identifier: MPL-2.0

// What the marketplace answers: install tokens for the App Fair app and its extension
// (App-Fair/docs/marketplace-server.md), and the restore and update lookups iOS makes itself
// (Apple's "Installing apps from an alternative marketplace").

import { DownloadType, installToken } from "./jwt";
import { Store, Version, buildNumber } from "./store";

export interface Signing {
  key: CryptoKey;
  keyID: string;
  marketplaceItemID: string;
}

export interface InstallTokenRequest {
  account: string;
  platform?: string;
  osVersion?: string;
  apps: {
    appleItemId: string;
    appleVersionId?: string | null;
    bundleId: string;
    alternativeDistributionPackage: string;
    update: boolean;
  }[];
}

export interface PackageAnswer {
  appleItemId: string;
  appleVersionId: string;
  alternativeDistributionPackage: string;
  installVerificationToken: string;
  appShareURL?: string;
  bundleVersion?: string;
  shortVersionString?: string;
}

export interface Failure {
  appleItemId: string;
  appleVersionId?: string;
  failure: { code: number; description: string };
}

export interface VersionsRequest {
  apps: { appleItemId: string; appleVersionId?: string }[];
  platform?: string;
  osVersion?: string;
}

export class Marketplace {
  constructor(
    private store: Store,
    private signing: Signing,
    /** `https://packages.appfair.cloud`: package folders are `<base>/<item>/` and `<base>/<item>/<version>/`. */
    private packagesBase: string,
  ) {}

  packageURL(item: string, version?: string): string {
    return version ? `${this.packagesBase}/${item}/${version}/` : `${this.packagesBase}/${item}/`;
  }

  /** The newest version iOS can install now, or nothing when there is none or the app was withdrawn. */
  async latest(item: string): Promise<Version | undefined> {
    if (await this.store.isWithdrawn(item)) return undefined;
    return (await this.store.versions(item)).find((v) => v.state === "available");
  }

  private token(v: Version, type: DownloadType): Promise<string> {
    return installToken({
      key: this.signing.key,
      keyID: this.signing.keyID,
      marketplaceItemID: this.signing.marketplaceItemID,
      bundleID: v.bundleId,
      type,
      itemID: v.appleItemId,
      versionID: v.appleVersionId,
    });
  }

  /** A token for every app the marketplace distributes; a reason, for people, for every other. */
  async installTokens(req: InstallTokenRequest) {
    const tokens: Record<string, string> = {};
    const failures: Record<string, string> = {};
    const account = (req.account ?? "").trim();
    for (const app of req.apps ?? []) {
      const id = String(app.appleItemId);
      const latest = await this.latest(id);
      if (!latest) {
        failures[id] = "App Fair does not distribute this app.";
        continue;
      }
      if (latest.bundleId !== app.bundleId) {
        failures[id] = "This listing does not match the app App Fair distributes.";
        continue;
      }
      if (!String(app.alternativeDistributionPackage).startsWith(this.packageURL(id))) {
        failures[id] = "This app's package is not distributed by App Fair.";
        continue;
      }
      const chosen =
        (app.appleVersionId &&
          (await this.store.versions(id)).find(
            (v) => v.appleVersionId === String(app.appleVersionId) && v.state === "available",
          )) ||
        latest;
      const type: DownloadType =
        app.update || !account ? "redownload" : await this.store.downloadType(account, id);
      tokens[id] = await this.token(chosen, type);
    }
    return { tokens, failures };
  }

  private unavailable(app: { appleItemId: string; appleVersionId?: string }): Failure {
    return {
      appleItemId: String(app.appleItemId),
      appleVersionId: app.appleVersionId,
      failure: { code: 404, description: "App unavailable." },
    };
  }

  private async answer(v: Version, withVersion: boolean): Promise<PackageAnswer> {
    return {
      appleItemId: v.appleItemId,
      appleVersionId: v.appleVersionId,
      alternativeDistributionPackage: this.packageURL(v.appleItemId, v.appleVersionId),
      installVerificationToken: await this.token(v, "redownload"),
      ...(withVersion ? { bundleVersion: v.bundleVersion, shortVersionString: v.shortVersion } : {}),
    };
  }

  /** The newest version of each app, for a device restoring from a backup. */
  async restore(req: VersionsRequest) {
    const restores: PackageAnswer[] = [];
    const failures: Failure[] = [];
    for (const app of req.apps ?? []) {
      const latest = await this.latest(String(app.appleItemId));
      if (latest) restores.push(await this.answer(latest, false));
      else failures.push(this.unavailable(app));
    }
    return { restores, failures };
  }

  /** Each app's newest version, when it is newer than the one installed. */
  async updates(req: VersionsRequest) {
    const updates: PackageAnswer[] = [];
    const failures: Failure[] = [];
    for (const app of req.apps ?? []) {
      const id = String(app.appleItemId);
      const latest = await this.latest(id);
      if (!latest) {
        failures.push(this.unavailable(app));
        continue;
      }
      if (app.appleVersionId === latest.appleVersionId) continue;
      const installed = (await this.store.versions(id)).find((v) => v.appleVersionId === app.appleVersionId);
      if (installed && buildNumber(installed.bundleVersion) >= buildNumber(latest.bundleVersion)) continue;
      updates.push(await this.answer(latest, true));
    }
    return { updates, failures };
  }

  /** What appfair.net's build reads to publish the static catalog. */
  async catalog() {
    return {
      packages: this.packagesBase,
      apps: (await this.store.latestAvailable()).map((v) => ({
        appleItemId: v.appleItemId,
        appleVersionId: v.appleVersionId,
        bundleId: v.bundleId,
        bundleVersion: v.bundleVersion,
        shortVersion: v.shortVersion,
        minimumSystemVersion: v.minimumSystemVersion,
        requiredDeviceCapabilities: v.requiredDeviceCapabilities,
        size: v.size,
        repo: v.repo,
        tag: v.tag,
        url: this.packageURL(v.appleItemId),
      })),
    };
  }
}
