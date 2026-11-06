"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { passwordProblem } from "@/lib/auth/login-policy";
import {
  createSessionToken,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from "@/lib/auth/session-token";
import { passwordMatches, setPassword } from "@/lib/auth/sql-auth";
import { usesSqlServer } from "@/lib/db/backend";
import { getUserDb } from "@/lib/db/client";
import { updateProfileFullName } from "@/lib/db/repos/profiles";
import { createClient } from "@/lib/supabase/server";
import { getAppSession } from "@/lib/rbac/session";

export async function updateMyProfile(fullName: string) {
  const session = await getAppSession();
  if (!session) throw new Error("No autenticado");

  const name = fullName.trim();
  if (!name) throw new Error("El nombre es obligatorio");

  const db = await getUserDb();
  const { error } = await updateProfileFullName(db, session.userId, name);

  if (error) throw new Error(error.message);

  if (!usesSqlServer()) {
    const supabase = await createClient();
    await supabase.auth.updateUser({
      data: { full_name: name },
    });
  }

  revalidatePath("/settings/profile");
  revalidatePath("/", "layout");
  return { ok: true as const };
}

export async function changeMyPassword(input: {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}) {
  const session = await getAppSession();
  if (!session) throw new Error("No autenticado");

  const currentPassword = input.currentPassword;
  const newPassword = input.newPassword;
  const confirmPassword = input.confirmPassword;

  if (!currentPassword) throw new Error("Ingresa tu contraseña actual");
  if (newPassword.length < 8) {
    throw new Error("La nueva contraseña debe tener al menos 8 caracteres");
  }
  if (newPassword !== confirmPassword) {
    throw new Error("Las contraseñas no coinciden");
  }

  if (usesSqlServer()) {
    const problem = passwordProblem(newPassword);
    if (problem) throw new Error(problem);
    if (!(await passwordMatches(session.userId, currentPassword))) {
      throw new Error("Contraseña actual incorrecta");
    }
    const version = await setPassword(session.userId, newPassword);
    // Ends the user's other sessions but keeps this one.
    (await cookies()).set(
      SESSION_COOKIE,
      await createSessionToken(session.userId, version),
      SESSION_COOKIE_OPTIONS,
    );
    return { ok: true as const };
  }

  const supabase = await createClient();

  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: session.email,
    password: currentPassword,
  });
  if (signInError) throw new Error("Contraseña actual incorrecta");

  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw new Error(error.message);

  return { ok: true as const };
}
