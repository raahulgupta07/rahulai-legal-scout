'use client'

import { memo } from 'react'

import { toast } from 'sonner'

import { type VideoData } from '@/types/os'
import Icon from '@/components/ui/icon'

const VideoItem = memo(({ video }: { video: VideoData }) => {
  const videoUrl = video.url

  const handleDownload = async () => {
    try {
      toast.loading('Downloading video...')
      const response = await fetch(videoUrl)
      if (!response.ok) throw new Error('Network response was not ok')

      const blob = await response.blob()
      const fileExtension = videoUrl.split('.').pop() ?? 'mp4'
      const fileName = `video-${Date.now()}.${fileExtension}`

      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName

      document.body.appendChild(a)
      a.click()

      window.URL.revokeObjectURL(url)
      document.body.removeChild(a)
      toast.dismiss()
      toast.success('Video downloaded successfully')
    } catch {
      toast.dismiss()
      toast.error('Failed to download video')
    }
  }

  return (
    <div className="group relative w-full min-w-0 max-w-xl border-[2px] border-b-[3px] border-r-[3px] border-[var(--ink)] bg-[var(--surface-raised)] p-1">
      <video
        src={videoUrl}
        autoPlay
        muted
        loop
        controls
        className="block w-full max-w-full"
        style={{ aspectRatio: '16 / 9' }}
      />
      <button
        type="button"
        onClick={handleDownload}
        className="stamp-press absolute right-3 top-3 flex items-center justify-center border-[2px] border-b-[3px] border-r-[3px] border-[var(--ink)] bg-[var(--surface-raised)] p-1.5 text-[var(--ink)] opacity-0 outline-none transition-opacity duration-150 focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-[var(--ok-neon)] group-hover:opacity-100"
        style={{ borderRadius: 0 }}
        aria-label="Download video"
      >
        <Icon type="download" size="xs" />
      </button>
    </div>
  )
})

VideoItem.displayName = 'VideoItem'

const Videos = memo(({ videos }: { videos: VideoData[] }) => (
  <div className="flex w-full min-w-0 flex-col gap-3">
    {videos.map((video) => (
      <VideoItem key={video.id} video={video} />
    ))}
  </div>
))

Videos.displayName = 'Videos'

export default Videos
