import { idiomaDaTela } from "@/lib/i18n/idiomas";
import type { ReactNode } from "react";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { AdminShell } from "@/components/admin/AdminShell";
import { ProvedorDeConfirmacao } from "@/components/ui/confirmar";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { modulosLigados } from "@/lib/instalacao/modulos";
import { instalacaoSemSmtp } from "@/lib/email/estado";
import { createAdminClient } from "@/lib/supabase/admin";
import { redesignLigado } from "@/lib/redesign/chave";
import { ProvedorDoRedesign } from "@/lib/redesign/contexto";

export default async function ProtectedAdminLayout({ children }: { children: ReactNode }) {
  const { user } = await requirePlatformAdmin();
  // Mesmo padrão de `app/app/layout.tsx`: o idioma envolve a árvore inteira e
  // recebe o código PRONTO. Sem este Provider, `useT()` nos componentes do
  // admin cai no padrão do Context (pt-BR) e nenhuma tradução aparece, não
  // importa quantas entradas o dicionário tenha — um admin de plataforma é a
  // MESMA conta que o dono do tenant (o install.sh promove o dono a platform
  // admin), então o `user_metadata.locale` dele já existe e é o mesmo lido em
  // `lib/auth/server.ts`.
  const locale = (user.user_metadata?.locale as string | undefined) ?? null;
  // Duas leituras da INSTALAÇÃO, em paralelo, no layout: os
  // módulos ligados (entradas do menu) e a ausência de SMTP (o aviso
  // persistente — #2755, item 3). É AQUI, e não em cada tela, porque o layout
  // é o denominador comum de todo `/admin/*`: nenhum componente do painel
  // repete consulta, e tela nova nasce com o sinal. `instalacaoSemSmtp` só
  // afirma "sem SMTP" com o banco tendo RESPONDIDO — ver `lib/email/estado.ts`.
  const [modulos, semSmtp] = await Promise.all([
    modulosLigados(createAdminClient()),
    instalacaoSemSmtp(),
  ]);
  return (
    <IdiomaProvider locale={idiomaDaTela(locale)}>
      {/* O admin também abre formulários do app (ex.: TenantForm no "Editar tenant"),
          que confirmam pela confirmação do produto. */}
      <ProvedorDeConfirmacao>
        {/* O painel fica fora de `/app`: o provedor do redesign precisa ser
            montado aqui, com o booleano lido no servidor. */}
        <ProvedorDoRedesign ligado={redesignLigado()}>
          <AdminShell userEmail={user.email ?? ""} modulosLigados={modulos} semSmtp={semSmtp}>
            {children}
          </AdminShell>
        </ProvedorDoRedesign>
      </ProvedorDeConfirmacao>
    </IdiomaProvider>
  );
}
