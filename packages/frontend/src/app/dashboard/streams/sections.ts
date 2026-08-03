import type { ElementType } from 'react';
import {
  BiBarChartAlt2,
  BiBlock,
  BiHistory,
  BiPlayCircle,
} from 'react-icons/bi';

/** The streams dashboard's sub-sections, shared by the layout, the router's
 *  search validator and the sidebar flyout. */
export type StreamsSectionId = 'active' | 'history' | 'bandwidth' | 'bans';

export const STREAMS_SECTIONS: {
  id: StreamsSectionId;
  label: string;
  icon: ElementType;
}[] = [
  { id: 'active', label: 'Active', icon: BiPlayCircle },
  { id: 'history', label: 'History', icon: BiHistory },
  { id: 'bandwidth', label: 'Bandwidth', icon: BiBarChartAlt2 },
  { id: 'bans', label: 'Blocks', icon: BiBlock },
];

export const DEFAULT_STREAMS_SECTION: StreamsSectionId = 'active';
