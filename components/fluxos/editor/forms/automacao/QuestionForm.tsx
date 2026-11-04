"use client";

import { useState } from "react";

import { Textarea } from "@/components/ui/textarea";
import type { FieldRef } from "@/lib/automacoes/schemas";
import { VALIDACOES_DA_PERGUNTA } from "@/lib/automacoes/vocabulario";
import {
  QUESTION_VALIDATIONS,
  questionConfigSchema,
  TEMPO_MAXIMO_DA_PERGUNTA_MS,
  TEMPO_MINIMO_DE_ESPERA_DE_RESPOSTA_MS,
  type QuestionConfig,
  type QuestionValidation,
} from "@/lib/followup/graph-schema";
import { useT } from "@/hooks/i18n/useT";

import {
  AjudaDeVariaveis,
  AvisoDoDirect,
  Campo,
  Seletor,
  SeletorDeCampo,
  TempoComUnidade,
  type RespostaDisponivel,
} from "./comum";
import { variavelDaResposta } from "./respostas";

const MAX_TEXTO = 1000;

interface Rascunho {
  question: string;
  saveTo: FieldRef | null;
  validation: QuestionValidation;
  /** `null` = o número digitado não serve. */
  timeoutMs: number | null;
  retries: number;
  retryMessage: string;
  timeoutMessage: string;
}

/** A config que o rascunho representa — candidata: quem decide se serve é o schema. */
export function configDaPergunta(r: Rascunho): unknown {
  return {
    question: r.question,
    ...(r.saveTo ? { save_to: r.saveTo } : {}),
    validation: r.validation,
    timeout_ms: r.timeoutMs ?? 0,
    retries: r.retries,
    ...(r.retryMessage.trim() ? { retry_message: r.retryMessage } : {}),
    ...(r.timeoutMessage.trim() ? { timeout_message: r.timeoutMessage } : {}),
  };
}

function problemaDa(r: Rascunho): string | null {
  if (r.question.trim() === "") return "Escreva a pergunta.";
  if (!r.saveTo) return "Escolha o campo que guarda a resposta.";
  if (
    r.timeoutMs === null ||
    r.timeoutMs < TEMPO_MINIMO_DE_ESPERA_DE_RESPOSTA_MS ||
    r.timeoutMs > TEMPO_MAXIMO_DA_PERGUNTA_MS
  )
    return "O tempo limite vai de 1 minuto a 7 dias.";
  return null;
}

/**
 * O bloco "Pergunta" da automação: pergunta, confere a resposta pelo tipo e a
 * grava num campo. Saídas: "Respondeu", "Resposta inválida", "Sem resposta" e
 * "Erro". A resposta também vira `{{resposta.<chave>}}` para os blocos seguintes.
 */
