/**
 * Rules for the human-readable name in `/stremio/u/<alias>/...`. A leaf module
 * with no db or config imports, so any layer can reach it.
 */

const UUID_REGEX =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

const ALIAS_REGEX = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])$/;

export function isConfigUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

export function normaliseAlias(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Returns null when the alias is usable, otherwise the reason to show. Assumes
 * the input has already been through {@link normaliseAlias}.
 */
export function validateAlias(alias: string): string | null {
  if (!ALIAS_REGEX.test(alias)) {
    return 'An alias must be 2 to 64 characters of a-z, 0-9, dot, dash or underscore, and must start and end with a letter or number';
  }
  // A uuid-shaped alias is never looked up: the request path tests for a uuid
  // first and would treat it as one.
  if (isConfigUuid(alias)) {
    return 'An alias cannot look like a configuration UUID';
  }
  return null;
}
