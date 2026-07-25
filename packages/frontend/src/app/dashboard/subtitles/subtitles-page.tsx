import React from 'react';
import { toast } from 'sonner';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BiTrash, BiDownload, BiCaptions } from 'react-icons/bi';
import { PageWrapper } from '@/components/shared/page-wrapper';
import { Card } from '@/components/ui/card';
import { IconButton } from '@/components/ui/button';
import { cn } from '@/components/ui/core/styling';
import {
  ConfirmationDialog,
  useConfirmationDialog,
} from '@/components/shared/confirmation-dialog';
import { DashboardQueryBoundary } from '@/components/shared/dashboard-query-boundary';
import { api } from '@/lib/api';
import { formatBytes, formatDurationMs } from '@/lib/format';

interface SubtitleJob {
  id: string;
  uuid: string;
  contentId: string;
  sourcePath: string;
  targetLang: string;
  sourceLang?: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  filename?: string;
  videoSize?: number;
  provider?: string;
  model?: string;
  error?: string;
  cueCount?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  durationMs?: number;
  extractedBytes: number;
  translatedBytes: number;
}

interface JobList {
  jobs: SubtitleJob[];
  total: number;
}

const STATUS_BADGE: Record<string, string> = {
  pending: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  running: 'bg-sky-500/10 text-sky-500 border-sky-500/20',
  done: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  failed: 'bg-red-500/10 text-red-500 border-red-500/20',
};

const DL_LINK =
  'inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border ' +
  'border-[--border] text-[--muted] hover:text-[--foreground] hover:bg-[--subtle]/40 transition-colors';

function fmtTime(ms?: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

export function SubtitlesPage() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['dashboard', 'subtitles'],
    queryFn: () => api<JobList>('/dashboard/subtitles'),
    refetchInterval: 10_000,
  });

  const [pendingId, setPendingId] = React.useState<string | undefined>();
  const del = useMutation({
    mutationFn: (id: string) => api(`DELETE /dashboard/subtitles/${id}`),
    onSuccess: () => {
      toast.success('Job deleted');
      qc.invalidateQueries({ queryKey: ['dashboard', 'subtitles'] });
    },
    onError: (e: any) => toast.error(e?.message ?? 'Delete failed'),
  });
  const confirmDelete = useConfirmationDialog({
    title: 'Delete subtitle job',
    description:
      'This permanently removes the job record and its stored SRT files.',
    actionText: 'Delete',
    actionIntent: 'alert-subtle',
    onConfirm: () => pendingId && del.mutate(pendingId),
  });

  const total = query.data?.total;

  return (
    <PageWrapper className="p-4 sm:p-8 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2>Subtitle Translations</h2>
          <p className="text-[--muted]">
            {total != null
              ? `${total} job${total === 1 ? '' : 's'} · extracted & translated .srt files`
              : 'Extraction + AI translation jobs'}
          </p>
        </div>
      </div>

      <DashboardQueryBoundary
        query={query}
        errorTitle="Failed to load subtitle jobs"
      >
        {(d) =>
          d.jobs.length === 0 ? (
            <Card className="p-8 text-center text-[--muted]">
              <BiCaptions className="mx-auto mb-2 text-2xl opacity-60" />
              <p>No subtitle jobs yet.</p>
              <p className="text-xs mt-1">
                Jobs appear here after a user picks a “Translate Exact” subtitle
                entry while watching.
              </p>
            </Card>
          ) : (
            <Card className="p-0 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-[--muted] text-xs uppercase bg-[--subtle]/40">
                    <tr className="text-left">
                      <th className="p-3">Status</th>
                      <th className="p-3">Source file</th>
                      <th className="p-3">Content</th>
                      <th className="p-3">Language</th>
                      <th className="p-3 text-right">Cues</th>
                      <th className="p-3 text-right">Size</th>
                      <th className="p-3 text-right">Time taken</th>
                      <th className="p-3">Updated</th>
                      <th className="p-3">Files</th>
                      <th className="p-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.jobs.map((job) => (
                      <tr
                        key={job.id}
                        className="border-t border-[--border]/50 align-top hover:bg-[--subtle]/30"
                      >
                        <td className="p-3">
                          <span
                            className={cn(
                              'text-[10px] uppercase px-1.5 py-0.5 rounded border',
                              STATUS_BADGE[job.status]
                            )}
                            title={job.error ?? undefined}
                          >
                            {job.status}
                          </span>
                        </td>
                        <td className="p-3 max-w-[280px]">
                          <div
                            className="font-mono text-xs truncate"
                            title={job.filename ?? undefined}
                          >
                            {job.filename ?? '—'}
                          </div>
                          {job.status === 'failed' && job.error && (
                            <div className="text-[11px] text-red-500 mt-1 line-clamp-2">
                              {job.error}
                            </div>
                          )}
                        </td>
                        <td className="p-3 font-mono text-xs">
                          {job.contentId}
                        </td>
                        <td className="p-3 whitespace-nowrap">
                          <span className="text-[--muted]">
                            {job.sourceLang ?? '?'}
                          </span>
                          {' → '}
                          <span>{job.targetLang}</span>
                          {job.provider && (
                            <span className="text-[10px] text-[--muted] ml-1">
                              ({job.provider})
                            </span>
                          )}
                        </td>
                        <td className="p-3 text-right tabular-nums">
                          {job.cueCount ?? '—'}
                        </td>
                        <td className="p-3 text-right tabular-nums whitespace-nowrap">
                          {job.videoSize != null
                            ? formatBytes(job.videoSize)
                            : '—'}
                        </td>
                        <td className="p-3 text-right tabular-nums whitespace-nowrap">
                          {job.durationMs != null
                            ? formatDurationMs(job.durationMs)
                            : '—'}
                        </td>
                        <td className="p-3 whitespace-nowrap text-xs text-[--muted]">
                          {fmtTime(job.completedAt ?? job.updatedAt)}
                        </td>
                        <td className="p-3">
                          <div className="flex flex-col gap-1">
                            {job.extractedBytes > 0 && (
                              <a
                                className={DL_LINK}
                                href={`/api/v1/dashboard/subtitles/${job.id}/extracted.srt`}
                                download
                              >
                                <BiDownload /> Extracted
                              </a>
                            )}
                            {job.translatedBytes > 0 && (
                              <a
                                className={DL_LINK}
                                href={`/api/v1/dashboard/subtitles/${job.id}/translated.srt`}
                                download
                              >
                                <BiDownload /> Translated
                              </a>
                            )}
                            {job.extractedBytes === 0 &&
                              job.translatedBytes === 0 && (
                                <span className="text-[11px] text-[--muted]">
                                  —
                                </span>
                              )}
                          </div>
                        </td>
                        <td className="p-3">
                          <div className="flex justify-end">
                            <IconButton
                              size="sm"
                              intent="alert-subtle"
                              icon={<BiTrash />}
                              aria-label="Delete job"
                              onClick={() => {
                                setPendingId(job.id);
                                confirmDelete.open();
                              }}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )
        }
      </DashboardQueryBoundary>

      <p className="text-xs text-[--muted]">
        SRT files are stored with each job so they can be re-downloaded here.
        The extracted file is the original embedded track; the translated file
        is the machine-translated result served to the player.
      </p>

      <ConfirmationDialog {...confirmDelete} />
    </PageWrapper>
  );
}
