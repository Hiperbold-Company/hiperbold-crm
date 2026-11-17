"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  disconnectAdInsights,
  updateAdInsightsConnection,
} from "@/app/actions/settings/updateAdInsightsConnection";
import { useBarraDeSalvar } from "@/components/configuracoes/grupo-de-salvar";
import { SecaoDaConfiguracao } from "@/components/configuracoes/secao-da-configuracao";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

/**
 * Cada recusa vira uma frase que diz O QUE FAZER — mesma regra do formulário de
 * Conversões. `cifra_indisponivel` é a que mais importa acertar: é problema de
 * INSTALAÇÃO, e um texto genérico mandaria o admin do tenant refazer um cadastro
 * que já está certo, para falhar igual.
 */
const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed: "Confira os campos: algum valor não está no formato esperado.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um administrador da organização pode mudar esta conexão.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
  cifra_indisponivel:
    "Esta instalação está sem a chave mestra de criptografia, e o token não foi gravado. Quem instalou o sistema precisa configurá-la — refazer o cadastro aqui não resolve.",
  erro_ao_gravar: "Não consegui gravar agora. Tente de novo em instantes.",
};

export function FormularioDeMetaAds({
  conectada,
  contaPadrao,
  idioma,
}: {
  conectada: boolean;
  contaPadrao: string | null;
  idioma: Idioma;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  // Desconectar é ação imediata, fora da barra: tem a própria transição.
  const [desconectando, startTransition] = useTransition();

  const [token, setToken] = useState("");
  const [conta, setConta] = useState(contaPadrao ?? "");
  // O último salvo da conta padrão. O token nunca volta do servidor, então
  // "mudou" para ele é só ter algo digitado.
  const [contaSalva, setContaSalva] = useState(contaPadrao ?? "");

  // Na primeira conexão o token é obrigatório — a coluna é NOT NULL (0214) e a
  // Server Action recusa. Barrar aqui explica antes de o clique acontecer, em
  // vez de devolver um erro de validação depois.
  const podeSalvar = conectada || token.trim().length >= 20;
  const sujo = token !== "" || conta !== contaSalva;

  const { barra, enviar, salvando } = useBarraDeSalvar({
    sujo,
    podeSalvar,
    aviso: t("Cole o token para poder salvar."),
    descartar: () => {
      setToken("");
      setConta(contaSalva);
    },
    salvar: async () => {
      if (!podeSalvar) {
        toast.error(t("Cole o token para poder salvar."));
        return "invalido";
      }
      const resultado = await updateAdInsightsConnection({
        platform: "meta_ads",
        access_token: token.trim() || undefined,
        default_account_id: conta.trim() || null,
      });

      if (resultado.ok) {
        // O campo é limpo no sucesso: deixá-lo preenchido dá a impressão de que
        // a tela guarda o token, e ela nunca o mostra de volta.
        setToken("");
        setContaSalva(conta);
        toast.success(t("Conexão salva."));
        router.refresh();
        return "salvo";
      }
      toast.error(t(ERRO_EM_PORTUGUES[resultado.error] ?? "Não consegui salvar agora."));
      return "falhou";
    },
  });

  const ocupado = salvando || desconectando;

  function desconectar() {
    startTransition(async () => {
      const resultado = await disconnectAdInsights();
      if (resultado.ok) {
        setToken("");
        setConta("");
        setContaSalva("");
        toast.success(t("Conta desconectada."));
        router.refresh();
        return;
      }
      toast.error(t(ERRO_EM_PORTUGUES[resultado.error] ?? "Não consegui desconectar agora."));
    });
  }

  return (
    <form onSubmit={enviar} className="flex flex-col gap-6">
      <SecaoDaConfiguracao
        titulo={t("Token de acesso")}
        descricao={
          conectada
            ? t(
                "Já existe um token guardado. Deixe em branco para mantê-lo, ou cole um novo para substituir.",
              )
            : t("Precisa da permissão ads_read.")
        }
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="access_token" className="sr-only">
            {t("Token de acesso")}
          </Label>
          <Input
            id="access_token"
            type="password"
            autoComplete="off"
            value={token}
            disabled={ocupado}
            onChange={(e) => setToken(e.target.value)}
            placeholder={conectada ? t("Guardado — preencha só para trocar") : "EAA…"}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="default_account_id">{t("Conta padrão (opcional)")}</Label>
          <Input
            id="default_account_id"
            value={conta}
            disabled={ocupado}
            onChange={(e) => setConta(e.target.value)}
            placeholder="act_123456789012345"
          />
          <p className="text-xs text-muted-foreground">
            {t(
              "A conta que a tela de Meta Ads abre por padrão. Em branco, ela abre a primeira conta ativa que o token alcançar.",
            )}
          </p>
        </div>
      </SecaoDaConfiguracao>

      {conectada && (
        <SecaoDaConfiguracao
          titulo={t("Desconectar")}
          descricao={
            /*
              Desconectar APAGA a linha — não existe "pausar" nesta feature, e o
              porquê está no cabeçalho da 0214: como nada roda sozinho, um estado
              "conectado mas desligado" teria a mesma consequência visível de não
              estar conectado.
            */
            t(
              "Desconectar apaga o token guardado. A tela de Meta Ads volta a pedir uma conexão, e nenhum dado histórico é perdido — nada é armazenado aqui.",
            )
          }
        >
          <div>
            <Button type="button" variant="outline" disabled={ocupado} onClick={desconectar}>
              {t("Desconectar")}
            </Button>
          </div>
        </SecaoDaConfiguracao>
      )}

      {barra}
    </form>
  );
}
