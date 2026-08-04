import { Request, Response, NextFunction } from 'express';
import { isConfigUuid, resolveConfigAlias } from '@aiostreams/core';

function extractUsernameFromBasicAuth(req: Request): string | undefined {
  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Basic ')) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(
      header.slice('Basic '.length).trim(),
      'base64'
    ).toString('utf-8');
    const sepIndex = decoded.indexOf(':');
    if (sepIndex === -1) return undefined;
    const username = decoded.slice(0, sepIndex);
    return username || undefined;
  } catch {
    return undefined;
  }
}

// Resolves alias to UUID for user API routes.
// If the provided value is not a UUID and matches a known alias, replaces it with the real UUID.
// Deliberately fails soft: an unresolved value is left for the route to treat as
// a UUID, so a lookup failure cannot turn a valid request into an error.
export async function resolveUuidAliasForUserApi(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    // Authorization header is the primary source for authenticated routes.
    const headerValue = extractUsernameFromBasicAuth(req);
    if (headerValue && !isConfigUuid(headerValue)) {
      const configuration = await resolveConfigAlias(headerValue);
      if (configuration) {
        req.uuid = configuration.uuid;
      }
    }

    // HEAD `/user` uses `?uuid=` for the existence probe (no creds required).
    if (!req.uuid && req.method.toUpperCase() === 'HEAD') {
      const value = req.query.uuid;
      if (typeof value === 'string' && !isConfigUuid(value)) {
        const configuration = await resolveConfigAlias(value);
        if (configuration) {
          req.uuid = configuration.uuid;
        }
      }
    }
  } catch {
    // fall through with req.uuid unset
  }

  next();
}
