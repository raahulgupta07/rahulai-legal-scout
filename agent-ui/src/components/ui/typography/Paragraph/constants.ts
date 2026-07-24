import { type ParagraphSizeMap } from './types'

// Chat-output type scale, matched to the bagofwords/Insights chat: body copy
// at 14px with a relaxed line, small variants stepping down from there.
export const PARAGRAPH_SIZES: ParagraphSizeMap = {
  xs: 'text-xs',
  sm: 'text-sm',
  default: 'text-sm',
  lg: 'text-base',
  lead: 'font-inter text-[0.9375rem] font-semibold leading-6 tracking-[-0.01em]',
  title: 'font-inter text-[0.875rem] font-semibold leading-5 tracking-[-0.01em]',
  body: 'font-inter text-[0.875rem] font-normal leading-[1.625] tracking-[-0.006em]',
  mono: 'font-dmmono text-[0.75rem] font-normal leading-[1.125rem] tracking-[-0.02em]',
  xsmall:
    'font-inter text-[0.8125rem] font-normal leading-5 tracking-[-0.01em]'
}
