/**
 * Subtitle extraction + translation pipeline (spec §4.2/§4.4). Public surface
 * consumed by the stream/subtitle resource handlers and the server route.
 */
export * from './types.js';
export * from './srt.js';
export * from './token.js';
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
