import { Router } from 'express';
import {
  createLogger,
  createStreamBan,
  deleteStreamHistory,
  getBandwidthOverview,
  getLiveStreams,
  getStreamHistory,
  liftStreamBan,
  listStreamBans,
  stopStream,
  stopUserStreams,
  type BandwidthWindow,
  type StreamTransport,
} from '@aiostreams/core';
import { createResponse } from '../../../utils/responses.js';

const router: Router = Router();
const logger = createLogger('dashboard:streams');

const WINDOWS: BandwidthWindow[] = ['24h', '7d', '30d'];
const TRANSPORTS: StreamTransport[] = ['usenet', 'proxy'];

function username(req: { user?: { username?: string } }): string {
  return req.user?.username ?? 'admin';
}

function notFound(res: import('express').Response, message: string) {
  return res.status(404).json(
    createResponse({
      success: false,
      error: { code: 'NOT_FOUND', message },
    })
  );
}

function badRequest(res: import('express').Response, message: string) {
  return res.status(400).json(
    createResponse({
      success: false,
      error: { code: 'BAD_REQUEST', message },
    })
  );
}

// GET /dashboard/streams/live: one-shot active sessions, seeding the first
// render; /live/stream is what keeps the page current.
router.get('/live', async (_req, res, next) => {
  try {
    res
      .status(200)
      .json(createResponse({ success: true, data: await getLiveStreams() }));
  } catch (err) {
    next(err);
  }
});

const LIVE_TICK_MS = 1_500;
const LIVE_HEARTBEAT_MS = 15_000;

router.get('/live/stream', (req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let closed = false;
  let last = '';
  let inFlight = false;
  const tick = async () => {
    if (closed || inFlight) return;
    inFlight = true;
    try {
      const frame = JSON.stringify({
        ...(await getLiveStreams()),
        tickMs: LIVE_TICK_MS,
      });
      if (!closed && frame !== last) {
        last = frame;
        res.write(`data: ${frame}\n\n`);
      }
    } catch {
      /* skip a frame */
    } finally {
      inFlight = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), LIVE_TICK_MS);
  const hb = setInterval(() => res.write(':hb\n\n'), LIVE_HEARTBEAT_MS);

  req.on('close', () => {
    closed = true;
    clearInterval(timer);
    clearInterval(hb);
    res.end();
  });
});

// GET /dashboard/streams/history: finished sessions, newest first.
router.get('/history', async (req, res, next) => {
  try {
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);
    const transport = String(req.query.transport ?? '') as StreamTransport;
    const data = await getStreamHistory({
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
      username: String(req.query.username ?? '').trim() || undefined,
      transport: TRANSPORTS.includes(transport) ? transport : undefined,
      search: String(req.query.q ?? '').trim() || undefined,
    });
    res.status(200).json(createResponse({ success: true, data }));
  } catch (err) {
    next(err);
  }
});

// DELETE /dashboard/streams/history: remove finished sessions. Body `{ ids }`
// deletes just those; no body clears the lot. Bandwidth totals live in their
// own rollup table and are unaffected.
router.delete('/history', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as { ids?: unknown };
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((id): id is string => typeof id === 'string')
      : undefined;
    if (ids && ids.length === 0) {
      return badRequest(res, 'ids must not be empty');
    }
    const deleted = await deleteStreamHistory(ids);
    logger.info(
      { deleted, scope: ids ? 'selected' : 'all', by: username(req) },
      'stream history deleted'
    );
    res.status(200).json(createResponse({ success: true, data: { deleted } }));
  } catch (err) {
    next(err);
  }
});

// GET /dashboard/streams/bandwidth?window=24h|7d|30d: `30d` is the configured
// accounting period, so it matches whatever the limits count.
router.get('/bandwidth', async (req, res, next) => {
  try {
    const w = String(req.query.window ?? '30d') as BandwidthWindow;
    const overview = await getBandwidthOverview(
      WINDOWS.includes(w) ? w : '30d'
    );
    res.status(200).json(createResponse({ success: true, data: overview }));
  } catch (err) {
    next(err);
  }
});

// DELETE /dashboard/streams/sessions/:id: stop one stream.
router.delete('/sessions/:id', async (req, res, next) => {
  try {
    if (!(await stopStream(req.params.id))) {
      return notFound(res, 'stream not found');
    }
    logger.info(
      { id: req.params.id, by: username(req) },
      'stream stopped from the dashboard'
    );
    res
      .status(200)
      .json(createResponse({ success: true, data: { stopped: true } }));
  } catch (err) {
    next(err);
  }
});

// POST /dashboard/streams/users/:username/kill: stop everything for a user.
router.post('/users/:username/kill', async (req, res, next) => {
  try {
    const stopped = await stopUserStreams(req.params.username);
    logger.info(
      { username: req.params.username, stopped, by: username(req) },
      'stopped all streams for user'
    );
    res.status(200).json(createResponse({ success: true, data: { stopped } }));
  } catch (err) {
    next(err);
  }
});

// GET /dashboard/streams/bans: currently-effective bans.
router.get('/bans', (_req, res, next) => {
  try {
    res
      .status(200)
      .json(
        createResponse({ success: true, data: { bans: listStreamBans() } })
      );
  } catch (err) {
    next(err);
  }
});

// POST /dashboard/streams/bans: block a user, or one target for a user.
router.post('/bans', async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as {
      scope?: unknown;
      username?: unknown;
      targetKey?: unknown;
      reason?: unknown;
      durationMs?: unknown;
    };
    const scope = body.scope === 'target' ? 'target' : 'user';
    if (typeof body.username !== 'string' || !body.username.trim()) {
      return badRequest(res, 'username is required');
    }
    if (scope === 'target' && typeof body.targetKey !== 'string') {
      return badRequest(res, 'targetKey is required for a target ban');
    }
    const durationMs =
      typeof body.durationMs === 'number' && body.durationMs > 0
        ? body.durationMs
        : undefined;
    const ban = await createStreamBan({
      scope,
      username: body.username.trim(),
      targetKey: scope === 'target' ? (body.targetKey as string) : undefined,
      reason: typeof body.reason === 'string' ? body.reason : undefined,
      createdBy: username(req),
      durationMs,
    });
    // The flush pass would catch these within a tick; this makes it immediate.
    // A target ban only stops that target.
    const stopped = await stopUserStreams(ban.username, ban.targetKey);
    res
      .status(200)
      .json(createResponse({ success: true, data: { ban, stopped } }));
  } catch (err) {
    next(err);
  }
});

// DELETE /dashboard/streams/bans/:id: lift a ban early.
router.delete('/bans/:id', async (req, res, next) => {
  try {
    if (!(await liftStreamBan(req.params.id))) {
      return notFound(res, 'ban not found');
    }
    res
      .status(200)
      .json(createResponse({ success: true, data: { lifted: true } }));
  } catch (err) {
    next(err);
  }
});

export default router;
