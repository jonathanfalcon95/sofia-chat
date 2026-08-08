"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getAppSession } from "@/lib/rbac/session";

export async function updateMyProfile(fullName: string) {
  const session = await getAppSession();
  if (!session) throw new Error("No autenticado");

  const name = fullName.trim();
  if (!name) throw new Error("El nombre es obligatorio");

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({ full_name: name })
    .eq("id", session.userId);

  if (error) throw new Error(error.message);

  await supabase.auth.updateUser({
    data: { full_name: name },
  });

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
