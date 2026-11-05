"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";

import { useT } from "@/hooks/i18n/useT";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format, formatRelative, isToday, isYesterday } from "date-fns";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { CaretDown, CaretUp, ChatCircle, Check, PencilSimple, Trash } from "@/lib/ui/icons";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useActiveOrg } from "@/hooks/auth/AuthProvider";
import { useContactTagVocabulary } from "@/hooks/contacts/useContactTagVocabulary";
import { useDeleteContact, mensagemDeBloqueioPorVinculo } from "@/hooks/contacts/useDeleteContact";
import type { ContactOrderBy } from "@/lib/schemas/contacts";
import type { Contact } from "@/lib/types/contacts";
import { rotuloParaAEquipe } from "@/lib/contacts/rotulo-do-contato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { COLUNAS_DO_SISTEMA, COLUNAS_PADRAO, PREFIXO_DE_CAMPO } from "@/lib/contacts/colunas-da-lista";
import { rotuloDaOrigem } from "@/lib/contacts/origens";
import { useConversaNovaComEscolhaDeCanal } from "@/components/channels/SeletorDeCanalParaConversa";
import { EditContactDialog } from "@/components/contacts/EditContactDialog";

/** A seleção em lote, quando a pessoa pode usá-la (exclusão pede `agent`). Ausente = sem caixas. */
export interface SelecaoDaTabela {
  ids: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** Marca (ou desmarca) todas as linhas que a tabela mostra. */
  onTogglePagina: (marcar: boolean) => void;
}

interface Props {
  contacts: Contact[];
  selecao?: SelecaoDaTabela;
  orderBy: ContactOrderBy;
  orderDir: "asc" | "desc";
  onSort: (column: ContactOrderBy) => void;
  /**
   * As colunas, na ordem (`lib/contacts/colunas-da-lista.ts`). Ausente = as 7 de sempre.
   * "nome" e "acoes" vêm sempre — quem garante é `normalizarColunas`.
   */
  colunas?: readonly string[];
  /** Rótulo de cada campo personalizado do contato (`cf:<chave>`); sem rótulo, a chave. */
  rotulosDeCampo?: ReadonlyMap<string, string>;
  /**
   * Seleção múltipla (#2484, fatia F3). Quando `onAlternarSelecao` vem, cada
   * linha ganha a caixa de marcação e a tabela oferece o "selecionar todas" —
   * sem ela, a tabela é exatamente a que era. A barra de ações em lote mora
   * FORA (no cliente da página): esta componente só mede a seleção.
   * Convive com `selecao` (a seleção da Hiperbold, com exportação): quando
   * `selecao` vem, ela manda e estas três são ignoradas.
   */
  selecionados?: Set<string>;
  onAlternarSelecao?: (id: string) => void;
  onSelecionarTodosVisiveis?: () => void;
}

/** Valor de campo personalizado como texto de célula. */
function textoDoCampo(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function displayName(c: Contact, t: (texto: string) => string = (texto) => texto): string {
  return rotuloParaAEquipe(c, t);
}

/** Hoje/ontem: relativo ("há 2 horas", "ontem"). Mais antigo: data, não dia da semana. */
// `locale` ANTES de `now`, e não depois: `now` tem default, e um parâmetro
// obrigatório atrás de um opcional obriga todo chamador a passar os dois. O
// codemod acrescentou no fim, que é o certo em 22 dos 23 casos e o errado aqui.
function formatUltimaAtividade(iso: string, locale: Locale, now = new Date()): string {
  const d = new Date(iso);
  if (isToday(d) || isYesterday(d)) {
    return formatRelative(d, now, { locale: locale });
  }
  return format(d, "dd/MM/yyyy", { locale: locale });
}

function SortableHead({
  label,
  column,
  orderBy,
  orderDir,
  onSort,
  className,
}: {
  label: string;
  column: ContactOrderBy;
  orderBy: ContactOrderBy;
  orderDir: "asc" | "desc";
  onSort: (column: ContactOrderBy) => void;
  className?: string;
}) {
  const active = orderBy === column;
  const muted = "text-muted-foreground";
  const emphasis = "text-foreground";

  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex items-center gap-1 font-medium hover:text-foreground"
        aria-sort={active ? (orderDir === "asc" ? "ascending" : "descending") : "none"}
      >
        {label}
        <span className="inline-flex flex-col -space-y-1" aria-hidden>
          <CaretUp
            size={12}
            weight="bold"
            className={active && orderDir === "asc" ? emphasis : muted}
          />
          <CaretDown
            size={12}
            weight="bold"
            className={active && orderDir === "desc" ? emphasis : muted}
          />
        </span>
      </button>
    </TableHead>
  );
}

