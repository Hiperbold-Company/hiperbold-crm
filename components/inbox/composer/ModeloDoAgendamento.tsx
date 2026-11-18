"use client";
/**
 * O modelo aprovado de uma mensagem agendada (migration 1017).
 *
 * Aparece quando a janela de 24h estará FECHADA no horário escolhido. Na hora do
 * envio, se o cliente tiver escrito antes, sai o texto; se não, sai este modelo.
 * Sem modelo a mensagem não sairia, então a tela o pede antes de agendar.
 *
 * A lista é a da CONEXÃO DA CONVERSA (`?channel_session_id=`, como a aba de
 * modelos do painel): uma organização com duas contas oficiais aprovaria o
 * modelo numa e o envio sairia pela outra. Só as aprovadas, um campo por valor.
 * O servidor confere nome e idioma contra o espelho DESTA conexão e monta o
 * texto pela definição guardada; o `body` daqui é só a prévia.
 * O que sai daqui só vale quando todo valor foi preenchido — o servidor recusa
 * modelo com valor faltando, e recusar no horário do envio é tarde demais.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { PreviaDoModelo } from "@/components/channels/PreviaDoModelo";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { renderTemplatePreview } from "@/lib/channels/meta/render-template";
import { lerConteudo } from "@/lib/channels/template-conteudo";
import { fonteDeTemplates, rotaDeTemplates } from "@/lib/channels/templates-fonte";
import type { ModeloDaAgendada } from "@/lib/mensagens-agendadas/regras";
import { cn } from "@/lib/utils";

interface Slot {
  key: string;
  expects: string;
  onde: string;
  valueKey: string;
}

interface ModeloAprovado {
  name: string;
  language: string;
  status: string;
  slots?: Slot[];
  components?: unknown[];
  savedValues?: Record<string, string>;
}

const CAMPO =
  "h-11 rounded-md border border-input bg-background px-2 text-base md:text-sm lg:h-9 focus:outline-hidden focus:ring-1 focus:ring-ring";

/** O modelo completo para gravar, ou `null` enquanto faltar escolha ou valor. */
export function modeloCompleto(modelo: ModeloAprovado | null, valores: Record<string, string>): ModeloDaAgendada | null {
  if (!modelo) return null;
  const slots = modelo.slots ?? [];
  if (slots.some((s) => !(valores[s.valueKey] ?? "").trim())) return null;
  const body = lerConteudo(modelo.components ?? []).body?.trim() || modelo.name;
  return { name: modelo.name, language: modelo.language, values: valores, body };
}

export function ModeloDoAgendamento({
  provider,
  channelSessionId = null,
  onChange,
}: {
  provider: string | null;
  /** A conexão da conversa: a lista é a dos modelos aprovados NELA. */
  channelSessionId?: string | null;
  onChange: (modelo: ModeloDaAgendada | null) => void;
}) {
  const t = useT();
  const fonte = fonteDeTemplates(provider);
  const [escolhido, setEscolhido] = useState("");
  const [valores, setValores] = useState<Record<string, string>>({});

  const { data, isLoading } = useQuery({
    queryKey: ["templates-da-conversa", fonte, channelSessionId ?? "padrao"],
    enabled: fonte !== null,
    queryFn: async () => {
      const rota = rotaDeTemplates(fonte!);
      const url = channelSessionId ? `${rota}?channel_session_id=${encodeURIComponent(channelSessionId)}` : rota;
      return apiClient.get<{ data: { templates: ModeloAprovado[] } }>(url);
    },
    staleTime: 30_000,
  });
  const aprovados = (data?.data.templates ?? []).filter((tpl) => tpl.status?.toUpperCase() === "APPROVED");
  const atual = aprovados.find((tpl) => `${tpl.name}|${tpl.language}` === escolhido) ?? null;

  function mudar(proximoEscolhido: string, proximosValores: Record<string, string>) {
    setEscolhido(proximoEscolhido);
    setValores(proximosValores);
    const modelo = aprovados.find((tpl) => `${tpl.name}|${tpl.language}` === proximoEscolhido) ?? null;
    onChange(modeloCompleto(modelo, proximosValores));
  }

  if (!fonte) return null;

  const previa = atual
    ? renderTemplatePreview(atual.components ?? [], valores, { name: atual.name, language: atual.language })
    : null;

  return (
    <div data-testid="modelo-do-agendamento" className="space-y-2 rounded-md border border-warning/30 bg-warning-bg p-2">
      <p className="text-xs text-warning-fg">
        {t("A janela de 24 horas estará fechada no horário escolhido. Escolha um modelo aprovado: ele sai se o cliente não escrever antes.")}
      </p>
      {!isLoading && aprovados.length === 0 ? (
        <p className="text-xs text-warning-fg">
          {t("Nenhum modelo aprovado ainda. Crie um em")} <strong>{t("Conexões → Templates")}</strong>
        </p>
      ) : (
        <select
          value={escolhido}
          onChange={(e) => {
            const modelo = aprovados.find((tpl) => `${tpl.name}|${tpl.language}` === e.target.value);
            mudar(e.target.value, { ...(modelo?.savedValues ?? {}) });
          }}
          aria-label={t("Modelo aprovado")}
          className={cn(CAMPO, "w-full")}
        >
          <option value="">{t("Escolha um modelo aprovado…")}</option>
          {aprovados.map((tpl) => (
            <option key={`${tpl.name}|${tpl.language}`} value={`${tpl.name}|${tpl.language}`}>
              {tpl.name} ({tpl.language})
            </option>
          ))}
        </select>
      )}
      {previa && <PreviaDoModelo previa={previa} />}
      {(atual?.slots ?? []).map((slot) => (
        <label key={slot.valueKey} className="flex flex-col gap-1">
          <span className="text-2xs text-warning-fg">
            {slot.onde} — {`{{${slot.key}}}`}
          </span>
          <input
            type="text"
            value={valores[slot.valueKey] ?? ""}
            onChange={(e) => mudar(escolhido, { ...valores, [slot.valueKey]: e.target.value })}
            className={CAMPO}
          />
        </label>
      ))}
    </div>
  );
}
