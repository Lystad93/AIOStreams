import type { ElementType } from 'react';
import { BiLibrary, BiBarChartAlt2, BiServer, BiCog } from 'react-icons/bi';

/** The usenet dashboard's sub-sections, shared by the page, the URL search
 *  param validator (router) and the sidebar hover flyout. Live streams are not
 *  here: they live on the unified `/dashboard/streams` page alongside proxy
 *  streams. */
export type SectionId = 'library' | 'stats' | 'providers' | 'settings';

export const SECTIONS: { id: SectionId; label: string; icon: ElementType }[] = [
  { id: 'library', label: 'Library', icon: BiLibrary },
  { id: 'stats', label: 'Stats', icon: BiBarChartAlt2 },
  { id: 'providers', label: 'Providers', icon: BiServer },
  { id: 'settings', label: 'Settings', icon: BiCog },
];

export const DEFAULT_SECTION: SectionId = 'library';
