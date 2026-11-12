// Copyright © The Daybrite Project
// SPDX-License-Identifier: MPL-2.0

// App Fair's alternative app marketplace on Cloudflare Workers (README.md). Three hosts:
//
//   appfair.cloud          /.well-known/marketplace-kit: iOS's directory of the endpoints below
//   api.appfair.cloud      POST /v1/install-tokens           the App Fair app and its extension
//                          POST /v1/restore, /v1/updates     iOS
//                          POST /v1/license, /v1/license/renew   iOS, through the license container
//                          POST /v1/notifications            App Store Connect's marketplace webhook
//                          POST /v1/published                the App Fair Publisher, when files are attached
//                          GET  /v1/catalog                  appfair.net's build, for the static catalog
//   packages.appfair.cloud /<item>/[<version>/]<path>        redirects to the app's GitHub release assets
//
// Everything static (the catalog, the license certificates, the license-resolution page) is on
// appfair.net (GitHub Pages).

import { Container, getRandom } from "@cloudflare/containers";
import { AppStoreConnectAPI, classify, ingestVersion, requestPublish } from "./ingest";
import { appStoreConnectToken, importP256, verifyAppleSignature, verifyGitHubOIDC } from "./jwt";
import { issue, LicenseService, renew } from "./license";
import { Marketplace } from "./marketplace";
import { servePackage } from "./packages";
import { D1Store, Store } from "./store";

export interface Env {
  DB: D1Database;
  /** The license container; absent until its image is deployed (wrangler.toml). */
  LICENSE?: DurableObjectNamespace<LicenseContainer>;

  // Plain configuration (wrangler.toml [vars]).
  MARKETPLACE_APPLE_ITEM_ID: string;
  DISTRIBUTION_KEY_ID: string;
  ASC_KEY_ID: string;
  ASC_ISSUER_ID: string;
  API_BASE: string;
  PACKAGES_BASE: string;
  STATIC_BASE: string;
  PUBLISHER_REPO: string;
  CATALOG_REPO: string;
  OIDC_AUDIENCE: string;
  DOWNLOADS: string;

  // Secrets (wrangler secret put).
  DISTRIBUTION_KEY: string;
  ASC_KEY: string;
  KEY_BLOB_SECRET: string;
  GITHUB_DISPATCH_TOKEN: string;
  /** The secret registered with App Store Connect's marketplace webhook. */
  MARKETPLACE_WEBHOOK_SECRET: string;
  ALD_SIGNING_CERT: string;
  ALD_SIGNING_KEY: string;
  ALD_ENCRYPTION_CERT: string;
  ALD_ENCRYPTION_KEY: string;
  ALD_PASK: string;
}

/** The Swift license service (../license/), one container image, started on demand. */
export class LicenseContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    // The App License Delivery assets reach the container as environment variables, base64.
    this.envVars = {
      ALD_SIGNING_CERT: env.ALD_SIGNING_CERT,
      ALD_SIGNING_KEY: env.ALD_SIGNING_KEY,
      ALD_ENCRYPTION_CERT: env.ALD_ENCRYPTION_CERT,
      ALD_ENCRYPTION_KEY: env.ALD_ENCRYPTION_KEY,
      ALD_PASK: env.ALD_PASK,
    };
  }
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

function fail(status: number, message: string): Response {
  return json({ error: message }, status);
}

/** The `.well-known/marketplace-kit` file. */
export function marketplaceKit(env: Pick<Env, "API_BASE" | "STATIC_BASE">) {
  return {
    license: {
      dynamicLicenseURL: `${env.API_BASE}/v1/license`,
      licenseRenewalURL: `${env.API_BASE}/v1/license/renew`,
      licenseResolutionURL: `${env.STATIC_BASE}/license-resolution/`,
      signingCertificateURL: `${env.STATIC_BASE}/certs/signing.cer`,
      encryptionCertificateURL: `${env.STATIC_BASE}/certs/encryption.cer`,
    },
    restore: `${env.API_BASE}/v1/restore`,
    updates: { url: `${env.API_BASE}/v1/updates`, pollingInterval: 24 },
  };
}

async function marketplace(env: Env, store: Store): Promise<Marketplace> {
  return new Marketplace(
    store,
    {
      key: await importP256(env.DISTRIBUTION_KEY),
      keyID: env.DISTRIBUTION_KEY_ID,
      marketplaceItemID: env.MARKETPLACE_APPLE_ITEM_ID,
    },
    env.PACKAGES_BASE,
  );
}

