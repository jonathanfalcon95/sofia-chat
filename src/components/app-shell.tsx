"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Building2,
  Contact,
  Inbox,
  Kanban,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Settings2,
  Ticket,
  UserCircle,
  Users,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { NotificationBell } from "@/components/notifications/notification-bell";
import type { PermissionCode } from "@/lib/rbac/permissions";

type NavLink = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** If set, user needs this permission (or platform admin). */
  permission?: PermissionCode;
};

const links: NavLink[] = [
  {
    href: "/dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    permission: "conversations.view",
  },
  {
    href: "/conversations",
    label: "Conversaciones",
    icon: MessageSquare,
    permission: "conversations.view",
  },
  {
    href: "/kanban",
    label: "Kanban",
    icon: Kanban,
    permission: "conversations.tag",
  },
  {
    href: "/tickets",
    label: "Tickets",
    icon: Ticket,
    permission: "tickets.view",
  },
  {
    href: "/contacts",
    label: "Contactos",
    icon: Contact,
    permission: "contacts.view",
  },
  {
    href: "/companies",
    label: "Empresas",
    icon: Building2,
    permission: "companies.manage",
  },
  {
    href: "/settings/error-logs",
    label: "Errores",
    icon: AlertTriangle,
    permission: "error_logs.view",
  },
  {
    href: "/inboxes",
    label: "Inboxes",
    icon: Inbox,
    permission: "inboxes.manage",
  },
  {
    href: "/settings/users",
    label: "Usuarios",
    icon: Users,
    permission: "users.manage",
  },
  {
    href: "/settings/roles",
    label: "Roles",
    icon: Settings2,
    permission: "roles.manage",
  },
];

export function AppShell({
  children,
  userId,
  userLabel,
  permissions,
  isPlatformAdmin,
}: {
  children: React.ReactNode;
  userId: string;
  userLabel: string;
  permissions: string[];
  isPlatformAdmin: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [navOpen, setNavOpen] = useState(false);

  const isChatRoute = pathname.startsWith("/conversations");
  const isChatThread =
    isChatRoute && /^\/conversations\/[^/]+/.test(pathname);

  const visibleLinks = links.filter((link) => {
    if (!link.permission) return true;
    if (isPlatformAdmin) return true;
    return permissions.includes(link.permission);
  });

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  async function logout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div
      className={cn(
        "app-shell",
        navOpen && "nav-open",
        isChatThread && "chat-thread-open",
      )}
    >
      <button
        type="button"
        className="app-nav-drawer-backdrop"
        aria-label="Cerrar menú"
        onClick={() => setNavOpen(false)}
      />

      <aside className="app-nav-aside flex flex-col gap-4 border-r border-[var(--line)] bg-[var(--sidebar)] px-3 py-4 text-[var(--sidebar-ink)]">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--line)] px-2 pb-4">
          <div className="flex min-w-0 items-center gap-3">
            <Image
              src="/sofia-logo.webp"
              alt="sofIA"
              width={42}
              height={42}
              className="h-10 w-10 object-contain"
              priority
            />
            <div className="min-w-0">
              <div className="text-base font-bold tracking-tight">Sofia Chat</div>
              <div className="text-xs text-[var(--muted)]">WhatsApp Inbox</div>
            </div>
          </div>
          <button
            type="button"
            className="app-nav-close h-11 w-11 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--surface-2)]"
            aria-label="Cerrar menú"
            onClick={() => setNavOpen(false)}
          >
            <X size={20} />
          </button>
        </div>

        <nav className="flex flex-1 flex-col gap-1">
          {visibleLinks.map((link) => {
            const Icon = link.icon;
            const active =
              link.href === "/dashboard"
                ? pathname === "/dashboard"
                : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setNavOpen(false)}
                className={cn(
                  "flex min-h-11 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition",
                  active
                    ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--sidebar-ink)]",
                )}
              >
                <Icon size={18} />
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="space-y-3 border-t border-[var(--line)] pt-3">
          <Link
            href="/settings/profile"
            onClick={() => setNavOpen(false)}
            className={cn(
              "flex min-h-11 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition",
              pathname.startsWith("/settings/profile")
                ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--sidebar-ink)]",
            )}
          >
            <UserCircle size={18} />
            Mi perfil
          </Link>
          <div className="flex items-center justify-between gap-2 px-1">
            <div className="truncate text-xs text-[var(--muted)]">{userLabel}</div>
            <ThemeToggle />
          </div>
          <Button variant="ghost" className="w-full min-h-11" onClick={logout}>
            <LogOut size={16} /> Salir
          </Button>
        </div>
      </aside>

      <div className={cn("app-main", isChatRoute && "app-main--chat")}>
        <header className="app-header flex items-center justify-between border-b border-[var(--line)] bg-[var(--surface)]">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              className="app-nav-toggle h-11 w-11 items-center justify-center rounded-lg border border-[var(--line)] bg-[var(--surface-2)] text-[var(--ink)] hover:bg-[var(--accent-soft)]"
              aria-label="Abrir menú"
              aria-expanded={navOpen}
              onClick={() => setNavOpen(true)}
            >
              <Menu size={20} />
            </button>
            <div className="truncate text-sm font-semibold text-[var(--muted)]">
              sofIA · Sofia Chat
            </div>
          </div>
          <div className="flex items-center gap-2">
            <NotificationBell userId={userId} />
            <ThemeToggle />
          </div>
        </header>
        <main
          className={cn(
            "app-content min-h-0 flex-1",
            isChatRoute ? "p-0" : "p-5",
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
