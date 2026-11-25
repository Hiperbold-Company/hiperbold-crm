"use client";

/**
 * "Nova etiqueta": cria uma etiqueta no vocabulário da organização antes de
 * qualquer contato, negócio ou conversa usá-la. Mesma paleta de tons nomeados
 * da ação Cor do painel (`PALETA_DE_ETIQUETAS`), e a cor é opcional.
 *
 * Vive fora do `_painel.tsx` porque o botão precisa existir também com a lista
 * vazia — o painel nem monta nesse caso, e é justamente a organização sem
 * etiqueta nenhuma que mais precisa dele.
 */
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChipDeEtiqueta } from "@/components/tags/ChipDeEtiqueta";
import { invalidarCoresDasEtiquetas } from "@/components/tags/CoresDasEtiquetas";
import { TAMANHO_MAXIMO_DA_TAG } from "@/lib/contacts/tag-normalizada";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import { NOME_DO_TOM, PALETA_DE_ETIQUETAS } from "@/lib/tags/cor-da-etiqueta";
import { cn } from "@/lib/utils";

import { CHAVES_COM_NOME_DE_ETIQUETA } from "./_painel";

const ERRO_EM_PORTUGUES: Record<string, string> = {
  tag_ja_existe: "Essa etiqueta já existe.",
  limite_de_etiquetas: "O vocabulário chegou ao limite de 200 etiquetas. Exclua ou junte alguma antes de criar outra.",
  validation_failed: "Confira a etiqueta, o novo nome e a cor.",
  forbidden: "Só um gerente ou administrador da organização pode mudar as etiquetas.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  mfa_required: "Confirme o segundo fator para mudar as etiquetas.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
};

export function NovaEtiqueta({ idioma }: { idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [aberto, setAberto] = useState(false);
  const [nome, setNome] = useState("");
  const [cor, setCor] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  function fechar() {
    setAberto(false);
    setNome("");
    setCor(null);
  }

  async function criar() {
    setOcupado(true);
    try {
      const resposta = await fetch("/api/v1/tags/vocabulario", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acao: "criar", tag: nome.trim(), ...(cor ? { cor } : {}) }),
      });
      if (!resposta.ok) {
        const corpo = (await resposta.json().catch(() => null)) as { error?: { code?: string } } | null;
        const codigo = corpo?.error?.code ?? "internal_error";
        toast.error(t(ERRO_EM_PORTUGUES[codigo] ?? "Não foi possível concluir agora. Tente de novo."));
        return;
      }
      invalidarCoresDasEtiquetas(queryClient);
      for (const queryKey of CHAVES_COM_NOME_DE_ETIQUETA) {
        void queryClient.invalidateQueries({ queryKey: [...queryKey] });
      }
      toast.success(t("Etiqueta criada."));
      fechar();
      router.refresh();
    } catch {
      toast.error(
        t("Não foi possível falar com o servidor. Recarregue a página e confira antes de tentar de novo."),
      );
    } finally {
      setOcupado(false);
    }
  }

  if (!aberto) {
    return (
      <div>
        <Button onClick={() => setAberto(true)}>{t("Nova etiqueta")}</Button>
      </div>
    );
  }

  return (
    <Card className="flex max-w-xl flex-col gap-4 p-4" role="group" aria-label={t("Nova etiqueta")}>
      <div className="flex flex-col gap-2">
        <Label htmlFor="nome-da-nova-etiqueta">{t("Nome da etiqueta")}</Label>
        <Input
          id="nome-da-nova-etiqueta"
          value={nome}
          onChange={(evento) => setNome(evento.target.value)}
          maxLength={TAMANHO_MAXIMO_DA_TAG}
          autoFocus
        />
      </div>
      <div className="flex flex-col gap-3">
        <Label>{t("Cor da etiqueta")}</Label>
        <div className="flex flex-wrap items-center gap-2">
          {PALETA_DE_ETIQUETAS.map((tom) => (
            <button
              key={tom}
              type="button"
              onClick={() => setCor(tom)}
              aria-pressed={cor === tom}
              aria-label={t(NOME_DO_TOM[tom] ?? tom)}
              title={tom}
              className={cn(
                "size-7 rounded-full border-2 transition-transform",
                cor === tom
                  ? "border-foreground ring-2 ring-ring ring-offset-1 ring-offset-background"
                  : "border-transparent hover:scale-110",
              )}
              style={{ backgroundColor: tom }}
            />
          ))}
          <Button
            type="button"
            size="sm"
            variant={cor === null ? "default" : "outline"}
            aria-pressed={cor === null}
            onClick={() => setCor(null)}
          >
            {t("Sem cor")}
          </Button>
        </div>
        {nome.trim() !== "" && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{t("Prévia:")}</span>
            <ChipDeEtiqueta tag={nome.trim().toLowerCase()} cor={cor} />
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <Button onClick={criar} disabled={ocupado || nome.trim().length === 0}>
          {ocupado ? t("Aplicando...") : t("Criar etiqueta")}
        </Button>
        <Button variant="ghost" onClick={fechar} disabled={ocupado}>
          {t("Cancelar")}
        </Button>
      </div>
    </Card>
  );
}
