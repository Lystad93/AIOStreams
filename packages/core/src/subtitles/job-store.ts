/**
 * Job-state storage (spec §5, open question §10). Rides the existing three-tier
 * {@link Cache} (memory / SQL / Redis) rather than a bespoke table, so it works
 * the same on single-process and Redis-backed multi-instance deployments.
 *
 * Two namespaces:
 *  - `subtitle-jobs`   → {@link SubtitleJob} metadata (status/eta/pointer).
 *  - `subtitle-results`→ the finished translated SRT text, pointed at by
 *                        `job.resultKey`.
 *
 * A finished result outlives its job record so a completed translation can be
 * re-served (and later shared cross-instance, spec §4.7) after the job's own
 * TTL lapses.
 */
import { Cache } from '../utils/index.js';
import { getSimpleTextHash } from '../utils/crypto.js';
import type { SubtitleJob, SubtitleJobKey } from './types.js';

/** How long a job record lingers after its last update. */
const JOB_TTL_SECONDS = 24 * 60 * 60;
/** Finished SRTs live longer — they're the reusable artefact. */
const RESULT_TTL_SECONDS = 7 * 24 * 60 * 60;

const jobCache = () =>
  Cache.getInstance<string, SubtitleJob>('subtitle-jobs');
const resultCache = () =>
  Cache.getInstance<string, string>('subtitle-results');

/** Deterministic id for a job tuple — stable across instances for §4.7 reuse. */
export function jobId(key: SubtitleJobKey): string {
  return getSimpleTextHash(
    [key.uuid, key.contentId, key.releaseHash, key.sourcePath, key.targetLang]
      .map((s) => encodeURIComponent(s))
      .join('|')
  );
}

/** Content-addressed key for a finished SRT (dedups identical translations). */
export function resultId(key: SubtitleJobKey): string {
  return getSimpleTextHash(
    ['result', key.contentId, key.releaseHash, key.sourcePath, key.targetLang]
      .map((s) => encodeURIComponent(s))
      .join('|')
  );
}

export async function getJob(
  key: SubtitleJobKey
): Promise<SubtitleJob | undefined> {
  return jobCache().get(jobId(key));
}

export async function getJobById(id: string): Promise<SubtitleJob | undefined> {
  return jobCache().get(id);
}

export async function putJob(job: SubtitleJob): Promise<void> {
  await jobCache().set(jobId(job), job, JOB_TTL_SECONDS);
}

/**
 * Atomic-enough create-if-absent: returns the existing job if one is already in
 * flight/done for this tuple, otherwise stores and returns `next`. Prevents a
 * double click (or two clients) from starting the same extract twice. The
 * shared cache is single-writer per process; the small race window is
 * acceptable for this workload (worst case: one duplicate job).
 */
export async function createJobIfAbsent(
  next: SubtitleJob
): Promise<{ job: SubtitleJob; created: boolean }> {
  const existing = await getJob(next);
  if (existing) return { job: existing, created: false };
  await putJob(next);
  return { job: next, created: true };
}

export async function getResult(id: string): Promise<string | undefined> {
  return resultCache().get(id);
}

export async function putResult(id: string, srt: string): Promise<void> {
  await resultCache().set(id, srt, RESULT_TTL_SECONDS);
}
