import { anonymizeIp } from '../analytics/index.js';
import { appConfig } from '../utils/index.js';

/**
 * Apply the IP recording policy to an address leaving the process. Sessions are
 * keyed on the real address whatever this returns, so coarsening one never
 * merges two viewers into a single watch.
 */
export function recordedClientIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  switch (appConfig.streams.clientIpRecording) {
    case 'none':
      return undefined;
    case 'prefix':
      return anonymizeIp(ip) ?? undefined;
    default:
      return ip;
  }
}
