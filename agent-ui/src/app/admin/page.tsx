"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { LoadingScreen } from "@/components/ui/kit"

/** /admin has no content of its own — the dashboard is the landing screen. */
export default function AdminPage() {
  const router = useRouter()
  useEffect(() => {
    router.replace("/admin/dashboard")
  }, [router])

  // Shown for the frame before the redirect lands, instead of a white flash.
  return <LoadingScreen label="Opening the dashboard" />
}
