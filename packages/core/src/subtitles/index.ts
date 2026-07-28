/**
 * Subtitle extraction + translation pipeline (spec §4.2/§4.4). Public surface
 * consumed by the stream/subtitle resource handlers and the server route.
 */
export * from './types.js';
export * from './srt.js';
export * from './fps.js';
export * from './token.js';
export * from './match.js';
export {
  findExternalSubtitles,
  downloadExternalSubtitle,
  getProviderClient,
  configuredProviders,
  type ScoredSubtitle,
  type ExternalSubtitleCandidate,
  type ExternalProviderId,
} from './providers/index.js';
export { normaliseReleaseName } from './release-name.js';
export { buildSubtitleFilename, subtitleLanguageCode } from './naming.js';
export {
  recordServedReleases,
  lookupServedRelease,
  releaseHash,
  type ServedRelease,
} from './release-lookup.js';
export {
  buildSubtitleSlots,
  resolveSubtitleConfig,
  getFinishedResult,
  precacheTranslateExact,
  markTranslatedStreams,
  buildExternalSlots,
  resolveExternalConfig,
  resolveTrackPreferences,
  externalJobHash,
} from './slots.js';
export {
  startExactJob,
  estimateEtaSeconds,
  type RunJobInput,
} from './pipeline.js';
export {
  getJob,
  getJobById,
  putJob,
  getResult,
  resultId,
  jobId,
  isStaleJob,
  blocksNewAttempt,
} from './job-store.js';
export {
  probeSubtitleTracks,
  probeMedia,
  extractBestSubtitle,
  extractTrackToSrt,
  pickTrack,
} from './extract.js';
export {
  findReusableSource,
  hasReusableSource,
  storeExtractedSource,
  pickSource,
  sourceScope,
} from './sources.js';
export {
  translateCues,
  geminiProvider,
  getTranslationProvider,
  type TranslationProvider,
} from './translate.js';
