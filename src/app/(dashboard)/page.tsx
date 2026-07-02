"use client"

import { useState, useEffect, useCallback } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  RefreshCw,
  CreditCard,
  User,
  Mail,
  Globe,
  Key,
  ShieldCheck,
  UserPlus,
} from "lucide-react"

function getKey() {
  return document.cookie.match(/z-api-key=([^;]+)/)?.[1] || ""
}

const RESOURCES = [
  { key: "cards", label: "支付卡", icon: CreditCard, color: "text-violet-600" },
  { key: "google", label: "谷歌账号", icon: User, color: "text-blue-600" },
  { key: "mailcom", label: "Mail.com", icon: Mail, color: "text-emerald-600" },
  { key: "proxies", label: "代理IP", icon: Globe, color: "text-orange-600" },
  { key: "codex", label: "Codex", icon: Key, color: "text-rose-600" },
  { key: "registered", label: "Claude官Key", icon: ShieldCheck, color: "text-indigo-600" },
  { key: "openai", label: "OpenAI官Key", icon: UserPlus, color: "text-cyan-600" },
  { key: "openaiPool", label: "OpenAI账号池", icon: User, color: "text-sky-600" },
]

export default function OverviewPage() {
  const [stats, setStats] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/stats", {
        headers: { "X-API-Key": getKey() },
      })
      if (res.ok) setStats(await res.json())
    } catch {
      /* ignore */
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">概览</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            资源池状态总览
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
          刷新
        </Button>
      </div>

      {!stats ? (
        <p className="text-sm text-muted-foreground">加载中...</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {RESOURCES.map(({ key, label, icon: Icon, color }) => {
            const s = stats[key] || {}
            const available = s.available ?? s.active ?? 0
            const total = s.total ?? 0
            const pct = total ? (available / total) * 100 : 0
            return (
              <Card key={key}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">{label}</CardTitle>
                    <Icon className={`h-4 w-4 ${color}`} />
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-semibold tabular-nums">
                    {available}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    可用 / 共 {total}
                    {s.allocated > 0 && (
                      <span className="ml-2">
                        · {s.allocated} 已分配
                      </span>
                    )}
                  </p>
                  <div className="mt-3 h-1.5 rounded-full bg-secondary overflow-hidden">
                    <div
                      className={`h-full rounded-full bg-current ${color} opacity-60`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
