import { NextResponse } from "next/server";
import { createAdminClient, hasServiceRole } from "@/lib/supabase/admin";
import { getAppSession, sessionHasPermission } from "@/lib/rbac/session";

export async function POST(request: Request) {
  const session = await getAppSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const fullName = String(body.fullName ?? "").trim();
  const companyId = String(body.companyId ?? "");
  const roleId = body.roleId ? String(body.roleId) : null;
  const inboxIds: string[] = Array.isArray(body.inboxIds)
    ? body.inboxIds.map(String).filter(Boolean)
    : [];

  if (!email || !password || !companyId) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  if (
    !sessionHasPermission(session, companyId, "users.manage") &&
    !session.isPlatformAdmin
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (!hasServiceRole()) {
    return NextResponse.json(
      {
        error:
          "Falta SUPABASE_SERVICE_ROLE_KEY para crear usuarios. Añádela en .env.local / Vercel.",
      },
      { status: 500 },
    );
  }

  if (inboxIds.length === 0) {
    return NextResponse.json(
      {
        error:
          "Debes asignar al menos un inbox. Si la empresa no tiene números, asígnalos en Empresas.",
      },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // Validate inboxes belong to the company and are active
  const { data: validInboxes, error: inboxCheckError } = await admin
    .from("inboxes")
    .select("id")
    .eq("company_id", companyId)
    .eq("is_active", true)
    .in("id", inboxIds);

  if (inboxCheckError) {
    return NextResponse.json({ error: inboxCheckError.message }, { status: 500 });
  }

  if ((validInboxes?.length ?? 0) !== inboxIds.length) {
    return NextResponse.json(
      { error: "Uno o más inboxes no pertenecen a la empresa seleccionada" },
      { status: 400 },
    );
  }

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName || email.split("@")[0] },
  });

  if (createError || !created.user) {
    return NextResponse.json(
      { error: createError?.message ?? "create_failed" },
      { status: 400 },
    );
  }

  // Use service role for membership writes (avoid silent RLS failures)
  const { data: membership, error: membershipError } = await admin
    .from("company_memberships")
    .insert({
      company_id: companyId,
      user_id: created.user.id,
      is_active: true,
    })
    .select("id")
    .single();

  if (membershipError || !membership) {
    return NextResponse.json(
      { error: membershipError?.message ?? "membership_failed" },
      { status: 500 },
    );
  }

  if (roleId) {
    const { error: roleError } = await admin.from("membership_roles").insert({
      membership_id: membership.id,
      role_id: roleId,
    });
    if (roleError) {
      return NextResponse.json({ error: roleError.message }, { status: 500 });
    }
  }

  const { error: inboxAssignError } = await admin.from("membership_inboxes").insert(
    inboxIds.map((inboxId) => ({
      membership_id: membership.id,
      inbox_id: inboxId,
    })),
  );

  if (inboxAssignError) {
    return NextResponse.json(
      { error: `Usuario creado pero falló asignación de inboxes: ${inboxAssignError.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    userId: created.user.id,
    membershipId: membership.id,
    inboxIds,
  });
}