/** Caixa de seleção nativa: acessível por teclado e leitor de tela sem biblioteca nova. */
function CaixaDeSelecao({
  marcada,
  indeterminada = false,
  desabilitada = false,
  onChange,
  rotulo,
}: {
  marcada: boolean;
  indeterminada?: boolean;
  desabilitada?: boolean;
  onChange: (marcada: boolean) => void;
  rotulo: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminada && !marcada;
  }, [indeterminada, marcada]);
  // No toque, a área que pega o dedo passa a 44px sem mudar o desenho (a mesma régua
  // da caixa do lote do upstream). O alvo é o `::before` do <label> que envolve a
  // caixa, e não o do <input>: o Safari do iPhone não desenha pseudo-elemento em
  // input. Tocar no rótulo marca a caixa em qualquer navegador.
  return (
    <label
      className="relative inline-flex cursor-pointer pointer-coarse:before:absolute pointer-coarse:before:-inset-3.5 pointer-coarse:before:content-['']"
      onClick={(e) => e.stopPropagation()}
    >
      <input
        ref={ref}
        type="checkbox"
        className="h-4 w-4 cursor-pointer rounded-sm border-border accent-[var(--color-accent,currentColor)]"
        checked={marcada}
        disabled={desabilitada}
        aria-label={rotulo}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

export function ContactsTable({
  contacts,
  selecao,
  orderBy,
  orderDir,
  onSort,
  colunas = COLUNAS_PADRAO,
  rotulosDeCampo,
  selecionados,
  onAlternarSelecao,
  onSelecionarTodosVisiveis,
}: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const orgAtiva = useActiveOrg();
  const clientesLigado = orgAtiva?.cliente_pela_agenda === true;
  // O autocompletar de etiquetas do diálogo de edição (issue #2732): o mesmo
  // vocabulário da ficha. O caminho rápido NÃO traz as `canonical_tags` do funil
  // — ele já abre sem os campos do funil (ver o comentário de `contatoEmEdicao`),
  // e o diálogo segue contando com o vocabulário da organização para sugerir o
  // que já existe.
  const vocabularioDeEtiquetas = useContactTagVocabulary(orgAtiva?.orgId ?? null);
  const del = useDeleteContact();
  const [alvo, setAlvo] = useState<Contact | null>(null);
  // Issue #2715 — editar pela linha, sem abrir a ficha. Sem customFieldDefs:
  // o contrato do diálogo some a seção de campos do funil, e o caminho rápido
  // coexiste com o completo (quem precisa dos campos abre a ficha, como hoje).
  const [contatoEmEdicao, setContatoEmEdicao] = useState<Contact | null>(null);
  const router = useRouter();
  const qc = useQueryClient();
  // Issue #2382 — seletor de canal ao INICIAR a conversa. O diálogo é o retorno
  // do hook (nulo quando não há o que escolher), e o que acontece depois de
  // abrir é daqui: invalidar a lista e navegar para o inbox.
  const {
    iniciarConversa: abrirConversa,
    abrindo,
    seletor: seletorDeCanal,
  } = useConversaNovaComEscolhaDeCanal({
    aoAbrir: async (conversationId) => {
      await qc.invalidateQueries({ queryKey: ["contacts"] });
      router.push(`/app/inbox?id=${conversationId}`);
    },
  });

  // Pré-checagem da exclusão (issue #1925): o diálogo "Excluir contato?" avisa
  // que a Agenda vai barrar ANTES do clique, com a MESMA contagem que o 409
  // usa (rota `contacts/[id]/vinculos`). Consulta só quando há alvo — uma
  // contagem por linha da lista seria N requisições para ver a tabela.
  // Se a prévia falhar, nada trava: sem ela o 409 continua barando e a frase
  // do erro já nomeia o vínculo.
  const alvoId = alvo?.id ?? null;
  const vinculos = useQuery({
    queryKey: ["contato-vinculos-para-excluir", alvoId],
    enabled: alvoId !== null,
    retry: false,
    queryFn: async () => {
      if (!alvoId) return { vinculos: [], por_tabela: {} };
      const corpo = await apiClient.get<{
        data?: { vinculos: string[]; por_tabela: Record<string, number> };
      }>(`/api/v1/contacts/${alvoId}/vinculos`);
      // O MESMO formato do `error.details` do 409: a frase da tela é uma só,
      // servida pela mesma função dos dois caminhos.
      return corpo.data ?? { vinculos: [], por_tabela: {} };
    },
  });
  const avisoDeVinculo = alvo ? mensagemDeBloqueioPorVinculo(vinculos.data, t) : null;

  async function iniciarConversa(c: Contact) {
    if (!c.phone_number || abrindo) return;
    // O hook decide se há escolha (issue #2382) e faz o POST; quem decide o
    // destino depois é `aoAbrir`, declarado acima.
    await abrirConversa({ contact_id: c.id, phone_number: c.phone_number });
  }

  async function confirmarExclusao() {
    if (!alvo) return;
    try {
      await del.mutateAsync(alvo.id);
      toast.success(t("Contato excluído."));
      setAlvo(null);
    } catch {
      // hook handles toast
    }
  }

  // Abaixo de `md` cada linha vira um cartão (só CSS, como o Inbox: o DOM é o
  // mesmo nas duas larguras). O telefone e a última atividade alinham sob o
  // nome, que começa depois da caixa de seleção quando ela existe.
  const recuoSobONome = selecao || onAlternarSelecao ? "max-md:pl-7.5" : "max-md:pl-0";

  return (
    <>
    <Table className="max-md:block">
      <TableHeader className="max-md:hidden">
        <TableRow>
          {selecao && (
            <TableHead className="w-10">
              <CaixaDeSelecao
                rotulo={t("Selecionar esta página")}
                marcada={
                  contacts.some((c) => !c.is_anonymized) &&
                  contacts.filter((c) => !c.is_anonymized).every((c) => selecao.ids.has(c.id))
                }
                indeterminada={contacts.some((c) => selecao.ids.has(c.id))}
                onChange={selecao.onTogglePagina}
              />
            </TableHead>
          )}
          {/*
            Cabeça da seleção em lote (#2484, F3): marca de uma vez tudo o que
            está na tela. Só existe quando a tabela recebe as props de seleção
            — quem não liga o lote continua com a tabela de sempre.
          */}
          {!selecao && onAlternarSelecao && (
            <TableHead className="w-[40px]">
              <button
                type="button"
                role="checkbox"
                aria-checked={
                  selecionados ? contacts.every((c) => selecionados.has(c.id)) : false
                }
                aria-label={t("Selecionar todos os contatos visíveis")}
                title={t("Selecionar todas")}
                data-testid="selecionar-todos-contatos"
                onClick={onSelecionarTodosVisiveis}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-muted-foreground bg-background transition-colors hover:bg-surface-elevated focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
              >
                {selecionados && contacts.every((c) => selecionados.has(c.id)) && (
                  <Check size={12} weight="bold" aria-hidden />
                )}
              </button>
            </TableHead>
          )}
          {colunas.map((id) => {
            const ordem = { orderBy, orderDir, onSort };
            switch (id) {
              case "nome":
                return <SortableHead key={id} label={t("Nome")} column="display_name" {...ordem} />;
              case "email":
                return <SortableHead key={id} label={t("Email")} column="email" {...ordem} />;
              case "telefone":
                return <SortableHead key={id} label={t("Telefone")} column="phone_number" {...ordem} />;
              case "ultima_atividade":
                return (
                  <SortableHead key={id} label={t("Última atividade")} column="last_activity_at" {...ordem} />
                );
              case "entrou_no_crm":
                return <SortableHead key={id} label={t("Entrou no CRM")} column="created_at" {...ordem} />;
              case "acoes":
                return (
                  <TableHead key={id} className="w-[88px]">
                    <span className="sr-only">{t("Ações")}</span>
                  </TableHead>
                );
              default: {
                const doSistema = COLUNAS_DO_SISTEMA.find((c) => c.id === id);
                const chave = id.slice(PREFIXO_DE_CAMPO.length);
                return (
                  <TableHead key={id}>{doSistema ? t(doSistema.rotulo) : (rotulosDeCampo?.get(chave) ?? chave)}</TableHead>
                );
              }
            }
          })}
        </TableRow>
      </TableHeader>
      <TableBody className="max-md:block">
        {contacts.map((c) => (
          <TableRow
            key={c.id}
            className="cursor-pointer max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-3.5 max-md:px-4 max-md:py-2"
            data-state={selecao?.ids.has(c.id) ? "selected" : undefined}
          >
            {selecao && (
              <TableCell className="w-10 max-md:p-0">
                <CaixaDeSelecao
                  rotulo={`${t("Selecionar")} ${displayName(c, t)}`}
                  marcada={selecao.ids.has(c.id)}
                  // Anonimizado (LGPD) aparece, mas não entra no lote nem na exportação.
                  desabilitada={Boolean(c.is_anonymized)}
                  onChange={() => selecao.onToggle(c.id)}
                />
              </TableCell>
            )}
            {!selecao && onAlternarSelecao && (
              <TableCell className="max-md:p-0">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={selecionados?.has(c.id) ?? false}
                  aria-label={`${t("Selecionar contato")} ${displayName(c, t)}`}
                  data-testid={`selecionar-contato-${c.id}`}
                  onClick={() => onAlternarSelecao(c.id)}
                  className="relative flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-muted-foreground bg-background transition-colors hover:bg-surface-elevated focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent pointer-coarse:before:absolute pointer-coarse:before:-inset-3.5"
                >
                  {selecionados?.has(c.id) && <Check size={12} weight="bold" aria-hidden />}
                </button>
              </TableCell>
            )}
            {colunas.map((id) => {
              switch (id) {
                case "nome":
                  return (
                    <TableCell key="nome" className="font-medium max-md:min-w-0 max-md:flex-1 max-md:p-0 max-md:wrap-anywhere">
                      <Link
                        href={`/app/contacts/${c.id}`}
                        className="hover:underline max-md:flex max-md:min-h-11 max-md:items-center"
                      >
                        {displayName(c)}
                      </Link>
                    </TableCell>
                  );
                case "email":
                  return (
                    <TableCell key="email" className="text-muted-foreground max-md:hidden">
                      {c.email ?? "—"}
                    </TableCell>
                  );
                case "telefone":
                  return (
                    <TableCell
                      key="telefone"
                      className={`text-muted-foreground max-md:basis-full max-md:py-0 max-md:pr-0 max-md:text-xs ${recuoSobONome}`}
                    >
                      {c.phone_number ? phoneForDisplay(c.phone_number) : "—"}
                    </TableCell>
                  );
                case "tags":
                  return (
                    <TableCell key="tags" className="max-md:hidden">
                      <div className="flex flex-wrap gap-1">
                        {c.tags.length === 0
                          ? <span className="text-muted-foreground text-xs">—</span>
                          : c.tags.map((tag) => (
                              <ChipDeEtiqueta key={tag} tag={tag} />
                            ))}
                      </div>
                    </TableCell>
                  );
                case "ultima_atividade":
                  return (
                    <TableCell
                      key="ultima_atividade"
                      className={`text-muted-foreground text-sm max-md:py-0 max-md:pr-0 max-md:text-xs ${recuoSobONome}`}
                    >
                      {c.last_activity_at
                        ? formatUltimaAtividade(c.last_activity_at, localeDaData)
                        : "—"}
                    </TableCell>
                  );
                case "status":
                  return (
                    <TableCell key="status" className="max-md:min-w-0 max-md:flex-1 max-md:p-0">
                      <div className="flex flex-wrap gap-1">
                        {c.is_anonymized && <Badge variant="destructive">{t("Anonimizado")}</Badge>}
                        {c.is_blocked && <Badge variant="warning">{t("Bloqueado")}</Badge>}
                        {/*
                          Selo "Pessoal" lido da COLUNA, nunca da etiqueta (critério 5):
                          mesma regra do aviso acima — etiqueta se edita, coluna não.
                          "Ativo" some junto: pessoal está fora da operação, então
                          chamar de ativo mentiria na mesma linha em que o selo conta.
                        */}
                        {c.is_personal && <Badge variant="secondary">{t("Pessoal")}</Badge>}
                        {/*
                          Lê a COLUNA, nunca a tag, e só com a regra ligada: a tag
                          `cliente` é removível à mão e pelo PATCH (que substitui `tags`
                          por inteiro), e um selo que some porque alguém editou
                          etiquetas mentiria sobre um fato. Desligada, a coluna está
                          congelada e o selo mentiria do outro lado.
                        */}
                        {clientesLigado && c.first_service_at && (
                          <Badge variant="secondary">{t("Cliente")}</Badge>
                        )}
                        {!c.is_anonymized && !c.is_blocked && !c.is_personal && (
                          <Badge variant="success">{t("Ativo")}</Badge>
                        )}
                      </div>
                    </TableCell>
                  );
                case "acoes":
                  return (
                    <TableCell key="acoes" className="max-md:p-0">
                      <div className="flex items-center justify-end gap-0.5">
                        {c.conversa ? (
                          <Button variant="ghost" size="icon" className="md:h-8 md:w-8" asChild>
                            <Link
                              href={`/app/inbox?id=${c.conversa.id}`}
                              title={t("Abrir conversa no Inbox")}
                              aria-label={`${t("Abrir conversa com")} ${displayName(c, t)} ${t("no Inbox")}`}
                            >
                              <ChatCircle size={16} weight="regular" aria-hidden />
                              {c.conversa.unread > 0 && (
                                <span className="sr-only">{c.conversa.unread} {t("sem ler")}</span>
                              )}
                            </Link>
                          </Button>
                        ) : c.phone_number ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="md:h-8 md:w-8"
                            title={t("Iniciar conversa no Inbox")}
                            aria-label={`${t("Iniciar conversa com")} ${displayName(c, t)} ${t("no Inbox")}`}
                            disabled={abrindo}
                            onClick={() => void iniciarConversa(c)}
                          >
                            <ChatCircle size={16} weight="regular" aria-hidden />
                          </Button>
                        ) : null}
                        {/* Issue #2715 — atalho de edição na linha: o MESMO diálogo da ficha (EditContactDialog), sem formulário novo. A lista já é invalidada pelo useUpdateContact (["contacts"]).
                            Anonimizado não ganha lápis, como na ficha: o servidor recusa com lgpd_anonymization_irreversible. */}
                        {!c.is_anonymized && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="md:h-8 md:w-8"
                            title={t("Editar contato")}
                            aria-label={`${t("Editar contato")} ${displayName(c, t)}`}
                            onClick={() => setContatoEmEdicao(c)}
                          >
                            <PencilSimple size={16} weight="regular" aria-hidden />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-error-fg md:h-8 md:w-8"
                          title={t("Excluir contato")}
                          aria-label={`${t("Excluir contato")} ${displayName(c, t)}`}
                          onClick={() => setAlvo(c)}
                        >
                          <Trash size={16} weight="regular" aria-hidden />
                        </Button>
                      </div>
                    </TableCell>
                  );
                case "entrou_no_crm":
                  return (
                    <TableCell key={id} className="text-muted-foreground text-sm max-md:hidden">
                      {format(new Date(c.created_at), "dd/MM/yyyy", { locale: localeDaData })}
                    </TableCell>
                  );
                case "origem":
                  return (
                    <TableCell key={id} className="text-muted-foreground text-sm max-md:hidden">
                      {c.source ? t(rotuloDaOrigem(c.source)) : "—"}
                    </TableCell>
                  );
                case "aniversario":
                  return (
                    <TableCell key={id} className="text-muted-foreground text-sm max-md:hidden">
                      {c.birthdate ? format(new Date(`${c.birthdate}T12:00:00`), "dd/MM/yyyy", { locale: localeDaData }) : "—"}
                    </TableCell>
                  );
                case "ultima_mensagem":
                  return (
                    <TableCell key={id} className="max-w-[16rem] truncate text-muted-foreground text-sm max-md:hidden">
                      {c.conversa?.preview ?? "—"}
                    </TableCell>
                  );
                case "utm_source":
                case "utm_medium":
                case "utm_campaign":
                case "utm_content":
                case "utm_term":
                  return (
                    <TableCell key={id} className="max-w-[14rem] truncate text-muted-foreground text-sm max-md:hidden">
                      {textoDoCampo(c.utms?.[id])}
                    </TableCell>
                  );
                default:
                  return (
                    <TableCell key={id} className="max-w-[14rem] truncate text-muted-foreground text-sm max-md:hidden">
                      {textoDoCampo(c.custom_fields?.[id.slice(PREFIXO_DE_CAMPO.length)])}
                    </TableCell>
                  );
              }
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>

    <AlertDialog open={alvo !== null} onOpenChange={(open) => { if (!open) setAlvo(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Excluir contato?")}</AlertDialogTitle>
          <AlertDialogDescription>
            {alvo
              ? `${t("Isso remove")} ${displayName(alvo, t)} ${t("e a conversa associada, se houver. Esta ação não pode ser desfeita.")}`
              : null}
            {/*
              O aviso ANTES do clique (issue #1925): a recusa já nomeava o
              vínculo, mas só depois que a pessoa tentava. Mesma frase do 409
              (plural e chave vindos do servidor), e o link vai direto para a
              Agenda — é lá que o compromisso é cancelado.
            */}
            {avisoDeVinculo ? (
              <span className="mt-2 block text-sm font-medium text-warning-fg">
                {avisoDeVinculo}{" "}
                <Link href="/app/agenda" className="underline">
                  {t("Abrir Agenda")}
                </Link>
              </span>
            ) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={del.isPending}>{t("Cancelar")}</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={() => void confirmarExclusao()}
            disabled={del.isPending}
          >
            {del.isPending ? t("Excluindo…") : t("Excluir")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {/* Issue #2715 — edição pela linha. Montado só com alvo escolhido, no
        mesmo molde do AlertDialog de exclusão: fechar zera o state. */}
    {contatoEmEdicao && (
      <EditContactDialog
        contact={contatoEmEdicao}
        open
        onOpenChange={(v) => { if (!v) setContatoEmEdicao(null); }}
        vocabulario={vocabularioDeEtiquetas.data}
      />
    )}
    {/* Issue #2382 — o seletor de canal, quando há mais de um elegível. */}
    {seletorDeCanal}
    </>
  );
}
