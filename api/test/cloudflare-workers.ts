// Copyright © The Daybrite Project
// SPDX-License-Identifier: MPL-2.0

// `cloudflare:workers` exists only inside the Workers runtime; the unit tests run in Node and never
// start a container, so the classes the Containers package extends only have to exist.
export class DurableObject {
  constructor(
    public ctx: unknown,
    public env: unknown,
  ) {}
}
export class WorkerEntrypoint {
  constructor(
    public ctx: unknown,
    public env: unknown,
  ) {}
}
export const env = {};
