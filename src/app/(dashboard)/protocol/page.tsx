"use client"

import { useState, useEffect, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { RefreshCw, Play } from "lucide-react"

function getKey() {
  return document.cookie.match(/z-api-key=([^;]+)/)?.[1] || ""
}

export default function ProtocolPage() {
  const [stats, setStats] = useState<any>(null)
  const [brands, setBrands] = useState<any[]>([])
  const [tasks, setTasks] = useState<any[]>([])
  const [tasksTotal, setTasksTotal] = useState(0)
  const [tasksPage, setTasksPage] = useState(1)

  // Form
  const [emailSource, setEmailSource] = useState("mailcom")
  const [brand, setBrand] = useState("")
  const [count, setCount] = useState(10)
  const [batchSize, setBatchSize] = useState(5)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState("")
  const [results, setResults] = useState<Array<{ email: string; success: boolean; key?: string; error?: string }>>([])
  const [workers, setWorkers] = useState<any[]>([])

  const hdrs = () => ({ "X-API-Key": getKey(), "Content-Type": "application/json" })

  const load = useCallback(async () => {
    const [s, b, t, w] = await Promise.all([
      fetch("/api/stats", { headers: hdrs() }).then(r => r.json()),
      fetch(`/api/brands?platform=claudePlatform`, { headers: hdrs() }).then(r => r.json()),
      fetch(`/api/dispatch?pageSize=30&page=${tasksPage}&action=claude-protocol`, { headers: hdrs() }).then(r => r.json()),
      fetch("/api/workers", { headers: hdrs() }).then(r => r.json()),
    ])
    setStats(s)
    setBrands(b.details || [])
    setTasks(t.tasks || [])
    setTasksTotal(t.total || 0)
    const pw = Array.isArray(w) ? w.filter((x: any) => x.capabilities?.includes("claude-protocol")) : []
    setWorkers(pw)
  }, [tasksPage])

  useEffect(() => { load() }, [load])
  useEffect(() => { const t = setInterval(load, 10000); return () => clearInterval(t) }, [load])

  const dispatch = async () => {
    setRunning(true)
    setProgress("准备中...")
    setResults([])
    try {
      const res = await fetch("/api/protocol/batch", {
        method: "POST", headers: hdrs(),
        body: JSON.stringify({ count, batchSize, brand: brand || undefined, emailSource }),
      })
      if (!res.body) throw new Error("No stream")
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split("\n")
        buf = lines.pop() || ""
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          try {
            const ev = JSON.parse(line.slice(6))
            if (ev.type === "start") setProgress(`开始 ${ev.total} 个任务 (${ev.batches}批)`)
            else if (ev.type === "batch_start") setProgress(`第${ev.batch}/${ev.batches}批: 分配资源...`)
            else if (ev.type === "batch_resources") setProgress(`第${ev.batch}批: ${ev.count}个任务开始执行`)
            else if (ev.type === "task_start") setProgress(`[${ev.batch}] ${ev.taskIdx}/${ev.total} ${ev.email}`)
            else if (ev.type === "task_done") {
              setProgress(`[${ev.batch}] ${ev.globalSuccess + ev.globalFailed}/${ev.total} 成功${ev.globalSuccess} 失败${ev.globalFailed}`)
              setResults(r => [...r, { email: ev.email, success: ev.success, key: ev.key, error: ev.error }])
            }
            else if (ev.type === "batch_done") setProgress(`第${ev.batch}/${ev.batches}批完成`)
            else if (ev.type === "done") setProgress(`全部完成! 成功${ev.success} 失败${ev.failed}`)
            else if (ev.type === "error") setProgress(`错误: ${ev.message}`)
          } catch { /* skip */ }
        }
      }
    } catch (e: any) {
      setProgress(`错误: ${e.message}`)
    }
    setRunning(false)
    load()
  }

  const emailAvail = emailSource === "outlook" ? (stats?.outlook?.available ?? 0) : (stats?.mailcom?.available ?? 0)
  const cardAvail = brand ? (brands.find(b => b.brand === brand)?.remainingUses ?? 0) : brands.reduce((s, b) => s + (b.remainingUses ?? 0), 0)
  const proxyAvail = stats?.proxies?.available ?? 0
  const addrAvail = stats?.addresses?.available ?? 0
  const maxCanDo = Math.min(emailAvail, cardAvail, proxyAvail, addrAvail)

  const INPUT_CLS = "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
  const SELECT_CLS = INPUT_CLS + " appearance-none"

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Claude 协议</h2>
          <p className="text-sm text-muted-foreground mt-0.5">直接在服务器上执行协议，无需 Worker</p>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />刷新
        </Button>
      </div>

      {/* Protocol Workers */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">协议节点 <Badge variant="secondary">{workers.filter(w => w.status === "online").length}/{workers.length}</Badge></CardTitle>
        </CardHeader>
        <CardContent>
          {workers.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">暂无协议节点</p>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-2">
              {workers.map((w: any) => (
                <div key={w.id} className={`border rounded-md px-3 py-2 text-xs ${w.status === "online" ? "border-green-500/30 bg-green-500/5" : w.status === "disabled" ? "opacity-40" : "border-border"}`}>
                  <div className="font-medium truncate">{w.name}</div>
                  <div className="text-muted-foreground truncate">{w.baseUrl?.replace("http://", "").replace(":9876", "")}</div>
                  <Badge variant={w.status === "online" ? "default" : "secondary"} className="text-[9px] mt-1">{w.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Dispatch Form */}
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-sm">任务调度</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 items-end">
            <div>
              <Label className="text-xs mb-1 block">邮箱来源</Label>
              <select value={emailSource} onChange={e => setEmailSource(e.target.value)} className={SELECT_CLS}>
                <option value="mailcom">Mail.com</option>
                <option value="outlook">Outlook</option>
              </select>
            </div>
            <div>
              <Label className="text-xs mb-1 block">卡品牌</Label>
              <select value={brand} onChange={e => setBrand(e.target.value)} className={SELECT_CLS}>
                <option value="">不限</option>
                {brands.map(b => (
                  <option key={b.brand} value={b.brand}>{b.brand} ({b.available}卡/{b.remainingUses}次)</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs mb-1 block">总数量</Label>
              <Input type="number" min={1} max={500} value={count} onChange={e => setCount(+e.target.value)} className="h-9" />
            </div>
            <div>
              <Label className="text-xs mb-1 block">每批 ({Math.ceil(count / (batchSize || count))}批)</Label>
              <Input type="number" min={1} value={batchSize} onChange={e => setBatchSize(+e.target.value)} className="h-9" />
            </div>
            <div>
              <Button onClick={dispatch} disabled={running || maxCanDo === 0} className="w-full h-9">
                <Play className="h-3.5 w-3.5 mr-1" />
                {running ? "运行中..." : "开始"}
              </Button>
            </div>
          </div>

          {/* Estimate */}
          <div className="flex items-center gap-4 text-xs text-muted-foreground border-t pt-3">
            <span>可调度: <strong className="text-foreground tabular-nums">{maxCanDo}</strong></span>
            <span>邮箱 <strong className="tabular-nums">{emailAvail}</strong></span>
            <span>卡次数 <strong className="tabular-nums">{cardAvail}</strong></span>
            <span>代理 <strong className="tabular-nums">{proxyAvail}</strong></span>
            <span>地址 <strong className="tabular-nums">{addrAvail}</strong></span>
          </div>

          {/* Progress */}
          {progress && (
            <div className="border-t pt-3">
              <div className="flex items-center gap-2 text-sm">
                {running && <span className="inline-block w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />}
                <span className={running ? "text-foreground" : progress.includes("错误") ? "text-destructive" : "text-emerald-600"}>{progress}</span>
              </div>
            </div>
          )}

          {/* Results */}
          {results.length > 0 && (
            <div className="border-t pt-3 max-h-60 overflow-y-auto space-y-1">
              {results.map((r, i) => (
                <div key={i} className={`text-xs ${r.success ? "text-green-600" : "text-red-500"}`}>
                  {r.success ? "✓" : "✗"} {r.email} {r.success ? r.key : r.error}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Task List */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">任务列表 <Badge variant="secondary">{tasksTotal}</Badge></CardTitle>
        </CardHeader>
        <CardContent>
          {tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">暂无协议任务</p>
          ) : (
            <div className="border rounded-md overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-left px-3 py-2 font-medium text-xs">ID</th>
                    <th className="text-left px-3 py-2 font-medium text-xs">邮箱</th>
                    <th className="text-left px-3 py-2 font-medium text-xs">状态</th>
                    <th className="text-left px-3 py-2 font-medium text-xs">结果</th>
                    <th className="text-left px-3 py-2 font-medium text-xs">时间</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t: any) => {
                    const resources = t.resources ? JSON.parse(t.resources) : {};
                    const result = t.result ? JSON.parse(t.result) : null;
                    return (
                      <tr key={t.id} className="border-b last:border-0 hover:bg-muted/20">
                        <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{t.id?.slice(-8)}</td>
                        <td className="px-3 py-2 text-xs">{resources.mailcomEmail || "—"}</td>
                        <td className="px-3 py-2">
                          <Badge variant={t.status === "success" ? "default" : t.status === "failed" ? "destructive" : "secondary"}>{t.status}</Badge>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground max-w-48 truncate">
                          {result?.key ? <span className="font-mono">{result.key.slice(0, 25)}...</span> : t.errorReason || "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{t.createdAt ? new Date(t.createdAt).toLocaleTimeString() : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {tasksTotal > 30 && (
            <div className="flex items-center justify-center gap-2 mt-3">
              <Button variant="outline" size="sm" disabled={tasksPage <= 1} onClick={() => setTasksPage(p => p - 1)}>上一页</Button>
              <span className="text-xs text-muted-foreground tabular-nums">{tasksPage}/{Math.ceil(tasksTotal / 30)}</span>
              <Button variant="outline" size="sm" disabled={tasksPage >= Math.ceil(tasksTotal / 30)} onClick={() => setTasksPage(p => p + 1)}>下一页</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
