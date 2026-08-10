"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getAppSession, sessionHasPermission } from "@/lib/rbac/session";
import {
  listWhatsAppPhoneNumbers,
  type YCloudPhoneNumber,
} from "@/lib/ycloud/client";

function normalizeE164(phone: string) {
  const trimmed = phone.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("+") ? trimmed : `+${trimmed}`;
}

async function assignCompanyInboxes(companyId: string, inboxIds: string[]) {
  const { createAdminClient, hasServiceRole } = await import(
    "@/lib/supabase/admin"
  );
  const db = hasServiceRole()
    ? createAdminClient()
    : await createClient();

  const selected = Array.from(new Set(inboxIds.filter(Boolean)));

  const { data: current, error: currentError } = await db
    .from("inboxes")
    .select("id")
    .eq("company_id", companyId);
  if (currentError) throw new Error(currentError.message);

  const currentIds = (current ?? []).map((i) => i.id as string);
  const toUnassign = currentIds.filter((id) => !selected.includes(id));
  const toAssign = selected.filter((id) => !currentIds.includes(id));

  if (toAssign.length) {
    const { data: assignable, error: assignableError } = await db
      .from("inboxes")
      .select("id, company_id")
      .in("id", toAssign);
    if (assignableError) throw new Error(assignableError.message);
    const invalid = (assignable ?? []).filter(
      (i) => i.company_id != null && i.company_id !== companyId,
    );
    if (invalid.length) {
      throw new Error("Uno o más números ya pertenecen a otra empresa");
    }
    if ((assignable ?? []).length !== toAssign.length) {
      throw new Error("Uno o más inboxes no existen");
    }
    const { error } = await db
      .from("inboxes")
      .update({ company_id: companyId })
      .in("id", toAssign);
    if (error) throw new Error(error.message);
  }

  if (toUnassign.length) {
    const { data: memberships, error: membershipsError } = await db
      .from("company_memberships")
      .select("id")
      .eq("company_id", companyId);
    if (membershipsError) throw new Error(membershipsError.message);
    const membershipIds = (memberships ?? []).map((m) => m.id as string);
    if (membershipIds.length) {
      const { error: miError } = await db
        .from("membership_inboxes")
        .delete()
        .in("membership_id", membershipIds)
        .in("inbox_id", toUnassign);
      if (miError) throw new Error(miError.message);
    }
    const { error } = await db
      .from("inboxes")
      .update({ company_id: null })
      .in("id", toUnassign)
      .eq("company_id", companyId);
    if (error) throw new Error(error.message);
  }
}

export async function createCompany(input: {
  name: string;
  slug: string;
  guidCompany?: string | null;
  inboxIds?: string[];
}) {
  const session = await getAppSession();
  if (!session?.isPlatformAdmin) throw new Error("forbidden");
  const supabase = await createClient();

  const { data: company, error } = await supabase
    .from("companies")
    .insert({
      name: input.name,
      slug: input.slug,
      guid_company: input.guidCompany?.trim() || null,
    })
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

  if (input.inboxIds?.length) {
    await assignCompanyInboxes(company.id, input.inboxIds);
  }

  revalidatePath("/companies");
  revalidatePath("/inboxes");
  return company.id as string;
}

export async function updateCompany(input: {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  guidCompany?: string | null;
  inboxIds: string[];
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
      guid_company: input.guidCompany?.trim() || null,
    })
    .eq("id", input.id);
  if (error) throw new Error(error.message);

  await assignCompanyInboxes(input.id, input.inboxIds);

  revalidatePath("/companies");
  revalidatePath("/inboxes");
  revalidatePath("/settings/users");
}

export async function syncYCloudInboxes() {
  const session = await getAppSession();
  if (!session?.isPlatformAdmin) throw new Error("forbidden");

  const { createAdminClient, hasServiceRole } = await import(
    "@/lib/supabase/admin"
  );
  if (!hasServiceRole()) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY no configurada");
  }
  const db = createAdminClient();

  const remote: YCloudPhoneNumber[] = [];
  let page = 1;
  for (;;) {
    const res = await listWhatsAppPhoneNumbers({
      page,
      limit: 100,
      includeTotal: true,
    });
    const items = res.items ?? res.data ?? [];
    remote.push(...items);
    if (items.length < 100) break;
    page += 1;
    if (page > 50) break;
  }

  const { data: existing, error: existingError } = await db
    .from("inboxes")
    .select("id, phone_number, ycloud_phone_number_id, name, waba_id");
  if (existingError) throw new Error(existingError.message);

  const byYCloudId = new Map<string, (typeof existing)[number]>();
  const byPhone = new Map<string, (typeof existing)[number]>();
  for (const row of existing ?? []) {
    if (row.ycloud_phone_number_id) {
      byYCloudId.set(row.ycloud_phone_number_id, row);
    }
    byPhone.set(normalizeE164(row.phone_number), row);
  }

  let created = 0;
  let updated = 0;

  for (const item of remote) {
    const ycloudId = item.id?.trim();
    const rawPhone = item.phoneNumber || item.displayPhoneNumber || "";
    const phone = normalizeE164(rawPhone.replace(/[^\d+]/g, ""));
    if (!ycloudId || !phone) continue;

    const name =
      item.verifiedName?.trim() ||
      item.newName?.trim() ||
      item.displayPhoneNumber?.trim() ||
      phone;
    const wabaId = item.wabaId?.trim() || null;

    const match =
      byYCloudId.get(ycloudId) ?? byPhone.get(phone) ?? null;

    if (!match) {
      const { data: inserted, error } = await db
        .from("inboxes")
        .insert({
          company_id: null,
          name,
          phone_number: phone,
          ycloud_phone_number_id: ycloudId,
          waba_id: wabaId,
          is_active: true,
        })
        .select("id, phone_number, ycloud_phone_number_id, name, waba_id")
        .single();
      if (error) throw new Error(error.message);
      if (inserted) {
        byYCloudId.set(ycloudId, inserted);
        byPhone.set(phone, inserted);
      }
      created += 1;
      continue;
    }

    const { error } = await db
      .from("inboxes")
      .update({
        name,
        phone_number: phone,
        ycloud_phone_number_id: ycloudId,
        waba_id: wabaId,
      })
      .eq("id", match.id);
    if (error) throw new Error(error.message);
    updated += 1;
  }

  revalidatePath("/inboxes");
  revalidatePath("/companies");
  return { created, updated, total: remote.length };
}

export async function updateInbox(input: {
  id: string;
  name: string;
  isActive: boolean;
}) {
  const session = await getAppSession();
  if (!session?.isPlatformAdmin) throw new Error("forbidden");

  const supabase = await createClient();
  const { error } = await supabase
    .from("inboxes")
    .update({
      name: input.name,
      is_active: input.isActive,
    })
    .eq("id", input.id);
  if (error) throw new Error(error.message);
  revalidatePath("/inboxes");
  revalidatePath("/companies");
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

  const { data: validInboxes, error: inboxCheckError } = await db
    .from("inboxes")
    .select("id")
    .eq("company_id", input.companyId)
    .eq("is_active", true)
    .in("id", input.inboxIds);
  if (inboxCheckError) throw new Error(inboxCheckError.message);
  if ((validInboxes?.length ?? 0) !== input.inboxIds.length) {
    throw new Error(
      "Uno o más inboxes no pertenecen a la empresa o están inactivos",
    );
  }

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
