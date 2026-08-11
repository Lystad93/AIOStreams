import { z } from 'zod';
import type { RuntimeConfigSection } from '../types.js';
import { PERMISSION_NAMES } from '../../utils/permissions.js';

/**
 * A pipe-separated permission list, e.g. `admin` or `proxy|sabnzbd`. `none` and
 * the empty string both mean no permissions. Validated but not transformed:
 * staying a string is what makes the group map render as a text grid.
 */
const permissionSpec = z.string().superRefine((value, ctx) => {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'none') return;
  const parts = trimmed.split('|').map((p) => p.trim());
  for (const part of parts) {
    if (part.toLowerCase() === 'none') {
      ctx.addIssue({
        code: 'custom',
        message: `"none" cannot be combined with other permissions (got "${value}").`,
      });
      return;
    }
    if (!(PERMISSION_NAMES as readonly string[]).includes(part)) {
      ctx.addIssue({
        code: 'custom',
        message: `Unknown permission "${part}". Valid: ${PERMISSION_NAMES.join(', ')}, none.`,
      });
      return;
    }
  }
});

/**
 * Group name to permission spec. Accepts the stored record form, or the
 * `group=admin,other=proxy|sabnzbd` env form. Group names containing `,` or `=`
 * (LDAP DNs) need the record form, which env values reach by being JSON-parsed.
 */
const groupPermissionSpecMap = z.union([
  z.record(z.string(), permissionSpec),
  z.string().transform((value, ctx) => {
    const out: Record<string, string> = {};
    if (!value.trim()) return out;
    for (const entry of value.split(',').map((e) => e.trim())) {
      if (!entry) continue;
      const sep = entry.indexOf('=');
      if (sep <= 0) {
        ctx.addIssue({
          code: 'custom',
          message: `Invalid entry "${entry}". Expected group=permission|permission.`,
        });
        return z.NEVER;
      }
      const group = entry.slice(0, sep).trim();
      const spec = entry.slice(sep + 1).trim();
      const result = permissionSpec.safeParse(spec);
      if (!result.success) {
        ctx.addIssue({
          code: 'custom',
          message: `Group "${group}": ${result.error.issues[0]?.message ?? 'invalid permissions'}`,
        });
        return z.NEVER;
      }
      out[group] = spec;
    }
    return out;
  }),
]);

/**
 * A URL or null. The empty check stays inside the transform: adding a
 * `z.literal('')` branch would classify the field as `json` and render the
 * issuer as a textarea.
 */
const nullableUrl = z.union([
  z.null(),
  z.string().transform((value, ctx) => {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    try {
      return new URL(trimmed).toString();
    } catch {
      ctx.addIssue({ code: 'custom', message: `Invalid URL: "${value}"` });
      return z.NEVER;
    }
  }),
]);

/** Env values are JSON-parsed, so an all-numeric client ID arrives as a number. */
const coercedNullableString = z.union([
  z.null(),
  z.string(),
  z.number().transform(String),
  z.boolean().transform(String),
]);

const scopeList = z.union([
  z.array(z.string()),
  z.string().transform((value) =>
    value
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  ),
]);

