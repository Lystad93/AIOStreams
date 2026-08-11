import { APIError, constants, resolveConfigAlias } from '@aiostreams/core';
import { Router, Request, Response } from 'express';

const router: Router = Router();

interface AliasParams {
  alias: string;
  wildcardPath?: string | string[]; // optional (wildcard route)
}

router.get(
  '/:alias/*wildcardPath',
  async (req: Request<AliasParams>, res: Response) => {
    const { alias } = req.params;
    let { wildcardPath } = req.params;
    if (Array.isArray(wildcardPath)) {
      wildcardPath = wildcardPath.join('/');
    }

    const configuration = await resolveConfigAlias(alias);
    if (!configuration) {
      throw new APIError(constants.ErrorCode.USER_INVALID_DETAILS);
    }

    const redirectPath = `/stremio/${configuration.uuid}/${configuration.encryptedPassword}${wildcardPath ? `/${wildcardPath}` : ''}`;

    // Keep the query string: it carries the config variant selector.
    const queryIndex = req.originalUrl.indexOf('?');
    const query = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);

    res.redirect(`${redirectPath}${query}`);
  }
);

export default router;
