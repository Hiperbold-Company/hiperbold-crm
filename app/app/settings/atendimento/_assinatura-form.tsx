"use client";
/**
 * Assinatura do emissor (#2066): a porta de `settings.assinatura_mensagens`.
 * Sem este cartão o recurso só ligava por SQL. A regra mora em
 * `lib/messaging/assinatura.ts`; a gravação, em `/api/v1/settings/assinatura`.
 */
import { Checkbox } from "@/components/ui/checkbox";
import { useState } from "react";
import { toast } from "sonner";

import { useBarraDeSalvar } from "@/components/configuracoes/grupo-de-salvar";
import { SecaoDaConfiguracao } from "@/components/configuracoes/secao-da-configuracao";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

export interface AssinaturaConfig {
  humanos: boolean;
  ia: boolean;
  nome_ia: string;
  /** #3310: a IA assina com o nome de cada agente (desligado = `nome_ia`). */
  por_agente: boolean;
}

export function AssinaturaForm({ initial }: { initial: AssinaturaConfig }) {
  const t = useT();
  const [form, setForm] = useState(initial);
  const [salvo, setSalvo] = useState(initial);
  const sujo = JSON.stringify(form) !== JSON.stringify(salvo);

  const { barra, enviar, salvando: isPending, refDoFormulario } = useBarraDeSalvar({
    sujo,
    descartar: () => setForm(salvo),
    salvar: async () => {
      try {
        await apiClient.patch("/api/v1/settings/assinatura", form);
        setSalvo(form);
        toast.success(t("Assinatura salva."));
        return "salvo";
      } catch (err) {
        toast.error(err instanceof Error ? t(err.message) : t("Não consegui salvar."));
        return "falhou";
      }
    },
  });

  const opcoes = [
    {
      chave: "humanos" as const,
      titulo: "Assinar as mensagens dos atendentes",
      corpo: "Cada atendente aparece pelo próprio nome, com as iniciais em maiúscula.",
    },
    {
      chave: "ia" as const,
      titulo: "Assinar as mensagens da IA",
      corpo: "A IA aparece pelo nome abaixo, nunca pelo nome de um atendente.",
    },
  ];

  return (
    <form ref={refDoFormulario} onSubmit={enviar} className="flex max-w-3xl flex-col gap-4" data-testid="form-assinatura">
      <SecaoDaConfiguracao
        id="sec-assinatura"
        titulo={t("Quem fala aparece na mensagem?")}
        descricao={t(
          "Ligado, a mensagem que vai ao cliente ganha o nome de quem fala em negrito, na linha de cima. O histórico do CRM guarda o texto como foi escrito. Campanhas, lembretes e integrações por token não assinam.",
        )}
      >
        {opcoes.map((o) => (
          <label key={o.chave} className="flex cursor-pointer items-start gap-3">
            <Checkbox
              data-testid={`assinatura-${o.chave}`}
              checked={form[o.chave]}
              disabled={isPending}
              onChange={(e) => setForm((f) => ({ ...f, [o.chave]: e.target.checked }))}
              className="mt-1 shrink-0"
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium">{t(o.titulo)}</span>
              <span className="block text-xs text-muted-foreground">{t(o.corpo)}</span>
            </span>
          </label>
        ))}
        <div className="max-w-sm space-y-1">
          <Label htmlFor="assinatura-nome-ia">{t("Nome da IA")}</Label>
          <Input
            id="assinatura-nome-ia"
            value={form.nome_ia}
            maxLength={120}
            disabled={isPending}
            onChange={(e) => setForm((f) => ({ ...f, nome_ia: e.target.value }))}
          />
          <p className="text-xs text-muted-foreground">{t("Sem asteriscos nem quebra de linha.")}</p>
        </div>
        <label className="flex cursor-pointer items-start gap-3">
          <Checkbox
            data-testid="assinatura-por_agente"
            checked={form.por_agente}
            disabled={isPending || !form.ia}
            onChange={(e) => setForm((f) => ({ ...f, por_agente: e.target.checked }))}
            className="mt-1 shrink-0"
          />
          <span className="space-y-1">
            <span className="block text-sm font-medium">{t("Assinar com o nome de cada agente")}</span>
            <span className="block text-xs text-muted-foreground">
              {t(
                "Ligado, cada mensagem da IA leva o nome do agente que a escreveu, como está no cadastro do agente. O Nome da IA acima fica para a mensagem sem agente.",
              )}
            </span>
          </span>
        </label>
      </SecaoDaConfiguracao>
      {barra}
    </form>
  );
}
