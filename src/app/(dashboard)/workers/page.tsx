"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
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
  const ms = ((end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime())
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

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

  // Dialogs
  const [showAddWorker, setShowAddWorker] = useState(false)
  const [dispatching, setDispatching] = useState(false)

  // Add worker form
  const [wName, setWName] = useState("")
  const [wUrl, setWUrl] = useState("")
  const [wToken, setWToken] = useState("")
  const [wMax, setWMax] = useState(5)

  // Dispatch form
  const [dAction, setDAction] = useState("claude-platform-bindcard")
  const [dWorker, setDWorker] = useState("auto")
  const [dCount, setDCount] = useState(1)
  const [dAmount, setDAmount] = useState(5)
  const [dSpendLimit, setDSpendLimit] = useState(1000)
  const [dBrand, setDBrand] = useState("")
  const [brands, setBrands] = useState<string[]>([])
  const [showPreview, setShowPreview] = useState(false)
  const [preview, setPreview] = useState<any>(null)

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const hdrs = () => ({ "X-API-Key": getKey(), "Content-Type": "application/json" })

  const load = useCallback(async () => {
    try {
      const [statsRes, workersRes, tasksRes, brandsRes] = await Promise.all([
        fetch("/api/stats", { headers: hdrs() }),
        fetch("/api/workers", { headers: hdrs() }),
        fetch(`/api/dispatch?pageSize=30&page=${tasksPage}${taskFilter ? `&status=${taskFilter}` : ""}`, { headers: hdrs() }),
        fetch("/api/brands", { headers: hdrs() }),
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
        setBrands(Array.isArray(b) ? b : b.brands || [])
      }
    } catch { /* ignore */ }
    setLoading(false)
  }, [tasksPage, taskFilter])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const hasRunning = tasks.some((t: any) => ["pending", "dispatching", "running"].includes(t.status))
    if (hasRunning) {
      timerRef.current = setInterval(load, 5000)
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [tasks, load])

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
    if (!confirm("确定删除此 Worker？关联的运行中任务将被取消。")) return
    await fetch(`/api/workers/${id}`, { method: "DELETE", headers: hdrs() })
    load()
  }

  const loadPreview = async () => {
    const platform = dAction === "claude-platform-bindcard" ? "claudePlatform" : "openaiPlatform"
    const emailType = dAction === "claude-platform-bindcard" ? "mailcom" : "openaiPool"
    try {
      const [emailRes, cardRes, proxyRes] = await Promise.all([
        fetch(`/api/${emailType === "mailcom" ? "mailcom" : "openai-pool"}/stats`, { headers: hdrs() }),
        fetch(`/api/cards/stats?platform=${platform}${dBrand ? `&brand=${dBrand}` : ""}`, { headers: hdrs() }),
        fetch("/api/proxies/stats", { headers: hdrs() }),
      ])
      const emailStats = emailRes.ok ? await emailRes.json() : {}
      const cardStats = cardRes.ok ? await cardRes.json() : {}
      const proxyStats = proxyRes.ok ? await proxyRes.json() : {}
      setPreview({ email: emailStats, card: cardStats, proxy: proxyStats, emailType })
    } catch { setPreview(null) }
    setShowPreview(true)
  }

  const dispatch = async () => {
    setDispatching(true)
    const params: any = { amount: dAmount }
    if (dBrand) params.brand = dBrand
    if (dAction === "platform-bindcard") params.spendLimit = dSpendLimit

    await fetch("/api/dispatch/batch", {
      method: "POST", headers: hdrs(),
      body: JSON.stringify({
        action: dAction,
        count: dCount,
        params,
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
      if (res.ok) {
        const d = await res.json()
        setTaskLog(d.log || "(空)")
      }
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
          <p className="text-sm text-muted-foreground py-8 text-center">暂无 Worker，点击上方按钮添加</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {workers.map((w: any) => (
              <Card key={w.id}>
                <CardContent className="pt-4 pb-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Server className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium text-sm">{w.name}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge variant={w.status === "online" ? "success" : "secondary"}>{w.status}</Badge>
                      <button onClick={() => deleteWorker(w.id)} className="text-muted-foreground hover:text-destructive transition-colors">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    <p className="font-mono truncate">{w.baseUrl}</p>
                    <p>任务: <span className="tabular-nums">{w.runningTasks}/{w.maxTasks}</span></p>
                    <p>心跳: {timeAgo(w.lastHeartbeat)}</p>
                    <p>浏览器: {w.browserType || "ads"}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
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
                    <option key={typeof b === "string" ? b : b.brand} value={typeof b === "string" ? b : b.brand}>
                      {typeof b === "string" ? b : b.brand}
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

            {/* Preview panel */}
            {showPreview && preview && (() => {
              const emailAvail = preview.email?.available ?? 0
              const cardAvail = preview.card?.available ?? preview.card?.active ?? 0
              const proxyAvail = preview.proxy?.available ?? 0
              const maxDispatch = Math.min(emailAvail, cardAvail, proxyAvail)
              const canDispatch = dCount <= maxDispatch && onlineWorkers.length > 0
              const emailLabel = preview.emailType === "mailcom" ? "Mail.com 邮箱" : "OpenAI 账号"

              return (
                <div className="border rounded-md p-4 bg-muted/20 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">调度预览</p>
                    <button onClick={() => setShowPreview(false)} className="text-muted-foreground hover:text-foreground">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="space-y-0.5">
                      <p className="text-xs text-muted-foreground">{emailLabel}</p>
                      <p className={`text-lg font-semibold tabular-nums ${emailAvail >= dCount ? "text-emerald-600" : "text-red-600"}`}>{emailAvail} 可用</p>
                    </div>
                    <div className="space-y-0.5">
                      <p className="text-xs text-muted-foreground">卡片{dBrand ? ` (${dBrand})` : ""}</p>
                      <p className={`text-lg font-semibold tabular-nums ${cardAvail >= dCount ? "text-emerald-600" : "text-red-600"}`}>{cardAvail} 可用</p>
                    </div>
                    <div className="space-y-0.5">
                      <p className="text-xs text-muted-foreground">代理 IP</p>
                      <p className={`text-lg font-semibold tabular-nums ${proxyAvail >= dCount ? "text-emerald-600" : "text-red-600"}`}>{proxyAvail} 可用</p>
                    </div>
                    <div className="space-y-0.5">
                      <p className="text-xs text-muted-foreground">本次调度</p>
                      <p className="text-lg font-semibold tabular-nums">{dCount} 个任务 → {dWorker === "auto" ? `${onlineWorkers.length} 个 Worker` : "1 个 Worker"}</p>
                    </div>
                  </div>
                  {!canDispatch && (
                    <p className="text-xs text-red-600">
                      {onlineWorkers.length === 0 ? "没有在线的 Worker" : `资源不足: 最多可调度 ${maxDispatch} 个任务`}
                    </p>
                  )}
                  <Button onClick={dispatch} disabled={dispatching || !canDispatch} className="h-9">
                    <Play className="h-3.5 w-3.5 mr-1" />
                    {dispatching ? "调度中..." : `确认调度 ${dCount} 个任务`}
                  </Button>
                </div>
              )
            })()}
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
                  return (
                    <tr key={t.id} className="border-b last:border-0 hover:bg-muted/20">
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{t.id?.slice(-8)}</td>
                      <td className="px-3 py-2 text-xs">{wk?.name || t.workerId || "—"}</td>
                      <td className="px-3 py-2 text-xs">{ACTION_LABEL[t.action] || t.action}</td>
                      <td className="px-3 py-2"><Badge variant={s.variant}>{s.label}</Badge></td>
                      <td className="px-3 py-2 text-xs tabular-nums">{duration(t.createdAt, t.finishedAt)}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground max-w-48 truncate">{t.errorReason || "—"}</td>
                      <td className="px-3 py-2">
                        <div className="flex gap-1">
                          <button onClick={() => toggleLog(t.id)} className="text-muted-foreground hover:text-foreground transition-colors" title="查看日志">
                            {expandedTask === t.id ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                          </button>
                          {["pending", "dispatching", "running"].includes(t.status) && (
                            <button onClick={() => cancelTask(t.id)} className="text-muted-foreground hover:text-destructive transition-colors" title="取消">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {expandedTask && (
              <div className="border-t bg-muted/10 p-3">
                <pre className="text-xs font-mono whitespace-pre-wrap max-h-80 overflow-y-auto text-muted-foreground leading-relaxed">{taskLog}</pre>
              </div>
            )}
          </div>
        )}

        {tasksTotal > 30 && (
          <div className="flex justify-center gap-2 mt-3">
            <Button variant="outline" size="sm" disabled={tasksPage <= 1} onClick={() => setTasksPage(p => p - 1)}>上一页</Button>
            <span className="text-xs text-muted-foreground self-center tabular-nums">{tasksPage} / {Math.ceil(tasksTotal / 30)}</span>
            <Button variant="outline" size="sm" disabled={tasksPage >= Math.ceil(tasksTotal / 30)} onClick={() => setTasksPage(p => p + 1)}>下一页</Button>
          </div>
        )}
      </div>

      {/* Add Worker Dialog */}
      <Dialog open={showAddWorker} onOpenChange={setShowAddWorker}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加 Worker</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <div>
              <Label className="text-xs mb-1 block">名称</Label>
              <Input value={wName} onChange={e => setWName(e.target.value)} placeholder="Linux Server #1" />
            </div>
            <div>
              <Label className="text-xs mb-1 block">地址 (baseUrl)</Label>
              <Input value={wUrl} onChange={e => setWUrl(e.target.value)} placeholder="http://1.2.3.4:8080" />
            </div>
            <div>
              <Label className="text-xs mb-1 block">Token (可选)</Label>
              <Input value={wToken} onChange={e => setWToken(e.target.value)} placeholder="Worker 认证 Token" />
            </div>
            <div>
              <Label className="text-xs mb-1 block">最大并发任务</Label>
              <Input type="number" min={1} max={50} value={wMax} onChange={e => setWMax(+e.target.value)} />
            </div>
            <Button onClick={addWorker} className="w-full" disabled={!wName || !wUrl}>添加</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
