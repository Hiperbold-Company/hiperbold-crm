"use client";

/**
 * A tela dos campos da organização (migration 1015): dois acordeões (Contatos, Negócios), a lista de
 * cada um e o diálogo de quatro abas (Campo, Tipo de dado, Avançado, Estatísticas).
 *
 * Grava só pela rota `/api/v1/custom-fields` — a regra (cota, chave única, tipo imutável, coerência
 * de opções) mora em `lib/campos/administracao.ts`, e esta tela só a antecipa onde ajuda a pessoa.
 */
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import {
  COTA_DE_CAMPOS_POR_ENTIDADE,
  PRESETS_DE_VALIDACAO,
  TIPOS_COM_OPCOES,
  TIPOS_DE_CAMPO_DA_ORGANIZACAO,
  presetDoPadrao,
  type DefinicaoDeCampo,
  type EntidadeDoCampo,
  type EstatisticasDoCampo,
  type PresetDeValidacao,
  type TipoDoCampo,
} from "@/lib/campos/definicoes";
import { importarOpcoesCsv } from "@/lib/leads/campos-pesquisaveis";
import { ROTULOS_DO_TIPO } from "@/lib/schemas/rotulos-do-campo";
import { CaretDown, Plus, Trash } from "@/lib/ui/icons";

type Opcao = { value: string; label: string; aliases?: string[] };

/** O estado do formulário do diálogo. `key`, `type` e `entidade` só se escolhem ao criar. */
export interface RascunhoDoCampo {
  id: string | null;
  entidade: EntidadeDoCampo;
  key: string;
  label: string;
  type: TipoDoCampo;
  descricao: string;
  grupo: "dados" | "rastreamento";
  publico: boolean;
  sempre_visivel: boolean;
  exibir_no_perfil: boolean;
  dica_de_ajuda: string;
  options: Opcao[];
  allow_new: boolean;
  multiple: boolean;
  preset: PresetDeValidacao;
  padrao: string;
  mensagem_padrao: string;
}

/** A chave sugerida a partir do nome: minúsculas, sem acento, `_` no lugar do resto. */
export function chaveDoNome(nome: string): string {
  const base = nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return /^[a-z]/.test(base) ? base : `campo_${base}`.slice(0, 40);
}

export function rascunhoVazio(entidade: EntidadeDoCampo): RascunhoDoCampo {
  return {
    id: null,
    entidade,
    key: "",
    label: "",
    type: "text",
    descricao: "",
    grupo: "dados",
    publico: true,
    sempre_visivel: false,
    exibir_no_perfil: false,
    dica_de_ajuda: "",
    options: [],
    allow_new: false,
    multiple: false,
    preset: "nenhum",
    padrao: "",
    mensagem_padrao: "",
  };
}

export function rascunhoDe(d: DefinicaoDeCampo): RascunhoDoCampo {
  const config = (d.config ?? {}) as Record<string, unknown>;
  const padrao = typeof config.padrao === "string" ? config.padrao : "";
  return {
    id: d.id,
    entidade: d.entidade,
    key: d.key,
    label: d.label,
    type: d.type,
    descricao: d.descricao ?? "",
    grupo: d.grupo ?? "dados",
    publico: d.publico,
    sempre_visivel: d.sempre_visivel,
    exibir_no_perfil: d.exibir_no_perfil,
    dica_de_ajuda: d.dica_de_ajuda ?? "",
    options: Array.isArray(config.options) ? (config.options as Opcao[]) : [],
    allow_new: config.allow_new === true,
    multiple: config.multiple === true,
    preset: presetDoPadrao(padrao),
    padrao,
    mensagem_padrao: typeof config.mensagem_padrao === "string" ? config.mensagem_padrao : "",
  };
}

/**
 * O corpo da rota. Na criação vão `entidade`, `key` e `type`; na edição, NUNCA (o schema `strict`
 * da alteração os recusaria). `config` só leva o que o tipo tem.
 */
