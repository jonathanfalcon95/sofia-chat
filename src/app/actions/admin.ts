"use server";

import { revalidatePath } from "next/cache";
import { getSystemDb, getUserDb, hasServiceRole } from "@/lib/db/client";
import {
  insertCompany,
  updateCompanyById,
} from "@/lib/db/repos/companies";
import {
  assignInboxesToCompany,
  listActiveCompanyInboxIds,
  listCompanyInboxIds,
  listInboxCompaniesByIds,
  unassignCompanyInboxes,
  updateInboxById,
} from "@/lib/db/repos/inboxes";
import {
  deleteMembershipInboxes,
  deleteMembershipInboxLinks,
  deleteMembershipRoles,
  findCompanyMembership,
  insertMembershipInboxes,
  insertMembershipRole,
  listCompanyMembershipIds,
  updateMembershipActive,
} from "@/lib/db/repos/memberships";
import { updateProfileFullName } from "@/lib/db/repos/profiles";
import {
  deleteRolePermissionsByIds,
  deleteRolePermissionsByRole,
  findCompanyRole,
  insertRole,
  insertRolePermissionRows,
  listPermissionsByCodes,
  listRolePermissionCodes,
  listRolePermissionRows,
  listTemplateRolesWithPermissions,
  updateCompanyRole,
} from "@/lib/db/repos/roles";
import { insertTags, updateContactDetails } from "@/lib/db/repos/tags";
import type { Db } from "@/lib/db/types";
import { getAppSession, sessionHasPermission } from "@/lib/rbac/session";
import {
  isPlatformPermission,
  isReservedRoleName,
  sanitizeRolePermissionCodes,
} from "@/lib/rbac/permissions";
import {
  ensureYCloudWebhook,
  listYCloudAccountsPublic,
  seedYCloudAccountsFromEnv,
  syncYCloudPhoneNumbers,
  upsertYCloudAccount,
  type YCloudAccountPublic,
} from "@/lib/ycloud/accounts";

