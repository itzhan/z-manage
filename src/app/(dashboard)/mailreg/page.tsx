"use client"

import { useState, useEffect, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  RefreshCw,
  Play,
  Square,
  Server,
  Zap,
  Plus,
  Trash2,
  Globe,
} from "lucide-react"

function getKey() {
  return document.cookie.match(/z-api-key=([^;]+)/)?.[1] || ""
}
function hdrs() {
  return { "X-API-Key": getKey(), "Content-Type": "application/json" } as HeadersInit
}

export default function MailRegPage() {
  const [workers, setWorkers] = useState<any[]>([])
  const [proxyCount, setProxyCount] = useState(0)
  const [loading, setLoading] = useState(true)

  // Dispatch form
  const [target, setTarget] = useState("30")
  const [threads, setThreads] = useState("10")
  const [dispatching, setDispatching] = useState(false)
  const [dispatchResult, setDispatchResult] = useState<any>(null)

  // Add worker dialog
  const [showAdd, setShowAdd] = useState(false)
  const [addId, setAddId] = useState("")
  const [addName, setAddName] = useState("")
  const [addHost, setAddHost] = useState("")
  const [addPort, setAddPort] = useState("8098")
  const [addMax, setAddMax] = useState("10")

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/mail-workers", { headers: hdrs() })
      const d = await r.json()
      setWorkers(d.workers ?? [])
      setProxyCount(d.proxyCount ?? 0)
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    const iv = setInterval(load, 5000)
    return () => clearInterval(iv)
  }, [load])

  const anyRunning = workers.some((w) => w.task?.running)
  const totalOk = workers.reduce((s: number, w: any) => s + (w.task?.ok ?? 0), 0)
  const totalFail = workers.reduce((s: number, w: any) => s + (w.task?.fail ?? 0), 0)
  const totalTarget = workers.reduce((s: number, w: any) => s + (w.task?.target ?? 0), 0)
  const onlineCount = workers.filter((w) => w.online).length

  const doDispatch = async () => {
    setDispatching(true)
    setDispatchResult(null)
    try {
      const r = await fetch("/api/mail-workers/dispatch", {
        method: "POST",
        headers: hdrs(),
        body: JSON.stringify({
          target: parseInt(target) || 30,
          threads: parseInt(threads) || 10,
        }),
      })
      const d = await r.json()
      setDispatchResult(d)
      setTimeout(load, 1500)
    } catch (e: any) {
      setDispatchResult({ error: e.message })
    }
    setDispatching(false)
  }

  const doCancel = async () => {
    await fetch("/api/mail-workers/dispatch", { method: "DELETE", headers: hdrs() })
    setTimeout(load, 1000)
  }

  const addWorker = async () => {
    if (!addHost) return
    await fetch("/api/mail-workers", {
      method: "POST",
      headers: hdrs(),
      body: JSON.stringify({
        id: addId || `pw-${Date.now()}`,
        name: addName || addHost,
        host: addHost,
        port: parseInt(addPort) || 8098,
        maxThreads: parseInt(addMax) || 10,
      }),
    })
    setShowAdd(false)
    setAddId(""); setAddName(""); setAddHost(""); setAddPort("8098"); setAddMax("10")
    load()
  }

  const removeWorker = async (id: string) => {
    await fetch("/api/mail-workers", {
      method: "DELETE",
      headers: hdrs(),
      body: JSON.stringify({ id }),
    })
    load()
  }

  const initDefaultWorkers = async () => {
    const defaults = [
      { id: "pw-1", name: "雨云1", host: "154.12.55.36", port: 8098, maxThreads: 10 },
      { id: "pw-2", name: "雨云2", host: "154.12.55.125", port: 8098, maxThreads: 10 },
      { id: "pw-3", name: "雨云3", host: "154.12.55.22", port: 8098, maxThreads: 10 },
      { id: "pw-4", name: "雨云4", host: "154.12.39.212", port: 8098, maxThreads: 10 },
      { id: "pw-5", name: "雨云5", host: "64.83.1.190", port: 8098, maxThreads: 10 },
      { id: "pw-6", name: "雨云6", host: "154.9.254.55", port: 8098, maxThreads: 10 },
      { id: "pw-7", name: "雨云7", host: "199.68.217.57", port: 8098, maxThreads: 10 },
      { id: "pw-8", name: "雨云8", host: "64.83.1.103", port: 8098, maxThreads: 10 },
      { id: "pw-9", name: "雨云9", host: "64.83.1.49", port: 8098, maxThreads: 10 },
    ]
    await fetch("/api/mail-workers", {
      method: "POST",
      headers: hdrs(),
      body: JSON.stringify({ workers: defaults }),
    })
    load()
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <Zap className="h-5 w-5" />Mail.com 注册机
          </h1>
          <p className="text-sm text-muted-foreground">
            分布式 mail.com 邮箱注册，产出自动入库到邮箱池
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`} />刷新
          </Button>
        </div>
      </div>

      {/* 总览卡片 */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Worker 在线</span>
            <span className="text-2xl font-bold text-emerald-600">
              {onlineCount}<span className="text-sm text-muted-foreground font-normal">/{workers.length}</span>
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <span className="text-xs text-muted-foreground flex items-center gap-1"><Globe className="h-3 w-3" />代理池</span>
            <span className="text-2xl font-bold">{proxyCount}</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">已产出</span>
            <span className="text-2xl font-bold text-emerald-600">{totalOk}</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">失败</span>
            <span className="text-2xl font-bold text-red-500">{totalFail}</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">目标</span>
            <span className="text-2xl font-bold">{totalTarget || "—"}</span>
          </CardContent>
        </Card>
      </div>

      {/* 派活控制 */}
      <Card>
        <CardHeader className="p-4 pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Play className="h-4 w-4" />派活控制
          </CardTitle>
          <CardDescription className="text-xs">
            设置目标成品数量和每台并发数，均分到所有在线 Worker
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <div className="flex items-end gap-3 flex-wrap">
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">目标数量（总成品）</label>
              <Input value={target} onChange={(e) => setTarget(e.target.value)} className="h-9 w-28 text-sm" />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">每台并发</label>
              <Input value={threads} onChange={(e) => setThreads(e.target.value)} className="h-9 w-20 text-sm" />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground">预计分配</label>
              <p className="text-sm text-muted-foreground h-9 flex items-center">
                {onlineCount} 台 × 每台 {Math.ceil((parseInt(target) || 30) / Math.max(onlineCount, 1))} = {parseInt(target) || 30}
              </p>
            </div>
            <div className="flex gap-2 ml-auto">
              {!anyRunning ? (
                <Button size="sm" onClick={doDispatch} disabled={dispatching || onlineCount === 0}>
                  {dispatching ? (
                    <><RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />派发中</>
                  ) : (
                    <><Play className="h-3.5 w-3.5 mr-1.5" />开始派活</>
                  )}
                </Button>
              ) : (
                <Button variant="destructive" size="sm" onClick={doCancel}>
                  <Square className="h-3.5 w-3.5 mr-1.5" />全部停止
                </Button>
              )}
            </div>
          </div>

          {/* 总进度条 */}
          {totalTarget > 0 && (
            <div className="mt-3">
              <div className="flex justify-between text-xs text-muted-foreground mb-1">
                <span>总进度</span>
                <span>{totalOk}/{totalTarget} ({(totalOk / Math.max(totalTarget, 1) * 100).toFixed(0)}%)</span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all"
                  style={{ width: `${Math.min(100, totalOk / Math.max(totalTarget, 1) * 100)}%` }}
                />
              </div>
            </div>
          )}

          {/* 派活结果提示 */}
          {dispatchResult && (
            <div className={`mt-3 text-xs p-2 rounded ${dispatchResult.error ? "bg-destructive/10 text-destructive" : "bg-emerald-500/10 text-emerald-700"}`}>
              {dispatchResult.error ? (
                <span>派活失败: {dispatchResult.error}</span>
              ) : (
                <span>
                  已派发 {dispatchResult.assigned}/{workers.length} 台 Worker，代理池 {dispatchResult.proxyCount} 个
                  {dispatchResult.errors?.length > 0 && (
                    <span className="block mt-1 text-amber-600">
                      {dispatchResult.errors.join(" · ")}
                    </span>
                  )}
                </span>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Worker 列表 */}
      <Card>
        <CardHeader className="p-4 pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <Server className="h-4 w-4" />Worker 列表
            </CardTitle>
            <div className="flex gap-2">
              {workers.length === 0 && (
                <Button variant="outline" size="sm" onClick={initDefaultWorkers}>
                  导入 9 台雨云
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setShowAdd(true)}>
                <Plus className="h-3.5 w-3.5 mr-1" />添加
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {workers.map((w: any) => (
              <div
                key={w.id}
                className={`rounded-xl border p-3 space-y-2 transition-colors ${
                  w.online
                    ? w.task?.running
                      ? "border-emerald-500/50 bg-emerald-500/[0.02]"
                      : "border-border"
                    : "border-destructive/30 opacity-60"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 rounded-full shrink-0 ${
                        w.online
                          ? w.task?.running
                            ? "bg-emerald-500 animate-pulse"
                            : "bg-emerald-500"
                          : "bg-red-500"
                      }`}
                    />
                    <span className="text-sm font-medium">{w.name}</span>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {w.id}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-muted-foreground font-mono">{w.host}:{w.port}</span>
                    <button
                      onClick={() => removeWorker(w.id)}
                      className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                      title="删除"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                {w.task ? (
                  <>
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">进度</span>
                      <span>
                        <span className="text-emerald-600 font-medium">{w.task.ok}</span>
                        <span className="text-muted-foreground"> / {w.task.target}</span>
                        <span className="text-muted-foreground ml-1">({w.task.fail} 失败)</span>
                      </span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-emerald-500 rounded-full transition-all"
                        style={{
                          width: `${Math.min(100, (w.task.ok / Math.max(w.task.target, 1)) * 100)}%`,
                        }}
                      />
                    </div>
                    <div className="flex justify-between text-[10px] text-muted-foreground">
                      <span>
                        {w.task.running ? (
                          <Badge variant="warning" className="text-[10px] px-1 py-0">运行中</Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px] px-1 py-0">已完成</Badge>
                        )}
                        <span className="ml-1">{w.task.threads} 并发</span>
                        {w.task.elapsed > 0 && <span className="ml-1">· {Math.floor(w.task.elapsed / 60)}m{w.task.elapsed % 60}s</span>}
                      </span>
                      {w.task.lastAccount && (
                        <span className="font-mono truncate max-w-[160px]" title={w.task.lastAccount}>
                          {w.task.lastAccount}
                        </span>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">{w.online ? "空闲" : "离线"}</p>
                )}

                {w.system?.cpu != null && (
                  <div className="flex gap-3 text-[10px] text-muted-foreground">
                    <span>CPU {w.system.cpu}%</span>
                    <span>MEM {w.system.mem}%</span>
                  </div>
                )}
              </div>
            ))}
          </div>

          {workers.length === 0 && (
            <p className="text-center text-sm text-muted-foreground py-8">
              暂无 Worker，点击"导入 9 台雨云"或手动添加
            </p>
          )}
        </CardContent>
      </Card>

      {/* 添加 Worker 对话框 */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>添加 Mail Worker</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">ID</label>
                <Input value={addId} onChange={(e) => setAddId(e.target.value)} placeholder="pw-10" className="h-9" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">名称</label>
                <Input value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="雨云10" className="h-9" />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">IP</label>
              <Input value={addHost} onChange={(e) => setAddHost(e.target.value)} placeholder="154.12.55.36" className="h-9" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">端口</label>
                <Input value={addPort} onChange={(e) => setAddPort(e.target.value)} placeholder="8098" className="h-9" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">最大并发</label>
                <Input value={addMax} onChange={(e) => setAddMax(e.target.value)} placeholder="10" className="h-9" />
              </div>
            </div>
            <Button onClick={addWorker} className="w-full" disabled={!addHost}>添加</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