export function corpoDoRascunho(r: RascunhoDoCampo): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (TIPOS_COM_OPCOES.has(r.type)) {
    config.options = r.options
      .map((o) => ({ ...o, value: o.value.trim() || o.label.trim(), label: o.label.trim() }))
      .filter((o) => o.label !== "");
  }
  if (r.type === "searchable_select") {
    config.allow_new = r.allow_new;
    config.multiple = r.multiple;
  }
  const padrao = r.preset === "custom" ? r.padrao.trim() : (PRESETS_DE_VALIDACAO[r.preset as keyof typeof PRESETS_DE_VALIDACAO] ?? "");
  // Na edição, `null` TIRA a chave do config (merge por chave na rota); na criação, ausência basta.
  if (padrao) config.padrao = padrao;
  else if (r.id) config.padrao = null;
  if (padrao && r.mensagem_padrao.trim()) config.mensagem_padrao = r.mensagem_padrao.trim();
  else if (r.id) config.mensagem_padrao = null;

  const comum = {
    label: r.label.trim(),
    descricao: r.descricao.trim() || null,
    grupo: r.grupo,
    publico: r.publico,
    sempre_visivel: r.sempre_visivel,
    exibir_no_perfil: r.exibir_no_perfil,
    dica_de_ajuda: r.dica_de_ajuda.trim() || null,
    config,
  };
  return r.id ? comum : { entidade: r.entidade, key: r.key.trim(), type: r.type, ...comum };
}

async function chamar(url: string, init?: RequestInit): Promise<{ ok: boolean; data?: unknown; erro?: string }> {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const corpo = (await res.json().catch(() => null)) as { data?: unknown; error?: { message?: string } } | null;
  if (!res.ok) return { ok: false, erro: corpo?.error?.message ?? String(res.status) };
  return { ok: true, data: corpo?.data };
}

