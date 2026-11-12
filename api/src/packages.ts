// Copyright © The Daybrite Project
// SPDX-License-Identifier: MPL-2.0

// packages.appfair.cloud: where iOS downloads a package from, because a package must come from the
// marketplace's registered domain. Nothing is stored here: each file is the app's own GitHub
// release asset, which the App Fair Publisher attached, and the answer is a redirect to it, or the
// bytes streamed through when DOWNLOADS is `stream` (should iOS refuse to follow a redirect to
// another domain).
//
//   /<appleItemId>/<appleVersionId>/<path>   one version's file
//   /<appleItemId>/<path>                    the newest version's file

import { Store } from "./store";

/** The release asset URL for a package path, or nothing. */
export async function resolvePackage(store: Store, pathname: string): Promise<string | undefined> {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2 || parts.some((p) => p === "." || p === ".." || p.includes("/"))) return undefined;
  const [item, ...rest] = parts;
  if (await store.isWithdrawn(item)) return undefined;
  const versions = (await store.versions(item)).filter((v) => v.state === "available");
  if (versions.length === 0) return undefined;
  const pinned = versions.find((v) => v.appleVersionId === rest[0]);
  const version = pinned ?? versions[0];
  const file = (pinned ? rest.slice(1) : rest).join("/");
  return version.assets.find((a) => a.path === file)?.url;
}

export async function servePackage(
  store: Store,
  request: Request,
  mode: string | undefined,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }
  const target = await resolvePackage(store, new URL(request.url).pathname);
  if (!target) return new Response("not found", { status: 404 });
  if (mode !== "stream") {
    return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "public, max-age=300" } });
  }
  // Follow GitHub's own redirect to its CDN and pass the bytes (and range requests) through.
  const headers = new Headers();
  for (const h of ["range", "if-none-match", "if-modified-since"]) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  const upstream = await fetch(target, { method: request.method, headers, redirect: "follow" });
  const out = new Headers();
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
