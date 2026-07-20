import { memo } from 'react'

import { type ImageData } from '@/types/os'
import { cn } from '@/lib/utils'

const Images = ({ images }: { images: ImageData[] }) => (
  <div
    className={cn(
      'grid w-full max-w-xl gap-3',
      images.length > 1 ? 'grid-cols-2' : 'grid-cols-1'
    )}
  >
    {images.map((image) => (
      <div
        key={image.url}
        className="group relative min-w-0 border-[2px] border-b-[3px] border-r-[3px] border-[var(--ink)] bg-[var(--surface-raised)] p-1"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={image.url}
          alt={image.revised_prompt || 'AI generated image'}
          className="block h-auto w-full max-w-full"
          onError={(e) => {
            const parent = e.currentTarget.parentElement
            if (parent) {
              parent.innerHTML = `
                    <div class="flex h-40 flex-col items-center justify-center gap-2 bg-[var(--bg)] p-3">
                      <p class="text-[11px] font-black uppercase tracking-[0.1em] text-[var(--danger-strong)]">Image unavailable</p>
                      <a href="${image.url}" target="_blank" rel="noopener noreferrer" class="block w-full max-w-full truncate text-center text-[11px] underline text-[var(--ink)]">
                        ${image.url}
                      </a>
                    </div>
                  `
            }
          }}
        />
      </div>
    ))}
  </div>
)

export default memo(Images)

Images.displayName = 'Images'
