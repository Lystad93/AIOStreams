import type { Migration } from './types.js';

/**
 * Configurations saved against a signed-in account.
 *
 * `owner` is the session username, which is safe as a key because a colliding
 * OIDC login is refused unless `linkByUsername` is on.
 *
 * `encrypted_password` is the same blob that already sits in every install
 * URL, so a stolen database alone opens nothing.
 */
export const configProfiles: Migration = {
  id: 19,
  name: 'config_profiles',
  up: {
    sqlite: `
      CREATE TABLE IF NOT EXISTS config_profiles (
        id                 TEXT PRIMARY KEY,
        owner              TEXT NOT NULL,
        uuid               TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        encrypted_password TEXT NOT NULL,
        label              TEXT NOT NULL,
        alias              TEXT,
        broken_at          INTEGER,
        last_opened_at     INTEGER,
        created_at         INTEGER NOT NULL DEFAULT 0,
        updated_at         INTEGER NOT NULL DEFAULT 0,
        CHECK (length(owner) BETWEEN 1 AND 255),
        CHECK (length(label) BETWEEN 1 AND 64 AND trim(label) = label),
        CHECK (alias IS NULL OR (length(alias) BETWEEN 2 AND 64 AND trim(alias) = alias))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_config_profiles_owner_uuid
        ON config_profiles (owner, uuid);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_config_profiles_owner_label
        ON config_profiles (owner, label);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_config_profiles_alias
        ON config_profiles (alias) WHERE alias IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_config_profiles_uuid
        ON config_profiles (uuid);
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS config_profiles (
        id                 TEXT PRIMARY KEY,
        owner              TEXT NOT NULL,
        uuid               TEXT NOT NULL REFERENCES users(uuid) ON DELETE CASCADE,
        encrypted_password TEXT NOT NULL,
        label              TEXT NOT NULL,
        alias              TEXT,
        broken_at          BIGINT,
        last_opened_at     BIGINT,
        created_at         BIGINT NOT NULL DEFAULT 0,
        updated_at         BIGINT NOT NULL DEFAULT 0,
        CHECK (length(owner) BETWEEN 1 AND 255),
        CHECK (length(label) BETWEEN 1 AND 64 AND trim(label) = label),
        CHECK (alias IS NULL OR (length(alias) BETWEEN 2 AND 64 AND trim(alias) = alias))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_config_profiles_owner_uuid
        ON config_profiles (owner, uuid);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_config_profiles_owner_label
        ON config_profiles (owner, label);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_config_profiles_alias
        ON config_profiles (alias) WHERE alias IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_config_profiles_uuid
        ON config_profiles (uuid);
    `,
  },
};