export function QuestionForm({
  config,
  onChange,
  nodeId,
  respostas = [],
  noInstagram = false,
}: {
  config: QuestionConfig;
  onChange: (config: QuestionConfig) => void;
  nodeId: string;
  respostas?: RespostaDisponivel[];
  /** A automação começa por comentário do Instagram: a pergunta sai pelo Direct. */
  noInstagram?: boolean;
}) {
  const t = useT();
  const [r, setR] = useState<Rascunho>({
    question: config.question,
    saveTo: config.save_to,
    validation: config.validation,
    timeoutMs: config.timeout_ms,
    retries: config.retries,
    retryMessage: config.retry_message ?? "",
    timeoutMessage: config.timeout_message ?? "",
  });
  const [erro, setErro] = useState<string | null>(null);

  const gravar = (patch: Partial<Rascunho>) => {
    const novo = { ...r, ...patch };
    setR(novo);
    const problema = problemaDa(novo);
    if (problema) {
      setErro(t(problema));
      return;
    }
    const parsed = questionConfigSchema.safeParse(configDaPergunta(novo));
    if (!parsed.success) {
      setErro(t("Configuração inválida."));
      return;
    }
    setErro(null);
    onChange(parsed.data);
  };
  const variavel = variavelDaResposta(nodeId);

  return (
    <div className="space-y-4" data-testid="question-form">
      {noInstagram && <AvisoDoDirect />}
      <Campo id="pergunta-texto" rotulo={t("Pergunta")}>
        <Textarea
          id="pergunta-texto"
          data-testid="pergunta-texto"
          rows={3}
          maxLength={MAX_TEXTO}
          value={r.question}
          onChange={(e) => gravar({ question: e.target.value })}
        />
        <p className="text-right text-xs text-text-muted" data-testid="pergunta-contador">
          {r.question.length} / {MAX_TEXTO}
        </p>
        <AjudaDeVariaveis
          respostas={respostas}
          onInserir={(v) =>
            gravar({
              question: `${r.question}${r.question && !r.question.endsWith(" ") ? " " : ""}${v}`,
            })
          }
          testId="pergunta-variaveis"
        />
      </Campo>

      <Campo id="pergunta-salvar-em" rotulo={t("Salvar a resposta no campo")}>
        <SeletorDeCampo
          id="pergunta-salvar-em"
          valor={r.saveTo}
          paraEscrita
          onChange={(saveTo) => gravar({ saveTo })}
        />
      </Campo>

      <div
        className="rounded-sm border border-border bg-muted p-2 text-xs text-text-muted"
        data-testid="pergunta-variavel"
      >
        {r.validation === "cpf" ? (
          <p>{t("A resposta de CPF fica só no campo escolhido e não vira variável.")}</p>
        ) : (
          <p>
            {t("A resposta também fica na variável")}{" "}
            <code className="font-mono text-text" data-testid="pergunta-variavel-nome">
              {variavel}
            </code>{" "}
            {t("para usar nos blocos seguintes.")}
          </p>
        )}
      </div>

      <Campo id="pergunta-validacao" rotulo={t("Tipo de resposta esperada")}>
        <Seletor
          id="pergunta-validacao"
          valor={r.validation}
          opcoes={QUESTION_VALIDATIONS.map((v) => ({
            valor: v,
            rotulo: t(VALIDACOES_DA_PERGUNTA[v]),
          }))}
          onChange={(v) => gravar({ validation: v as QuestionValidation })}
        />
      </Campo>

      <Campo
        id="pergunta-tempo-limite"
        rotulo={t("Esperar a resposta por")}
        ajuda={t(
          'Se o tempo acabar sem resposta, o contato segue por "Sem resposta". A resposta é processada em até 1 minuto.',
        )}
      >
        <TempoComUnidade
          id="pergunta-tempo-limite"
          ms={r.timeoutMs ?? 86_400_000}
          unidades={["minutos", "horas", "dias"]}
          onChange={(ms) => gravar({ timeoutMs: ms })}
        />
      </Campo>

      <Campo
        id="pergunta-tentativas"
        rotulo={t("Novas tentativas se a resposta não servir")}
        ajuda={t('Esgotadas as tentativas, o contato segue por "Resposta inválida".')}
      >
        <Seletor
          id="pergunta-tentativas"
          valor={String(r.retries)}
          opcoes={[0, 1, 2, 3, 4, 5].map((n) => ({ valor: String(n), rotulo: String(n) }))}
          onChange={(v) => gravar({ retries: Number(v) })}
        />
      </Campo>

      {r.retries > 0 && (
        <Campo
          id="pergunta-nova-tentativa"
          rotulo={t("Mensagem da nova tentativa")}
          ajuda={t("Em branco, a pergunta é enviada de novo.")}
        >
          <Textarea
            id="pergunta-nova-tentativa"
            data-testid="pergunta-nova-tentativa"
            rows={2}
            maxLength={MAX_TEXTO}
            value={r.retryMessage}
            onChange={(e) => gravar({ retryMessage: e.target.value })}
          />
        </Campo>
      )}

      <Campo id="pergunta-tempo-esgotado" rotulo={t("Mensagem quando o tempo acabar (opcional)")}>
        <Textarea
          id="pergunta-tempo-esgotado"
          data-testid="pergunta-tempo-esgotado"
          rows={2}
          maxLength={MAX_TEXTO}
          value={r.timeoutMessage}
          onChange={(e) => gravar({ timeoutMessage: e.target.value })}
        />
      </Campo>

      {erro && (
        <p className="text-xs text-error-fg" data-testid="pergunta-erro">
          {erro}
        </p>
      )}
    </div>
  );
}
