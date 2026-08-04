import { queryOptions } from '@tanstack/react-query';
import { getSession, listConfigProfiles, api } from './api';
import type { StatusResponse } from '@aiostreams/core';

export const sessionQuery = queryOptions({
  queryKey: ['session'] as const,
  queryFn: getSession,
  staleTime: 60_000,
  retry: false,
});

export const statusQuery = queryOptions({
  queryKey: ['status'] as const,
  queryFn: () => api<StatusResponse>('/status'),
  staleTime: 60_000,
  retry: false,
});

// 401s without a session, which is a normal state on the configure page.
export const configProfilesQuery = queryOptions({
  queryKey: ['config-profiles'] as const,
  queryFn: listConfigProfiles,
  staleTime: 30_000,
  retry: false,
});
