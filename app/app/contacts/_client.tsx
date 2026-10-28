"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { useT } from "@/hooks/i18n/useT";
import { Columns, Plus, MagnifyingGlass, UploadSimple, UsersThree } from "@/lib/ui/icons";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useContactList } from "@/hooks/contacts/useContactList";
import { useContactCount } from "@/hooks/contacts/useContactCount";
import { useContactFilterOptions } from "@/hooks/contacts/useContactFilterOptions";
import { useBulkDeleteContacts } from "@/hooks/contacts/useBulkDeleteContacts";
import { useBuscaNaUrl } from "@/hooks/contacts/useBuscaNaUrl";
import { ContactsTable } from "@/components/contacts/ContactsTable";
import { PontoDaEtiqueta } from "@/components/tags/PontoDaEtiqueta";
import { NewContactDialog } from "@/components/contacts/NewContactDialog";
import { ImportContactsDialog } from "@/components/contacts/ImportContactsDialog";
import { TAG_DE_CLIENTE } from "@/lib/contacts/cliente";
import { useActiveOrg, usePermission } from "@/hooks/auth/AuthProvider";
import { FiltrosAvancadosDeContatos } from "@/components/contacts/FiltrosAvancadosDeContatos";
import { BarraDeSelecaoDeContatos } from "@/components/contacts/BarraDeSelecaoDeContatos";
import { ExcluirContatosEmLoteDialog } from "@/components/contacts/ExcluirContatosEmLoteDialog";
import { baixarCsvDeContatos } from "@/lib/contacts/baixar-csv";
import { ORIGENS_DE_CONTATO } from "@/lib/contacts/origens";
import {
  filtrosFromParams,
  filtrosParaCorpo,
  filtrosToParams,
  quantidadeDeFiltros,
  type FiltrosDaTela,
} from "@/lib/contacts/filtros-url";
import { MergeDialog } from "@/components/contacts/MergeDialog";
import { PersonalizarColunasDialog } from "@/components/contacts/PersonalizarColunasDialog";
import { useColunasDeContatos } from "@/hooks/contacts/useColunasDeContatos";
import { EmptyContacts } from "@/components/empty";
import type { ContactOrderBy } from "@/lib/schemas/contacts";

const SOURCE_OPTIONS: Array<{ value: string | undefined; label: string }> = [
  { value: undefined, label: "Todas as origens" },
  ...ORIGENS_DE_CONTATO,
];

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

