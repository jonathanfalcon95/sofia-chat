export const metadata = { title: "Sofia Chat · Mantenimiento" };

export default function MaintenancePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-[#070b14] px-6 text-center text-[#e8eef9]">
      <h1 className="text-2xl font-bold tracking-tight">Estamos en mantenimiento</h1>
      <p className="max-w-md text-sm text-[#93a4c3]">
        Volvemos en unos minutos. Los mensajes de WhatsApp que lleguen mientras tanto no se pierden:
        aparecerán en tu bandeja cuando terminemos.
      </p>
    </main>
  );
}
