"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { atualizarPerfilDaEmpresa } from "@/app/actions/settings/atualizarPerfilDaEmpresa";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { perfilDaEmpresaSchema, TAMANHO_MAXIMO_DO_QUE_FAZ } from "@/lib/schemas/perfil-da-empresa";

interface Props {
  /** `onboarding_state.welcome.o_que_faz` hoje, ou vazio. */
  initial: string;
}

/** Configurações › Empresa › "O que a empresa faz": o passo "Perfil da empresa" do Início termina aqui. */
export function PerfilDaEmpresaForm({ initial }: Props) {
  const t = useT();
  const [oQueFaz, setOQueFaz] = useState(initial);
  const [isPending, startTransition] = useTransition();

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    const parsed = perfilDaEmpresaSchema.safeParse({ o_que_faz: oQueFaz });
    if (!parsed.success) {
      toast.error(t("Descreva em poucas palavras o que sua empresa faz."));
      return;
    }
    startTransition(async () => {
      const r = await atualizarPerfilDaEmpresa(parsed.data);
      if (r.ok) toast.success(t("Perfil da empresa salvo."));
      else toast.error(t("Não foi possível salvar o perfil da empresa."));
    });
  }

  return (
    <form id="perfil-da-empresa" onSubmit={salvar} className="max-w-2xl scroll-mt-6">
      <Card className="space-y-3 p-6">
        <h2 className="text-sm font-medium">{t("Perfil da empresa")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("Conte, do seu jeito, o que sua empresa faz. O agente de IA usa isso para falar do seu negócio. O fuso horário fica logo acima.")}
        </p>
        <div className="space-y-2">
          <Label htmlFor="o_que_faz">{t("O que sua empresa faz")}</Label>
          <Textarea
            id="o_que_faz"
            value={oQueFaz}
            maxLength={TAMANHO_MAXIMO_DO_QUE_FAZ}
            rows={3}
            placeholder={t("Ex.: clínica odontológica, ou venda de roupa fitness pelo WhatsApp")}
            onChange={(e) => setOQueFaz(e.target.value)}
          />
        </div>
        <Button type="submit" size="sm" disabled={isPending}>
          {t("Salvar perfil")}
        </Button>
      </Card>
    </form>
  );
}
