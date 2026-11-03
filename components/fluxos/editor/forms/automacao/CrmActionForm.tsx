"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  CHAVE_DE_PARAMETRO,
  crmActionConfigSchema,
  MAX_PARAMETROS,
  MAX_VALOR_DE_PARAMETRO,
  type CrmAction,
  type CrmActionConfig,
  type CrmActionType,
} from "@/lib/automacoes/schemas";
import {
  ACOES_DE_CRM,
  ALVOS,
  fraseDaAcao,
  SE_DER_ERRO,
  SE_JA_TEM_NEGOCIO,
} from "@/lib/automacoes/vocabulario";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useT } from "@/hooks/i18n/useT";
import { Plus, Trash } from "@/lib/ui/icons";

import {
  AJUDA_DAS_VARIAVEIS,
  AjudaDeVariaveis,
  Campo,
  listaDeTags,
  opcoesDeEtapa,
  Seletor,
  useAutomacoesDaOrganizacao,
  useFunis,
  useNomesDaAutomacao,
  type Opcao,
  type RespostaDisponivel,
} from "./comum";

/** Ação recém-escolhida: o mínimo que a tela precisa para mostrar os campos. */
export function acaoEmBranco(type: CrmActionType): CrmAction {
  switch (type) {
    case "create_deal":
      return { type, pipeline_id: "", stage_id: "", if_open_exists: "skip" };
    case "move_deal":
      return { type, pipeline_id: "", stage_id: "" };
    case "win_deal":
      return { type };
    case "lose_deal":
      return { type, reason: "" };
    case "add_tags":
    case "remove_tags":
      return { type, target: "lead", tags: [] };
    case "set_owner":
      return { type, mode: { m: "round_robin" } };
    case "notify":
      return { type, to: "owner", message: "" };
    case "create_task":
      return { type, title: "", due_in_minutes: 60, assignee: "owner" };
    case "add_note":
      return { type, body: "", target: "lead" };
    case "start_automation":
      return { type, pointer_id: "", params: [] };
  }
}

const opcoesDe = <K extends string>(mapa: Record<K, string>, t: (s: string) => string): Opcao[] =>
  (Object.keys(mapa) as K[]).map((k) => ({ valor: k, rotulo: t(mapa[k]) }));

/**
 * O bloco "Ação no CRM": uma lista de ações executadas em ordem. Grava no nó
 * só quando todas as ações estão completas (o schema decide); enquanto falta
 * algo, o aviso diz qual.
 */
export function CrmActionForm({
  config,
  onChange,
  flowId,
  respostas = [],
}: {
  config: CrmActionConfig;
  onChange: (config: CrmActionConfig) => void;
  /** A automação aberta: "Iniciar outra automação" não a oferece. */
  flowId?: string;
  /** Respostas dos blocos anteriores, para os valores dos dados passados. */
  respostas?: RespostaDisponivel[];
}) {
  const t = useT();
  const [rascunho, setRascunho] = useState<CrmActionConfig>(config);
  const [erro, setErro] = useState<string | null>(null);
  const nomes = useNomesDaAutomacao();

  const gravar = (novo: CrmActionConfig) => {
    setRascunho(novo);
    const r = crmActionConfigSchema.safeParse(novo);
    if (!r.success) {
      const i = r.error.issues[0]?.path[1];
      setErro(
        typeof i === "number"
          ? `${t("Complete a ação")} ${i + 1}.`
          : t("Adicione ao menos uma ação."),
      );
      return;
    }
    setErro(null);
    onChange(r.data);
  };
  const trocar = (i: number, a: CrmAction) =>
    gravar({ ...rascunho, actions: rascunho.actions.map((x, j) => (j === i ? a : x)) });

  return (
    <div className="space-y-4" data-testid="crm-action-form">
      {rascunho.actions.map((acao, i) => (
        <div
          key={i}
          className="space-y-3 rounded-sm border border-border p-2"
          data-testid={`acao-${i}`}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-muted">
              {t("Ação")} {i + 1}
            </span>
            {rascunho.actions.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("Remover ação")}
                onClick={() =>
                  gravar({ ...rascunho, actions: rascunho.actions.filter((_, j) => j !== i) })
                }
              >
                <Trash size={14} aria-hidden />
              </Button>
            )}
          </div>
          <Campo id={`acao-${i}-tipo`} rotulo={t("O que fazer")}>
            <Seletor
              id={`acao-${i}-tipo`}
              valor={acao.type}
              opcoes={opcoesDe(ACOES_DE_CRM, t)}
              onChange={(v) => trocar(i, acaoEmBranco(v as CrmActionType))}
            />
          </Campo>
          <CamposDaAcao
            prefixo={`acao-${i}`}
            acao={acao}
            onChange={(a) => trocar(i, a)}
            respostas={respostas}
            {...(flowId !== undefined ? { flowId } : {})}
          />
          <p className="text-xs text-text-muted">{fraseDaAcao(acao, nomes)}</p>
        </div>
      ))}
      {rascunho.actions.length < 10 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="adicionar-acao"
          onClick={() =>
            gravar({ ...rascunho, actions: [...rascunho.actions, acaoEmBranco("add_tags")] })
          }
        >
          <Plus size={14} aria-hidden className="mr-1" /> {t("Ação")}
        </Button>
      )}
      <Campo id="acao-se-der-erro" rotulo={t("Se uma ação falhar")}>
        <Seletor
          id="acao-se-der-erro"
          valor={rascunho.on_error}
          opcoes={opcoesDe(SE_DER_ERRO, t)}
          onChange={(v) => gravar({ ...rascunho, on_error: v as CrmActionConfig["on_error"] })}
        />
      </Campo>
      {erro && <p className="text-xs text-error-fg">{erro}</p>}
    </div>
  );
}

