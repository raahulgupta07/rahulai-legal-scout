import type { Metadata } from 'next'
import { NuqsAdapter } from 'nuqs/adapters/next/app'
import { Toaster } from '@/components/ui/sonner'
import AuthGuard from '@/components/AuthGuard'
import './globals.css'

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
  // No data-theme attribute: the token layer now carries a real dark ground,
  // so leaving it off lets prefers-color-scheme decide. Setting data-theme to
  // "light" or "dark" on <html> still overrides the OS in either direction —
  // globals.css restates both themes under the attribute for exactly that.
  return (
    <html lang="en">
      <body className="antialiased">
        <AuthGuard>
          <NuqsAdapter>{children}</NuqsAdapter>
        </AuthGuard>
        <Toaster position="top-right" duration={3000} visibleToasts={2} />
      </body>
    </html>
  )
}