export function CamposPersonalizadosClient({ iniciais }: { iniciais: DefinicaoDeCampo[] }) {
  const t = useT();
  const [campos, setCampos] = useState<DefinicaoDeCampo[]>(iniciais);
  const [abertos, setAbertos] = useState<Record<EntidadeDoCampo, boolean>>({ contato: true, negocio: true });
  const [rascunho, setRascunho] = useState<RascunhoDoCampo | null>(null);
  const [excluindo, setExcluindo] = useState<{ campo: DefinicaoDeCampo; registros: number | null } | null>(null);

  async function confirmarExclusao(campo: DefinicaoDeCampo) {
    setExcluindo({ campo, registros: null });
    const r = await chamar(`/api/v1/custom-fields/${campo.id}/stats`);
    setExcluindo({ campo, registros: r.ok ? ((r.data as EstatisticasDoCampo).preenchidos ?? 0) : null });
  }

  async function excluir() {
    if (!excluindo) return;
    const r = await chamar(`/api/v1/custom-fields/${excluindo.campo.id}`, { method: "DELETE" });
    if (!r.ok) {
      toast.error(r.erro ?? t("Não foi possível excluir o campo."));
      return;
    }
    setCampos((atuais) => atuais.filter((c) => c.id !== excluindo.campo.id));
    setExcluindo(null);
    toast.success(t("Campo excluído. Os valores já gravados continuam nos registros."));
  }

  function aoSalvar(salvo: DefinicaoDeCampo) {
    setCampos((atuais) =>
      atuais.some((c) => c.id === salvo.id) ? atuais.map((c) => (c.id === salvo.id ? salvo : c)) : [...atuais, salvo],
    );
    setRascunho(null);
  }

  const secoes: Array<{ entidade: EntidadeDoCampo; titulo: string; descricao: string }> = [
    { entidade: "contato", titulo: t("Contatos"), descricao: t("Aparecem na ficha do contato.") },
    { entidade: "negocio", titulo: t("Negócios"), descricao: t("Aparecem no card e no dossiê do negócio, em todos os funis.") },
  ];

  return (
    <div className="space-y-4">
      {secoes.map((s) => {
        const lista = campos.filter((c) => c.entidade === s.entidade);
        const aberto = abertos[s.entidade];
        return (
          <section key={s.entidade} className="rounded-md border border-border" data-testid={`acordeao-${s.entidade}`}>
            <div className="flex items-center justify-between gap-2 p-3">
              <button
                type="button"
                className="flex flex-1 items-center gap-2 text-left"
                aria-expanded={aberto}
                onClick={() => setAbertos((a) => ({ ...a, [s.entidade]: !a[s.entidade] }))}
              >
                <CaretDown className={aberto ? "size-4" : "size-4 -rotate-90"} aria-hidden />
                <span className="font-medium">{s.titulo}</span>
                <span className="text-xs text-muted-foreground">
                  {lista.length} / {COTA_DE_CAMPOS_POR_ENTIDADE}
                </span>
              </button>
              <Button
                type="button"
                size="sm"
                disabled={lista.length >= COTA_DE_CAMPOS_POR_ENTIDADE}
                onClick={() => setRascunho(rascunhoVazio(s.entidade))}
                data-testid={`novo-campo-${s.entidade}`}
              >
                <Plus className="mr-1 size-4" aria-hidden />
                {t("Novo campo")}
              </Button>
            </div>
            {aberto && (
              <div className="border-t border-border p-3">
                <p className="mb-2 text-xs text-muted-foreground">{s.descricao}</p>
                {lista.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("Nenhum campo cadastrado.")}</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {lista.map((c) => (
                      <li key={c.id} className="flex flex-wrap items-center gap-2 py-2" data-testid={`campo-${c.key}`}>
                        <span className="font-medium">{c.label}</span>
                        <span className="text-xs text-muted-foreground">{t(ROTULOS_DO_TIPO[c.type])}</span>
                        <code className="text-xs text-muted-foreground">{c.key}</code>
                        {c.publico ? <Badge variant="secondary">{t("Público")}</Badge> : <Badge variant="outline">{t("Só administradores")}</Badge>}
                        {c.sempre_visivel && <Badge variant="secondary">{t("Sempre visível")}</Badge>}
                        <span className="ml-auto flex gap-1">
                          <Button type="button" variant="ghost" size="sm" onClick={() => setRascunho(rascunhoDe(c))}>
                            {t("Editar")}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={`${t("Excluir")} ${c.label}`}
                            onClick={() => void confirmarExclusao(c)}
                          >
                            <Trash className="size-4" aria-hidden />
                          </Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        );
      })}

      {rascunho && (
        <DialogoDoCampo
          inicial={rascunho}
          definicao={campos.find((c) => c.id === rascunho.id) ?? null}
          aoFechar={() => setRascunho(null)}
          aoSalvar={aoSalvar}
        />
      )}

      <Dialog open={excluindo !== null} onOpenChange={(o) => !o && setExcluindo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Excluir campo")}</DialogTitle>
            <DialogDescription>
              {excluindo?.registros === null
                ? t("Contando os registros com valor…")
                : `${excluindo?.registros ?? 0} ${t("registros têm valor neste campo. Excluir tira o campo das telas; os valores continuam guardados nos registros.")}`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setExcluindo(null)}>
              {t("Cancelar")}
            </Button>
            <Button type="button" variant="destructive" onClick={() => void excluir()} data-testid="confirmar-exclusao">
              {t("Excluir")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Interruptor({ id, rotulo, marcado, aoMudar }: { id: string; rotulo: string; marcado: boolean; aoMudar: (v: boolean) => void }) {
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={marcado} onCheckedChange={aoMudar} />
      <Label htmlFor={id}>{rotulo}</Label>
    </div>
  );
}

export function DialogoDoCampo({
  inicial,
  definicao,
  aoFechar,
  aoSalvar,
}: {
  inicial: RascunhoDoCampo;
  definicao: DefinicaoDeCampo | null;
  aoFechar: () => void;
  aoSalvar: (d: DefinicaoDeCampo) => void;
}) {
  const t = useT();
  const [r, setR] = useState<RascunhoDoCampo>(inicial);
  const [chaveTocada, setChaveTocada] = useState(inicial.id !== null);
  const [csv, setCsv] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [estatisticas, setEstatisticas] = useState<EstatisticasDoCampo | null>(null);
  const editando = r.id !== null;
  const mudar = (parcial: Partial<RascunhoDoCampo>) => setR((atual) => ({ ...atual, ...parcial }));

  async function carregarEstatisticas() {
    if (!r.id || estatisticas) return;
    const res = await chamar(`/api/v1/custom-fields/${r.id}/stats`);
    if (res.ok) setEstatisticas(res.data as EstatisticasDoCampo);
  }

  async function salvar() {
    if (r.label.trim() === "") {
      toast.error(t("Dê um nome ao campo."));
      return;
    }
    if (!editando && !/^[a-z][a-z0-9_]*$/i.test(r.key.trim())) {
      toast.error(t("A chave usa letras, números e _ e começa por letra."));
      return;
    }
    setSalvando(true);
    const res = await chamar(editando ? `/api/v1/custom-fields/${r.id}` : "/api/v1/custom-fields", {
      method: editando ? "PATCH" : "POST",
      body: JSON.stringify(corpoDoRascunho(r)),
    });
    setSalvando(false);
    if (!res.ok) {
      toast.error(res.erro ?? t("Não foi possível salvar o campo."));
      return;
    }
    toast.success(editando ? t("Campo atualizado.") : t("Campo criado."));
    aoSalvar(res.data as DefinicaoDeCampo);
  }

  const temOpcoes = TIPOS_COM_OPCOES.has(r.type);
  const data = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "—");

  return (
    <Dialog open onOpenChange={(o) => !o && aoFechar()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editando ? t("Editar campo") : t("Novo campo")}</DialogTitle>
          <DialogDescription>{r.entidade === "contato" ? t("Campo de contato") : t("Campo de negócio")}</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="campo" onValueChange={(aba) => aba === "estatisticas" && void carregarEstatisticas()}>
          <TabsList>
            <TabsTrigger value="campo">{t("Campo")}</TabsTrigger>
            <TabsTrigger value="tipo">{t("Tipo de dado")}</TabsTrigger>
            <TabsTrigger value="avancado">{t("Avançado")}</TabsTrigger>
            {editando && <TabsTrigger value="estatisticas">{t("Estatísticas")}</TabsTrigger>}
          </TabsList>

          <TabsContent value="campo" className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="cp-nome">{t("Nome")} *</Label>
              <Input
                id="cp-nome"
                value={r.label}
                maxLength={80}
                onChange={(e) => mudar({ label: e.target.value, ...(chaveTocada ? {} : { key: chaveDoNome(e.target.value) }) })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cp-chave">{t("Chave")}</Label>
              <Input
                id="cp-chave"
                value={r.key}
                maxLength={40}
                disabled={editando}
                onChange={(e) => {
                  setChaveTocada(true);
                  mudar({ key: e.target.value });
                }}
              />
              {editando && <p className="text-xs text-muted-foreground">{t("A chave não muda depois de criada.")}</p>}
            </div>
            <div className="space-y-1">
              <Label htmlFor="cp-descricao">{t("Descrição")}</Label>
              <Textarea id="cp-descricao" value={r.descricao} maxLength={500} onChange={(e) => mudar({ descricao: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cp-grupo">{t("Grupo")}</Label>
              <select
                id="cp-grupo"
                className="h-9 w-full rounded-md border border-border bg-transparent px-2 text-sm"
                value={r.grupo}
                onChange={(e) => mudar({ grupo: e.target.value as RascunhoDoCampo["grupo"] })}
              >
                <option value="dados">{t("Dados do lead")}</option>
                <option value="rastreamento">{t("Rastreamento")}</option>
              </select>
            </div>
            <Interruptor id="cp-publico" rotulo={t("Público (atendentes e gerentes veem)")} marcado={r.publico} aoMudar={(v) => mudar({ publico: v })} />
            <Interruptor id="cp-sempre" rotulo={t("Sempre visível, mesmo vazio")} marcado={r.sempre_visivel} aoMudar={(v) => mudar({ sempre_visivel: v })} />
            <Interruptor id="cp-perfil" rotulo={t("Exibir no perfil")} marcado={r.exibir_no_perfil} aoMudar={(v) => mudar({ exibir_no_perfil: v })} />
            <div className="rounded-md border border-dashed border-border p-3" data-testid="previa-do-campo">
              <p className="text-xs text-muted-foreground">{t("Pré-visualização")}</p>
              <Label>{r.label || t("Nome do campo")}</Label>
              {r.dica_de_ajuda && <p className="text-xs text-muted-foreground">{r.dica_de_ajuda}</p>}
              <Input disabled placeholder={t(ROTULOS_DO_TIPO[r.type])} />
            </div>
          </TabsContent>

          <TabsContent value="tipo" className="space-y-3">
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3" role="radiogroup" aria-label={t("Tipo de dado")}>
              {TIPOS_DE_CAMPO_DA_ORGANIZACAO.map((tipo) => (
                <button
                  key={tipo}
                  type="button"
                  role="radio"
                  aria-checked={r.type === tipo}
                  disabled={editando && r.type !== tipo}
                  onClick={() => mudar({ type: tipo })}
                  className={`rounded-md border p-2 text-left text-sm ${r.type === tipo ? "border-primary bg-primary/10" : "border-border"} disabled:opacity-40`}
                  data-testid={`tipo-${tipo}`}
                >
                  {t(ROTULOS_DO_TIPO[tipo])}
                </button>
              ))}
            </div>
            {editando && <p className="text-xs text-muted-foreground">{t("O tipo não muda depois de criado. Para outro tipo, crie outro campo.")}</p>}
            {temOpcoes && (
              <div className="space-y-2" data-testid="opcoes-do-campo">
                <Label>{t("Opções")}</Label>
                {r.options.map((o, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      aria-label={`${t("Rótulo da opção")} ${i + 1}`}
                      value={o.label}
                      onChange={(e) => mudar({ options: r.options.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
                    />
                    <Input
                      aria-label={`${t("Valor da opção")} ${i + 1}`}
                      value={o.value}
                      placeholder={t("igual ao rótulo")}
                      onChange={(e) => mudar({ options: r.options.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                    />
                    <Button type="button" variant="ghost" size="sm" aria-label={`${t("Remover opção")} ${i + 1}`} onClick={() => mudar({ options: r.options.filter((_, j) => j !== i) })}>
                      <Trash className="size-4" aria-hidden />
                    </Button>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" onClick={() => mudar({ options: [...r.options, { value: "", label: "" }] })}>
                  {t("Acrescentar opção")}
                </Button>
                {r.type === "searchable_select" && (
                  <>
                    <Textarea
                      aria-label={t("Importar opções (CSV)")}
                      placeholder={t("value,label,apelidos — uma opção por linha")}
                      value={csv}
                      onChange={(e) => setCsv(e.target.value)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const res = importarOpcoesCsv(r.options, csv);
                        mudar({ options: res.opcoes as Opcao[] });
                        setCsv("");
                      }}
                    >
                      {t("Importar")}
                    </Button>
                    <Interruptor id="cp-novo" rotulo={t("Permitir valor novo")} marcado={r.allow_new} aoMudar={(v) => mudar({ allow_new: v })} />
                    <Interruptor id="cp-multiplo" rotulo={t("Múltipla escolha")} marcado={r.multiple} aoMudar={(v) => mudar({ multiple: v })} />
                  </>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="avancado" className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="cp-dica">{t("Dica de ajuda")}</Label>
              <Input id="cp-dica" value={r.dica_de_ajuda} maxLength={300} onChange={(e) => mudar({ dica_de_ajuda: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cp-preset">{t("Regex de validação")}</Label>
              <select
                id="cp-preset"
                className="h-9 w-full rounded-md border border-border bg-transparent px-2 text-sm"
                value={r.preset}
                onChange={(e) => mudar({ preset: e.target.value as PresetDeValidacao })}
              >
                <option value="nenhum">{t("Sem validação")}</option>
                <option value="email">{t("E-mail")}</option>
                <option value="url">{t("URL")}</option>
                <option value="telefone">{t("Telefone")}</option>
                <option value="custom">{t("Personalizada")}</option>
              </select>
              {r.preset === "custom" && (
                <Input aria-label={t("Expressão regular")} value={r.padrao} onChange={(e) => mudar({ padrao: e.target.value })} />
              )}
            </div>
            {r.preset !== "nenhum" && (
              <div className="space-y-1">
                <Label htmlFor="cp-mensagem">{t("Mensagem de erro")}</Label>
                <Input id="cp-mensagem" value={r.mensagem_padrao} maxLength={200} onChange={(e) => mudar({ mensagem_padrao: e.target.value })} />
              </div>
            )}
          </TabsContent>

          {editando && (
            <TabsContent value="estatisticas" className="space-y-2" data-testid="estatisticas">
              {!estatisticas ? (
                <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
              ) : (
                <>
                  <p className="text-sm">
                    {t("Registros preenchidos")}: <strong>{estatisticas.preenchidos}</strong> / {estatisticas.total}
                  </p>
                  <div className="h-2 w-full rounded bg-muted" aria-label={t("Taxa de preenchimento")}>
                    <div className="h-2 rounded bg-primary" style={{ width: `${estatisticas.taxa}%` }} />
                  </div>
                  <p className="text-sm">{t("Taxa de preenchimento")}: {estatisticas.taxa}%</p>
                  <p className="text-sm">{t("Registros vazios")}: {estatisticas.vazios}</p>
                  <p className="text-sm">{t("Criado em")}: {data(estatisticas.criado_em ?? definicao?.created_at)}</p>
                  <p className="text-sm">{t("Última edição")}: {data(estatisticas.editado_em ?? definicao?.updated_at)}</p>
                  <p className="text-sm">{t("Último uso")}: {data(estatisticas.ultimo_uso)}</p>
                </>
              )}
            </TabsContent>
          )}
        </Tabs>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={aoFechar}>
            {t("Cancelar")}
          </Button>
          <Button type="button" disabled={salvando} onClick={() => void salvar()} data-testid="salvar-campo">
            {t("Salvar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
