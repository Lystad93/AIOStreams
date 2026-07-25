import { Router, Request, Response } from 'express';
import { SubtitleJobRepository, createLogger } from '@aiostreams/core';
import { createResponse } from '../../utils/responses.js';

/**
 * Dashboard endpoints for the subtitle extraction+translation feature (spec
 * §4.2/§4.4). Mounted under `/dashboard/subtitles`, which is already admin-only.
 *
 *  - `GET /`                       → recent jobs (metadata; no SRT bodies)
 *  - `GET /:id/extracted.srt`      → download the extracted (source) SRT
 *  - `GET /:id/translated.srt`     → download the translated SRT
 *  - `DELETE /:id`                 → remove a job record + its stored SRTs
 */
const logger = createLogger('dashboard');
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

/** Derive a friendly download filename from the source release name. */
function downloadName(
  filename: string | undefined,
  which: 'extracted' | 'translated'
): string {
  const base = (filename ?? 'subtitle')
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/[\r\n"\\/]/g, '_')
    .slice(0, 150);
  return `${base}.${which}.srt`;
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
          `attachment; filename="${downloadName(data.filename, which)}"`
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
