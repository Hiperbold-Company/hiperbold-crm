"use client";

/**
 * O CONTROLE DA #3644: quem já comprou volta pelo funil de clientes — e, dentro
 * da janela de pós-venda, a conversa não abre negócio nenhum.
 *
 * ⚠️ O TEXTO DIZ O QUE ACONTECE E O QUE NÃO ACONTECE, e não é enfeite: quem liga
 * isto precisa saber, ANTES, que (a) o destino só muda se existir um funil
 * marcado como de clientes — sem ele, o card cai no padrão como sempre; (b) só
 * conta negócio GANHO, e só enquanto não houver outro aberto; (c) a janela de
 * pós-venda NÃO apaga nem fecha nada: ela só deixa de abrir um card novo.
 *
 * O interruptor salva no clique. A janela entra na barra de salvar da tela
 * (`GrupoDeSalvar` da página, junto dos outros formulários): digitar acende a
 * barra e o aviso de saída, Salvar grava, Descartar volta ao último gravado.
 * São duas chaves que a leitura do nascimento do lead consulta no ato — nada é
 * reescrito no histórico, ao contrário de `ClientePelaAgenda`, cuja ligação
 * etiqueta a base inteira de uma vez.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  definirClientePelaVenda,
  type ResultadoClientePelaVenda,
} from "@/app/actions/settings/definirClientePelaVenda";
import { useBarraDeSalvar } from "@/components/configuracoes/grupo-de-salvar";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

const ERRO: Record<string, string> = {
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um administrador da organização pode mudar esta opção.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
};

export function ClientePelaVenda({
  ligada,
  posVendaDias,
  idioma,
  podeMudar,
}: {
  ligada: boolean;
  posVendaDias: number;
  idioma: Idioma;
  /** Espelha o `admin` que a action cobra. Cortesia, não autorização. */
  podeMudar: boolean;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [valor, setValor] = useState(ligada);
  const [janela, setJanela] = useState(String(posVendaDias));
  // O último valor GRAVADO da janela: o interruptor não deve salvar um número
  // que a pessoa digitou e ainda não confirmou.
  const [janelaGravada, setJanelaGravada] = useState(posVendaDias);
  // E o último valor GRAVADO do interruptor: é ele que a janela leva junto.
  const [ligadoGravado, setLigadoGravado] = useState(ligada);
  const [isPending, startTransition] = useTransition();

  const janelaInvalida =
    janela.trim() === "" || !/^\d+$/.test(janela.trim()) || Number(janela) > 365;
  // Inválida também é mudança pendente: a barra aparece com o Salvar desligado
  // e o motivo, em vez de a edição sumir em silêncio.
  const janelaSuja = podeMudar && (janelaInvalida || Number(janela) !== janelaGravada);

  async function gravar(novoLigado: boolean, novaJanela: number): Promise<ResultadoClientePelaVenda> {
    const r = await definirClientePelaVenda({ ligado: novoLigado, posVendaDias: novaJanela });
    if (r.ok) {
      setValor(r.ligado);
      setLigadoGravado(r.ligado);
      setJanelaGravada(r.posVendaDias);
      toast.success(t("Opção salva."));
      router.refresh();
    } else {
      toast.error(t(ERRO[r.error] ?? "Não consegui salvar agora."));
    }
    return r;
  }

  const { barra, enviar, salvando, refDoFormulario } = useBarraDeSalvar({
    sujo: janelaSuja,
    // Com o interruptor a caminho do servidor, o Salvar espera: as duas
    // gravações escrevem as mesmas duas chaves.
    podeSalvar: !janelaInvalida && !isPending,
    aviso: janelaInvalida ? t("Use um número inteiro entre 0 e 365.") : null,
    descartar: () => setJanela(String(janelaGravada)),
    salvar: async () => {
      if (janelaInvalida) return "invalido";
      // Com o interruptor como está GRAVADO: a janela não leva junto um
      // interruptor que ainda está a caminho do servidor.
      const r = await gravar(ligadoGravado, Number(janela));
      if (!r.ok) return "falhou";
      setJanela(String(r.posVendaDias));
      return "salvo";
    },
  });

  function trocarInterruptor(novo: boolean) {
    setValor(novo);
    startTransition(async () => {
      // A janela GRAVADA vai junto, nunca a digitada: a que está pendente
      // continua na tela e na barra.
      const r = await gravar(novo, janelaGravada);
      if (!r.ok) setValor(ligada);
    });
  }

  return (
    <Card className="p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="cliente_pela_venda">
            {t("Quem já comprou volta pelo funil de clientes")}
          </Label>
          <p className="max-w-2xl text-xs text-muted-foreground">
            {t(
              "Quando o contato já tem um negócio GANHO e nenhum aberto, a conversa nova dele nasce no funil marcado como de clientes, em vez do funil de entrada — que existe para medir quem é novo. Sem funil de clientes marcado, nada muda de destino: o negócio nasce no funil padrão, mas a linha do tempo passa a dizer que é recompra, com a data, o funil e o valor da venda anterior. Só negócio ganho conta; negócio perdido não. Vem desligada.",
            )}
          </p>
          <p className="max-w-2xl text-xs" data-testid="cliente-pela-venda-estado">
            {valor
              ? t("Ligado: quem já comprou não cai mais no funil de captação.")
              : t("Desligado: o funil continua decidido só pelo agendamento, como antes.")}
          </p>
          {!podeMudar && (
            <p className="text-xs text-muted-foreground">
              {t("Só um administrador da organização pode mudar esta opção.")}
            </p>
          )}
        </div>
        <Switch
          id="cliente_pela_venda"
          checked={valor}
          disabled={isPending || salvando || !podeMudar}
          onCheckedChange={trocarInterruptor}
        />
      </div>

      <form
        ref={refDoFormulario}
        onSubmit={enviar}
        className="mt-6 flex flex-col gap-1 border-t pt-4"
      >
        <Label htmlFor="pos_venda_dias">{t("Janela de pós-venda (dias)")}</Label>
        <p className="max-w-2xl text-xs text-muted-foreground">
          {t(
            "Dentro desta janela, a conversa de quem acabou de comprar não abre negócio nenhum — é o \"chegou certinho?\" dos primeiros dias. Zero desliga a janela e o negócio nasce sempre. Nada do que já existe é apagado ou fechado: a janela só decide se um card NOVO nasce.",
          )}
        </p>
        <div className="mt-2 flex items-end gap-2">
          <Input
            id="pos_venda_dias"
            className="w-24"
            inputMode="numeric"
            value={janela}
            disabled={isPending || salvando || !podeMudar}
            onChange={(e) => setJanela(e.target.value)}
          />
        </div>
        <p className="mt-2 text-xs" data-testid="pos-venda-dias-estado">
          {/* Desligada, a janela não vale: `decidirPelaVenda` devolve "sem venda"
              antes de olhar a janela. O texto acompanha o interruptor. */}
          {janelaGravada === 0
            ? t("Sem janela: todo retorno de quem já comprou abre negócio.")
            : !valor
              ? t("Janela guardada, mas sem efeito: ela só vale com a opção acima ligada.")
            : `${t("Janela ativa: compras dos últimos")} ${janelaGravada} ${t("dias não abrem negócio novo.")}`}
        </p>
        {janelaInvalida && (
          <p className="text-xs text-destructive">
            {t("Use um número inteiro entre 0 e 365.")}
          </p>
        )}
        {barra}
      </form>
    </Card>
  );
}