async function assignCompanyInboxes(companyId: string, inboxIds: string[]) {
  const db = hasServiceRole()
    ? getSystemDb()
    : await getUserDb();

  const selected = Array.from(new Set(inboxIds.filter(Boolean)));

  const { data: current, error: currentError } = await listCompanyInboxIds(
    db,
    companyId,
  );
  if (currentError) throw new Error(currentError.message);

  const currentIds = (current ?? []).map((i) => i.id as string);
  const toUnassign = currentIds.filter((id) => !selected.includes(id));
  const toAssign = selected.filter((id) => !currentIds.includes(id));

  if (toAssign.length) {
    const { data: assignable, error: assignableError } =
      await listInboxCompaniesByIds(db, toAssign);
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
    const { error } = await assignInboxesToCompany(db, toAssign, companyId);
    if (error) throw new Error(error.message);
  }

  if (toUnassign.length) {
    const { data: memberships, error: membershipsError } =
      await listCompanyMembershipIds(db, companyId);
    if (membershipsError) throw new Error(membershipsError.message);
    const membershipIds = (memberships ?? []).map((m) => m.id as string);
    if (membershipIds.length) {
      const { error: miError } = await deleteMembershipInboxLinks(
        db,
        membershipIds,
        toUnassign,
      );
      if (miError) throw new Error(miError.message);
    }
    const { error } = await unassignCompanyInboxes(db, toUnassign, companyId);
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
  const db = await getUserDb();

  const { data: company, error } = await insertCompany(db, {
    name: input.name,
    slug: input.slug,
    guid_company: input.guidCompany?.trim() || null,
  });
  if (error || !company) throw new Error(error?.message ?? "create_failed");

  const { data: templates } = await listTemplateRolesWithPermissions(db);

  for (const template of templates ?? []) {
    const { data: role } = await insertRole(db, {
      company_id: company.id,
      name: template.name,
      description: template.description,
      is_system: true,
    });
    if (!role) continue;
    const perms =
      template.role_permissions?.map((rp: { permission_id: string }) => ({
        role_id: role.id,
        permission_id: rp.permission_id,
      })) ?? [];
    if (perms.length) await insertRolePermissionRows(db, perms);
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

  await insertTags(
    db,
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
  const db = await getUserDb();
  const { error } = await updateCompanyById(db, input.id, {
    name: input.name,
    slug: input.slug,
    is_active: input.isActive,
    guid_company: input.guidCompany?.trim() || null,
  });
  if (error) throw new Error(error.message);

  await assignCompanyInboxes(input.id, input.inboxIds);

  revalidatePath("/companies");
  revalidatePath("/inboxes");
  revalidatePath("/settings/users");
}

export async function listYCloudAccounts(): Promise<YCloudAccountPublic[]> {
  const session = await getAppSession();
  if (!session?.isPlatformAdmin) throw new Error("forbidden");
  await seedYCloudAccountsFromEnv();
  return listYCloudAccountsPublic();
}

export async function saveYCloudAccount(input: {
  id?: string;
  name: string;
  apiKey?: string;
  webhookSecret?: string;
  isActive?: boolean;
}) {
  const session = await getAppSession();
  if (!session?.isPlatformAdmin) throw new Error("forbidden");
  const row = await upsertYCloudAccount(input);
  const webhook = await ensureYCloudWebhook(row.id);
  revalidatePath("/inboxes");
  return { account: (await listYCloudAccountsPublic()).find((a) => a.id === row.id)!, webhook };
}

export async function registerYCloudWebhook(accountId: string) {
  const session = await getAppSession();
  if (!session?.isPlatformAdmin) throw new Error("forbidden");
  const webhook = await ensureYCloudWebhook(accountId);
  revalidatePath("/inboxes");
  return webhook;
}

export async function syncYCloudInboxes(accountId: string) {
  const session = await getAppSession();
  if (!session?.isPlatformAdmin) throw new Error("forbidden");
  if (!accountId) throw new Error("Selecciona una cuenta YCloud");
  if (!hasServiceRole()) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY no configurada");
  }

  const result = await syncYCloudPhoneNumbers(accountId);
  revalidatePath("/inboxes");
  revalidatePath("/companies");
  return result;
}

export async function updateInbox(input: {
  id: string;
  name: string;
  isActive: boolean;
}) {
  const session = await getAppSession();
  if (!session?.isPlatformAdmin) throw new Error("forbidden");

  const db = await getUserDb();
  const { error } = await updateInboxById(db, input.id, {
    name: input.name,
    is_active: input.isActive,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/inboxes");
  revalidatePath("/companies");
}

async function insertRolePermissions(
  db: Db,
  roleId: string,
  codes: string[],
) {
  if (!codes.length) return;
  const { data: perms, error } = await listPermissionsByCodes(db, codes);
  if (error) throw new Error(error.message);
  if (!perms?.length) return;
  const { error: insertError } = await insertRolePermissionRows(
    db,
    perms.map((p) => ({ role_id: roleId, permission_id: p.id })),
  );
  if (insertError) throw new Error(insertError.message);
}

async function replaceRolePermissions(
  db: Db,
  roleId: string,
  codes: string[],
  isPlatformAdmin: boolean,
) {
  const codesToInsert = isPlatformAdmin
    ? codes
    : codes.filter((code) => !isPlatformPermission(code));

  if (isPlatformAdmin) {
    const { error } = await deleteRolePermissionsByRole(db, roleId);
    if (error) throw new Error(error.message);
  } else {
    const { data: existing, error: existingError } =
      await listRolePermissionRows(db, roleId);
    if (existingError) throw new Error(existingError.message);
    const idsToDelete = (existing ?? [])
      .filter((row) => {
        const perm = Array.isArray(row.permissions)
          ? row.permissions[0]
          : row.permissions;
        const code = perm?.code as string | undefined;
        return typeof code === "string" && !isPlatformPermission(code);
      })
      .map((row) => row.id as string);
    if (idsToDelete.length) {
      const { error } = await deleteRolePermissionsByIds(db, idsToDelete);
      if (error) throw new Error(error.message);
    }
  }

  await insertRolePermissions(db, roleId, codesToInsert);
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
  if (isReservedRoleName(input.name)) {
    throw new Error("Ese nombre de rol está reservado");
  }

  const permissionCodes = sanitizeRolePermissionCodes(
    input.permissionCodes,
    [],
    session.isPlatformAdmin,
  );

  const db = await getUserDb();
  const { data: role, error } = await insertRole(db, {
    company_id: input.companyId,
    name: input.name,
    description: input.description ?? null,
    is_system: false,
  });
  if (error || !role) throw new Error(error?.message ?? "role_failed");

  await insertRolePermissions(db, role.id, permissionCodes);

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
  if (isReservedRoleName(input.name)) {
    throw new Error("Ese nombre de rol está reservado");
  }

  const db = await getUserDb();
  const { data: existingRows, error: existingError } =
    await listRolePermissionCodes(db, input.id);
  if (existingError) throw new Error(existingError.message);

  const existingCodes = (existingRows ?? [])
    .map((row) => {
      const perm = Array.isArray(row.permissions)
        ? row.permissions[0]
        : row.permissions;
      return perm?.code as string | undefined;
    })
    .filter((code): code is string => Boolean(code));

  const permissionCodes = sanitizeRolePermissionCodes(
    input.permissionCodes,
    existingCodes,
    session.isPlatformAdmin,
  );

  const { error } = await updateCompanyRole(db, input.id, input.companyId, {
    name: input.name,
    description: input.description ?? null,
  });
  if (error) throw new Error(error.message);

  await replaceRolePermissions(
    db,
    input.id,
    permissionCodes,
    session.isPlatformAdmin,
  );
  revalidatePath("/settings/roles");
}

async function assignMembershipInboxes(
  membershipId: string,
  inboxIds: string[],
) {
  const db = hasServiceRole()
    ? getSystemDb()
    : await getUserDb();

  const { error: delError } = await deleteMembershipInboxes(db, membershipId);
  if (delError) throw new Error(delError.message);

  if (inboxIds.length) {
    const { error } = await insertMembershipInboxes(
      db,
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

  const db = hasServiceRole()
    ? getSystemDb()
    : await getUserDb();

  // The permission above only covers input.companyId; writes below use ids
  // from the client with the service role, so tie them to that company first.
  const { data: membership, error: membershipCheckError } =
    await findCompanyMembership(
      db,
      input.membershipId,
      input.companyId,
      input.userId,
    );
  if (membershipCheckError) throw new Error(membershipCheckError.message);
  if (!membership) throw new Error("forbidden");

  if (input.roleId) {
    const { data: role, error: roleCheckError } = await findCompanyRole(
      db,
      input.roleId,
      input.companyId,
    );
    if (roleCheckError) throw new Error(roleCheckError.message);
    if (!role) throw new Error("El rol no pertenece a la empresa");
  }

  const { data: validInboxes, error: inboxCheckError } =
    await listActiveCompanyInboxIds(db, input.companyId, input.inboxIds);
  if (inboxCheckError) throw new Error(inboxCheckError.message);
  if ((validInboxes?.length ?? 0) !== input.inboxIds.length) {
    throw new Error(
      "Uno o más inboxes no pertenecen a la empresa o están inactivos",
    );
  }

  const { error: mErr } = await updateMembershipActive(
    db,
    input.membershipId,
    input.isActive,
  );
  if (mErr) throw new Error(mErr.message);

  if (input.fullName) {
    const { error: pErr } = await updateProfileFullName(
      db,
      input.userId,
      input.fullName,
    );
    if (pErr) throw new Error(pErr.message);
  }

  const { error: delRolesErr } = await deleteMembershipRoles(
    db,
    input.membershipId,
  );
  if (delRolesErr) throw new Error(delRolesErr.message);

  if (input.roleId) {
    const { error: roleErr } = await insertMembershipRole(db, {
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
  const db = await getUserDb();
  const phone = input.phoneNumber.startsWith("+")
    ? input.phoneNumber
    : `+${input.phoneNumber}`;
  const { error } = await updateContactDetails(db, input.id, {
    name: input.name,
    phone_number: phone,
  });
  if (error) throw new Error(error.message);
  revalidatePath("/contacts");
}
