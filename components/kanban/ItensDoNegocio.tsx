"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { useItensDoNegocio, useMutacoesDosItens } from "@/hooks/leads/useItensDoNegocio";
import { apiClient } from "@/lib/api/client";
import {
  formatValorDoNegocio,
  MOEDA_PADRAO,
  parseReaisToCents,
  precoDoCatalogoParaValorDoNegocio,
} from "@/lib/money";
import {
  somaDosItens,
  subtotalDoItem,
  type ItemDoNegocio,
} from "@/lib/schemas/lead-itens";
import type { Produto } from "@/lib/schemas/produtos";

function centavosParaCampo(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

/** "1,5" ou "1.5" → 1.5; vazio/ruim → null. */
function lerQuantidade(texto: string): number | null {
  const n = Number(texto.trim().replace(",", "."));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function quantidadeParaCampo(q: number): string {
  return String(q).replace(".", ",");
}

interface Props {
  leadId: string;
  pipelineId: string;
  /** Moeda do negócio (`crm_leads.currency`); ausente = a padrão do produto. */
  moeda: string | null;
  /** Agent para cima. A rota cobra de novo — esconder o controle é cortesia. */
  podeEditar: boolean;
  /**
   * Avisa a ficha do total dos itens: a soma em centavos, ou `null` quando o
   * negócio NÃO tem itens (o valor volta a ser digitado). Só chama depois que a
   * lista chegou — "carregando" não é "sem itens".
   */
  onTotalChange?: (total: number | null) => void;
}

/**
 * Os PRODUTOS do negócio, dentro da ficha.
 *
 * O atendente escolhe produtos do catálogo ativo; cada item tem quantidade e
 * valor unitário. O valor unitário nasce com o preço do produto de valor FIXO
 * (editável) e nasce VAZIO e obrigatório no produto de valor VARIÁVEL. O valor
 * do negócio é a soma dos itens — o banco a mantém por gatilho, e este
 * componente só a mostra e avisa a ficha.
 */
export function ItensDoNegocio({ leadId, pipelineId, moeda, podeEditar, onTotalChange }: Props) {
  const t = useT();
  const moedaDoNegocio = moeda ?? MOEDA_PADRAO;
  const itensQ = useItensDoNegocio(leadId);
  const { adicionar, alterar, remover } = useMutacoesDosItens(leadId, pipelineId);

  // O catálogo só é pedido a quem pode adicionar.
  const produtosQ = useQuery({
    queryKey: ["produtos-do-catalogo"],
    enabled: podeEditar,
    staleTime: 30_000,
    queryFn: async () => (await apiClient.get<{ data: Produto[] }>("/api/v1/products")).data,
  });
  const ativos = useMemo(() => (produtosQ.data ?? []).filter((p) => p.ativo), [produtosQ.data]);

  const itens = itensQ.data;
  const total = itens ? somaDosItens(itens) : null;

  useEffect(() => {
    if (!itens) return;
    onTotalChange?.(itens.length > 0 ? somaDosItens(itens) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itens]);

  const [produtoId, setProdutoId] = useState("");
  const [quantidade, setQuantidade] = useState("1");
  const [valor, setValor] = useState("");
  const escolhido = ativos.find((p) => p.id === produtoId) ?? null;

  function escolher(id: string) {
    setProdutoId(id);
    setQuantidade("1");
    const p = ativos.find((x) => x.id === id);
    // Fixo: o preço do catálogo, editável. Variável: vazio e obrigatório.
    setValor(
      p && p.tipo_de_preco === "fixo" && p.preco_cents !== null
        ? centavosParaCampo(precoDoCatalogoParaValorDoNegocio(p.preco_cents, p.moeda))
        : "",
    );
  }

  const qtdLida = lerQuantidade(quantidade);
  const valorLido = valor.trim() === "" ? null : parseReaisToCents(valor);
  const podeAdicionar = escolhido !== null && qtdLida !== null && valorLido !== null;

  async function adicionarItem() {
    if (!escolhido || qtdLida === null || valorLido === null) return;
    try {
      await adicionar.mutateAsync({
        product_id: escolhido.id,
        quantidade: qtdLida,
        valor_unitario_cents: valorLido,
      });
      toast.success(t("Produto adicionado"));
      setProdutoId("");
      setQuantidade("1");
      setValor("");
    } catch {
      // o toast de erro já saiu
    }
  }

  return (
    <section
      className="space-y-2 rounded-md border border-border p-3"
      aria-label={t("Produtos")}
      data-testid="itens-do-negocio"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-sm font-medium">{t("Produtos")}</h4>
        {itens && itens.length > 0 && total !== null && (
          <span className="text-xs tabular-nums text-text-muted" data-testid="itens-total">
            {t("Total")}: {formatValorDoNegocio(total, moedaDoNegocio)}
          </span>
        )}
      </div>

      {itensQ.isLoading && <p className="text-xs text-text-muted">{t("Carregando…")}</p>}

      {itens && itens.length === 0 && (
        <p className="text-xs text-text-muted" data-testid="itens-vazio">
          {podeEditar
            ? t("Nenhum produto neste negócio. Sem produtos, o valor é o que você digita acima.")
            : t("Nenhum produto neste negócio.")}
        </p>
      )}

      {itens && itens.length > 0 && (
        <ul className="space-y-2" data-testid="itens-lista">
          {itens.map((item) => (
            <LinhaDoItem
              key={`${item.id}:${item.updated_at}`}
              item={item}
              moeda={moedaDoNegocio}
              podeEditar={podeEditar}
              ocupado={alterar.isPending || remover.isPending}
              aoAlterar={(patch) => alterar.mutate({ itemId: item.id, patch })}
              aoRemover={() => remover.mutate(item.id)}
            />
          ))}
        </ul>
      )}

      {podeEditar && (
        <div className="space-y-2 border-t border-border pt-2" data-testid="itens-adicionar">
          <label className="block text-xs text-text-muted" htmlFor={`produto-${leadId}`}>
            {t("Adicionar produto")}
          </label>
          <select
            id={`produto-${leadId}`}
            value={produtoId}
            onChange={(e) => escolher(e.target.value)}
            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
            data-testid="itens-seletor"
          >
            <option value="">
              {produtosQ.isLoading
                ? t("Carregando o catálogo…")
                : ativos.length === 0
                  ? t("Nenhum produto ativo no catálogo")
                  : t("Escolha um produto…")}
            </option>
            {ativos.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nome}
                {" — "}
                {p.tipo_de_preco === "variavel" || p.preco_cents === null
                  ? t("valor variável")
                  : formatValorDoNegocio(
                      precoDoCatalogoParaValorDoNegocio(p.preco_cents, p.moeda),
                      p.moeda,
                    )}
              </option>
            ))}
          </select>

          {escolhido && (
            <div className="grid grid-cols-[5rem_1fr_auto] items-end gap-2">
              <div className="space-y-1">
                <label className="block text-xs text-text-muted" htmlFor={`qtd-novo-${leadId}`}>
                  {t("Qtd.")}
                </label>
                <Input
                  id={`qtd-novo-${leadId}`}
                  inputMode="decimal"
                  value={quantidade}
                  onChange={(e) => setQuantidade(e.target.value)}
                  data-testid="itens-novo-quantidade"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-xs text-text-muted" htmlFor={`valor-novo-${leadId}`}>
                  {escolhido.tipo_de_preco === "variavel"
                    ? t("Valor unitário (obrigatório)")
                    : t("Valor unitário")}
                </label>
                <Input
                  id={`valor-novo-${leadId}`}
                  inputMode="decimal"
                  placeholder="0,00"
                  value={valor}
                  onChange={(e) => setValor(e.target.value)}
                  data-testid="itens-novo-valor"
                />
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => void adicionarItem()}
                disabled={!podeAdicionar || adicionar.isPending}
                data-testid="itens-adicionar-botao"
              >
                {adicionar.isPending ? t("Adicionando…") : t("Adicionar")}
              </Button>
            </div>
          )}
          {escolhido && escolhido.tipo_de_preco === "variavel" && valorLido === null && (
            <p className="text-xs text-text-muted">
              {t("Este produto tem valor variável: informe o valor deste negócio.")}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function LinhaDoItem({
  item,
  moeda,
  podeEditar,
  ocupado,
  aoAlterar,
  aoRemover,
}: {
  item: ItemDoNegocio;
  moeda: string;
  podeEditar: boolean;
  ocupado: boolean;
  aoAlterar: (patch: { quantidade?: number; valor_unitario_cents?: number }) => void;
  aoRemover: () => void;
}) {
  const t = useT();
  const [qtd, setQtd] = useState(quantidadeParaCampo(item.quantidade));
  const [valor, setValor] = useState(centavosParaCampo(item.valor_unitario_cents));

  function confirmarQuantidade() {
    const q = lerQuantidade(qtd);
    if (q === null) {
      setQtd(quantidadeParaCampo(item.quantidade));
      return;
    }
    if (q !== item.quantidade) aoAlterar({ quantidade: q });
  }

  function confirmarValor() {
    const v = parseReaisToCents(valor);
    if (v === null) {
      setValor(centavosParaCampo(item.valor_unitario_cents));
      return;
    }
    if (v !== item.valor_unitario_cents) aoAlterar({ valor_unitario_cents: v });
  }

  return (
    <li className="space-y-1" data-testid="item-do-negocio">
      <p className="text-sm font-medium leading-5" data-testid="item-nome">
        {item.nome_snapshot}
      </p>
      {podeEditar ? (
        <div className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-2">
          <Input
            aria-label={`${t("Quantidade")} — ${item.nome_snapshot}`}
            inputMode="decimal"
            value={qtd}
            onChange={(e) => setQtd(e.target.value)}
            onBlur={confirmarQuantidade}
            disabled={ocupado}
            data-testid="item-quantidade"
          />
          <Input
            aria-label={`${t("Valor unitário")} — ${item.nome_snapshot}`}
            inputMode="decimal"
            value={valor}
            onChange={(e) => setValor(e.target.value)}
            onBlur={confirmarValor}
            disabled={ocupado}
            data-testid="item-valor"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={aoRemover}
            disabled={ocupado}
            aria-label={`${t("Remover")} ${item.nome_snapshot}`}
            data-testid="item-remover"
          >
            {t("Remover")}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-text-muted">
          {quantidadeParaCampo(item.quantidade)} × {formatValorDoNegocio(item.valor_unitario_cents, moeda)}
        </p>
      )}
      <p className="text-right text-xs tabular-nums text-text-muted" data-testid="item-subtotal">
        {t("Subtotal")}: {formatValorDoNegocio(subtotalDoItem(item), moeda)}
      </p>
    </li>
  );
}
