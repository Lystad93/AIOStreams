/**
 * Everything recorded about one subtitle job, in one place.
 *
 * The table can only show what fits; when something goes wrong the fields that
 * explain it (the release hash, the job id, the full error) are exactly the
 * ones that were truncated. This shows all of them, and makes the long ones
 * copyable — most are meant to be pasted into a log grep or an issue.
 */
import React from 'react';
import { toast } from 'sonner';
import { BiCopy } from 'react-icons/bi';
import { Modal } from '@/components/ui/modal';
import { IconButton } from '@/components/ui/button';
import { copyToClipboard } from '@/utils/clipboard';
import { formatBytes, formatDurationMs } from '@/lib/format';

export interface SubtitleJobInfo {
  id: string;
  uuid: string;
  contentId: string;
  releaseHash?: string;
  sourcePath: string;
  targetLang: string;
  sourceLang?: string;
  status: string;
  filename?: string;
  videoSize?: number;
  provider?: string;
  model?: string;
  error?: string;
  cueCount?: number;
  externalProvider?: string;
  externalFile?: string;
  externalReleases?: string[];
  externalStatedDurationMs?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  durationMs?: number;
  extractedBytes: number;
  translatedBytes: number;
}

/** `exact` means we demuxed the playing file; anything else came from a site. */
export function sourceLabel(job: {
  sourcePath: string;
  provider?: string;
}): string {
  return job.sourcePath === 'exact' ? 'Embedded track' : 'External provider';
}

const PROVIDER_NAMES: Record<string, string> = {
  subdl: 'SubDL',
  subsource: 'SubSource',
  opensubtitles: 'OpenSub',
  podnapisi: 'Podnapisi',
};

function fmtRuntime(ms?: number): string {
  if (!ms) return '—';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h${m}m${s}s` : `${m}m${s}s`;
}

function fmtTime(ms?: number): string {
  return ms ? new Date(ms).toLocaleString() : '—';
}

function Row({
  label,
  value,
  copyable,
  mono,
}: {
  label: string;
  value?: string | number | null;
  copyable?: boolean;
  mono?: boolean;
}) {
  const text = value == null || value === '' ? '—' : String(value);
  const canCopy = copyable && text !== '—';
  return (
    <div className="flex items-start gap-2 py-1.5 border-b border-[--border]/40 last:border-0">
      <span className="w-40 shrink-0 text-xs text-[--muted] pt-0.5">
        {label}
      </span>
      <span
        className={`flex-1 text-sm break-all ${mono ? 'font-mono text-xs' : ''}`}
      >
        {text}
      </span>
      {canCopy && (
        <IconButton
          size="sm"
          intent="gray-subtle"
          aria-label={`Copy ${label}`}
          icon={<BiCopy />}
          onClick={() =>
            copyToClipboard(text, {
              onSuccess: () => toast.success(`${label} copied`),
              onError: () => toast.error('Could not copy'),
            })
          }
        />
      )}
    </div>
  );
}

export function JobInfoModal({
  job,
  open,
  onOpenChange,
}: {
  job: SubtitleJobInfo | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  if (!job) return null;
  const embedded = job.sourcePath === 'exact';

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Subtitle job details">
      <div className="space-y-4">
        <div>
          <p className="text-xs text-[--muted] mb-1">Origin</p>
          <Row label="Came from" value={sourceLabel(job)} />
          {embedded ? (
            <Row label="Extracted from" value="the playing file" />
          ) : (
            // NOT `job.provider` — that column holds the AI provider, so an
            // external job used to report its origin as "gemini".
            <Row
              label="Subtitle provider"
              value={
                job.externalProvider
                  ? (PROVIDER_NAMES[job.externalProvider] ??
                    job.externalProvider)
                  : 'unknown'
              }
            />
          )}
          <Row label="Playing release" value={job.filename} copyable mono />
          <Row
            label="File size"
            value={job.videoSize != null ? formatBytes(job.videoSize) : '—'}
          />
          {!embedded && (
            <>
              <Row
                label="Subtitle file"
                value={job.externalFile}
                copyable
                mono
              />
              <Row
                label="Stated runtime"
                value={
                  job.externalStatedDurationMs
                    ? `${fmtRuntime(job.externalStatedDurationMs)} (from the uploader's comment)`
                    : '—'
                }
              />
            </>
          )}
        </div>

        {!embedded && !!job.externalReleases?.length && (
          <div>
            {/* What the entry claimed to fit — the evidence the match score
                was computed from. */}
            <p className="text-xs text-[--muted] mb-1">
              Releases this subtitle claims to fit (
              {job.externalReleases.length})
            </p>
            <Row
              label="Claimed releases"
              value={job.externalReleases.join('\n')}
              copyable
              mono
            />
          </div>
        )}

        <div>
          <p className="text-xs text-[--muted] mb-1">Translation</p>
          <Row label="Source language" value={job.sourceLang ?? 'unknown'} />
          <Row label="Target language" value={job.targetLang} />
          <Row label="AI provider" value={job.provider} />
          <Row label="Model" value={job.model} />
          <Row label="Cues" value={job.cueCount} />
        </div>

        <div>
          <p className="text-xs text-[--muted] mb-1">Timing</p>
          <Row label="Status" value={job.status} />
          <Row
            label="Time taken"
            value={
              job.durationMs != null ? formatDurationMs(job.durationMs) : '—'
            }
          />
          <Row label="Created" value={fmtTime(job.createdAt)} />
          <Row label="Updated" value={fmtTime(job.updatedAt)} />
          <Row label="Completed" value={fmtTime(job.completedAt)} />
        </div>

        <div>
          <p className="text-xs text-[--muted] mb-1">Stored files</p>
          <Row
            label="Extracted SRT"
            value={
              job.extractedBytes > 0 ? formatBytes(job.extractedBytes) : 'none'
            }
          />
          <Row
            label="Translated SRT"
            value={
              job.translatedBytes > 0
                ? formatBytes(job.translatedBytes)
                : 'none'
            }
          />
        </div>

        <div>
          {/* The identifiers worth pasting into a log grep. */}
          <p className="text-xs text-[--muted] mb-1">Identifiers</p>
          <Row label="Job id" value={job.id} copyable mono />
          <Row label="Content id" value={job.contentId} copyable mono />
          <Row label="Release hash" value={job.releaseHash} copyable mono />
          <Row label="Source path" value={job.sourcePath} mono />
          <Row label="User" value={job.uuid} copyable mono />
        </div>

        {job.error && (
          <div>
            <p className="text-xs text-[--muted] mb-1">Error</p>
            <Row label="Message" value={job.error} copyable />
          </div>
        )}
      </div>
    </Modal>
  );
}
