import { notFound } from "next/navigation";

import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Honorários é MÓDULO DE TABELA do ADR-0002, como as comandas (`app/app/comandas/layout.tsx`).
 * Não instalado ou DESLIGADO em `/admin/modulos` (migration 1016), esta tela não existe para
 * ninguém: a porta some, não abre vazia. Desligado, as tabelas e os contratos continuam no
 * banco e voltam quando o módulo é religado.
 */
export default async function Layout({ children }: { children: React.ReactNode }) {
  if (!(await moduloLigado(createAdminClient(), "honorarios"))) notFound();
  return children;
}