export const oidcSchema = {
  enabled: {
    schema: z.boolean(),
    default: false,
    label: 'Enable SSO login',
    description:
      'Allow operators to sign in with an OpenID Connect provider. This governs dashboard and config-page access only; it does not affect Stremio addon URLs.',
    env: 'AIOSTREAMS_OIDC_ENABLED',
    requiresRestart: false,
    secret: false,
  },
  issuer: {
    schema: nullableUrl,
    default: null,
    label: 'Issuer URL',
    description: {
      ui: "Your provider's issuer URL, e.g. `https://auth.example.com`. Its `/.well-known/openid-configuration` is fetched automatically. Copy it exactly as your provider states it, including any trailing slash. Register `<your base URL>/api/v1/auth/oidc/callback` as an allowed redirect URI.",
      env: 'OIDC issuer URL. Discovery is performed against {issuer}/.well-known/openid-configuration. Copy it exactly as your provider states it, including any trailing slash. Register <BASE_URL>/api/v1/auth/oidc/callback as an allowed redirect URI with your provider.',
    },
    env: 'AIOSTREAMS_OIDC_ISSUER',
    requiresRestart: false,
    secret: false,
  },
  clientId: {
    schema: coercedNullableString,
    default: null,
    label: 'Client ID',
    description: 'OAuth client ID issued by your provider.',
    env: 'AIOSTREAMS_OIDC_CLIENT_ID',
    requiresRestart: false,
    secret: false,
    ui: { kind: 'string' as const },
  },
  clientSecret: {
    schema: coercedNullableString,
    default: null,
    label: 'Client secret',
    description: 'OAuth client secret issued by your provider.',
    env: 'AIOSTREAMS_OIDC_CLIENT_SECRET',
    requiresRestart: false,
    secret: true,
    ui: { kind: 'string' as const },
  },
  scopes: {
    schema: scopeList,
    default: ['openid', 'profile', 'email'],
    label: 'Scopes',
    description:
      'Scopes requested at login. Add the scope that carries group membership (often `groups`) if your provider requires one; Google and Entra ID reject an unknown `groups` scope.',
    env: 'AIOSTREAMS_OIDC_SCOPES',
    requiresRestart: false,
    secret: false,
  },
  usernameClaim: {
    schema: z.string().min(1),
    default: 'preferred_username',
    label: 'Username claim',
    description:
      'Claim used as the AIOStreams username. Use `sub` if your provider lets users rename themselves, since a renamed user otherwise splits their audit history.',
    env: 'AIOSTREAMS_OIDC_USERNAME_CLAIM',
    requiresRestart: false,
    secret: false,
  },
  linkByUsername: {
    schema: z.boolean(),
    default: false,
    label: 'Link to local users by username',
    description:
      'Treat an SSO identity whose username matches an AIOSTREAMS_AUTH user as that user, rather than refusing the login. Such a session takes its permissions from AIOSTREAMS_AUTH_PERMISSIONS and the group mapping is not consulted, so the person is configured once rather than per login method. Only enable this if you control who can authenticate at your provider and who can change their own username there.',
    env: 'AIOSTREAMS_OIDC_LINK_BY_USERNAME',
    requiresRestart: false,
    secret: false,
  },
  usernamePrefix: {
    schema: z.string(),
    default: '',
    label: 'Username prefix',
    description:
      'Prepended to every SSO username. Set to something like `sso:` to make collisions with local AIOSTREAMS_AUTH users impossible.',
    env: 'AIOSTREAMS_OIDC_USERNAME_PREFIX',
    requiresRestart: false,
    secret: false,
  },
  groupsClaim: {
    schema: z.string().min(1),
    default: 'groups',
    label: 'Groups claim',
    description:
      'Claim carrying group membership. If absent from the ID token, the userinfo endpoint is consulted automatically.',
    env: 'AIOSTREAMS_OIDC_GROUPS_CLAIM',
    requiresRestart: false,
    secret: false,
  },
  groupPermissions: {
    schema: groupPermissionSpecMap,
    default: {} as Record<string, string>,
    label: 'Group permissions',
    description: {
      ui: `Maps a group from the groups claim to permissions. Valid: ${PERMISSION_NAMES.map((p) => `\`${p}\``).join(', ')}, or \`none\`; combine with \`|\`. \`admin\` implies all of them.`,
      env: `Maps groups to permissions. Comma-separated \`group=perm|perm\` entries (valid: ${PERMISSION_NAMES.join(', ')}, none). Group names containing "," or "=" (such as LDAP DNs) must use the JSON object form instead, e.g. {"cn=admins,ou=groups,dc=example,dc=com":"admin"}.`,
    },
    env: 'AIOSTREAMS_OIDC_GROUP_PERMISSIONS',
    requiresRestart: false,
    secret: false,
    ui: { mapWidth: 'wide-key' as const },
  },
  defaultPermissions: {
    schema: permissionSpec,
    default: '',
    label: 'Default permissions',
    description:
      'Permissions for an SSO user whose groups match nothing above. Empty means such a user is refused, which is the safe default. Set to `admin` only if every user your provider admits should administer this instance.',
    env: 'AIOSTREAMS_OIDC_DEFAULT_PERMISSIONS',
    requiresRestart: false,
    secret: false,
  },
  allowLocalLogin: {
    schema: z.boolean(),
    default: true,
    label: 'Allow local login',
    description:
      'Keep the AIOSTREAMS_AUTH username/password form available alongside SSO. Turning this off means a provider outage locks everyone out; recover with AIOSTREAMS_OIDC_ENABLED=false and a restart.',
    env: 'AIOSTREAMS_OIDC_ALLOW_LOCAL_LOGIN',
    requiresRestart: false,
    secret: false,
  },
  buttonLabel: {
    schema: z.string().min(1),
    default: 'Sign in with SSO',
    label: 'Login button label',
    description: 'Text on the SSO button on the login page.',
    env: 'AIOSTREAMS_OIDC_BUTTON_LABEL',
    requiresRestart: false,
    secret: false,
  },
  autoRedirect: {
    schema: z.boolean(),
    default: false,
    label: 'Redirect to provider automatically',
    description:
      'Skip the login page and go straight to the provider. Visit `/login?local=1` to reach the password form anyway.',
    env: 'AIOSTREAMS_OIDC_AUTO_REDIRECT',
    requiresRestart: false,
    secret: false,
  },
  allowInsecureRequests: {
    schema: z.boolean(),
    default: false,
    label: 'Allow insecure (http) issuer',
    description:
      'Permit a plain-http issuer URL. This exposes the client secret and tokens on the wire; use only on a trusted network.',
    env: 'AIOSTREAMS_OIDC_ALLOW_INSECURE_REQUESTS',
    requiresRestart: false,
    secret: false,
  },
} as const satisfies RuntimeConfigSection;
