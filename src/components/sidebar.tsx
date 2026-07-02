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
} from "lucide-react"
import { cn } from "@/lib/utils"

const NAV = [
  { href: "/", label: "概览", icon: LayoutDashboard },
  { href: "/cards", label: "支付卡", icon: CreditCard },
  { href: "/google", label: "谷歌账号", icon: User },
  { href: "/mailcom", label: "Mail.com", icon: Mail },
  { href: "/proxies", label: "代理IP", icon: Globe },
  { href: "/codex", label: "Codex", icon: Key },
  { href: "/registered", label: "Claude官Key", icon: ShieldCheck },
  { href: "/openai-keys", label: "OpenAI官Key", icon: UserPlus },
  { href: "/log", label: "分配记录", icon: ClipboardList },
  { href: "/settings", label: "设置", icon: Settings },
] as const

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
      <nav className="flex-1 py-3 px-3 space-y-0.5 overflow-y-auto">
        {NAV.map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
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
