"use client"

import { useState, useEffect, useCallback, Fragment } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  RefreshCw,
  Plus,
  Trash2,
  Play,
  X,
  Server,
  ChevronDown,
  ChevronUp,
  Pencil,
  Crosshair,
} from "lucide-react"

function getKey() {
  return document.cookie.match(/z-api-key=([^;]+)/)?.[1] || ""
}

function timeAgo(iso: string) {
  if (!iso) return "—"
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 10) return "刚刚"
  if (diff < 60) return `${Math.floor(diff)}秒前`
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`
  return `${Math.floor(diff / 86400)}天前`
}

function duration(start: string, end?: string) {
  if (!start) return "—"
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

const MASK = (s: string) => (s && s.length > 8 ? s.slice(0, 4) + "····" + s.slice(-4) : s || "—")

const STATUS_MAP: Record<string, { variant: "default" | "success" | "destructive" | "warning" | "secondary" | "outline"; label: string }> = {
  pending: { variant: "secondary", label: "等待中" },
  dispatching: { variant: "default", label: "分发中" },
  running: { variant: "warning", label: "运行中" },
  success: { variant: "success", label: "成功" },
  failed: { variant: "destructive", label: "失败" },
  cancelled: { variant: "outline", label: "已取消" },
}

const ACTION_LABEL: Record<string, string> = {
  "claude-platform-bindcard": "Claude官Key",
  "platform-bindcard": "OpenAI官Key",
}

const INPUT_CLS = "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
const SELECT_CLS = INPUT_CLS + " appearance-none"

export default function WorkersPage() {
  const [stats, setStats] = useState<any>(null)
  const [workers, setWorkers] = useState<any[]>([])
  const [tasks, setTasks] = useState<any[]>([])
  const [tasksTotal, setTasksTotal] = useState(0)
  const [tasksPage, setTasksPage] = useState(1)
  const [taskFilter, setTaskFilter] = useState("")
  const [expandedTask, setExpandedTask] = useState<string | null>(null)
  const [taskLog, setTaskLog] = useState("")
  const [loading, setLoading] = useState(true)
  const [brands, setBrands] = useState<any[]>([])

  // Dialogs
  const [showAddWorker, setShowAddWorker] = useState(false)
  const [dispatching, setDispatching] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [preview, setPreview] = useState<any>(null)

  // Add worker form
  const [wName, setWName] = useState("")
  const [wUrl, setWUrl] = useState("")
  const [wToken, setWToken] = useState("")
  const [wMax, setWMax] = useState(5)

  // Edit worker
  const [editWorker, setEditWorker] = useState<any>(null)
  const [ewName, setEwName] = useState("")
  const [ewMax, setEwMax] = useState(5)

  // Dispatch form — restore from localStorage
  const [dAction, setDAction] = useState("claude-platform-bindcard")
  const [dWorker, setDWorker] = useState("auto")
  const [dCount, setDCount] = useState(1)
  const [dAmount, setDAmount] = useState(5)
  const [dSpendLimit, setDSpendLimit] = useState(1000)
  const [dBrand, setDBrand] = useState("")
  const [dEmailSource, setDEmailSource] = useState("mailcom")

  useEffect(() => {
    try {
      const saved = localStorage.getItem("z-dispatch-form")
      if (saved) {
        const s = JSON.parse(saved)
        if (s.action) setDAction(s.action)
        if (s.worker) setDWorker(s.worker)
        if (s.count) setDCount(s.count)
        if (s.amount) setDAmount(s.amount)
        if (s.spendLimit) setDSpendLimit(s.spendLimit)
        if (s.brand) setDBrand(s.brand)
        if (s.emailSource) setDEmailSource(s.emailSource)
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    localStorage.setItem("z-dispatch-form", JSON.stringify({
      action: dAction, worker: dWorker, count: dCount,
      amount: dAmount, spendLimit: dSpendLimit, brand: dBrand, emailSource: dEmailSource,
    }))
  }, [dAction, dWorker, dCount, dAmount, dSpendLimit, dBrand, dEmailSource])

  // Auto-push bullets (server-side)
  const [autoPush, setAutoPush] = useState(false)
  const [autoPushLog, setAutoPushLog] = useState("")
  const [hubUrl, setHubUrl] = useState("http://38.34.191.113:3104")
  const [hubPoolCount, setHubPoolCount] = useState<number | null>(null)

  const fetchAutoPushStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/auto-push", { headers: hdrs() })
      if (res.ok) {
        const s = await res.json()
        setAutoPush(s.enabled)
        setHubUrl(s.hubUrl || "http://38.34.191.113:3104")
        setAutoPushLog(s.log || "")
        if (s.hubPoolCount !== null && s.hubPoolCount !== undefined) setHubPoolCount(s.hubPoolCount)
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { fetchAutoPushStatus() }, [fetchAutoPushStatus])

  // Poll status every 5s to show latest log
  useEffect(() => {
    const t = setInterval(fetchAutoPushStatus, 5000)
    return () => clearInterval(t)
  }, [fetchAutoPushStatus])

  const toggleAutoPush = async () => {
    const newEnabled = !autoPush
    try {
      const res = await fetch("/api/auto-push", {
        method: "POST", headers: hdrs(),
        body: JSON.stringify({ enabled: newEnabled, hubUrl }),
      })
      if (res.ok) {
        const s = await res.json()
        setAutoPush(s.enabled)
        setAutoPushLog(s.log || "")
      }
    } catch { /* ignore */ }
  }

  const hdrs = () => ({ "X-API-Key": getKey(), "Content-Type": "application/json" })

  const load = useCallback(async () => {
    try {
      const platform = dAction === "claude-platform-bindcard" ? "claudePlatform" : "openaiPlatform"
      const [statsRes, workersRes, tasksRes, brandsRes] = await Promise.all([
        fetch("/api/stats", { headers: hdrs() }),
        fetch("/api/workers", { headers: hdrs() }),
        fetch(`/api/dispatch?pageSize=30&page=${tasksPage}${taskFilter ? `&status=${taskFilter}` : ""}`, { headers: hdrs() }),
        fetch(`/api/brands?platform=${platform}&minBalance=${dAmount}`, { headers: hdrs() }),
      ])
      if (statsRes.ok) setStats(await statsRes.json())
      if (workersRes.ok) setWorkers(await workersRes.json())
      if (tasksRes.ok) {
        const d = await tasksRes.json()
        setTasks(d.tasks || [])
        setTasksTotal(d.total || 0)
      }
      if (brandsRes.ok) {
        const b = await brandsRes.json()
        setBrands(b.details || [])
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [tasksPage, taskFilter, dAction, dAmount])

  useEffect(() => { load() }, [load])

  // Auto-refresh every 10s
  useEffect(() => {
    const timer = setInterval(load, 10000)
    return () => clearInterval(timer)
  }, [load])

  const addWorker = async () => {
    if (!wName || !wUrl) return
    await fetch("/api/workers", {
      method: "POST", headers: hdrs(),
      body: JSON.stringify({ name: wName, baseUrl: wUrl.replace(/\/$/, ""), token: wToken, maxTasks: wMax }),
    })
    setShowAddWorker(false)
    setWName(""); setWUrl(""); setWToken(""); setWMax(5)
    load()
  }

  const deleteWorker = async (id: string) => {
    if (!confirm("确定删除此 Worker？")) return
    await fetch(`/api/workers/${id}`, { method: "DELETE", headers: hdrs() })
    load()
  }

  const toggleWorker = async (id: string, status: string) => {
    await fetch(`/api/workers/${id}`, { method: "PUT", headers: hdrs(), body: JSON.stringify({ status }) })
    load()
  }

  const openEditWorker = (w: any) => {
    setEditWorker(w)
    setEwName(w.name)
    setEwMax(w.maxTasks)
  }

  const saveEditWorker = async () => {
    if (!editWorker) return
    await fetch("/api/workers", {
      method: "POST", headers: hdrs(),
      body: JSON.stringify({ id: editWorker.id, name: ewName, baseUrl: editWorker.baseUrl, token: editWorker.token, maxTasks: ewMax }),
    })
    setEditWorker(null)
    load()
  }

  const loadPreview = async () => {
    const platform = dAction === "claude-platform-bindcard" ? "claudePlatform" : "openaiPlatform"
    const isClaude = dAction === "claude-platform-bindcard"
    const emailEndpoint = isClaude ? dEmailSource : "openai-pool"

    const fetches: Promise<Response>[] = [
      fetch(`/api/${emailEndpoint}/pull`, { method: "POST", headers: hdrs(), body: JSON.stringify({ count: dCount, machineId: "preview", preview: true }) }),
      fetch("/api/cards/pull", { method: "POST", headers: hdrs(), body: JSON.stringify({ count: dCount, machineId: "preview", platform, brand: dBrand || undefined, preview: true }) }),
      fetch("/api/proxies/pull", { method: "POST", headers: hdrs(), body: JSON.stringify({ count: dCount, machineId: "preview", preview: true }) }),
    ]
    if (isClaude) {
      fetches.push(fetch("/api/addresses/stats", { headers: hdrs() }))
    }

    const results = await Promise.all(fetches)
    const emails = results[0].ok ? await results[0].json() : {}
    const cards = results[1].ok ? await results[1].json() : {}
    const proxies = results[2].ok ? await results[2].json() : {}
    const addrStats = isClaude && results[3]?.ok ? await results[3].json() : null

    setPreview({
      emails: emails.accounts || emails.items || [],
      cards: cards.cards || cards.items || [],
      proxies: proxies.proxies || proxies.items || [],
      addressAvailable: addrStats?.available ?? null,
      isClaude,
    })
    setShowPreview(true)
  }

  const dispatch = async () => {
    setDispatching(true)
    const params: any = { amount: dAmount, emailSource: dEmailSource }
    if (dBrand) params.brand = dBrand
    if (dAction === "platform-bindcard") params.spendLimit = dSpendLimit

    await fetch("/api/dispatch/batch", {
      method: "POST", headers: hdrs(),
      body: JSON.stringify({
        action: dAction, count: dCount, params,
        workerIds: dWorker === "auto" ? undefined : [dWorker],
      }),
    })
    setDispatching(false)
    setShowPreview(false)
    load()
  }

  const cancelTask = async (id: string) => {
    await fetch(`/api/dispatch/${id}/cancel`, { method: "POST", headers: hdrs() })
    load()
  }

  const toggleLog = async (id: string) => {
    if (expandedTask === id) { setExpandedTask(null); return }
    setExpandedTask(id)
    try {
      const res = await fetch(`/api/dispatch/${id}/log`, { headers: hdrs() })
      if (res.ok) setTaskLog((await res.json()).log || "(空)")
    } catch { setTaskLog("加载失败") }
  }

  const onlineWorkers = workers.filter((w: any) => w.status === "online")

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Worker 调度</h2>
          <p className="text-sm text-muted-foreground mt-0.5">管理工作节点、调度自动化任务</p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />
          刷新
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Workers 在线", value: `${stats?.workers?.online ?? 0}/${stats?.workers?.total ?? 0}`, color: "text-emerald-600" },
          { label: "运行中", value: stats?.tasks?.running ?? 0, color: "text-amber-600" },
          { label: "成功", value: stats?.tasks?.success ?? 0, color: "text-emerald-600" },
          { label: "失败", value: stats?.tasks?.failed ?? 0, color: "text-red-600" },
        ].map(({ label, value, color }) => (
          <Card key={label}>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className={`text-2xl font-semibold tabular-nums mt-1 ${color}`}>{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Workers */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium">工作节点</h3>
          <Button size="sm" variant="outline" onClick={() => setShowAddWorker(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" />添加
          </Button>
        </div>
        {workers.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">暂无 Worker</p>
        ) : (
          <div className="border rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="text-left px-3 py-2 font-medium text-xs">名称</th>
                  <th className="text-left px-3 py-2 font-medium text-xs">地址</th>
                  <th className="text-left px-3 py-2 font-medium text-xs">状态</th>
                  <th className="text-left px-3 py-2 font-medium text-xs">任务</th>
                  <th className="text-left px-3 py-2 font-medium text-xs">心跳</th>
                  <th className="text-left px-3 py-2 font-medium text-xs w-28">操作</th>
                </tr>
              </thead>
              <tbody>
                {workers.map((w: any) => (
                  <tr key={w.id} className={`border-b last:border-0 hover:bg-muted/20 ${w.status === "disabled" ? "opacity-50" : ""}`}>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <Server className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-medium">{w.name}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground truncate max-w-[200px]">{w.baseUrl}</td>
                    <td className="px-3 py-2">
                      <Badge variant={w.status === "online" ? "default" : w.status === "disabled" ? "destructive" : "secondary"}>{w.status === "disabled" ? "已禁用" : w.status}</Badge>
                    </td>
                    <td className="px-3 py-2 text-xs tabular-nums">{w.runningTasks}/{w.maxTasks}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{timeAgo(w.lastHeartbeat)}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        {w.status === "disabled" ? (
                          <button onClick={() => toggleWorker(w.id, "online")} className="text-xs text-green-600 hover:underline">启用</button>
                        ) : (
                          <button onClick={() => toggleWorker(w.id, "disabled")} className="text-xs text-muted-foreground hover:text-amber-600">禁用</button>
                        )}
                        <button onClick={() => openEditWorker(w)} className="text-muted-foreground hover:text-foreground transition-colors"><Pencil className="h-3 w-3" /></button>
                        <button onClick={() => deleteWorker(w.id)} className="text-muted-foreground hover:text-destructive transition-colors"><Trash2 className="h-3 w-3" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Dispatch */}
      <div>
        <h3 className="text-sm font-medium mb-3">任务调度</h3>
        <Card>
          <CardContent className="pt-4 pb-4 space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3 items-end">
              <div>
                <Label className="text-xs mb-1 block">类型</Label>
                <select value={dAction} onChange={e => setDAction(e.target.value)} className={SELECT_CLS}>
                  <option value="claude-platform-bindcard">Claude官Key</option>
                  <option value="platform-bindcard">OpenAI官Key</option>
                </select>
              </div>
              <div>
                <Label className="text-xs mb-1 block">邮箱来源</Label>
                <select value={dEmailSource} onChange={e => setDEmailSource(e.target.value)} className={SELECT_CLS}>
                  <option value="mailcom">Mail.com</option>
                  <option value="outlook">Outlook</option>
                </select>
              </div>
              <div>
                <Label className="text-xs mb-1 block">Worker</Label>
                <select value={dWorker} onChange={e => setDWorker(e.target.value)} className={SELECT_CLS}>
                  <option value="auto">自动分配</option>
                  {onlineWorkers.map((w: any) => (
                    <option key={w.id} value={w.id}>{w.name} ({w.runningTasks}/{w.maxTasks})</option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-xs mb-1 block">卡品牌</Label>
                <select value={dBrand} onChange={e => setDBrand(e.target.value)} className={SELECT_CLS}>
                  <option value="">不限</option>
                  {brands.map((b: any) => (
                    <option key={b.brand} value={b.brand}>
                      {b.brand} ({b.available}卡/{b.remainingUses}次)
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-xs mb-1 block">数量</Label>
                <Input type="number" min={1} max={100} value={dCount} onChange={e => setDCount(+e.target.value)} className="h-9" />
              </div>
              <div>
                <Label className="text-xs mb-1 block">充值金额</Label>
                <Input type="number" min={1} value={dAmount} onChange={e => setDAmount(+e.target.value)} className="h-9" />
              </div>
              {dAction === "platform-bindcard" && (
                <div>
                  <Label className="text-xs mb-1 block">消费上限</Label>
                  <Input type="number" min={1} value={dSpendLimit} onChange={e => setDSpendLimit(+e.target.value)} className="h-9" />
                </div>
              )}
              <div>
                <Button variant="outline" onClick={loadPreview} disabled={onlineWorkers.length === 0} className="w-full h-9">
                  预览调度
                </Button>
              </div>
            </div>

            {/* Estimate */}
            {stats && (() => {
              const isClaude = dAction === "claude-platform-bindcard"
              const emailAvail = isClaude ? (dEmailSource === "outlook" ? (stats.outlook?.available ?? 0) : (stats.mailcom?.available ?? 0)) : (stats.openaiPool?.available ?? 0)
              const selectedBrand = brands.find((b: any) => b.brand === dBrand)
              const cardUses = dBrand
                ? (selectedBrand?.remainingUses ?? 0)
                : brands.reduce((s: number, b: any) => s + (b.remainingUses ?? 0), 0)
              const proxyAvail = stats.proxies?.available ?? 0
              const parts = [emailAvail, cardUses, proxyAvail]
              if (isClaude) parts.push(stats.addresses?.available ?? 0)
              const maxCanDo = Math.min(...parts)
              return (
                <div className="flex items-center gap-4 text-xs text-muted-foreground border-t pt-3">
                  <span>可调度估算: <strong className="text-foreground tabular-nums">{maxCanDo}</strong></span>
                  <span className="text-muted-foreground/60">|</span>
                  <span>邮箱 <strong className="tabular-nums">{emailAvail}</strong></span>
                  <span>卡剩余次数 <strong className="tabular-nums">{cardUses}</strong>{dBrand && <span className="text-muted-foreground/60"> ({dBrand})</span>}</span>
                  <span>代理 <strong className="tabular-nums">{proxyAvail}</strong></span>
                  {isClaude && <span>地址 <strong className="tabular-nums">{stats.addresses?.available ?? 0}</strong></span>}
                </div>
              )
            })()}

            {/* Preview panel */}
            {showPreview && preview && (() => {
              const { emails, cards, proxies, addressAvailable, isClaude } = preview
              let minAvail = Math.min(emails.length, cards.length, proxies.length)
              if (isClaude && addressAvailable !== null) minAvail = Math.min(minAvail, addressAvailable)
              const canDispatch = dCount <= minAvail && onlineWorkers.length > 0

              return (
                <div className="border rounded-md bg-muted/20">
                  <div className="flex items-center justify-between px-4 pt-3 pb-2">
                    <p className="text-sm font-medium">调度预览 · {dCount} 个任务</p>
                    <button onClick={() => setShowPreview(false)} className="text-muted-foreground hover:text-foreground">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="max-h-60 overflow-y-auto px-4">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-muted/60">
                        <tr className="border-b">
                          <th className="text-left py-1.5 font-medium w-8">#</th>
                          <th className="text-left py-1.5 font-medium">邮箱</th>
                          <th className="text-left py-1.5 font-medium">卡品牌</th>
                          <th className="text-left py-1.5 font-medium">卡号</th>
                          <th className="text-left py-1.5 font-medium">代理IP</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from({ length: dCount }).map((_, i) => (
                          <tr key={i} className="border-b last:border-0">
                            <td className="py-1.5 text-muted-foreground tabular-nums">{i + 1}</td>
                            <td className="py-1.5">{emails[i]?.email || <span className="text-red-500">不足</span>}</td>
                            <td className="py-1.5">{cards[i]?.brand || "—"}</td>
                            <td className="py-1.5 font-mono">{cards[i]?.cardNumber ? MASK(cards[i].cardNumber) : <span className="text-red-500">不足</span>}</td>
                            <td className="py-1.5 font-mono">{proxies[i] ? `${proxies[i].host}:${proxies[i].port}` : <span className="text-red-500">不足</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="px-4 py-3 flex items-center justify-between border-t">
                    <p className="text-xs text-muted-foreground">
                      {emails.length} 邮箱 · {cards.length} 卡 · {proxies.length} 代理
                      {isClaude && addressAvailable !== null && <> · {addressAvailable} 地址</>}
                      {!canDispatch && <span className="text-red-500 ml-2">{onlineWorkers.length === 0 ? "无在线Worker" : "资源不足"}</span>}
                    </p>
                    <Button onClick={dispatch} disabled={dispatching || !canDispatch} size="sm">
                      <Play className="h-3.5 w-3.5 mr-1" />
                      {dispatching ? "调度中..." : `确认调度 ${dCount} 个`}
                    </Button>
                  </div>
                </div>
              )
            })()}
          </CardContent>
        </Card>
      </div>

      {/* Auto-push bullets */}
      <div>
        <h3 className="text-sm font-medium mb-3">自动录入子弹</h3>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2 min-w-0">
                <Label className="text-xs whitespace-nowrap">中枢地址</Label>
                <input
                  value={hubUrl}
                  onChange={e => setHubUrl(e.target.value)}
                  className="h-8 w-56 rounded-md border border-input bg-background px-2.5 text-xs font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  disabled={autoPush}
                />
              </div>
              {hubPoolCount !== null && (
                <span className="text-xs text-muted-foreground border border-border rounded-md px-2 py-1">
                  中枢池: <strong className="text-foreground tabular-nums">{hubPoolCount}</strong>
                </span>
              )}
              <Button
                size="sm"
                variant={autoPush ? "destructive" : "default"}
                onClick={toggleAutoPush}
              >
                <Crosshair className={`h-3.5 w-3.5 mr-1.5 ${autoPush ? "animate-pulse" : ""}`} />
                {autoPush ? "停止自动推送" : "开启自动推送"}
              </Button>
              {autoPushLog && (
                <span className={`text-xs ${autoPushLog.includes("失败") || autoPushLog.includes("错误") ? "text-destructive" : "text-muted-foreground"}`}>
                  {autoPushLog}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tasks */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium">任务列表</h3>
          <div className="flex gap-1">
            {[
              { key: "", label: "全部" },
              { key: "running", label: "运行中" },
              { key: "success", label: "成功" },
              { key: "failed", label: "失败" },
            ].map(f => (
              <button
                key={f.key}
                onClick={() => { setTaskFilter(f.key); setTasksPage(1) }}
                className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                  taskFilter === f.key ? "bg-secondary text-foreground font-medium" : "text-muted-foreground hover:bg-secondary/50"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">暂无任务</p>
        ) : (
          <div className="border rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="text-left px-3 py-2 font-medium text-xs">ID</th>
                  <th className="text-left px-3 py-2 font-medium text-xs">Worker</th>
                  <th className="text-left px-3 py-2 font-medium text-xs">类型</th>
                  <th className="text-left px-3 py-2 font-medium text-xs">状态</th>
                  <th className="text-left px-3 py-2 font-medium text-xs">耗时</th>
                  <th className="text-left px-3 py-2 font-medium text-xs">错误</th>
                  <th className="text-left px-3 py-2 font-medium text-xs w-20">操作</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t: any) => {
                  const s = STATUS_MAP[t.status] || { variant: "secondary" as const, label: t.status }
                  const wk = workers.find((w: any) => w.id === t.workerId)
                  const isExpanded = expandedTask === t.id
                  return (
                    <Fragment key={t.id}>
                      <tr className="border-b last:border-0 hover:bg-muted/20">
                        <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{t.id?.slice(-8)}</td>
                        <td className="px-3 py-2 text-xs">{wk?.name || t.workerId || "—"}</td>
                        <td className="px-3 py-2 text-xs">{ACTION_LABEL[t.action] || t.action}</td>
                        <td className="px-3 py-2"><Badge variant={s.variant}>{s.label}</Badge></td>
                        <td className="px-3 py-2 text-xs tabular-nums">{duration(t.createdAt, t.finishedAt)}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground max-w-48 truncate">{t.errorReason || "—"}</td>
                        <td className="px-3 py-2">
                          <div className="flex gap-1">
                            <button onClick={() => toggleLog(t.id)} className="text-muted-foreground hover:text-foreground transition-colors" title="日志">
                              {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                            </button>
                            {["pending", "dispatching", "running"].includes(t.status) && (
                              <button onClick={() => cancelTask(t.id)} className="text-muted-foreground hover:text-destructive transition-colors" title="取消">
                                <X className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={7} className="bg-muted/10 p-3 border-b">
                            <pre className="text-xs font-mono whitespace-pre-wrap max-h-80 overflow-y-auto text-muted-foreground leading-relaxed">{taskLog}</pre>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {tasksTotal > 0 && (
          <div className="flex items-center justify-between mt-3">
            <span className="text-xs text-muted-foreground">共 {tasksTotal} 条任务</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={tasksPage <= 1} onClick={() => setTasksPage(p => p - 1)}>上一页</Button>
              <span className="text-xs text-muted-foreground tabular-nums">{tasksPage} / {Math.ceil(tasksTotal / 30)}</span>
              <Button variant="outline" size="sm" disabled={tasksPage >= Math.ceil(tasksTotal / 30)} onClick={() => setTasksPage(p => p + 1)}>下一页</Button>
            </div>
          </div>
        )}
      </div>

      {/* Add Worker Dialog */}
      <Dialog open={showAddWorker} onOpenChange={setShowAddWorker}>
        <DialogContent>
          <DialogHeader><DialogTitle>添加 Worker</DialogTitle></DialogHeader>
          <div className="space-y-3 pt-2">
            <div><Label className="text-xs mb-1 block">名称</Label><Input value={wName} onChange={e => setWName(e.target.value)} placeholder="Linux Server #1" /></div>
            <div><Label className="text-xs mb-1 block">地址 (baseUrl)</Label><Input value={wUrl} onChange={e => setWUrl(e.target.value)} placeholder="http://1.2.3.4:8099" /></div>
            <div><Label className="text-xs mb-1 block">Token</Label><Input value={wToken} onChange={e => setWToken(e.target.value)} placeholder="认证 Token" /></div>
            <div><Label className="text-xs mb-1 block">最大并发</Label><Input type="number" min={1} max={50} value={wMax} onChange={e => setWMax(+e.target.value)} /></div>
            <Button onClick={addWorker} className="w-full" disabled={!wName || !wUrl}>添加</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Worker Dialog */}
      <Dialog open={!!editWorker} onOpenChange={(open) => { if (!open) setEditWorker(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>编辑 Worker</DialogTitle></DialogHeader>
          <div className="space-y-3 pt-2">
            <div><Label className="text-xs mb-1 block">名称</Label><Input value={ewName} onChange={e => setEwName(e.target.value)} /></div>
            <div><Label className="text-xs mb-1 block">最大并发任务</Label><Input type="number" min={1} max={50} value={ewMax} onChange={e => setEwMax(+e.target.value)} /></div>
            <Button onClick={saveEditWorker} className="w-full">保存</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
