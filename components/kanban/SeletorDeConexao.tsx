"use client";
import { useId, useState, type ReactNode } from "react";

import { useT } from "@/hooks/i18n/useT";
import { useMinhasConexoes } from "@/hooks/inbox/useMinhasConexoes";
import { conexaoPadraoDoSeletor, type ConexaoResumo } from "@/lib/inbox/conexao-ao-abrir";

/**
 * O seletor de conexão do painel do negócio, junto de "Abrir conversa no Chat do CRM" (pedido do
 * dono do produto, 18/11/2026).
 *
 * As opções e o padrão vêm de `useMinhasConexoes` (`GET …/open-with-contact/opcoes`): só as
 * conexões da organização ativa pelas quais quem está logado pode iniciar conversa (no modo "só a
 * conexão própria", a mesma régua que o POST confere). Vem marcado com a conexão de que a pessoa é
 * o membro responsável (`conexaoPadraoDoSeletor`); sem nenhuma, em "Automático", que é o
 * comportamento de antes (`decidirAbertura`).
 *
 * `conexao` = a escolhida; `null` = Automático. Sem opções (leitura falhou ou resposta antiga), o
 * seletor não aparece e a abertura segue como antes.
 */
export function useSeletorDeConexao(): { conexao: ConexaoResumo | null; seletor: ReactNode } {
  const t = useT();
  const id = useId();
  const minhas = useMinhasConexoes();
  // `undefined` = a pessoa ainda não mexeu: vale o padrão, que pode chegar depois do primeiro render.
  const [escolha, setEscolha] = useState<string | undefined>(undefined);

  const opcoes = minhas?.conexoes_do_seletor ?? [];
  const padrao = minhas ? conexaoPadraoDoSeletor(minhas) : null;
  const valor = escolha ?? padrao?.id ?? "";
  const conexao = opcoes.find((c) => c.id === valor) ?? null;

  if (opcoes.length === 0) return { conexao: null, seletor: null };

  const seletor = (
    <div
      className="flex items-center gap-2"
      // O card do funil é arrastável e clicável: escolher não pode abrir nem arrastar nada.
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <label htmlFor={id} className="shrink-0 text-2xs text-text-muted">
        {t("Abrir pela conexão")}
      </label>
      <select
        id={id}
        value={conexao ? conexao.id : ""}
        onChange={(e) => setEscolha(e.target.value)}
        className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs"
        data-testid="seletor-de-conexao"
      >
        <option value="">{t("Automático")}</option>
        {opcoes.map((c) => (
          <option key={c.id} value={c.id}>
            {t(c.nome)}
            {c.conectada ? "" : ` (${t("desconectada")})`}
          </option>
        ))}
      </select>
    </div>
  );
  return { conexao, seletor };
}
