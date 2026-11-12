-- Copyright © The Daybrite Project
-- SPDX-License-Identifier: MPL-2.0
--
-- The marketplace's state (src/store.ts).

CREATE TABLE versions (
  apple_item_id TEXT NOT NULL,
  apple_version_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  bundle_version TEXT NOT NULL,
  short_version TEXT NOT NULL,
  minimum_system_version TEXT,
  required_device_capabilities TEXT NOT NULL DEFAULT '[]',
  size INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending',
  repo TEXT,
  tag TEXT,
  created_at INTEGER NOT NULL,
  -- [{path, publicId, name, url?}]
  assets TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (apple_item_id, apple_version_id)
);

-- Apps a developer withdrew, or Apple took down.
CREATE TABLE withdrawn (
  apple_item_id TEXT PRIMARY KEY
);

-- Each variant's and delta's key blob, AES-GCM sealed with KEY_BLOB_SECRET.
CREATE TABLE key_blobs (
  apple_item_id TEXT NOT NULL,
  public_id TEXT NOT NULL,
  sealed TEXT NOT NULL,
  PRIMARY KEY (apple_item_id, public_id)
);

-- One row per account and app: the first install token is a download, the rest redownloads.
CREATE TABLE downloads (
  account TEXT NOT NULL,
  apple_item_id TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  PRIMARY KEY (account, apple_item_id)
);

-- Every license issued, so a renewal can reissue it.
CREATE TABLE licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  apple_item_id TEXT NOT NULL,
  public_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL
);
