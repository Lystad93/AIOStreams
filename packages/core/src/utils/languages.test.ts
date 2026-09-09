import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseLangCode, normaliseLanguage } from './languages.js';
import { parseMediaInfo } from './media-info.js';

describe('normaliseLangCode', () => {
  it('maps ISO 639-2/B codes to their /T equivalent', () => {
    assert.equal(normaliseLangCode('fre'), 'fra');
    assert.equal(normaliseLangCode('ger'), 'deu');
    assert.equal(normaliseLangCode('cze'), 'ces');
  });

  it('maps Bokmal and Nynorsk to the Norwegian macrolanguage', () => {
    assert.equal(normaliseLangCode('nob'), 'nor');
    assert.equal(normaliseLangCode('nno'), 'nor');
  });

  it('leaves an unknown code alone', () => {
    assert.equal(normaliseLangCode('zzz'), 'zzz');
  });
});

describe('normaliseLanguage', () => {
  it('resolves every Norwegian code to Norwegian', () => {
    // Amazon and HBO Max tag the track `nob`; a NORDiC release tags it `nor`.
    // Both are Norwegian, and reading only one of them silently drops the
    // subtitle track from the stream's language list.
    for (const code of ['nor', 'no', 'nob', 'nno']) {
      assert.equal(normaliseLanguage(code), 'Norwegian', `code ${code}`);
    }
  });

  it('still resolves the other aliased codes', () => {
    assert.equal(normaliseLanguage('cze'), 'Czech');
    assert.equal(normaliseLanguage('dut'), 'Dutch');
    assert.equal(normaliseLanguage('may'), 'Malay');
  });
});

describe('parseMediaInfo with a Bokmal subtitle track', () => {
  it('reports the track as Norwegian', () => {
    // The track layout Amazon and HBO Max ship: the Norwegian subtitle is
    // tagged `nob`, alongside codes that already resolved before this change.
    const parsed = parseMediaInfo({
      video: { w: 3840, h: 2160 },
      audio: [{ lang: 'eng', codec: 'eac3' }],
      subtitle: [
        { lang: 'eng' },
        { lang: 'dan' },
        { lang: 'nob' },
        { lang: 'swe' },
      ],
    });
    assert.deepEqual(parsed?.subtitles, [
      'English',
      'Danish',
      'Norwegian',
      'Swedish',
    ]);
  });
});
