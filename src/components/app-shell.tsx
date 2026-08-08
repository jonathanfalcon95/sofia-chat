"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Building2,
  Contact,
  Inbox,
  Kanban,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Settings2,
  Ticket,
  UserCircle,
  Users,
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

  const visibleLinks = links.filter((link) => {
    if (!link.permission) return true;
    if (isPlatformAdmin) return true;
    return permissions.includes(link.permission);
  });

  async function logout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="app-shell">
      <aside className="flex flex-col gap-4 border-r border-[var(--line)] bg-[var(--sidebar)] px-3 py-4 text-[var(--sidebar-ink)]">
        <div className="flex items-center gap-3 border-b border-[var(--line)] px-2 pb-4">
          <Image
            src="/sofia-logo.webp"
            alt="sofIA"
            width={42}
            height={42}
            className="h-10 w-10 object-contain"
            priority
          />
          <div>
            <div className="text-base font-bold tracking-tight">Sofia Chat</div>
            <div className="text-xs text-[var(--muted)]">WhatsApp Inbox</div>
          </div>
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
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition",
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
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition",
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
          <Button variant="ghost" className="w-full" onClick={logout}>
            <LogOut size={16} /> Salir
          </Button>
        </div>
      </aside>

      <div className="app-main">
        <header className="flex h-[57px] items-center justify-between border-b border-[var(--line)] bg-[var(--surface)] px-5">
          <div className="text-sm font-semibold text-[var(--muted)]">
            sofIA · Sofia Chat
          </div>
          <div className="flex items-center gap-2">
            <NotificationBell userId={userId} />
            <ThemeToggle />
          </div>
        </header>
        <main className="min-h-0 flex-1 p-5">{children}</main>
      </div>
    </div>
  );
}
