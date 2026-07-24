"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { LoadingScreen } from "@/components/ui/kit"

/** Consolidated route — redirects to the new tabbed page. */
export default function DashboardRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace("/admin/overview/?tab=dashboard")
  }, [router])
  return <LoadingScreen label="Opening Overview" />
}