function CamposDaAcao({
  prefixo,
  acao,
  onChange,
  flowId,
  respostas,
}: {
  prefixo: string;
  acao: CrmAction;
  onChange: (a: CrmAction) => void;
  flowId?: string;
  respostas: RespostaDisponivel[];
}) {
  const t = useT();
  const { funis, etapas } = useFunis();
  const membros = useAssignableMembers(
    acao.type === "set_owner" || acao.type === "notify" || acao.type === "create_task",
  );
  const opcoesDeMembro = (membros.data ?? []).map((m) => ({
    valor: m.user_id,
    rotulo: m.full_name ?? m.user_id,
  }));
  const [tags, setTags] = useState("tags" in acao ? acao.tags.join(", ") : "");

  switch (acao.type) {
    case "create_deal":
    case "move_deal":
      return (
        <>
          <Campo id={`${prefixo}-funil`} rotulo={t("Funil")}>
            <Seletor
              id={`${prefixo}-funil`}
              valor={acao.pipeline_id}
              vazio={t("Escolha o funil")}
              opcoes={funis.map((f) => ({ valor: f.id, rotulo: f.nome }))}
              onChange={(v) =>
                onChange({
                  ...acao,
                  pipeline_id: v,
                  stage_id: funis.find((f) => f.id === v)?.etapas[0]?.stageId ?? "",
                })
              }
            />
          </Campo>
          <Campo id={`${prefixo}-etapa`} rotulo={t("Etapa")}>
            <Seletor
              id={`${prefixo}-etapa`}
              valor={acao.stage_id}
              vazio={t("Escolha a etapa")}
              opcoes={acao.pipeline_id ? opcoesDeEtapa(etapas, acao.pipeline_id) : []}
              onChange={(v) => onChange({ ...acao, stage_id: v })}
            />
          </Campo>
          {acao.type === "create_deal" && (
            <>
              <Campo
                id={`${prefixo}-se-ja-tem`}
                rotulo={t("Se o contato já tem negócio aberto neste funil")}
              >
                <Seletor
                  id={`${prefixo}-se-ja-tem`}
                  valor={acao.if_open_exists}
                  opcoes={opcoesDe(SE_JA_TEM_NEGOCIO, t)}
                  onChange={(v) =>
                    onChange({ ...acao, if_open_exists: v as typeof acao.if_open_exists })
                  }
                />
              </Campo>
              <Campo
                id={`${prefixo}-titulo`}
                rotulo={t("Título (opcional)")}
                ajuda={t(AJUDA_DAS_VARIAVEIS)}
              >
                <Input
                  id={`${prefixo}-titulo`}
                  maxLength={200}
                  value={acao.title ?? ""}
                  placeholder="{{contact.name}}"
                  onChange={(e) => {
                    const { title: _antes, ...resto } = acao;
                    onChange(e.target.value ? { ...resto, title: e.target.value } : resto);
                  }}
                />
              </Campo>
            </>
          )}
        </>
      );
    case "win_deal":
    case "lose_deal":
      return (
        <Campo
          id={`${prefixo}-motivo`}
          rotulo={acao.type === "lose_deal" ? t("Motivo da perda") : t("Observação (opcional)")}
        >
          <Input
            id={`${prefixo}-motivo`}
            maxLength={500}
            value={acao.reason ?? ""}
            onChange={(e) =>
              acao.type === "lose_deal"
                ? onChange({ ...acao, reason: e.target.value })
                : onChange(
                    e.target.value
                      ? { type: "win_deal", reason: e.target.value }
                      : { type: "win_deal" },
                  )
            }
          />
        </Campo>
      );
    case "add_tags":
    case "remove_tags":
      return (
        <>
          <Campo id={`${prefixo}-alvo`} rotulo={t("Em quem")}>
            <Seletor
              id={`${prefixo}-alvo`}
              valor={acao.target}
              opcoes={opcoesDe(ALVOS, t)}
              onChange={(v) => onChange({ ...acao, target: v as "lead" | "contact" })}
            />
          </Campo>
          <Campo id={`${prefixo}-tags`} rotulo={t("Tags (separe por vírgula)")}>
            <Input
              id={`${prefixo}-tags`}
              value={tags}
              onChange={(e) => {
                setTags(e.target.value);
                onChange({ ...acao, tags: listaDeTags(e.target.value).slice(0, 10) });
              }}
            />
          </Campo>
        </>
      );
    case "set_owner":
      return (
        <>
          <Campo id={`${prefixo}-modo`} rotulo={t("Quem")}>
            <Seletor
              id={`${prefixo}-modo`}
              valor={acao.mode.m === "user" ? acao.mode.user_id : "__rodizio"}
              opcoes={[
                { valor: "__rodizio", rotulo: t("Rodízio entre os atendentes") },
                ...opcoesDeMembro,
              ]}
              onChange={(v) =>
                onChange({
                  ...acao,
                  mode: v === "__rodizio" ? { m: "round_robin" } : { m: "user", user_id: v },
                })
              }
            />
          </Campo>
        </>
      );
    case "notify":
      return (
        <>
          <Campo id={`${prefixo}-para`} rotulo={t("Para quem")}>
            <Seletor
              id={`${prefixo}-para`}
              valor={acao.to === "owner" ? "owner" : (acao.to[0] ?? "owner")}
              opcoes={[{ valor: "owner", rotulo: t("Responsável do negócio") }, ...opcoesDeMembro]}
              onChange={(v) => onChange({ ...acao, to: v === "owner" ? "owner" : [v] })}
            />
          </Campo>
          <Campo id={`${prefixo}-mensagem`} rotulo={t("Mensagem")} ajuda={t(AJUDA_DAS_VARIAVEIS)}>
            <Textarea
              id={`${prefixo}-mensagem`}
              maxLength={500}
              value={acao.message}
              onChange={(e) => onChange({ ...acao, message: e.target.value })}
            />
          </Campo>
        </>
      );
    case "create_task":
      return (
        <>
          <Campo
            id={`${prefixo}-tarefa`}
            rotulo={t("Título da tarefa")}
            ajuda={t(AJUDA_DAS_VARIAVEIS)}
          >
            <Input
              id={`${prefixo}-tarefa`}
              maxLength={200}
              value={acao.title}
              onChange={(e) => onChange({ ...acao, title: e.target.value })}
            />
          </Campo>
          <Campo id={`${prefixo}-prazo`} rotulo={t("Prazo, em minutos a partir de agora")}>
            <Input
              id={`${prefixo}-prazo`}
              type="number"
              min={0}
              max={525600}
              defaultValue={acao.due_in_minutes}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 0 && n <= 525_600)
                  onChange({ ...acao, due_in_minutes: n });
              }}
            />
          </Campo>
          <Campo id={`${prefixo}-responsavel`} rotulo={t("Responsável da tarefa")}>
            <Seletor
              id={`${prefixo}-responsavel`}
              valor={acao.assignee}
              opcoes={[{ valor: "owner", rotulo: t("Responsável do negócio") }, ...opcoesDeMembro]}
              onChange={(v) => onChange({ ...acao, assignee: v })}
            />
          </Campo>
        </>
      );
    case "add_note":
      return (
        <>
          <Campo id={`${prefixo}-nota`} rotulo={t("Nota")} ajuda={t(AJUDA_DAS_VARIAVEIS)}>
            <Textarea
              id={`${prefixo}-nota`}
              maxLength={2000}
              value={acao.body}
              onChange={(e) => onChange({ ...acao, body: e.target.value })}
            />
          </Campo>
        </>
      );
    case "start_automation":
      return (
        <CamposDeIniciarAutomacao
          prefixo={prefixo}
          acao={acao}
          onChange={onChange}
          respostas={respostas}
          {...(flowId !== undefined ? { flowId } : {})}
        />
      );
  }
}

