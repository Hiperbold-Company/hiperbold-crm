"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { FieldRef } from "@/lib/automacoes/schemas";
import { TIPOS_DE_OPCAO } from "@/lib/automacoes/vocabulario";
import {
  MAX_BOTOES,
  MAX_CORPO_COM_OPCOES,
  MAX_DESCRICAO_DA_LISTA,
  MAX_ITENS_DA_LISTA,
  MAX_ROTULO_DA_LISTA,
  MAX_ROTULO_DO_BOTAO,
} from "@/lib/channels/opcoes-numeradas";
import {
  messageConfigSchema,
  TEMPO_MAXIMO_DE_ESPERA_DE_RESPOSTA_MS,
  TEMPO_MINIMO_DE_ESPERA_DE_RESPOSTA_MS,
  type MessageConfig,
} from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";
import { ArrowDown, ArrowUp, Plus, Trash } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import {
  AjudaDeVariaveis,
  Campo,
  Seletor,
  SeletorDeCampo,
  TempoComUnidade,
  type RespostaDisponivel,
} from "./comum";

/** Teto do texto sem opções (o mesmo do schema). */
const MAX_CORPO = 4000;
const UM_DIA_MS = 86_400_000;

type TipoDeOpcao = "none" | "buttons" | "list";

const TIPOS: Record<TipoDeOpcao, string> = {
  none: "Sem opções",
  buttons: TIPOS_DE_OPCAO.buttons,
  list: TIPOS_DE_OPCAO.list,
};

interface OpcaoEditavel {
  id: string;
  label: string;
  description: string;
}

interface Rascunho {
  body: string;
  tipo: TipoDeOpcao;
  itens: OpcaoEditavel[];
  botaoDaLista: string;
  /** `null` = o número digitado não serve. */
  esperaMs: number | null;
  textoDaInvalida: string;
  tentativas: number;
  saveTo: FieldRef | null;
}

/**
 * Id novo de opção. É o id do RAMO (a aresta aponta para ele) e o que vai à
 * plataforma oficial no botão: nasce uma vez, quando a opção é criada, e nunca
 * é recalculado do rótulo — renomear "Moradia" não pode desligar a aresta.
 */
export function novoIdDeOpcao(existentes: readonly string[]): string {
  for (;;) {
    const id = `opcao_${Math.random().toString(36).slice(2, 8)}`;
    if (!existentes.includes(id)) return id;
  }
}

function rascunhoDe(config: MessageConfig, t: (s: string) => string): Rascunho {
  const o = config.options;
  return {
    body: config.body,
    tipo: o?.kind ?? "none",
    itens: (o?.items ?? []).map((i) => ({
      id: i.id,
      label: i.label,
      description: "description" in i && typeof i.description === "string" ? i.description : "",
    })),
    botaoDaLista: o?.kind === "list" ? o.button_label : t("Ver opções"),
    esperaMs: config.reply_timeout_ms ?? UM_DIA_MS,
    textoDaInvalida: config.invalid_reply?.message ?? "",
    tentativas: config.invalid_reply?.attempts ?? 1,
    saveTo: config.save_to ?? null,
  };
}

/** A config que o rascunho representa — candidata: quem decide se serve é o schema. */
export function configDoRascunho(r: Rascunho): unknown {
  if (r.tipo === "none") return { body: r.body };
  const options: NonNullable<MessageConfig["options"]> =
    r.tipo === "buttons"
      ? { kind: "buttons", items: r.itens.map(({ id, label }) => ({ id, label })) }
      : {
          kind: "list",
          button_label: r.botaoDaLista,
          items: r.itens.map(({ id, label, description }) => ({
            id,
            label,
            ...(description.trim() ? { description } : {}),
          })),
        };
  return {
    body: r.body,
    options,
    reply_timeout_ms: r.esperaMs ?? 0,
    invalid_reply: {
      attempts: r.tentativas,
      ...(r.textoDaInvalida.trim() ? { message: r.textoDaInvalida } : {}),
    },
    ...(r.saveTo ? { save_to: r.saveTo } : {}),
  };
}

