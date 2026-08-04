import { config as appConfig } from '../../config/index.js';
import { isConfigUuid } from '../../utils/config-alias.js';
import { generateUUID } from '../../utils/crypto.js';
import { getDb } from '../db.js';
import type { DbDriver } from '../driver/types.js';
import { join, raw, sql, SqlFragment } from '../sql.js';

export const MAX_PROFILES_PER_OWNER = 50;

/** Bounds how stale an alias can be on a replica that did not write it. */
const ALIAS_TTL_MS = 15_000;

/** Keeps one pathological table from stalling the request that refreshes. */
const ALIAS_LIMIT = 5000;

/** Never carries the password blob. */
export interface ConfigProfile {
  id: string;
  uuid: string;
  label: string;
  alias: string | null;
  /** The stored password no longer opens the configuration. */
  needsRelink: boolean;
  lastOpenedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConfigAliasTarget {
  uuid: string;
  encryptedPassword: string;
}

interface ConfigProfileDbRow {
  id: string;
  owner: string;
  uuid: string;
  encrypted_password: string;
  label: string;
  alias: string | null;
  broken_at: number | string | null;
  last_opened_at: number | string | null;
  created_at: number | string;
  updated_at: number | string;
  [k: string]: unknown;
}

const COLUMNS =
  'id, owner, uuid, label, alias, broken_at, last_opened_at, created_at, updated_at';

function optionalNumber(v: number | string | null): number | undefined {
  return v == null ? undefined : Number(v);
}

function toProfile(r: ConfigProfileDbRow): ConfigProfile {
  return {
    id: r.id,
    uuid: r.uuid,
    label: r.label,
    alias: r.alias,
    needsRelink: r.broken_at != null,
    lastOpenedAt: optionalNumber(r.last_opened_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export class ConfigProfileRepository {
  private static aliases: {
    value: Map<string, ConfigAliasTarget>;
    at: number;
  } | null = null;

  private static invalidateAliases(): void {
    this.aliases = null;
  }

  static async list(owner: string): Promise<ConfigProfile[]> {
    const rows = await getDb().query<ConfigProfileDbRow>(
      sql`SELECT ${raw(COLUMNS)} FROM config_profiles
           WHERE owner = ${owner}
           ORDER BY COALESCE(last_opened_at, 0) DESC, created_at DESC`
    );
    return rows.map(toProfile);
  }

  static async get(owner: string, id: string): Promise<ConfigProfile | null> {
    const row = await getDb().maybeOne<ConfigProfileDbRow>(
      sql`SELECT ${raw(COLUMNS)} FROM config_profiles
           WHERE owner = ${owner} AND id = ${id}`
    );
    return row ? toProfile(row) : null;
  }

  static async countForOwner(owner: string): Promise<number> {
    return getDb().count(
      sql`SELECT COUNT(*) FROM config_profiles WHERE owner = ${owner}`
    );
  }

  static async labelTaken(
    owner: string,
    label: string,
    exceptId?: string
  ): Promise<boolean> {
    const scope = exceptId ? sql` AND id <> ${exceptId}` : sql``;
    const count = await getDb().count(
      sql`SELECT COUNT(*) FROM config_profiles
           WHERE owner = ${owner} AND label = ${label}${scope}`
    );
    return count > 0;
  }

  static async aliasTaken(alias: string, exceptId?: string): Promise<boolean> {
    const scope = exceptId ? sql` AND id <> ${exceptId}` : sql``;
    const count = await getDb().count(
      sql`SELECT COUNT(*) FROM config_profiles
           WHERE alias = ${alias}${scope}`
    );
    return count > 0;
  }

  /** Re-saving the same uuid refreshes the blob and clears any broken mark. */
  static async save(
    owner: string,
    input: { uuid: string; encryptedPassword: string; label: string }
  ): Promise<ConfigProfile> {
    const now = Date.now();
    const db = getDb();
    await db.exec(
      sql`INSERT INTO config_profiles
            (id, owner, uuid, encrypted_password, label, created_at, updated_at)
          VALUES
            (${generateUUID()}, ${owner}, ${input.uuid},
             ${input.encryptedPassword}, ${input.label}, ${now}, ${now})
          ON CONFLICT(owner, uuid) DO UPDATE SET
            encrypted_password = EXCLUDED.encrypted_password,
            label = EXCLUDED.label,
            broken_at = NULL,
            updated_at = EXCLUDED.updated_at`
    );
    this.invalidateAliases();
    const row = await db.maybeOne<ConfigProfileDbRow>(
      sql`SELECT ${raw(COLUMNS)} FROM config_profiles
           WHERE owner = ${owner} AND uuid = ${input.uuid}`
    );
    // The insert above just guaranteed the row.
    return toProfile(row as ConfigProfileDbRow);
  }

  /** An absent `alias` key leaves it alone; `null` clears it. */
  static async update(
    owner: string,
    id: string,
    fields: { label?: string; alias?: string | null }
  ): Promise<ConfigProfile | null> {
    const sets: SqlFragment[] = [sql`updated_at = ${Date.now()}`];
    if (fields.label !== undefined) {
      sets.push(sql`label = ${fields.label}`);
    }
    if ('alias' in fields) {
      sets.push(sql`alias = ${fields.alias ?? null}`);
    }
    const res = await getDb().exec(
      sql`UPDATE config_profiles SET ${join(sets)}
           WHERE owner = ${owner} AND id = ${id}`
    );
    if ((res.rowCount ?? 0) === 0) {
      return null;
    }
    this.invalidateAliases();
    return this.get(owner, id);
  }

  /** Unlinks the saved configuration. The configuration itself is untouched. */
  static async remove(owner: string, id: string): Promise<boolean> {
    const res = await getDb().exec(
      sql`DELETE FROM config_profiles WHERE owner = ${owner} AND id = ${id}`
    );
    const removed = (res.rowCount ?? 0) > 0;
    if (removed) {
      this.invalidateAliases();
    }
    return removed;
  }

  /** The only read that returns the password blob. */
  static async openSecret(
    owner: string,
    id: string
  ): Promise<{ uuid: string; encryptedPassword: string } | null> {
    const row = await getDb().maybeOne<ConfigProfileDbRow>(
      sql`SELECT uuid, encrypted_password FROM config_profiles
           WHERE owner = ${owner} AND id = ${id}`
    );
    return row
      ? { uuid: row.uuid, encryptedPassword: row.encrypted_password }
      : null;
  }

  static async markOpened(owner: string, id: string): Promise<void> {
    await getDb().exec(
      sql`UPDATE config_profiles
             SET last_opened_at = ${Date.now()}, broken_at = NULL
           WHERE owner = ${owner} AND id = ${id}`
    );
  }

  /** Persisted so listing profiles never has to pay a bcrypt verify per row. */
  static async markBroken(owner: string, id: string): Promise<void> {
    await getDb().exec(
      sql`UPDATE config_profiles SET broken_at = ${Date.now()}
           WHERE owner = ${owner} AND id = ${id}`
    );
  }

  static async aliasMap(): Promise<Map<string, ConfigAliasTarget>> {
    const cached = this.aliases;
    if (cached && Date.now() - cached.at < ALIAS_TTL_MS) {
      return cached.value;
    }
    const rows = await getDb().query<ConfigProfileDbRow>(
      sql`SELECT alias, uuid, encrypted_password FROM config_profiles
           WHERE alias IS NOT NULL
           LIMIT ${ALIAS_LIMIT}`
    );
    const value = new Map<string, ConfigAliasTarget>();
    for (const row of rows) {
      if (row.alias) {
        value.set(row.alias, {
          uuid: row.uuid,
          encryptedPassword: row.encrypted_password,
        });
      }
    }
    this.aliases = { value, at: Date.now() };
    return value;
  }

  /**
   * Refresh the stored blob after a config password change. Takes the caller's
   * transaction so it commits with the password itself, and covers every owner
   * who saved this configuration.
   */
  static async reencryptForUuid(
    tx: DbDriver,
    uuid: string,
    encryptedPassword: string
  ): Promise<number> {
    const res = await tx.exec(
      sql`UPDATE config_profiles
             SET encrypted_password = ${encryptedPassword},
                 broken_at = NULL,
                 updated_at = ${Date.now()}
           WHERE uuid = ${uuid}`
    );
    this.invalidateAliases();
    return res.rowCount ?? 0;
  }
}

/**
 * Resolve a value that may be a configuration UUID or an alias. Returns null
 * for uuid-shaped input and unknown aliases.
 *
 * ALIASED_CONFIGURATIONS is consulted first so a saved alias can never take
 * over an install URL the operator published from settings. Never throws: a
 * database failure degrades to the settings-only answer.
 */
export async function resolveConfigAlias(
  value: string
): Promise<ConfigAliasTarget | null> {
  if (!value || isConfigUuid(value)) {
    return null;
  }
  const configured = appConfig.api.aliasedConfigurations[value];
  if (configured?.uuid && configured.password) {
    return { uuid: configured.uuid, encryptedPassword: configured.password };
  }
  try {
    return (await ConfigProfileRepository.aliasMap()).get(value) ?? null;
  } catch {
    return null;
  }
}