/** Por que a chave de um dado não serve (`null` = serve). */
export function problemaDaChave(chave: string, outras: string[]): string | null {
  if (!CHAVE_DE_PARAMETRO.test(chave))
    return "Use letras minúsculas, números e underscore, até 40 caracteres.";
  if (outras.includes(chave)) return "Esta chave já está na lista.";
  return null;
}

/**
 * "Iniciar outra automação": qual automação (as ATIVAS da organização, menos
 * esta) e os dados que ela recebe como `{{param.<chave>}}`.
 */
function CamposDeIniciarAutomacao({
  prefixo,
  acao,
  onChange,
  flowId,
  respostas,
}: {
  prefixo: string;
  acao: Extract<CrmAction, { type: "start_automation" }>;
  onChange: (a: CrmAction) => void;
  flowId?: string;
  respostas: RespostaDisponivel[];
}) {
  const t = useT();
  const automacoes = useAutomacoesDaOrganizacao();
  const nomes = useNomesDaAutomacao();
  const [foco, setFoco] = useState<number | null>(null);
  const opcoes: Opcao[] = (automacoes.data ?? [])
    .filter((a) => a.status === "active" && a.id !== flowId)
    .map((a) => ({ valor: a.id, rotulo: a.name }));
  // A escolhida que saiu da lista (desativada): continua visível, o publish avisa.
  if (acao.pointer_id && acao.pointer_id !== flowId && !opcoes.some((o) => o.valor === acao.pointer_id))
    opcoes.push({
      valor: acao.pointer_id,
      rotulo: nomes.automacao?.(acao.pointer_id) ?? t("Automação escolhida"),
    });
  const params = acao.params;
  const trocarParam = (j: number, p: { key: string; value: string }) =>
    onChange({ ...acao, params: params.map((x, k) => (k === j ? p : x)) });
  return (
    <>
      <Campo id={`${prefixo}-automacao`} rotulo={t("Qual automação")}>
        <Seletor
          id={`${prefixo}-automacao`}
          valor={acao.pointer_id === flowId ? "" : acao.pointer_id}
          vazio={t("Escolha a automação")}
          opcoes={opcoes}
          onChange={(v) => onChange({ ...acao, pointer_id: v })}
        />
      </Campo>
      {!automacoes.isLoading && opcoes.length === 0 && (
        <p className="text-xs text-text-muted">
          {t("Nenhuma outra automação ativa. Publique a automação de destino primeiro.")}
        </p>
      )}
      <div className="space-y-2" data-testid={`${prefixo}-dados`}>
        <p className="text-sm font-medium text-text">{t("Dados para passar (opcional)")}</p>
        <p className="text-xs text-text-muted">
          {t("Na automação escolhida, cada dado se usa como {{param.chave}}.")}
        </p>
        {params.map((p, j) => {
          const problema = problemaDaChave(
            p.key,
            params.filter((_, k) => k !== j).map((x) => x.key),
          );
          return (
            <div key={j} className="space-y-1" data-testid={`${prefixo}-dado-${j}`}>
              <div className="flex gap-2">
                <Input
                  id={`${prefixo}-dado-${j}-chave`}
                  data-testid={`${prefixo}-dado-${j}-chave`}
                  aria-label={t("Chave")}
                  className="w-36 font-mono"
                  maxLength={40}
                  placeholder="chave"
                  value={p.key}
                  onChange={(e) => trocarParam(j, { ...p, key: e.target.value })}
                />
                <Input
                  id={`${prefixo}-dado-${j}-valor`}
                  data-testid={`${prefixo}-dado-${j}-valor`}
                  aria-label={t("Valor")}
                  maxLength={MAX_VALOR_DE_PARAMETRO}
                  placeholder="{{contact.name}}"
                  value={p.value}
                  onFocus={() => setFoco(j)}
                  onChange={(e) => trocarParam(j, { ...p, value: e.target.value })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("Remover dado")}
                  data-testid={`${prefixo}-dado-${j}-remover`}
                  onClick={() => onChange({ ...acao, params: params.filter((_, k) => k !== j) })}
                >
                  <Trash size={14} aria-hidden />
                </Button>
              </div>
              {p.key !== "" && problema && (
                <p className="text-xs text-error-fg" data-testid={`${prefixo}-dado-${j}-erro`}>
                  {t(problema)}
                </p>
              )}
            </div>
          );
        })}
        {params.length < MAX_PARAMETROS && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid={`${prefixo}-adicionar-dado`}
            onClick={() => onChange({ ...acao, params: [...params, { key: "", value: "" }] })}
          >
            <Plus size={14} aria-hidden className="mr-1" /> {t("Dado")}
          </Button>
        )}
        {params.length > 0 && (
          <AjudaDeVariaveis
            respostas={respostas}
            testId={`${prefixo}-ajuda-variaveis`}
            onInserir={(variavel) => {
              const j = foco !== null && foco < params.length ? foco : params.length - 1;
              const p = params[j];
              if (p) trocarParam(j, { ...p, value: `${p.value}${variavel}` });
            }}
          />
        )}
      </div>
    </>
  );
}