const normalizar = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/** O primeiro problema do rascunho, em português de quem usa a tela; `null` = pronto. */
function problemaDo(r: Rascunho): string | null {
  const limite = r.tipo === "none" ? MAX_CORPO : MAX_CORPO_COM_OPCOES;
  if (r.body.trim() === "") return "Escreva a mensagem.";
  if (r.body.length > limite) return "A mensagem passou do limite de caracteres.";
  if (r.tipo === "none") return null;
  if (r.itens.length === 0) return "Adicione ao menos uma opção.";
  const maximo = r.tipo === "buttons" ? MAX_BOTOES : MAX_ITENS_DA_LISTA;
  if (r.itens.length > maximo)
    return r.tipo === "buttons"
      ? "Botões aceitam até 3 opções. Tire uma ou use Lista."
      : "A lista aceita até 10 opções.";
  const tetoDoRotulo = r.tipo === "buttons" ? MAX_ROTULO_DO_BOTAO : MAX_ROTULO_DA_LISTA;
  if (r.itens.some((i) => i.label.trim() === "")) return "Dê um nome a cada opção.";
  if (r.itens.some((i) => i.label.trim().length > tetoDoRotulo))
    return r.tipo === "buttons"
      ? "O nome de um botão tem no máximo 20 caracteres."
      : "O nome de uma opção da lista tem no máximo 24 caracteres.";
  if (new Set(r.itens.map((i) => normalizar(i.label))).size !== r.itens.length)
    return "Duas opções têm o mesmo nome.";
  if (r.tipo === "list" && r.botaoDaLista.trim() === "")
    return "Escreva o texto do botão da lista.";
  if (
    r.esperaMs === null ||
    r.esperaMs < TEMPO_MINIMO_DE_ESPERA_DE_RESPOSTA_MS ||
    r.esperaMs > TEMPO_MAXIMO_DE_ESPERA_DE_RESPOSTA_MS
  )
    return "O tempo de espera vai de 1 minuto a 30 dias.";
  return null;
}

/**
 * O bloco "Mensagem" da automação: um texto com variáveis e, se quiser,
 * botões (até 3) ou uma lista (até 10). Com opções, cada uma vira um caminho
 * no fluxo, mais "Sem resposta", "Resposta inválida" e "Erro".
 */
