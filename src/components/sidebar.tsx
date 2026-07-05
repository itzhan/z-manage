"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  LayoutDashboard,
  CreditCard,
  User,
  Mail,
  Globe,
  Key,
  ShieldCheck,
  UserPlus,
  ClipboardList,
  Settings,
  LogOut,
  Server,
  Database,
  MapPin,
} from "lucide-react"
import { cn } from "@/lib/utils"

const NAV_GROUPS = [
  {
    label: "调度",
    items: [
      { href: "/", label: "概览", icon: LayoutDashboard },
      { href: "/workers", label: "Worker调度", icon: Server },
    ],
  },
  {
    label: "资源池",
    items: [
      { href: "/cards", label: "支付卡", icon: CreditCard },
      { href: "/mailcom", label: "Mail.com", icon: Mail },
      { href: "/outlook", label: "Outlook", icon: Mail },
      { href: "/openai-pool", label: "OpenAI账号池", icon: Database },
      { href: "/google", label: "谷歌账号", icon: User },
      { href: "/proxies", label: "代理IP", icon: Globe },
      { href: "/addresses", label: "地址库", icon: MapPin },
    ],
  },
  {
    label: "产出",
    items: [
      { href: "/registered", label: "Claude官Key", icon: ShieldCheck },
      { href: "/openai-keys", label: "OpenAI官Key", icon: UserPlus },
      { href: "/codex", label: "Codex", icon: Key },
    ],
  },
  {
    label: "系统",
    items: [
      { href: "/log", label: "分配记录", icon: ClipboardList },
      { href: "/settings", label: "设置", icon: Settings },
    ],
  },
]

export default function Sidebar() {
  const pathname = usePathname()

  const logout = () => {
    document.cookie = "z-api-key=; path=/; max-age=0"
    window.location.href = "/login"
  }

  return (
    <aside className="w-52 shrink-0 border-r bg-muted/20 flex flex-col h-screen sticky top-0">
      <div className="h-14 flex items-center px-5 border-b">
        <h1 className="text-sm font-semibold tracking-tight">Z-Manage</h1>
      </div>
      <nav className="flex-1 py-2 px-3 overflow-y-auto">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="mb-1">
            <p className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider">
              {group.label}
            </p>
            {group.items.map((item) => {
              const active =
                item.href === "/"
                  ? pathname === "/"
                  : pathname.startsWith(item.href)
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition-colors",
                    active
                      ? "bg-secondary text-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                  )}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  {item.label}
                </Link>
              )
            })}
          </div>
        ))}
      </nav>
      <div className="p-3 border-t">
        <button
          onClick={logout}
          className="flex items-center gap-2.5 w-full rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
        >
          <LogOut className="h-4 w-4 shrink-0" />
          退出登录
        </button>
      </div>
    </aside>
  )
}
