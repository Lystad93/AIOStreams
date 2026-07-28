import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../utils/crypto.js';
import {
  foldDecorativeUnicode,
  parseCommentDuration,
  parseCommentReleases,
  parseUploaderComment,
} from './comment-parse.js';

test('duration: reads the unambiguous h:mm:ss form', () => {
  assert.equal(parseCommentDuration('Runtime 1:53:28'), 6_808_000);
  assert.equal(parseCommentDuration('01:53:28'), 6_808_000);
  // Fractional seconds are tolerated and discarded.
  assert.equal(parseCommentDuration('length 1:53:28.500'), 6_808_000);
});

test('duration: reads written hour/minute forms', () => {
  assert.equal(parseCommentDuration('1h53m28s'), 6_808_000);
  assert.equal(parseCommentDuration('1 h 53 min'), 6_780_000);
  assert.equal(parseCommentDuration('2hours 05minutes'), 7_500_000);
});

test('duration: bare minutes only when nothing better is present', () => {
  assert.equal(parseCommentDuration('113 min'), 6_780_000);
  // A precise form present alongside it wins.
  assert.equal(parseCommentDuration('113 min (1:53:28)'), 6_808_000);
});

test('duration: implausible values are rejected, not guessed at', () => {
  // Bitrates, file sizes and version numbers must not become runtimes.
  assert.equal(parseCommentDuration('encoded at 5000 kbps'), undefined);
  assert.equal(parseCommentDuration('v2.1 release'), undefined);
  assert.equal(parseCommentDuration('sync 0:00:30 offset'), undefined); // too short
  assert.equal(parseCommentDuration('12:00:00'), undefined); // too long
  assert.equal(parseCommentDuration(''), undefined);
  assert.equal(parseCommentDuration('no timing information here'), undefined);
});

test('releases: only dotted tokens carrying a real release marker', () => {
  const found = parseCommentReleases(
    'Also syncs with Backrooms.2026.1080p.AMZN.WEB-DL.DDP5.1.H.264-BYNDR and Backrooms.2026.2160p.WEB-DL.HEVC-FLUX'
  );
  assert.equal(found.length, 2);
  assert.ok(found[0].includes('AMZN'));
  assert.ok(found[1].includes('FLUX'));
});

test('releases: ordinary prose with dots is not a release name', () => {
  // The marker requirement is what keeps sentences and filenames out.
  assert.deepEqual(parseCommentReleases('see the readme.txt.for.details'), []);
  assert.deepEqual(parseCommentReleases('Thanks. Enjoy. Rate please.'), []);
  assert.deepEqual(parseCommentReleases('resync by me, no changes'), []);
});

test('releases: deduped and capped', () => {
  const dup =
    'Backrooms.2026.1080p.AMZN.WEB-DL.H.264-BYNDR Backrooms.2026.1080p.AMZN.WEB-DL.H.264-BYNDR';
  assert.equal(parseCommentReleases(dup).length, 1);
});

test('parseUploaderComment: absent input yields nothing, never throws', () => {
  assert.deepEqual(parseUploaderComment(undefined), { releaseNames: [] });
  assert.deepEqual(parseUploaderComment('   '), { releaseNames: [] });
});

test('parseUploaderComment: a realistic comment yields both signals', () => {
  const parsed = parseUploaderComment(
    'Runtime 1:53:28. Synced for Backrooms.2026.1080p.AMZN.WEB-DL.DDP5.1.Atmos.H.264-BYNDR, should also fit the 2160p version.'
  );
  assert.equal(parsed.durationMs, 6_808_000);
  assert.equal(parsed.releaseNames.length, 1);
  assert.ok(parsed.releaseNames[0].includes('BYNDR'));
});

// --------------------------------------------------------- decorative Unicode

test('folds mathematical-bold Unicode before matching', () => {
  // SubDL renders whole comments this way. Left unfolded, `\d` matches none of
  // it and a comment plainly stating the runtime parses to nothing.
  const styled =
    '\u{1D403}\u{1D42E}\u{1D42B}\u{1D41A}\u{1D42D}\u{1D422}\u{1D428}\u{1D427} : ' +
    '\u{1D7CE}\u{1D7CF}\u{1D421} \u{1D7D2}\u{1D7D6}\u{1D426} \u{1D7CF}\u{1D7D2}\u{1D42C}';
  assert.equal(foldDecorativeUnicode(styled), 'Duration : 01h 48m 14s');
  assert.equal(parseUploaderComment(styled).durationMs, 6_494_000);
});

test('a styled release name normalises onto the plain-ASCII key', () => {
  // The name is a storage key, so a styled copy must land in the same slot as
  // the ordinary spelling the stream list carries.
  const styled =
    '\u{1D5E6}\u{1D5E8}\u{1D5E3}\u{1D5D8}\u{1D5E5}\u{1D5DA}\u{1D5DC}\u{1D5E5}\u{1D5DF}';
  assert.equal(foldDecorativeUnicode(styled), 'SUPERGIRL');
});

test('real SubSource comment yields the runtime and its source release', () => {
  const parsed = parseUploaderComment(
    'Extracted the SDH/HI srt file from Supergirl.2026.720p.AMZN.WEB-DL.DDP5.1.H.264-BYNDR. ' +
      'Went through balanced some lines. Movie running time 1:48:14.'
  );
  assert.equal(parsed.durationMs, 6_494_000);
  assert.equal(parsed.releaseNames.length, 1);
  assert.ok(parsed.releaseNames[0].includes('BYNDR'));
});
