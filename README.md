# appfair.cloud

The dynamic half of App Fair's iOS alternative app marketplace, on Cloudflare. The static half (the
App Index catalog, the App License Delivery certificates, the license-resolution page) is served
from appfair.net (GitHub Pages, `appfair/appfair.net`). Package files are never stored here: each
version's alternative distribution package is attached to the app's own GitHub release by the
App Fair Publisher (`appfair/appfair-apps`), and `packages.appfair.cloud` redirects to it.

| Folder | What | Where it runs |
|---|---|---|
| `api/` | The Worker: `/.well-known/marketplace-kit`, install tokens, restore and updates, the App Store Connect webhook and ingestion, the Publisher's callback, the package redirector, the catalog feed | `appfair.cloud`, `api.appfair.cloud`, `packages.appfair.cloud` |
| `license/` | The license service: Apple's App License Delivery SDK, which is native code and so cannot run in a Worker | a Cloudflare Container behind the Worker's `LICENSE` binding |

The contract the App Fair app relies on is `App-Fair/docs/marketplace-server.md`.

## How a version reaches devices

1. A developer distributing through App Fair submits a version for notarization. App Store Connect
   posts `AlternativeDistributionPackageVersionAvailable` to `api.appfair.cloud/v1/notifications`.
2. The Worker reads the version from the App Store Connect API: the package zip (manifest and
   signature) and each variant's and delta's download URL and key blob. It keeps the key blobs in
   D1, sealed with `KEY_BLOB_SECRET`, and records the version as pending.
3. It sends `repository_dispatch` (`adp-available`) to `appfair/appfair-apps`, whose `adp.yml`
   attaches the files to the app's release as `x-adp-<appleVersionId>-<path>` with the App Fair
   Publisher's token, and calls back `POST /v1/published` with a GitHub OIDC token.
4. The Worker marks the version available and asks `appfair/appfair.net` to rebuild
   (`marketplace-updated`), so the static catalog lists it.
5. On a device, App Fair asks `/v1/install-tokens`. iOS then asks `/v1/license` (through the
   license container) and downloads from `packages.appfair.cloud`, which redirects to the
   release assets. `DOWNLOADS = "stream"` passes the bytes through instead, should iOS refuse a
   redirect to another domain.

## Setup

```sh
cd api && npm install
npx wrangler login
npx wrangler d1 create appfair-marketplace      # put the id in wrangler.toml
npm run db:migrate
```

Secrets (`npx wrangler secret put <NAME>`, from `api/`):

| Secret | Value |
|---|---|
| `DISTRIBUTION_KEY` | the alternative distribution private key as PKCS#8: `openssl pkcs8 -topk8 -nocrypt -in private_key.pem` (the key App Store Connect knows as `b3818104-…`) |
| `ASC_KEY` | the App Store Connect API key `.p8` the Worker ingests with (`ASC_KEY_ID` in wrangler.toml) |
| `KEY_BLOB_SECRET` | `openssl rand -base64 32` |
| `GITHUB_DISPATCH_TOKEN` | a fine-grained token that can send `repository_dispatch` to `appfair/appfair-apps` and `appfair/appfair.net` (Contents: write on those two repositories), from the `appfairz` account |
| `MARKETPLACE_WEBHOOK_SECRET` | the secret registered with App Store Connect's marketplace webhook (`openssl rand -hex 32`) |
| `ALD_SIGNING_CERT`, `ALD_SIGNING_KEY`, `ALD_ENCRYPTION_CERT`, `ALD_ENCRYPTION_KEY`, `ALD_PASK` | `base64 -i <file>` of each App License Delivery file (`appfair/marketplace/certificate/ALD/`) |

The license service needs Apple's SDK in `license/vendor/aldsdk`:
`license/scripts/setup-ald-sdk.sh ~/Downloads/aldsdk1.0.1.tgz`, from
<https://developer.apple.com/download/all/?q=license%20delivery>. It is not redistributable, so
it is git-ignored.

`license/scripts/build-linux.sh` then cross-compiles the service into `license/dist/`: a static
x86_64 Linux binary, built natively with Swift's Static Linux SDK (the script lists the toolchain
it needs), so Apple silicon needs no x86_64 emulation. The image only wraps that binary.

Then `npm run deploy` from `api/` (with Docker running: `. ./docker-env.sh` for Colima) builds
the image, pushes it to Cloudflare's registry, deploys the Worker, and attaches the three
hostnames. Containers need the Workers Paid plan and a workers.dev subdomain on the account
(opening Workers & Pages in the dashboard once creates it); the Worker itself is not on it.

## App Store Connect

- Alternative distribution keys (2026-11-12), both holding the same public key:
  `b3818104-a7f6-4bd7-8af0-ee63bad3e348`, linked to the App Fair app record (6480579814), which
  install tokens name as their `kid`; and the team key `ba9a5fd2-94f5-413d-803d-06e95c6b49d3`,
  which App Store Connect requires before it registers a domain.
- Marketplace domain: `appfair.cloud` (`c3984703-566f-4632-ace0-1f394fd6912b`, 2026-11-12).
  Domains and keys need an **Admin** API key; App Manager is refused.
- Marketplace connection: App Fair Project's apps Net Skip, Fleet Reader, Games Fair, and Stanza
  Redux list App Fair as a marketplace, with notifications on.
- Marketplace webhook: `https://api.appfair.cloud/v1/notifications`
  (`e4cce735-771f-43d9-82fa-d9a21d1df43d`, 2026-11-12), signed with `MARKETPLACE_WEBHOOK_SECRET`
  (`x-apple-signature: hmacsha256=…`); the Worker refuses anything unsigned.

## Deployed (2026-11-12)

- Worker `appfair-cloud-api` on `appfair.cloud`, `api.appfair.cloud`, `packages.appfair.cloud`
  (Cloudflare account `cloudflare@appfair.org`).
- D1 `appfair-marketplace` (`47bc3fd1-5f06-43de-a815-b0db241ff202`), migration 0001 applied.
- Secrets set: `DISTRIBUTION_KEY`, `ASC_KEY`, `KEY_BLOB_SECRET`, `GITHUB_DISPATCH_TOKEN`,
  `MARKETPLACE_WEBHOOK_SECRET`, and the five `ALD_*`. Backups of the generated ones are beside the
  private key in `appfair/marketplace/certificate/alternative-distribution/`.
- License container `appfair-cloud-api-licensecontainer` (application
  `a030aa32-6f92-4884-8bda-d8c7794308f0`), on the Workers Paid plan.
- App License Delivery certificates reissued 2026-11-12, valid to 2027-12-12 (renew before then):
  `appfair/marketplace/certificate/ALD/2026-11-12/`, published at
  `https://appfair.net/marketplace/certs/`.

## Tests

```sh
cd api && npm test && npm run check                     # the Worker
cd license && swift test -Xbuild-tools-swiftc -Dmacos_TRIPLE   # the license service
```
