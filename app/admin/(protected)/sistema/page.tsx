import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { notFound } from "next/navigation";

import { LinhaDoRecurso } from "@/components/recursos-opcionais/LinhaDoRecurso";
import { loadAuthUser } from "@/lib/auth/server";
import {
  organizacoesAtrasadasESuspensas,
  ultimoDiaDoPeriodo,
} from "@/lib/billing/assinatura/estado-da-assinatura";
import { carregarBloqueioDosPlanos } from "@/lib/billing/planos/bloqueio-da-instalacao";
import { DIAS_DO_CONTADOR, contarFalhasRecentesDoGatilho } from "@/lib/billing/alarmes-de-gatilho";
import { lerAssinaturaDasEntregas } from "@/lib/channels/assinatura-das-entregas";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { carregarComportamentoDaInstalacao } from "@/lib/instalacao/comportamento-servidor";
import { empresasParaMolde, lerMoldeDeIa, resumoDoMoldeNoBanco } from "@/lib/instalacao/molde-de-ia-servidor";
import { MODULOS_AINDA_NAO_LIGAVEIS, MODULOS_OPCIONAIS_POR_FLAG, modulosLigados, type ModuloOpcional } from "@/lib/instalacao/modulos";
import type { TipoDeSuspensao } from "@/lib/organizacao/operante";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  RECURSOS_OPCIONAIS,
  ROTULO_DO_ESTADO,
  estadoDoRecurso,
  type EstadoDoRecurso,
} from "@/lib/recursos-opcionais/catalogo";
import { detectarServidor } from "@/lib/recursos-opcionais/estado";

import {
  FormularioDeBloqueioDosPlanos,
  FormularioDeCadastroDePacotes,
  FormularioDeComportamento,
  FormularioDeModulos,
} from "./_form";
import { FormularioDoMoldeDeIa } from "./_molde-de-ia";

export const metadata = { title: "Recursos opcionais" };

/** Para o que depende do servidor, a voz é "configurado", não "ligado". */
const ROTULO_NO_SERVIDOR: Record<EstadoDoRecurso, string> = {
  ...ROTULO_DO_ESTADO,
  ligado: "Configurado",
  desligado: "Não configurado",
  nao_verificado: "Não dá para ver daqui",
};
export const dynamic = "force-dynamic";

/**
 * `current_period_end`/`dataPrevistaDaSuspensao` são sempre 00:00 em
 * America/Sao_Paulo (migração 0908, decisão 2; comentário de
 * `ultimoDiaDoPeriodo` em `lib/billing/assinatura/estado-da-assinatura.ts`).
 * Fixar o fuso aqui evita que a data mostrada dependa do fuso do SERVIDOR.
 */
const FUSO_SP = "America/Sao_Paulo";

/**
 * Formata no SERVIDOR, com fuso fixo: no cliente, o HTML servido (fuso do
 * contêiner) e a hidratação (fuso do navegador) divergiriam. Mesmo motivo e
 * mesma escolha de `/admin/marca` e `/admin/google`.
 */
function instanteLegivel(iso: string | null, tag: string): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString(tag, {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short",
  });
}

