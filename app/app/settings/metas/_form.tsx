"use client";

/**
 * O cadastro da meta mensal (issue #3025, fatia 1).
 *
 * Um mês e um número. O formulário não escolhe o indicador nem o funil: nesta
 * fatia o indicador é um só (vendas ganhas) e o escopo é a empresa — oferecer um
 * seletor com uma opção seria prometer o que a fatia seguinte traz.
 *
 * Cada recusa vira uma frase que diz O QUE FAZER, como as vizinhas de
 * Configurações: "forbidden_role" mandaria um atendente tentar de novo para
 * falhar igual, então ela diz quem pode.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirMetaMensal } from "@/app/actions/settings/definirMetaMensal";
import { useBarraDeSalvar } from "@/components/configuracoes/grupo-de-salvar";
import { SecaoDaConfiguracao } from "@/components/configuracoes/secao-da-configuracao";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";

const ERRO_EM_PORTUGUES: Record<string, string> = {
  validation_failed: "Confira os campos: o mês e a quantidade precisam estar preenchidos.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só quem administra a empresa pode definir a meta.",
  erro_ao_gravar: "Não consegui gravar a meta agora. Tente de novo em instantes.",
};

export function FormularioDaMeta({
  mes,
  alvoAtual,
}: {
  mes: string;
  alvoAtual: number | null;
}) {
  const t = useT();
  const router = useRouter();

  const inicial = { periodo: mes, alvo: alvoAtual === null ? "" : String(alvoAtual) };
  const [salvo, setSalvo] = useState(inicial);
  const [periodo, setPeriodo] = useState(inicial.periodo);
  const [alvo, setAlvo] = useState(inicial.alvo);

  const numero = Number.parseInt(alvo, 10);
  const podeSalvar = /^\d{4}-\d{2}$/.test(periodo) && Number.isInteger(numero) && numero > 0;
  const sujo = periodo !== salvo.periodo || alvo !== salvo.alvo;

  const { barra, enviar, salvando } = useBarraDeSalvar({
    sujo,
    podeSalvar,
    aviso: t("Informe um mês e uma quantidade de vendas maior que zero."),
    descartar: () => {
      setPeriodo(salvo.periodo);
      setAlvo(salvo.alvo);
    },
    salvar: async () => {
      if (!podeSalvar) {
        toast.error(t("Informe um mês e uma quantidade de vendas maior que zero."));
        return "invalido";
      }
      const resultado = await definirMetaMensal({ periodo, alvo: numero });
      if (resultado.ok) {
        setSalvo({ periodo, alvo });
        toast.success(t("Meta salva."));
        router.refresh();
        return "salvo";
      }
      toast.error(t(ERRO_EM_PORTUGUES[resultado.error] ?? "Não consegui salvar a meta agora."));
      return "falhou";
    },
  });

  return (
    <form onSubmit={enviar} className="flex max-w-xl flex-col gap-6">
      <SecaoDaConfiguracao titulo={t("Meta do mês")}>
        <div className="flex flex-col gap-2">
          <Label htmlFor="periodo">{t("Mês")}</Label>
          <Input
            id="periodo"
            type="month"
            value={periodo}
            disabled={salvando}
            onChange={(e) => setPeriodo(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("A meta vale para o mês escolhido, do dia 1º ao último.")}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="alvo">{t("Vendas ganhas no mês")}</Label>
          <Input
            id="alvo"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={alvo}
            disabled={salvando}
            onChange={(e) => setAlvo(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {alvoAtual === null
              ? t("Ainda não há meta para este mês.")
              : t("Salvar de novo corrige a meta deste mês — nada é duplicado.")}
          </p>
        </div>
      </SecaoDaConfiguracao>
      {barra}
    </form>
  );
}
