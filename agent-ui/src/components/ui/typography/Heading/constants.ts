import { type HeadingSizeMap } from './types'

// Inside chat output a "heading" is a section label, not a page title —
// bagofwords caps them at ~16px semibold and steps down from there.
export const HEADING_SIZES: HeadingSizeMap = {
  1: 'text-base font-semibold font-inter',
  2: 'text-base font-semibold font-inter',
  3: 'text-[0.9375rem] font-inter font-semibold',
  4: 'text-[0.9375rem] font-inter font-semibold',
  5: 'text-sm font-semibold',
  6: 'text-sm font-semibold'
}
