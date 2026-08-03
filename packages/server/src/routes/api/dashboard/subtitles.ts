import { Router, Request, Response } from 'express';
import {
  SubtitleJobRepository,
  buildSubtitleFilename,
  createLogger,
} from '@aiostreams/core';
import { createResponse } from '../../../utils/responses.js';

/**
 * Dashboard endpoints for the subtitle extraction+translation feature (spec
 * §4.2/§4.4). Mounted under `/dashboard/subtitles`, which is already admin-only.
 *
 *  - `GET /`                       → recent jobs (metadata; no SRT bodies)
 *  - `GET /:id/extracted.srt`      → download the extracted (source) SRT
 *  - `GET /:id/translated.srt`     → download the translated SRT
 *  - `DELETE /:id`                 → remove a job record + its stored SRTs
 */
const logger = createLogger('dashboard:subtitles');
const router: Router = Router();

router.get('/', async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const [jobs, total] = await Promise.all([
    SubtitleJobRepository.list({ limit, offset }),
    SubtitleJobRepository.count(),
  ]);
  res
    .status(200)
    .json(
      createResponse({ success: true, data: { jobs, total, limit, offset } })
    );
});

/**
 * Name the download the way players expect (`<release>.<lang>.srt`), so it can
 * be dropped next to the video file and picked up automatically.
 */
function downloadName(
  job: { filename?: string; sourceLang?: string; targetLang?: string },
  which: 'extracted' | 'translated'
): string {
  const language = which === 'extracted' ? job.sourceLang : job.targetLang;
  return buildSubtitleFilename({
    releaseName: job.filename,
    language,
    // Distinguish the two files when both ended up in the same language.
    suffix:
      which === 'extracted' &&
      job.sourceLang &&
      job.targetLang &&
      job.sourceLang === job.targetLang
        ? 'source'
        : undefined,
  });
}

function serveSrt(which: 'extracted' | 'translated') {
  return async (req: Request<{ id: string }>, res: Response) => {
    try {
      const data = await SubtitleJobRepository.getSrt(req.params.id, which);
      if (!data) {
        res
          .status(404)
          .json(createResponse({ success: false, detail: 'Not found' }));
        return;
      }
      res
        .status(200)
        .set('content-type', 'application/x-subrip; charset=utf-8')
        .set(
          'content-disposition',
          `attachment; filename="${downloadName(data, which)}"`
        )
        .set('cache-control', 'no-store')
        .send(data.srt);
    } catch (error) {
      logger.error(
        `subtitle download error: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      res
        .status(500)
        .json(createResponse({ success: false, detail: 'Download failed' }));
    }
  };
}

router.get('/:id/extracted.srt', serveSrt('extracted'));
router.get('/:id/translated.srt', serveSrt('translated'));

router.delete('/:id', async (req: Request<{ id: string }>, res: Response) => {
  await SubtitleJobRepository.delete(req.params.id);
  res
    .status(200)
    .json(createResponse({ success: true, data: { deleted: true } }));
});

export default router;
