"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { LoadingScreen } from "@/components/ui/kit"

/** Consolidated route — redirects to the new tabbed page. */
export default function TemplatesRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace("/admin/registers/?tab=templates")
  }, [router])
  return <LoadingScreen label="Opening Registers" />
}
