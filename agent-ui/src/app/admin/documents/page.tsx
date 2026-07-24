"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { LoadingScreen } from "@/components/ui/kit"

/** Consolidated route — redirects to the new tabbed page. */
export default function DocumentsRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace("/admin/overview/?tab=documents")
  }, [router])
  return <LoadingScreen label="Opening Overview" />
}