export function ContactsListClient() {
  const t = useT();
  const clientesLigado = useActiveOrg()?.cliente_pela_agenda === true;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Os filtros moram na URL: recarregar, voltar e compartilhar o link mantêm a lista.
  // `toString()` e não o objeto: o hook devolve uma instância nova a cada render.
  const chaveDaUrl = searchParams.toString();
  const filtros = useMemo<FiltrosDaTela>(
    () => filtrosFromParams(new URLSearchParams(chaveDaUrl)),
    [chaveDaUrl],
  );
  const { search, tag, source } = filtros;
  const [orderBy, setOrderBy] = useState<ContactOrderBy>("last_activity_at");
  const [orderDir, setOrderDir] = useState<"asc" | "desc">("desc");
  const [limit, setLimit] = useState<number>(25);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [duplicadosOpen, setDuplicadosOpen] = useState(false);
  const [colunasOpen, setColunasOpen] = useState(false);
  // As colunas que ESTE usuário escolheu (salvas no servidor, `user_preferences`).
  const { colunas } = useColunasDeContatos();

  const podeExcluirEmLote = usePermission("contact.bulk_delete");
  const podeExportar = usePermission("contact.export");
  // Permissões por perfil: o botão segue `POST /api/v1/contacts/import`.
  const podeImportar = usePermission("contatos.importar");
  const [selecionados, setSelecionados] = useState<ReadonlySet<string>>(new Set());
  const [todosDoFiltro, setTodosDoFiltro] = useState(false);
  const [confirmarExclusao, setConfirmarExclusao] = useState(false);
  const [exportando, setExportando] = useState(false);
  const exclusaoEmLote = useBulkDeleteContacts();

  /** Troca parte dos filtros na URL (`undefined` apaga a chave). */
  const mudarFiltros = useCallback(
    (mudanca: Partial<Record<keyof FiltrosDaTela, string | undefined>>) => {
      const proximo = filtrosToParams({ ...filtros, ...mudanca } as FiltrosDaTela);
      const qs = proximo.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [filtros, pathname, router],
  );

  // A caixa é estado local; a URL a segue sem nunca reescrevê-la no meio da digitação.
  const busca = useBuscaNaUrl(search ?? "", (texto) => mudarFiltros({ search: texto || undefined }));
  const searchInput = busca.texto;

  const listFilters = useMemo(
    () => ({ ...filtros, order_by: orderBy, order_dir: orderDir, limit }),
    [filtros, orderBy, orderDir, limit],
  );
  const q = useContactList(listFilters);
  const contagem = useContactCount(filtros);
  const opcoesDeFiltro = useContactFilterOptions();
  const totalDoFiltro = contagem.data;
  const camposDoContato = useMemo(() => opcoesDeFiltro.data?.campos.contato ?? [], [opcoesDeFiltro.data]);
  const rotulosDeCampo = useMemo(
    () => new Map(camposDoContato.map((c) => [c.key, c.label] as const)),
    [camposDoContato],
  );

  // Outro filtro = outro conjunto: a seleção não atravessa.
  const chaveDosFiltros = filtrosToParams(filtros).toString();
  useEffect(() => {
    setSelecionados(new Set());
    setTodosDoFiltro(false);
  }, [chaveDosFiltros]);

  const allContacts = useMemo(
    () => q.data?.pages.flatMap((p) => p.data) ?? [],
    [q.data],
  );

  const tagOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of allContacts) for (const tag of c.tags) set.add(tag);
    // A etiqueta filtrada na URL continua na lista mesmo que a página carregada não a mostre.
    if (filtros.tag) set.add(filtros.tag);
    // `cliente` na lista mesmo que nenhum contato da página carregada a tenha —
    // COM A REGRA LIGADA. As demais opções saem do que já foi paginado — o que
    // basta para etiqueta que a equipe criou e usa em bloco, e falha justamente
    // para esta, que o sistema escreve sozinho e cujo primeiro uso é "filtrar
    // quem já é cliente" numa base grande, onde a primeira página pode não ter
    // nenhum. Desligada, a opção fixa ofereceria um filtro de uma regra que não
    // roda; quem já tem a etiqueta continua aparecendo pela linha de cima.
    if (clientesLigado) set.add(TAG_DE_CLIENTE);
    return Array.from(set).sort();
  }, [allContacts, clientesLigado, filtros.tag]);

  const handleSort = useCallback(
    (column: ContactOrderBy) => {
      if (column === orderBy) {
        setOrderDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setOrderBy(column);
        setOrderDir(column === "display_name" ? "asc" : "desc");
      }
    },
    [orderBy],
  );

  // ── Seleção em lote ───────────────────────────────────────────────────────
  const selecaoDisponivel = podeExcluirEmLote || podeExportar;
  // Contato anonimizado (LGPD) aparece na lista, com o selo, mas não entra no lote nem na exportação.
  const idsCarregados = useMemo(
    () => allContacts.filter((c) => !c.is_anonymized).map((c) => c.id),
    [allContacts],
  );
  const quantidadeSelecionada = todosDoFiltro ? (totalDoFiltro ?? 0) : selecionados.size;
  const selecaoAtiva = selecaoDisponivel && quantidadeSelecionada > 0;
  const paginaInteiraMarcada =
    idsCarregados.length > 0 && idsCarregados.every((id) => selecionados.has(id));
  // A faixa do Gmail: com a página inteira marcada e mais resultados no filtro, oferece "todos".
  const faixaDeTodosDoFiltro =
    selecaoDisponivel &&
    (todosDoFiltro || (paginaInteiraMarcada && (totalDoFiltro ?? 0) > idsCarregados.length));
  // No modo "todos do filtro" as linhas mostradas aparecem marcadas.
  const idsMarcadosNaTabela = useMemo<ReadonlySet<string>>(
    () => (todosDoFiltro ? new Set(idsCarregados) : selecionados),
    [todosDoFiltro, idsCarregados, selecionados],
  );

  const limparSelecao = useCallback(() => {
    setSelecionados(new Set());
    setTodosDoFiltro(false);
  }, []);

  const alternarContato = useCallback(
    (id: string) => {
      if (todosDoFiltro) {
        // Desmarcar uma linha sai do "todos do filtro": vira seleção explícita do que está carregado.
        setTodosDoFiltro(false);
        setSelecionados(new Set(idsCarregados.filter((x) => x !== id)));
        return;
      }
      setSelecionados((atual) => {
        const proximo = new Set(atual);
        if (proximo.has(id)) proximo.delete(id);
        else proximo.add(id);
        return proximo;
      });
    },
    [todosDoFiltro, idsCarregados],
  );

  const alternarPagina = useCallback(
    (marcar: boolean) => {
      setTodosDoFiltro(false);
      setSelecionados(marcar ? new Set(idsCarregados) : new Set());
    },
    [idsCarregados],
  );

  async function excluirSelecionados() {
    const alvo = todosDoFiltro
      ? { filtro: filtrosParaCorpo(filtros), esperado: totalDoFiltro ?? 0 }
      : { ids: [...selecionados] };
    try {
      const r = await exclusaoEmLote.mutateAsync(alvo);
      toast.success(
        r.excluidos === 1
          ? t("1 contato excluído.")
          : `${r.excluidos.toLocaleString("pt-BR")} ${t("contatos excluídos.")}`,
      );
      if (r.ignorados > 0) {
        toast.warning(
          `${r.ignorados.toLocaleString("pt-BR")} ${t("não foram excluídos: anonimizados ou já mesclados.")}`,
        );
      }
      if (r.bloqueados > 0) {
        toast.warning(
          `${r.bloqueados.toLocaleString("pt-BR")} ${t("não foram excluídos: têm compromisso na agenda.")}`,
        );
      }
      limparSelecao();
    } catch {
      // o hook já mostrou o erro; a lista é recarregada e a seleção fica para nova tentativa
    } finally {
      setConfirmarExclusao(false);
    }
  }

  async function exportar() {
    setExportando(true);
    try {
      const r = await baixarCsvDeContatos(
        todosDoFiltro
          ? { filtro: filtrosParaCorpo(filtros), esperado: totalDoFiltro ?? undefined }
          : { ids: [...selecionados] },
      );
      toast.success(
        `${r.linhas.toLocaleString("pt-BR")} ${r.linhas === 1 ? t("contato exportado") : t("contatos exportados")} (${r.arquivo}).`,
      );
    } catch (err) {
      toast.error(t(err instanceof Error ? err.message : "Não foi possível exportar os contatos."));
    } finally {
      setExportando(false);
    }
  }

  return (
    <div className="space-y-4 p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{t("Contatos")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Customer 360 — busque, filtre e gerencie contatos.")}
          </p>
        </div>
        {/*
          A estrutura é a da main (o "Importar CSV" do PR #313); o `shrink-0`
          vem do PR #267, e vale para os DOIS botões agora: numa tela de 390px
          uma linha de dois botões sem isso comprime os rótulos.
        */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {/*
            A porta do recurso de duplicados fica AQUI, na tela que já existe, e
            não num item de menu novo: quem descobre que tem contato repetido
            descobre olhando a lista, e a barra lateral não precisa crescer para
            um trabalho que se faz de vez em quando.
          */}
          <Button variant="outline" onClick={() => setColunasOpen(true)} data-acao="personalizar-colunas">
            <Columns size={16} weight="bold" aria-hidden />
            <span>{t("Personalizar colunas")}</span>
          </Button>
          <Button variant="outline" onClick={() => setDuplicadosOpen(true)}>
            <UsersThree size={16} weight="bold" aria-hidden />
            <span>{t("Duplicados")}</span>
          </Button>
          {podeImportar ? (
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <UploadSimple size={16} weight="bold" aria-hidden />
              <span>{t("Importar CSV")}</span>
            </Button>
          ) : null}
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={16} weight="bold" aria-hidden />
            <span>{t("Novo contato")}</span>
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-2">
        <div className="relative w-full sm:w-72">
          <MagnifyingGlass
            size={16}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            placeholder={t("Buscar por nome, email ou telefone…")}
            value={searchInput}
            onChange={(e) => busca.setTexto(e.target.value)}
            className="h-9 w-full pl-8"
          />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={tagOptions.length === 0}>
              {tag ? <PontoDaEtiqueta tag={tag} className="mr-2" /> : null}
              {tag ? `${t("Tag")}: ${tag}` : `${t("Tag")}: ${t("todas")}`}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t("Tag")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => mudarFiltros({ tag: undefined })}>{t("Todas")}</DropdownMenuItem>
            {tagOptions.map((tagOption) => (
              <DropdownMenuItem key={tagOption} onClick={() => mudarFiltros({ tag: tagOption })}>
                <PontoDaEtiqueta tag={tagOption} className="mr-2" />
                {tagOption}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {t(SOURCE_OPTIONS.find((s) => s.value === source)?.label ?? "Origem")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {SOURCE_OPTIONS.map((s) => (
              <DropdownMenuItem key={s.label} onClick={() => mudarFiltros({ source: s.value })}>
                {t(s.label)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <FiltrosAvancadosDeContatos
          filtros={filtros}
          opcoes={opcoesDeFiltro.data}
          onChange={mudarFiltros}
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {limit} {t("por página")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t("Itens por página")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {PAGE_SIZE_OPTIONS.map((n) => (
              <DropdownMenuItem key={n} onClick={() => setLimit(n)}>
                {n}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {(quantidadeDeFiltros(filtros) > 0 || searchInput.trim() !== "") && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              busca.limpar();
              router.replace(pathname, { scroll: false });
            }}
          >
            {t("Limpar filtros")}
          </Button>
        )}
      </div>

      {selecaoAtiva && (
        <BarraDeSelecaoDeContatos
          quantidade={quantidadeSelecionada}
          podeExcluir={podeExcluirEmLote}
          podeExportar={podeExportar}
          exportando={exportando}
          onExcluir={() => setConfirmarExclusao(true)}
          onExportar={() => void exportar()}
          onLimpar={limparSelecao}
        />
      )}

      {faixaDeTodosDoFiltro && totalDoFiltro !== undefined && (
        <div
          role="status"
          data-faixa-selecionar-todos
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
        >
          {todosDoFiltro ? (
            <>
              {t("Todos os")} <strong>{totalDoFiltro.toLocaleString("pt-BR")}</strong>{" "}
              {t("contatos do filtro estão selecionados.")}{" "}
              <button type="button" className="font-medium text-accent underline" onClick={limparSelecao}>
                {t("Limpar seleção")}
              </button>
            </>
          ) : (
            <>
              {idsCarregados.length === limit
                ? `${t("Os")} ${idsCarregados.length} ${t("desta página estão selecionados.")}`
                : `${t("Os")} ${idsCarregados.length} ${t("contatos carregados estão selecionados.")}`}{" "}
              <button
                type="button"
                className="font-medium text-accent underline"
                onClick={() => setTodosDoFiltro(true)}
              >
                {t("Selecionar todos os")} {totalDoFiltro.toLocaleString("pt-BR")} {t("contatos do filtro")}
              </button>
            </>
          )}
        </div>
      )}

      {q.isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : q.isError ? (
        <Card className="p-6 text-center">
          <p className="text-sm text-error-fg">{t("Erro ao carregar contatos.")}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => q.refetch()}
          >
            {t("Tentar novamente")}
          </Button>
        </Card>
      ) : allContacts.length === 0 ? (
        <Card className="p-2">
          <EmptyContacts />
        </Card>
      ) : (
        <>
          <Card className="overflow-hidden">
            <ContactsTable
              contacts={allContacts}
              selecao={
                selecaoDisponivel
                  ? { ids: idsMarcadosNaTabela, onToggle: alternarContato, onTogglePagina: alternarPagina }
                  : undefined
              }
              orderBy={orderBy}
              orderDir={orderDir}
              onSort={handleSort}
              colunas={colunas}
              rotulosDeCampo={rotulosDeCampo}
            />
          </Card>
          <div className="flex flex-col items-center gap-2 sm:flex-row sm:justify-between">
            <p className="text-sm text-muted-foreground">
              {totalDoFiltro !== undefined && totalDoFiltro > allContacts.length
                ? `${allContacts.length.toLocaleString("pt-BR")} ${t("de")} ${totalDoFiltro.toLocaleString("pt-BR")} ${t("contatos")}`
                : `${allContacts.length} ${allContacts.length === 1 ? t("contato") : t("contatos")}`}
              {q.hasNextPage ? ` ${t("carregados — há mais resultados")}` : ""}
            </p>
            {q.hasNextPage && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => q.fetchNextPage()}
                disabled={q.isFetchingNextPage}
              >
                {q.isFetchingNextPage ? t("Carregando…") : t("Carregar mais")}
              </Button>
            )}
          </div>
        </>
      )}

      <NewContactDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ImportContactsDialog open={importOpen} onOpenChange={setImportOpen} />
      <MergeDialog open={duplicadosOpen} onOpenChange={setDuplicadosOpen} />
      {colunasOpen && (
        <PersonalizarColunasDialog open onOpenChange={setColunasOpen} camposDoContato={camposDoContato} />
      )}
      <ExcluirContatosEmLoteDialog
        open={confirmarExclusao}
        quantidade={quantidadeSelecionada}
        pendente={exclusaoEmLote.isPending}
        onConfirm={() => void excluirSelecionados()}
        onOpenChange={setConfirmarExclusao}
      />
    </div>
  );
}