/**
 * A tela onde o dono da instalação decide COMO ela se comporta, sem SSH.
 *
 * ── O defeito que ela fecha (issue #1034) ───────────────────────────────────
 *
 * As chaves que decidem o comportamento de uma instalação JÁ EM OPERAÇÃO — o
 * kill switch do orçamento de IA, a exigência de assinatura no webhook do
 * canal, o modo do portão de divulgação e a camada semântica de promessa — só
 * existiam no `.env`: quem instalou a VPS era o único que conseguia mudá-las,
 * por SSH. É a decisão de produto escondida atrás de infraestrutura.
 *
 * ── Por que `/admin`, e não `/app/settings` ─────────────────────────────────
 *
 * O objeto é a INSTALAÇÃO inteira, não uma empresa. Num revendedor que hospeda
 * várias organizações, deixar o admin de um tenant desligar o bloqueio de gasto
 * mudaria o comportamento de TODOS os clientes daquele servidor. Mesmo
 * argumento de `/admin/cadastro`, `/admin/marca` e `/admin/google` — esta tela
 * é irmã das três, e usa o mesmo `traduzir`/`_form` das irmãs.
 *
 * ── Por que `notFound()`, e não `redirect('/403')` ──────────────────────────
 *
 * Para quem não administra a instalação, esta tela não faz parte do produto. O
 * layout de `(protected)` já roda `requirePlatformAdmin()`, então o gate abaixo
 * é redundante HOJE; ele fica porque a garantia precisa ser local, e um layout
 * pode ser movido. Mesma decisão, mesma frase, de `/admin/cadastro`.
 *
 * ── Por que ela virou "Recursos opcionais" (doc 80) ─────────────────────────
 *
 * Os módulos se ligavam aqui, e a porta se chamava "Comportamento": o
 * mantenedor procurou onde ligar recursos e não achou. Agora são três blocos —
 * Módulos, Comportamento e o que Depende do servidor (só leitura, detectado
 * pelos mesmos leitores das telas de cada recurso). Os dois primeiros continuam
 * gravando pelos formulários de sempre; a lista de recursos é
 * `lib/recursos-opcionais/catalogo.ts`.
 */
