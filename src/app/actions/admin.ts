"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getAppSession, sessionHasPermission } from "@/lib/rbac/session";

export async function createCompany(name: string, slug: string) {
  const session = await getAppSession();
  if (!session?.isPlatformAdmin) throw new Error("forbidden");
  const supabase = await createClient();

  const { data: company, error } = await supabase
    .from("companies")
    .insert({ name, slug })
    .select("id")
    .single();
  if (error || !company) throw new Error(error?.message ?? "create_failed");

  const { data: templates } = await supabase
    .from("roles")
    .select("id, name, description, role_permissions(permission_id)")
    .is("company_id", null);

  for (const template of templates ?? []) {
    const { data: role } = await supabase
      .from("roles")
      .insert({
        company_id: company.id,
        name: template.name,
        description: template.description,
        is_system: true,
      })
      .select("id")
      .single();
    if (!role) continue;
    const perms =
      template.role_permissions?.map((rp: { permission_id: string }) => ({
        role_id: role.id,
        permission_id: rp.permission_id,
      })) ?? [];
    if (perms.length) await supabase.from("role_permissions").insert(perms);
  }

  const salesTags = [
    ["Nuevo lead", "#3b82f6", 1],
    ["Contactado", "#06b6d4", 2],
    ["Calificado", "#8b5cf6", 3],
    ["Propuesta", "#f59e0b", 4],
    ["Negociación", "#f97316", 5],
    ["Ganado", "#22c55e", 6],
    ["Perdido", "#ef4444", 7],
  ] as const;

  await supabase.from("tags").insert(
    salesTags.map(([name, color, position]) => ({
      company_id: company.id,
      name,
      color,
      position,
      is_kanban_column: true,
    })),
  );

  revalidatePath("/companies");
  return company.id as string;
}

export async function updateCompany(input: {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
}) {
  const session = await getAppSession();
  if (!session?.isPlatformAdmin) throw new Error("forbidden");
  const supabase = await createClient();
  const { error } = await supabase
    .from("companies")
    .update({
      name: input.name,
      slug: input.slug,
      is_active: input.isActive,
    })
    .eq("id", input.id);
  if (error) throw new Error(error.message);
  revalidatePath("/companies");
}

