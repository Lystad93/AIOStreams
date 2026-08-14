import { useUserData } from '@/context/userData';
import { SettingsCard } from '../../../shared/settings-card';
import { Switch } from '../../../ui/switch';
import { Select } from '../../../ui/select';
import { Combobox } from '../../../ui/combobox';
import { NumberInput } from '../../../ui/number-input/number-input';
import { TextInput } from '../../../ui/text-input/text-input';
import { PasswordInput } from '../../../ui/password-input/password-input';
import { SortableList } from '../../../shared/sortable-list';
import { Alert } from '../../../ui/alert';
import { TranslationProviders } from './translation-providers';
import { SubtitleDisplay } from './subtitle-display';
import {
  AUTO_PLAY_ATTRIBUTES,
  DEFAULT_AUTO_PLAY_ATTRIBUTES,
  AutoPlayMethod,
  AUTO_PLAY_METHODS,
  AUTO_PLAY_METHOD_DETAILS,
  LANGUAGES,
} from '../../../../../../core/src/utils/constants';

const SUBTITLE_LANGUAGE_OPTIONS = LANGUAGES.map((lang) => ({
  label: lang,
  value: lang,
}));

// Note: NZB Failover and Auto Remove Downloads have been moved to the Services menu (Built-in tab).

export function PlaybackBehavior() {
  const { userData, setUserData } = useUserData();
  // Same fallback the backend applies (see resolveExternalConfig): a config
  // written before `externalSubtitles` existed has the feature on by virtue of
  // subtitle translation being on. Reading the raw flag here instead would
  // render the section switched ON with every field greyed out.
  const externalEnabled =
    userData.externalSubtitles?.enabled ??
    userData.subtitleTranslation?.enabled ??
    false;

  return (
    <>
      <SettingsCard
        title="Auto Play"
        id="autoPlay"
        description={
          <div className="space-y-2">
            <p>
              Configure how AIOStreams suggests the next stream for Stremio's
              auto-play feature.
            </p>
            <Alert intent="info-basic">
              <p className="text-sm">
                AIOStreams does not (and cannot) directly control auto-play. It
                uses the{' '}
                <code>
                  <a
                    rel="noopener noreferrer"
                    href="https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/stream.md#additional-properties-to-provide-information--behaviour-flags"
                    target="_blank"
                    className="text-[--brand] hover:text-[--brand]/80 hover:underline"
                  >
                    bingeGroup
                  </a>
                </code>{' '}
                attribute to suggest the next stream to Stremio. For this to
                work, you must have auto-play enabled in your Stremio settings.
              </p>
            </Alert>
          </div>
        }
      >
        <Switch
          label="Enable"
          side="right"
          value={userData.autoPlay?.enabled ?? true}
          onValueChange={(value) => {
            setUserData((prev) => ({
              ...prev,
              autoPlay: {
                ...prev.autoPlay,
                enabled: value,
              },
            }));
          }}
        />
        <Select
          label="Auto Play Method"
          disabled={userData.autoPlay?.enabled === false}
          options={AUTO_PLAY_METHODS.map((method) => ({
            label: AUTO_PLAY_METHOD_DETAILS[method].name,
            value: method,
          }))}
          value={userData.autoPlay?.method || 'matchingFile'}
          onValueChange={(value) => {
            setUserData((prev) => ({
              ...prev,
              autoPlay: {
                ...prev.autoPlay,
                method: value as AutoPlayMethod,
              },
            }));
          }}
          help={
            AUTO_PLAY_METHOD_DETAILS[
              userData.autoPlay?.method || 'matchingFile'
            ].description
          }
        />
        {(userData.autoPlay?.method ?? 'matchingFile') === 'matchingFile' && (
          <Combobox
            label="Auto Play Attributes"
            help="The attributes that will be used to match the stream for auto-play. The first stream for the next episode that has the same set of attributes selected above will be auto-played. Less attributes means more likely to auto-play but less accurate in terms of playing a similar type of stream."
            options={AUTO_PLAY_ATTRIBUTES.map((attribute) => ({
              label: attribute,
              value: attribute,
            }))}
            multiple
            disabled={userData.autoPlay?.enabled === false}
            emptyMessage="No attributes found"
            value={userData.autoPlay?.attributes}
            defaultValue={DEFAULT_AUTO_PLAY_ATTRIBUTES as unknown as string[]}
            onValueChange={(value) => {
              setUserData((prev) => ({
                ...prev,
                autoPlay: {
                  ...prev.autoPlay,
                  attributes: value as (typeof AUTO_PLAY_ATTRIBUTES)[number][],
                },
              }));
            }}
          />
        )}
      </SettingsCard>

      <SettingsCard
        title="Are you still there?"
        id="areYouStillThere"
        description="Stop autoplay after a number of consecutive episodes so the player returns to stream selection."
      >
        <Switch
          label="Enable"
          side="right"
          value={userData.areYouStillThere?.enabled}
          onValueChange={(value) => {
            setUserData((prev) => ({
              ...prev,
              areYouStillThere: {
                ...prev.areYouStillThere,
                enabled: value,
              },
            }));
          }}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <NumberInput
            label="Episodes before check"
            min={1}
            defaultValue={3}
            disabled={!userData.areYouStillThere?.enabled}
            value={userData.areYouStillThere?.episodesBeforeCheck ?? 3}
            onValueChange={(value) => {
              setUserData((prev) => ({
                ...prev,
                areYouStillThere: {
                  ...prev.areYouStillThere,
                  episodesBeforeCheck: Math.max(1, Number(value || 3)),
                },
              }));
            }}
          />
          <NumberInput
            label="Cooldown (minutes)"
            min={1}
            defaultValue={60}
            disabled={!userData.areYouStillThere?.enabled}
            value={userData.areYouStillThere?.cooldownMinutes ?? 60}
            onValueChange={(value) => {
              setUserData((prev) => ({
                ...prev,
                areYouStillThere: {
                  ...prev.areYouStillThere,
                  cooldownMinutes: Math.max(1, Number(value || 60)),
                },
              }));
            }}
          />
        </div>
      </SettingsCard>

      <SubtitleDisplay />

      <SettingsCard
        title="External Subtitles"
        id="externalSubtitles"
        description={
          <div className="space-y-2">
            <p>
              Search subtitle providers for the exact release you're playing and
              offer the closest matches, each labelled with how well it matches.
              This downloads no video and needs no AI key — it works on its own.
            </p>
            <Alert intent="info-basic">
              <p className="text-sm">
                Two entries appear per match: <strong>Use</strong> plays the
                subtitle as-is, and <strong>Translate</strong> (when Subtitle
                Translation below is configured) runs it through your AI
                provider into your target language — far cheaper than extracting
                from the video, since only a small subtitle file is fetched.
              </p>
            </Alert>
          </div>
        }
      >
        <Switch
          label="Enable"
          side="right"
          help="When off, no external subtitle entries are offered."
          value={externalEnabled}
          onValueChange={(value) => {
            setUserData((prev) => ({
              ...prev,
              externalSubtitles: { ...prev.externalSubtitles, enabled: value },
            }));
          }}
        />
        <Combobox
          label="Languages"
          multiple
          disabled={!externalEnabled}
          help="Which subtitle languages to look for. Leave empty to reuse the translation languages below (target first, then your source languages)."
          options={SUBTITLE_LANGUAGE_OPTIONS}
          emptyMessage="No languages found"
          value={userData.externalSubtitles?.languages}
          onValueChange={(value) => {
            setUserData((prev) => {
              const next = value as string[];
              const previous = prev.externalSubtitles?.languages ?? [];
              const kept = previous.filter((l) => next.includes(l));
              const added = next.filter((l) => !kept.includes(l));
              return {
                ...prev,
                externalSubtitles: {
                  ...prev.externalSubtitles,
                  languages: [...kept, ...added],
                },
              };
            });
          }}
        />
        {(userData.externalSubtitles?.languages?.length ?? 0) > 0 && (
          <div className="space-y-2">
            <p className="text-sm text-[--muted]">
              Priority order — drag to reorder.
            </p>
            <SortableList
              items={userData.externalSubtitles?.languages ?? []}
              disabled={!externalEnabled}
              onChange={(languages) => {
                setUserData((prev) => ({
                  ...prev,
                  externalSubtitles: { ...prev.externalSubtitles, languages },
                }));
              }}
            />
          </div>
        )}
        {(
          [
            ['subsource', 'SubSource'],
            ['subdl', 'SubDL'],
            ['opensubtitles', 'OpenSubtitles'],
          ] as const
        ).map(([id, name]) => (
          <Switch
            key={id}
            label={`Search ${name}`}
            side="right"
            disabled={!externalEnabled}
            help={`Turn off to stop offering ${name} results. This overrides any key — including one set by this instance's owner.`}
            value={userData.externalSubtitles?.providers?.[id] ?? true}
            onValueChange={(value) => {
              setUserData((prev) => ({
                ...prev,
                externalSubtitles: {
                  ...prev.externalSubtitles,
                  providers: {
                    ...prev.externalSubtitles?.providers,
                    [id]: value,
                  },
                },
              }));
            }}
          />
        ))}
        <Switch
          label="Include hearing impaired (SDH)"
          side="right"
          disabled={!externalEnabled}
          help="Tracks that add speaker labels and sound descriptions like [door creaks]. SDH and HI are two names for the same thing. Also applies to which embedded track is extracted for translation."
          value={userData.externalSubtitles?.includeHearingImpaired ?? true}
          onValueChange={(value) => {
            setUserData((prev) => ({
              ...prev,
              externalSubtitles: {
                ...prev.externalSubtitles,
                includeHearingImpaired: value,
              },
            }));
          }}
        />
        <Switch
          label="Prefer hearing impaired (SDH)"
          side="right"
          disabled={!externalEnabled}
          help="Pick SDH over a plain subtitle whenever both match equally well — for external results, embedded tracks, and the track a translation is made from, so the translation keeps its sound descriptions. Only breaks ties: a better-synced plain subtitle still wins. Turning this on includes SDH regardless of the switch above."
          value={userData.externalSubtitles?.preferHearingImpaired ?? false}
          onValueChange={(value) => {
            setUserData((prev) => ({
              ...prev,
              externalSubtitles: {
                ...prev.externalSubtitles,
                preferHearingImpaired: value,
              },
            }));
          }}
        />
        <Switch
          label="Include forced"
          side="right"
          disabled={!externalEnabled}
          help="Forced tracks only cover foreign-language dialogue, so they look broken if picked as a full subtitle track. Also applies to which embedded track is extracted for translation."
          value={userData.externalSubtitles?.includeForced ?? true}
          onValueChange={(value) => {
            setUserData((prev) => ({
              ...prev,
              externalSubtitles: {
                ...prev.externalSubtitles,
                includeForced: value,
              },
            }));
          }}
        />
        <PasswordInput
          label="SubSource API key"
          autoComplete="off"
          disabled={!externalEnabled}
          help="Your own key. Leave blank to use the one configured by this instance's owner."
          value={userData.externalSubtitles?.subsourceApiKey ?? ''}
          onValueChange={(value) => {
            setUserData((prev) => ({
              ...prev,
              externalSubtitles: {
                ...prev.externalSubtitles,
                subsourceApiKey: value || undefined,
              },
            }));
          }}
        />
        <PasswordInput
          label="SubDL API key"
          autoComplete="off"
          disabled={!externalEnabled}
          help="Your own key. Leave blank to use the one configured by this instance's owner."
          value={userData.externalSubtitles?.subdlApiKey ?? ''}
          onValueChange={(value) => {
            setUserData((prev) => ({
              ...prev,
              externalSubtitles: {
                ...prev.externalSubtitles,
                subdlApiKey: value || undefined,
              },
            }));
          }}
        />
        <TextInput
          label="OpenSubtitles username"
          disabled={!externalEnabled}
          help="OpenSubtitles downloads use a personal daily quota, so searching works with the instance key but downloading needs your own account."
          value={userData.externalSubtitles?.opensubtitlesUsername ?? ''}
          onValueChange={(value) => {
            setUserData((prev) => ({
              ...prev,
              externalSubtitles: {
                ...prev.externalSubtitles,
                opensubtitlesUsername: value || undefined,
              },
            }));
          }}
        />
        <PasswordInput
          label="OpenSubtitles password"
          autoComplete="off"
          disabled={!externalEnabled}
          value={userData.externalSubtitles?.opensubtitlesPassword ?? ''}
          onValueChange={(value) => {
            setUserData((prev) => ({
              ...prev,
              externalSubtitles: {
                ...prev.externalSubtitles,
                opensubtitlesPassword: value || undefined,
              },
            }));
          }}
        />
      </SettingsCard>

      <SettingsCard
        title="Subtitle Translation"
        id="subtitleTranslation"
        description={
          <div className="space-y-2">
            <p>
              Extract an embedded text subtitle track from the file you're about
              to watch and machine-translate it into your preferred language
              using your own AI provider key. A "Translate Exact" entry appears
              in Stremio/Nuvio's subtitle menu for the playing stream.
            </p>
            <Alert intent="warning-basic">
              <p className="text-sm">
                Extraction downloads the release on your backbone (same cost as
                playing it once) and only runs when you explicitly pick the
                subtitle entry — never automatically. Translation uses your own
                API key. The instance owner can disable extraction entirely.
              </p>
            </Alert>
          </div>
        }
      >
        <Switch
          label="Enable"
          side="right"
          value={userData.subtitleTranslation?.enabled ?? false}
          onValueChange={(value) => {
            setUserData((prev) => ({
              ...prev,
              subtitleTranslation: {
                ...prev.subtitleTranslation,
                enabled: value,
              },
            }));
          }}
        />
        <TranslationProviders
          disabled={!userData.subtitleTranslation?.enabled}
        />
        <Select
          label="Translate into"
          disabled={!userData.subtitleTranslation?.enabled}
          help="The language subtitles will be translated into."
          options={SUBTITLE_LANGUAGE_OPTIONS}
          value={userData.subtitleTranslation?.targetLanguage}
          onValueChange={(value) => {
            setUserData((prev) => ({
              ...prev,
              subtitleTranslation: {
                ...prev.subtitleTranslation,
                targetLanguage: value,
              },
            }));
          }}
        />
        <Combobox
          label="Preferred source languages"
          multiple
          disabled={!userData.subtitleTranslation?.enabled}
          help="Which embedded track to translate from when several exist (e.g. prefer Danish over English). Drag to set priority below. Leave empty to use the first text track found."
          options={SUBTITLE_LANGUAGE_OPTIONS}
          emptyMessage="No languages found"
          value={userData.subtitleTranslation?.sourceLanguages}
          onValueChange={(value) => {
            setUserData((prev) => {
              const next = value as string[];
              // Preserve the user's existing order; append only what's new, so
              // re-opening the picker never scrambles a hand-tuned priority.
              const previous = prev.subtitleTranslation?.sourceLanguages ?? [];
              const kept = previous.filter((l) => next.includes(l));
              const added = next.filter((l) => !kept.includes(l));
              return {
                ...prev,
                subtitleTranslation: {
                  ...prev.subtitleTranslation,
                  sourceLanguages: [...kept, ...added],
                },
              };
            });
          }}
        />
        {(userData.subtitleTranslation?.sourceLanguages?.length ?? 0) > 0 && (
          <div className="space-y-2">
            <p className="text-sm text-[--muted]">
              Preference order — drag to reorder. The first available language
              is used as the translation source.
            </p>
            <SortableList
              items={userData.subtitleTranslation?.sourceLanguages ?? []}
              disabled={!userData.subtitleTranslation?.enabled}
              onChange={(sourceLanguages) => {
                setUserData((prev) => ({
                  ...prev,
                  subtitleTranslation: {
                    ...prev.subtitleTranslation,
                    sourceLanguages,
                  },
                }));
              }}
            />
          </div>
        )}
        <Switch
          label="Offer subtitles already in your target language"
          side="right"
          disabled={!userData.subtitleTranslation?.enabled}
          help="When a provider already has a subtitle in your target language, list it directly. Nothing is translated, so these are free and instant — they appear above the translation rows."
          value={userData.subtitleTranslation?.showTargetLanguageSubs ?? true}
          onValueChange={(value) => {
            setUserData((prev) => ({
              ...prev,
              subtitleTranslation: {
                ...prev.subtitleTranslation,
                showTargetLanguageSubs: value,
              },
            }));
          }}
        />
        <NumberInput
          label="How many to show"
          min={0}
          max={20}
          defaultValue={3}
          disabled={
            !userData.subtitleTranslation?.enabled ||
            userData.subtitleTranslation?.showTargetLanguageSubs === false
          }
          help="Counted separately from the external use/translate limits, so ready-made subtitles never compete for those slots."
          value={userData.subtitleTranslation?.targetLanguageSubLimit ?? 3}
          onValueChange={(value) => {
            setUserData((prev) => ({
              ...prev,
              subtitleTranslation: {
                ...prev.subtitleTranslation,
                targetLanguageSubLimit: Math.max(
                  0,
                  Math.min(20, Number(value ?? 3))
                ),
              },
            }));
          }}
        />
        <Switch
          label="Pre-translate next episode"
          side="right"
          disabled={
            !userData.subtitleTranslation?.enabled ||
            !userData.precacheNextEpisode
          }
          help={
            userData.precacheNextEpisode
              ? 'When binge-watching, translate the next episode ahead of time so it is ready with no wait. Extracts the next file early (extra bandwidth), so it only runs when Precache next episode is also enabled.'
              : 'Requires the "Precache next episode" feature to be enabled first.'
          }
          value={userData.subtitleTranslation?.precacheNextEpisode ?? false}
          onValueChange={(value) => {
            setUserData((prev) => ({
              ...prev,
              subtitleTranslation: {
                ...prev.subtitleTranslation,
                precacheNextEpisode: value,
              },
            }));
          }}
        />
      </SettingsCard>
    </>
  );
}
