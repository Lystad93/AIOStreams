/**
 * Which pieces appear on each subtitle row, and in what order.
 *
 * Two independent token lists, because the two lines are read differently: the
 * header is what the player renders large (and what some players resolve as a
 * language), while the detail line is the small secondary text where the
 * quantitative evidence belongs.
 */
import { useUserData } from '@/context/userData';
import { SettingsCard } from '../../../shared/settings-card';
import { Switch } from '../../../ui/switch';
import { Combobox } from '../../../ui/combobox';
import { SortableList } from '../../../shared/sortable-list';
import { Alert } from '../../../ui/alert';
import {
  HEADER_TOKENS,
  DETAIL_TOKENS,
  DEFAULT_HEADER,
  DEFAULT_DETAIL,
  TOKEN_DETAILS,
} from '../../../../../../core/src/subtitles/display-tokens';

function options(tokens: readonly string[]) {
  return tokens.map((t) => ({
    label: TOKEN_DETAILS[t]?.name ?? t,
    value: t,
  }));
}

/** Keep the user's existing order, append newly-selected tokens at the end. */
function reorder(previous: string[], next: string[]): string[] {
  const kept = previous.filter((t) => next.includes(t));
  return [...kept, ...next.filter((t) => !kept.includes(t))];
}

export function SubtitleDisplay() {
  const { userData, setUserData } = useUserData();
  const cfg = userData.subtitleDisplay;
  const header = cfg?.header?.length ? cfg.header : DEFAULT_HEADER;
  const detail = cfg?.detail?.length ? cfg.detail : DEFAULT_DETAIL;

  const write = (patch: Partial<NonNullable<typeof cfg>>) =>
    setUserData((prev) => ({
      ...prev,
      subtitleDisplay: { ...prev.subtitleDisplay, ...patch },
    }));

  return (
    <SettingsCard
      title="Subtitle List Display"
      id="subtitleDisplay"
      description={
        <div className="space-y-2">
          <p>
            Choose what each subtitle row shows, and drag to reorder. The header
            is the large line your player uses as the track name; the detail
            line is the smaller text beneath it.
          </p>
          <Alert intent="info-basic">
            <p className="text-sm">
              Some players resolve the header strictly as a language and show
              anything else as <strong>Unknown</strong>. The switch below keeps
              rows that actually deliver a subtitle on a standard ISO 639-2 code
              (<code>nor</code>) so they always resolve — offers and in-progress
              rows keep their readable header either way.
            </p>
          </Alert>
        </div>
      }
    >
      <Switch
        label="Use standard language codes for delivered subtitles"
        side="right"
        help="Recommended. Applies to finished translations and ready-to-use subtitles — the rows that are a real subtitle in a known language."
        value={cfg?.standardLanguageCodes ?? true}
        onValueChange={(value) => write({ standardLanguageCodes: value })}
      />

      <Combobox
        label="Header fields"
        multiple
        help="Shown on the large line, space-separated."
        options={options(HEADER_TOKENS)}
        emptyMessage="No fields found"
        value={header}
        onValueChange={(value) =>
          write({ header: reorder(header, value as string[]) })
        }
      />
      {header.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-[--muted]">
            Header order — drag to change.
          </p>
          <SortableList
            items={header}
            onChange={(items) => write({ header: items })}
          />
        </div>
      )}

      <Combobox
        label="Detail fields"
        multiple
        help="Shown on the smaller secondary line."
        options={options(DETAIL_TOKENS)}
        emptyMessage="No fields found"
        value={detail}
        onValueChange={(value) =>
          write({ detail: reorder(detail, value as string[]) })
        }
      />
      {detail.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-[--muted]">
            Detail order — drag to change.
          </p>
          <SortableList
            items={detail}
            onChange={(items) => write({ detail: items })}
          />
        </div>
      )}

      <div className="text-xs text-[--muted] space-y-1">
        {[...new Set([...header, ...detail])].map((t) => (
          <p key={t}>
            <strong>{TOKEN_DETAILS[t]?.name ?? t}</strong> —{' '}
            {TOKEN_DETAILS[t]?.description ?? ''}
          </p>
        ))}
      </div>
    </SettingsCard>
  );
}
