import type { Metadata } from 'next'
import { DM_Mono, Geist, Space_Grotesk } from 'next/font/google'
import { NuqsAdapter } from 'nuqs/adapters/next/app'
import { Toaster } from '@/components/ui/sonner'
import AuthGuard from '@/components/AuthGuard'
import './globals.css'

const geistSans = Geist({
  variable: '--font-geist-sans',
  weight: '400',
  subsets: ['latin']
})

const dmMono = DM_Mono({
  subsets: ['latin'],
  variable: '--font-dm-mono',
  weight: '400'
})

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-space-grotesk',
  weight: ['300', '400', '500', '600', '700']
})

export const metadata: Metadata = {
  title: 'Legal Scout',
  description:
    'AI Document Assistant - Powered by Legal Scout'
}

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode
}>) {
  // data-theme is pinned to light for now: the token layer defines a dark
  // ground behind a prefers-color-scheme rule, and this attribute is what
  // keeps a dark-OS machine looking exactly like it does today. Phase 2+
  // replaces the literal with a real toggle.
  return (
    <html lang="en" data-theme="light">
      <body className={`${geistSans.variable} ${dmMono.variable} ${spaceGrotesk.variable} antialiased`}>
        <AuthGuard>
          <NuqsAdapter>{children}</NuqsAdapter>
        </AuthGuard>
        <Toaster position="top-right" duration={3000} visibleToasts={2} />
      </body>
    </html>
  )
}