export default async function Page() {
  const usuario = await loadAuthUser();
  if (!usuario?.is_platform_admin) notFound();
  const idioma = usuario.idioma;

  const admin = createAdminClient();
  const t = (texto: string) => traduzir(texto, usuario.idioma);
  const tagDoIdioma = tagDeIdioma(usuario.idioma);

  // O valor EFETIVO (linha acima, `.env` como piso): a tela mostra o que está
  // valendo de verdade, e não o que a linha diria se ela existisse.
  const [comportamento, ligados, servidor, assinatura, molde, bloqueio, atrasadasESuspensas, pacotesRes, falhasDoPlano] = await Promise.all([
    carregarComportamentoDaInstalacao(),
    modulosLigados(admin),
    detectarServidor(),
    lerAssinaturaDasEntregas(admin),
    lerMoldeDeIa(admin),
    carregarBloqueioDosPlanos(admin),
    // Fase F4, tarefa 8, decisão 9: a lista de atrasadas e suspensas na tela
    // da instalação.
    organizacoesAtrasadasESuspensas(admin),
    // Fase F4, tarefa 8, decisão 10: o catálogo INTEIRO (ativo e inativo) para
    // o cadastro simples de pacotes desta tela poder desativar.
    admin
      .from("billing_token_pacotes")
      .select("id, codigo, nome, tokens, preco_cents, ativo")
      .order("created_at", { ascending: false }),
    // D-074: o contador ao lado da porta de "Falhas na contagem do plano".
    contarFalhasRecentesDoGatilho(admin),
  ]);
  // O molde de IA das empresas novas (migration 9096). Leitura que falhou vira
  // "nenhum" na tela, com a lista travada: o seletor não oferece escolha sobre
  // um estado que ninguém leu.
  const moldeAtual = molde ?? null;
  const [empresasDoMolde, resumoDoMolde] = await Promise.all([
    molde === undefined ? Promise.resolve(null) : empresasParaMolde(admin, moldeAtual),
    moldeAtual ? resumoDoMoldeNoBanco(admin, moldeAtual) : Promise.resolve(null),
  ]);
  // Spec da cobrança §7(h): o aviso de quantas o desligar libera só existe com ela ligada.
  const suspensasPorCobranca = ligados.includes("cobranca") ? await contarSuspensasPorCobranca(admin) : 0;
  // Módulo que ainda não se liga nesta versão só aparece se já estiver ligado
  // (pelo banco): dá para desligar, e quem nunca ligou não vê interruptor que recusa.
  const escondidos = MODULOS_AINDA_NAO_LIGAVEIS.filter((m) => !ligados.includes(m));
  // `telefonia: null` porque esta tela é da INSTALAÇÃO: o sinal de telefonia é
  // por organização (o tronco salvo) e não existe um "da instalação toda" para
  // ler. `null` é "não lido", nunca "desligado".
  const fontes = { modulos: ligados, settings: null, servidor, telefonia: null };

  // Os módulos que NÃO se ligam por interruptor aqui (módulo de tabela, ADR-0002)
  // aparecem com o caminho de onde se instalam — saem do catálogo, sem lista escrita.
  const modulosDeOutraTela = RECURSOS_OPCIONAIS.filter(
    (r) =>
      r.nivel === "instalacao" &&
      r.modulo &&
      !(MODULOS_OPCIONAIS_POR_FLAG as readonly ModuloOpcional[]).includes(r.modulo),
  );
  const outrasChaves = RECURSOS_OPCIONAIS.filter(
    (r) => r.nivel === "instalacao" && !r.modulo && r.href !== "/admin/sistema",
  );
  const doServidor = RECURSOS_OPCIONAIS.filter((r) => r.nivel === "servidor");

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Recursos opcionais", idioma)}</h1>
        <p className="text-sm text-muted-foreground">
          {traduzir(
            "Tudo o que se liga e desliga nesta instalação, num lugar só. Vale para todas as empresas hospedadas aqui.",
            idioma,
          )}
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <Link className="text-sm text-primary underline-offset-4 hover:underline" href="/admin/sistema/cobranca">{t("Cobrança (Asaas)")}</Link>
          <Link className="text-sm text-primary underline-offset-4 hover:underline" href="/admin/sistema/cupons">{t("Cupons de desconto")}</Link>
          <Link className="text-sm text-primary underline-offset-4 hover:underline" href="/admin/sistema/reembolsos">{t("Reembolsos e cancelamentos")}</Link>
          <Link className="text-sm text-primary underline-offset-4 hover:underline" href="/admin/sistema/exclusoes">{t("Exclusão dos dados")}</Link>
          <Link className="text-sm text-primary underline-offset-4 hover:underline" href="/admin/sistema/falhas-do-plano">
            {t("Falhas na contagem do plano")}
            {falhasDoPlano !== null && falhasDoPlano > 0 && (
              <Badge variant="warning" className="ml-1.5">
                {falhasDoPlano} {t("em")} {DIAS_DO_CONTADOR} {t("dias")}
              </Badge>
            )}
          </Link>
        </div>
      </div>

      <section className="space-y-3" aria-labelledby="bloco-modulos">
        <h2 id="bloco-modulos" className="text-lg font-semibold">
          {traduzir("Módulos", idioma)}
        </h2>
        <FormularioDeModulos ligados={ligados} escondidos={escondidos} suspensasPorCobranca={suspensasPorCobranca} />
        {modulosDeOutraTela.length > 0 && (
          <ul className="space-y-3">
            {modulosDeOutraTela.map((r) => {
              const estado = estadoDoRecurso(r, fontes);
              return (
                <LinhaDoRecurso
                  key={r.id}
                  recurso={r}
                  estado={estado}
                  rotuloDoEstado={traduzir(ROTULO_DO_ESTADO[estado], idioma)}
                  ajustar={r.href}
                  idioma={idioma}
                />
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="bloco-comportamento">
        <h2 id="bloco-comportamento" className="text-lg font-semibold">
          {traduzir("Comportamento", idioma)}
        </h2>
        <FormularioDeComportamento
          inicial={comportamento}
          assinatura={
            assinatura && {
              assinadas: assinatura.assinadas,
              ultimaAssinada: instanteLegivel(assinatura.ultimaAssinadaEm, tagDeIdioma(idioma)),
              ultimaSemAssinatura: instanteLegivel(assinatura.ultimaSemAssinaturaEm, tagDeIdioma(idioma)),
            }
          }
        />
        <FormularioDoMoldeDeIa inicial={moldeAtual} empresas={empresasDoMolde} resumoInicial={resumoDoMolde} />
        <ul className="space-y-3">
          {outrasChaves.map((r) => (
            <LinhaDoRecurso
              key={r.id}
              recurso={r}
              estado="nao_verificado"
              rotuloDoEstado={traduzir("Veja na tela dele", idioma)}
              ajustar={r.href}
              idioma={idioma}
            />
          ))}
        </ul>
      </section>

      {/* Planos e assinatura da Hiperbold (lib/billing): bloqueio, atrasadas e suspensas, pacotes. */}
      <div className="space-y-6">
        <FormularioDeBloqueioDosPlanos inicial={bloqueio} />

        {/* Fase F4, tarefa 8, decisão 9: organizações atrasadas e suspensas. */}
        <Card>
          <CardHeader>
            <CardTitle>{t("Organizações atrasadas e suspensas")}</CardTitle>
          </CardHeader>
          <CardContent>
            {atrasadasESuspensas.leituraFalhou ? (
              <p className="text-sm text-destructive">
                {t("Não foi possível ler as organizações atrasadas e suspensas agora.")}
              </p>
            ) : atrasadasESuspensas.organizacoes.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("Nenhuma organização atrasada ou suspensa no momento.")}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Organização")}</TableHead>
                    <TableHead>{t("Estado")}</TableHead>
                    <TableHead>{t("Fim do período")}</TableHead>
                    <TableHead>{t("Data prevista do modo leitura")}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {atrasadasESuspensas.organizacoes.map((org) => (
                    <TableRow key={org.organizationId}>
                      <TableCell className="font-medium">{org.nome}</TableCell>
                      <TableCell>
                        <Badge variant={org.status === "suspensa" ? "error" : "warning"}>
                          {org.status === "suspensa" ? t("Suspensa") : t("Atrasada")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {org.currentPeriodEnd
                          ? ultimoDiaDoPeriodo(org.currentPeriodEnd).toLocaleDateString(tagDoIdioma, {
                              timeZone: FUSO_SP,
                            })
                          : "-"}
                      </TableCell>
                      <TableCell>
                        {org.dataPrevistaDaSuspensao
                          ? new Date(org.dataPrevistaDaSuspensao).toLocaleDateString(tagDoIdioma, {
                              timeZone: FUSO_SP,
                            })
                          : "-"}
                      </TableCell>
                      <TableCell>
                        <Link
                          className="text-sm text-primary underline-offset-4 hover:underline"
                          href={`/admin/tenants/${org.organizationId}/plano`}
                        >
                          {t("Ver plano")}
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <FormularioDeCadastroDePacotes
          pacotes={(pacotesRes.data ?? []) as {
            id: string;
            codigo: string;
            nome: string;
            tokens: number;
            preco_cents: number | null;
            ativo: boolean;
          }[]}
          leituraFalhou={Boolean(pacotesRes.error)}
        />
      </div>

      <section className="space-y-3" aria-labelledby="bloco-servidor">
        <div className="space-y-1">
          <h2 id="bloco-servidor" className="text-lg font-semibold">
            {traduzir("Depende do servidor", idioma)}
          </h2>
          <p className="text-sm text-muted-foreground">
            {traduzir(
              "Só leitura. Estes dependem de credencial ou do arquivo de ambiente do servidor. Nenhum valor de segredo aparece aqui.",
              idioma,
            )}
          </p>
        </div>
        <ul className="space-y-3">
          {doServidor.map((r) => {
            const estado = estadoDoRecurso(r, fontes);
            return (
              <LinhaDoRecurso
                key={r.id}
                recurso={r}
                estado={estado}
                rotuloDoEstado={traduzir(ROTULO_NO_SERVIDOR[estado], idioma)}
                ajustar={r.href}
                idioma={idioma}
              />
            );
          })}
        </ul>
      </section>
    </div>
  );
}

const SUSPENSA_POR_COBRANCA: TipoDeSuspensao = "cobranca";

/** Quantas empresas estão suspensas por falta de pagamento. `null` = a leitura falhou: a tela não afirma número que não leu. */
async function contarSuspensasPorCobranca(db: SupabaseClient): Promise<number | null> {
  const { count, error } = await db
    .from("organizations")
    .select("id", { count: "exact", head: true })
    .eq("status", "suspended")
    .eq("suspended_kind", SUSPENSA_POR_COBRANCA);
  return error ? null : (count ?? 0);
}
