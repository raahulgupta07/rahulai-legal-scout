import { cn } from '@/lib/utils'

const Skeleton = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => {
  return (
    <div
      className={cn('animate-pulse rounded-none bg-[color-mix(in_srgb,var(--text)_10%,transparent)]', className)}
      {...props}
    />
  )
}

export { Skeleton }
