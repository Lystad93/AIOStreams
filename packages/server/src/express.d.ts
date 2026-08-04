import 'express';
import { UserData, SessionUser } from '@aiostreams/core';
import type { RateLimitInfo } from 'express-rate-limit';

declare global {
  namespace Express {
    interface Request {
      userData?: UserData;
      userIp?: string;
      requestIp?: string;
      uuid?: string;
      user?: SessionUser;
      rateLimit?: RateLimitInfo;
    }
  }
}