function licenseService(env: Env): LicenseService {
  return {
    async fetch(path, body) {
      const container = await getRandom(env.LICENSE!, 2);
      return container.fetch(
        new Request(`http://license${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    },
  };
}

function appStoreConnect(env: Env) {
  let key: Promise<CryptoKey> | undefined;
  return new AppStoreConnectAPI(async () => {
    key ??= importP256(env.ASC_KEY);
    return appStoreConnectToken(await key, env.ASC_KEY_ID, env.ASC_ISSUER_ID || undefined);
  });
}

/** Ingest a notified version and hand its files to the App Fair Publisher. */
async function ingestAndPublish(env: Env, store: Store, versionId: string): Promise<string> {
  const { publish } = await ingestVersion({
    asc: appStoreConnect(env),
    store,
    keyBlobSecret: env.KEY_BLOB_SECRET,
    versionId,
  });
  await requestPublish(env.PUBLISHER_REPO, env.GITHUB_DISPATCH_TOKEN, publish);
  return `${publish.bundleId} ${publish.shortVersion} (${publish.bundleVersion}) sent to ${env.PUBLISHER_REPO}`;
}

async function readJSON(request: Request): Promise<any> {
  if ((Number(request.headers.get("content-length")) || 0) > 1_000_000) throw new Error("too large");
  return request.json();
}

export async function handle(request: Request, env: Env, ctx: ExecutionContext, store: Store): Promise<Response> {
  const url = new URL(request.url);
  const host = url.hostname;
  const path = url.pathname;

  if (path === "/.well-known/marketplace-kit") {
    // The marketplace domain's directory; no redirects, per Apple.
    return json(marketplaceKit(env), 200, { "Cache-Control": "public, max-age=300" });
  }
  if (host.startsWith("packages.")) return servePackage(store, request, env.DOWNLOADS);
  if (path.startsWith("/packages/")) {
    // The same, on any host, for local development.
    const local = new Request(new URL(path.slice("/packages".length), url), request);
    return servePackage(store, local, env.DOWNLOADS);
  }

  if (request.method === "GET" && path === "/health") return json({ ok: true });
  if (request.method === "GET" && path === "/v1/catalog") {
    return json(await (await marketplace(env, store)).catalog(), 200, { "Cache-Control": "public, max-age=60" });
  }
  if (request.method !== "POST") return fail(404, "not found");

  try {
    switch (path) {
      case "/v1/install-tokens":
        return json(await (await marketplace(env, store)).installTokens(await readJSON(request)));
      case "/v1/restore":
        return json(await (await marketplace(env, store)).restore(await readJSON(request)));
      case "/v1/updates":
        return json(await (await marketplace(env, store)).updates(await readJSON(request)));
      case "/v1/license":
        if (!env.LICENSE) return fail(503, "licensing is not deployed yet");
        return issue(store, licenseService(env), env.KEY_BLOB_SECRET, await readJSON(request));
      case "/v1/license/renew":
        if (!env.LICENSE) return fail(503, "licensing is not deployed yet");
        return renew(store, licenseService(env), env.KEY_BLOB_SECRET, await readJSON(request));
      case "/v1/notifications": {
        // Signed by App Store Connect; and even then only a hint, since everything ingested is read
        // back from the App Store Connect API.
        const raw = await request.text();
        if (!(await verifyAppleSignature(env.MARKETPLACE_WEBHOOK_SECRET, raw, request.headers.get("x-apple-signature")))) {
          return fail(401, "bad signature");
        }
        const action = classify(JSON.parse(raw));
        if (action.kind === "ingest") {
          ctx.waitUntil(
            ingestAndPublish(env, store, action.versionId).then(
              (msg) => console.log(`notification: ${msg}`),
              (e) => console.error(`notification ${action.versionId}: ${e}`),
            ),
          );
        } else if (action.kind === "withdraw") {
          await store.setWithdrawn(action.appleItemId, true);
        }
        return new Response(null, { status: 202 });
      }
      case "/v1/published": {
        // The App Fair Publisher (appfair/appfair-apps, adp.yml) attached a version's files to the
        // app's release. Only that repository's workflows can say so.
        const auth = request.headers.get("authorization") ?? "";
        await verifyGitHubOIDC(auth.replace(/^Bearer\s+/i, ""), {
          audience: env.OIDC_AUDIENCE,
          repository: env.PUBLISHER_REPO,
        });
        const body = await readJSON(request);
        const urls: Record<string, string> = {};
        const versions = await store.versions(String(body.appleItemId));
        const v = versions.find((x) => x.appleVersionId === String(body.appleVersionId));
        if (!v) return fail(404, "unknown version");
        for (const a of v.assets) {
          urls[a.path] = `https://github.com/${body.repo}/releases/download/${encodeURIComponent(body.tag)}/${encodeURIComponent(a.name)}`;
        }
        const ok = await store.publish(v.appleItemId, v.appleVersionId, body.repo, body.tag, urls);
        if (!ok) return fail(409, "the version's files are not all accounted for");
        ctx.waitUntil(
          requestPublishCatalog(env).catch((e) => console.error(`catalog rebuild: ${e}`)),
        );
        return json({ available: true });
      }
      case "/v1/ingest": {
        // Ingest by hand (a version notarized before the webhook existed): the Publisher's OIDC
        // token or nothing.
        const auth = request.headers.get("authorization") ?? "";
        await verifyGitHubOIDC(auth.replace(/^Bearer\s+/i, ""), {
          audience: env.OIDC_AUDIENCE,
          repository: env.PUBLISHER_REPO,
        });
        const body = await readJSON(request);
        return json({ queued: await ingestAndPublish(env, store, String(body.alternativeDistributionPackageVersionId)) });
      }
      default:
        return fail(404, "not found");
    }
  } catch (e) {
    console.error(`${path}: ${e}`);
    return fail(400, String(e instanceof Error ? e.message : e));
  }
}

/** Ask appfair.net to rebuild, so its static catalog lists the new version. */
async function requestPublishCatalog(env: Env): Promise<void> {
  const r = await fetch(`https://api.github.com/repos/${env.CATALOG_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "appfair-cloud-api",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ event_type: "marketplace-updated" }),
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(request, env, ctx, new D1Store(env.DB));
  },
} satisfies ExportedHandler<Env>;