export async function createInbox(input: {
  companyId: string;
  name: string;
  phoneNumber: string;
  ycloudPhoneNumberId?: string;
  wabaId?: string;
}) {
  const session = await getAppSession();
  if (
    !session ||
    (!session.isPlatformAdmin &&
      !sessionHasPermission(session, input.companyId, "inboxes.manage"))
  ) {
    throw new Error("forbidden");
  }

  const supabase = await createClient();
  const phone = input.phoneNumber.startsWith("+")
    ? input.phoneNumber
    : `+${input.phoneNumber}`;

  const { error } = await supabase.from("inboxes").insert({
    company_id: input.companyId,
    name: input.name,
    phone_number: phone,
    ycloud_phone_number_id: input.ycloudPhoneNumberId || null,
    waba_id: input.wabaId || null,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/inboxes");
}

export async function updateInbox(input: {
  id: string;
  companyId: string;
  name: string;
  phoneNumber: string;
  isActive: boolean;
  ycloudPhoneNumberId?: string;
  wabaId?: string;
}) {
  const session = await getAppSession();
  if (
    !session ||
    (!session.isPlatformAdmin &&
      !sessionHasPermission(session, input.companyId, "inboxes.manage"))
  ) {
    throw new Error("forbidden");
  }
  const supabase = await createClient();
  const phone = input.phoneNumber.startsWith("+")
    ? input.phoneNumber
    : `+${input.phoneNumber}`;
  const { error } = await supabase
    .from("inboxes")
    .update({
      name: input.name,
      phone_number: phone,
      is_active: input.isActive,
      ycloud_phone_number_id: input.ycloudPhoneNumberId || null,
      waba_id: input.wabaId || null,
    })
    .eq("id", input.id);
  if (error) throw new Error(error.message);
  revalidatePath("/inboxes");
}

export async function createRole(input: {
  companyId: string;
  name: string;
  description?: string;
  permissionCodes: string[];
}) {
  const session = await getAppSession();
  if (
    !session ||
    (!session.isPlatformAdmin &&
      !sessionHasPermission(session, input.companyId, "roles.manage"))
  ) {
    throw new Error("forbidden");
  }

  const supabase = await createClient();
  const { data: role, error } = await supabase
    .from("roles")
    .insert({
      company_id: input.companyId,
      name: input.name,
      description: input.description ?? null,
      is_system: false,
    })
    .select("id")
    .single();
  if (error || !role) throw new Error(error?.message ?? "role_failed");

  if (input.permissionCodes.length) {
    const { data: perms } = await supabase
      .from("permissions")
      .select("id, code")
      .in("code", input.permissionCodes);
    if (perms?.length) {
      await supabase.from("role_permissions").insert(
        perms.map((p) => ({ role_id: role.id, permission_id: p.id })),
      );
    }
  }

  revalidatePath("/settings/roles");
}

export async function updateRole(input: {
  id: string;
  companyId: string;
  name: string;
  description?: string;
  permissionCodes: string[];
}) {
  const session = await getAppSession();
  if (
    !session ||
    (!session.isPlatformAdmin &&
      !sessionHasPermission(session, input.companyId, "roles.manage"))
  ) {
    throw new Error("forbidden");
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("roles")
    .update({
      name: input.name,
      description: input.description ?? null,
    })
    .eq("id", input.id)
    .eq("company_id", input.companyId);
  if (error) throw new Error(error.message);

  await supabase.from("role_permissions").delete().eq("role_id", input.id);
  if (input.permissionCodes.length) {
    const { data: perms } = await supabase
      .from("permissions")
      .select("id, code")
      .in("code", input.permissionCodes);
    if (perms?.length) {
      await supabase.from("role_permissions").insert(
        perms.map((p) => ({ role_id: input.id, permission_id: p.id })),
      );
    }
  }
  revalidatePath("/settings/roles");
}

export async function assignMembershipInboxes(
  membershipId: string,
  inboxIds: string[],
) {
  const { createAdminClient, hasServiceRole } = await import(
    "@/lib/supabase/admin"
  );
  const db = hasServiceRole()
    ? createAdminClient()
    : await createClient();

  const { error: delError } = await db
    .from("membership_inboxes")
    .delete()
    .eq("membership_id", membershipId);
  if (delError) throw new Error(delError.message);

  if (inboxIds.length) {
    const { error } = await db.from("membership_inboxes").insert(
      inboxIds.map((inboxId) => ({
        membership_id: membershipId,
        inbox_id: inboxId,
      })),
    );
    if (error) throw new Error(error.message);
  }
  revalidatePath("/settings/users");
}

export async function updateMembership(input: {
  membershipId: string;
  companyId: string;
  roleId: string | null;
  inboxIds: string[];
  isActive: boolean;
  fullName?: string;
  userId: string;
}) {
  const session = await getAppSession();
  if (
    !session ||
    (!session.isPlatformAdmin &&
      !sessionHasPermission(session, input.companyId, "users.manage"))
  ) {
    throw new Error("forbidden");
  }

  if (input.inboxIds.length === 0) {
    throw new Error("Debes asignar al menos un inbox");
  }

  const { createAdminClient, hasServiceRole } = await import(
    "@/lib/supabase/admin"
  );
  const db = hasServiceRole()
    ? createAdminClient()
    : await createClient();

  const { error: mErr } = await db
    .from("company_memberships")
    .update({ is_active: input.isActive })
    .eq("id", input.membershipId);
  if (mErr) throw new Error(mErr.message);

  if (input.fullName) {
    const { error: pErr } = await db
      .from("profiles")
      .update({ full_name: input.fullName })
      .eq("id", input.userId);
    if (pErr) throw new Error(pErr.message);
  }

  const { error: delRolesErr } = await db
    .from("membership_roles")
    .delete()
    .eq("membership_id", input.membershipId);
  if (delRolesErr) throw new Error(delRolesErr.message);

  if (input.roleId) {
    const { error: roleErr } = await db.from("membership_roles").insert({
      membership_id: input.membershipId,
      role_id: input.roleId,
    });
    if (roleErr) throw new Error(roleErr.message);
  }

  await assignMembershipInboxes(input.membershipId, input.inboxIds);
  revalidatePath("/settings/users");
}

export async function updateContact(input: {
  id: string;
  name: string;
  phoneNumber: string;
}) {
  const supabase = await createClient();
  const phone = input.phoneNumber.startsWith("+")
    ? input.phoneNumber
    : `+${input.phoneNumber}`;
  const { error } = await supabase
    .from("contacts")
    .update({ name: input.name, phone_number: phone })
    .eq("id", input.id);
  if (error) throw new Error(error.message);
  revalidatePath("/contacts");
}