export function MessageForm({
  config,
  onChange,
  respostas = [],
}: {
  config: MessageConfig;
  onChange: (config: MessageConfig) => void;
  /** Respostas dos blocos anteriores, oferecidas como variável. */
  respostas?: RespostaDisponivel[];
}) {
  const t = useT();
  const [r, setR] = useState<Rascunho>(() => rascunhoDe(config, t));
  const [erro, setErro] = useState<string | null>(null);

  const gravar = (patch: Partial<Rascunho>) => {
    const novo = { ...r, ...patch };
    setR(novo);
    const problema = problemaDo(novo);
    if (problema) {
      setErro(t(problema));
      return;
    }
    const parsed = messageConfigSchema.safeParse(configDoRascunho(novo));
    if (!parsed.success) {
      setErro(t("Configuração inválida."));
      return;
    }
    setErro(null);
    onChange(parsed.data);
  };
  const trocarItem = (i: number, patch: Partial<OpcaoEditavel>) =>
    gravar({ itens: r.itens.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const mover = (i: number, delta: -1 | 1) => {
    const itens = [...r.itens];
    const [item] = itens.splice(i, 1);
    itens.splice(i + delta, 0, item!);
    gravar({ itens });
  };
  const novaOpcao = (itens: OpcaoEditavel[]): OpcaoEditavel => ({
    id: novoIdDeOpcao(itens.map((x) => x.id)),
    label: "",
    description: "",
  });

  const comOpcoes = r.tipo !== "none";
  const limiteDoCorpo = comOpcoes ? MAX_CORPO_COM_OPCOES : MAX_CORPO;
  const maximo = r.tipo === "buttons" ? MAX_BOTOES : MAX_ITENS_DA_LISTA;
  const tetoDoRotulo = r.tipo === "buttons" ? MAX_ROTULO_DO_BOTAO : MAX_ROTULO_DA_LISTA;

  return (
    <div className="space-y-4" data-testid="message-form">
      <Campo id="mensagem-texto" rotulo={t("Mensagem")}>
        <Textarea
          id="mensagem-texto"
          data-testid="mensagem-texto"
          rows={4}
          maxLength={MAX_CORPO}
          value={r.body}
          onChange={(e) => gravar({ body: e.target.value })}
        />
        <p
          className={cn(
            "text-right text-xs",
            r.body.length > limiteDoCorpo ? "text-error-fg" : "text-text-muted",
          )}
          data-testid="mensagem-contador"
        >
          {r.body.length} / {limiteDoCorpo}
        </p>
        <AjudaDeVariaveis
          respostas={respostas}
          onInserir={(v) =>
            gravar({ body: `${r.body}${r.body && !r.body.endsWith(" ") ? " " : ""}${v}` })
          }
          testId="mensagem-variaveis"
        />
      </Campo>

      <div className="space-y-1.5">
        <p className="text-sm font-medium text-text">{t("Opções de resposta")}</p>
        <div className="flex flex-wrap gap-1" role="group" aria-label={t("Opções de resposta")}>
          {(Object.keys(TIPOS) as TipoDeOpcao[]).map((tipo) => (
            <Button
              key={tipo}
              type="button"
              size="sm"
              variant={r.tipo === tipo ? "default" : "outline"}
              aria-pressed={r.tipo === tipo}
              data-testid={`mensagem-tipo-${tipo}`}
              onClick={() =>
                gravar({
                  tipo,
                  // Ao ligar as opções pela primeira vez, duas linhas em branco para preencher.
                  itens:
                    tipo !== "none" && r.itens.length === 0
                      ? (() => {
                          const a = novaOpcao([]);
                          return [a, novaOpcao([a])];
                        })()
                      : r.itens,
                })
              }
            >
              {t(TIPOS[tipo])}
            </Button>
          ))}
        </div>
      </div>

      {comOpcoes && (
        <>
          <div
            className="space-y-1 rounded-sm border border-border bg-muted p-2 text-xs text-text-muted"
            data-testid="mensagem-aviso-canal"
          >
            <p>
              {t(
                "No WhatsApp oficial o contato vê botões; nos outros números, as opções chegam numeradas (1, 2, 3) e ele responde com o número.",
              )}
            </p>
            <p>{t("A resposta é processada em até 1 minuto.")}</p>
          </div>

          <ol className="space-y-2" data-testid="mensagem-opcoes">
            {r.itens.map((item, i) => (
              <li
                key={item.id}
                className="space-y-2 rounded-sm border border-border p-2"
                data-testid={`opcao-${i}`}
                data-opcao-id={item.id}
              >
                <div className="flex items-center gap-1">
                  <span className="w-5 shrink-0 text-xs text-text-muted">{i + 1}.</span>
                  <Input
                    id={`opcao-${i}-rotulo`}
                    data-testid={`opcao-${i}-rotulo`}
                    aria-label={`${t("Nome da opção")} ${i + 1}`}
                    maxLength={tetoDoRotulo}
                    value={item.label}
                    onChange={(e) => trocarItem(i, { label: e.target.value })}
                  />
                  <span className="w-10 shrink-0 text-right text-[11px] text-text-muted">
                    {item.label.length}/{tetoDoRotulo}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("Subir opção")}
                    data-testid={`opcao-${i}-subir`}
                    disabled={i === 0}
                    onClick={() => mover(i, -1)}
                  >
                    <ArrowUp size={14} aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("Descer opção")}
                    data-testid={`opcao-${i}-descer`}
                    disabled={i === r.itens.length - 1}
                    onClick={() => mover(i, 1)}
                  >
                    <ArrowDown size={14} aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("Remover opção")}
                    data-testid={`opcao-${i}-remover`}
                    disabled={r.itens.length === 1}
                    onClick={() => gravar({ itens: r.itens.filter((_, j) => j !== i) })}
                  >
                    <Trash size={14} aria-hidden />
                  </Button>
                </div>
                {r.tipo === "list" && (
                  <Input
                    id={`opcao-${i}-descricao`}
                    data-testid={`opcao-${i}-descricao`}
                    aria-label={`${t("Descrição da opção (opcional)")} ${i + 1}`}
                    placeholder={t("Descrição (opcional)")}
                    maxLength={MAX_DESCRICAO_DA_LISTA}
                    value={item.description}
                    onChange={(e) => trocarItem(i, { description: e.target.value })}
                  />
                )}
              </li>
            ))}
          </ol>
          {r.itens.length < maximo && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="adicionar-opcao"
              onClick={() => gravar({ itens: [...r.itens, novaOpcao(r.itens)] })}
            >
              <Plus size={14} aria-hidden className="mr-1" /> {t("Opção")}
            </Button>
          )}

          {r.tipo === "list" && (
            <Campo
              id="mensagem-botao-da-lista"
              rotulo={t("Texto do botão que abre a lista")}
              ajuda={`${r.botaoDaLista.length}/${MAX_ROTULO_DO_BOTAO}`}
            >
              <Input
                id="mensagem-botao-da-lista"
                data-testid="mensagem-botao-da-lista"
                maxLength={MAX_ROTULO_DO_BOTAO}
                value={r.botaoDaLista}
                onChange={(e) => gravar({ botaoDaLista: e.target.value })}
              />
            </Campo>
          )}

          <Campo
            id="mensagem-espera"
            rotulo={t("Esperar a escolha por")}
            ajuda={t('Se o tempo acabar sem resposta, o contato segue por "Sem resposta".')}
          >
            <TempoComUnidade
              id="mensagem-espera"
              ms={r.esperaMs ?? UM_DIA_MS}
              unidades={["minutos", "horas", "dias"]}
              onChange={(ms) => gravar({ esperaMs: ms })}
            />
          </Campo>

          <Campo
            id="mensagem-invalida-texto"
            rotulo={t("Se a resposta não for uma das opções, enviar")}
            ajuda={t("Em branco, a mensagem é enviada de novo.")}
          >
            <Textarea
              id="mensagem-invalida-texto"
              data-testid="mensagem-invalida-texto"
              rows={2}
              maxLength={1000}
              value={r.textoDaInvalida}
              onChange={(e) => gravar({ textoDaInvalida: e.target.value })}
            />
          </Campo>
          <Campo
            id="mensagem-invalida-tentativas"
            rotulo={t("Novas tentativas")}
            ajuda={t('Esgotadas as tentativas, o contato segue por "Resposta inválida".')}
          >
            <Seletor
              id="mensagem-invalida-tentativas"
              valor={String(r.tentativas)}
              opcoes={[0, 1, 2, 3].map((n) => ({ valor: String(n), rotulo: String(n) }))}
              onChange={(v) => gravar({ tentativas: Number(v) })}
            />
          </Campo>

          <Campo
            id="mensagem-salvar-em"
            rotulo={t("Salvar a escolha no campo")}
            ajuda={t("Grava o nome da opção escolhida.")}
          >
            <SeletorDeCampo
              id="mensagem-salvar-em"
              valor={r.saveTo}
              paraEscrita
              vazio={t("Não salvar")}
              onChange={(saveTo) => gravar({ saveTo })}
              onLimpar={() => gravar({ saveTo: null })}
            />
          </Campo>
        </>
      )}

      {erro && (
        <p className="text-xs text-error-fg" data-testid="mensagem-erro">
          {erro}
        </p>
      )}
    </div>
  );
}
