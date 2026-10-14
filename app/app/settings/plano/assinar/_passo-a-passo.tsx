"use client";

/**
 * D-180: assinar um plano em quatro passos (1 Plano, 2 Ciclo, 3 Pagamento, 4 Resumo), no lugar da tela
 * que mostrava todos os planos com todas as opções ao mesmo tempo. SÓ a interface mudou: a regra, o
 * servidor e as contas são os de antes. O botão final chama a MESMA ação (`iniciarAssinatura`) com a
 * mesma entrada, a chave de idempotência segue a regra da correção 6 (`../_logica-compra`), as opções de
 * parcelas continuam calculadas no servidor (D-177) e o resumo do ciclo continua vindo só dos preços do
 * catálogo (`resumoDoCiclo`, D-176). Os dados do cartão nunca passam por aqui: ficam na fatura do Asaas.
 *
 * O estado de todos os passos vive neste componente, então voltar preserva o que já foi escolhido. Ao
 * trocar de plano, ciclo e forma de pagamento recomeçam (o ciclo escolhido pode nem existir no outro
 * plano); ao trocar de ciclo, o parcelamento volta para 1x, como antes. A cada passo novo o foco vai
 * para o título dele, e o indicador do topo marca o passo atual com `aria-current="step"`.
 *
 * Cupom de desconto (0955): no resumo, "Tem um cupom?" abre o campo; "Aplicar" chama `simularCupom`, e quem
 * conta o desconto é o banco (aqui só se mostra). O cupom aplicado guarda para QUAL escolha foi simulado
 * (plano, ciclo, forma de pagamento, parcelas): se a escolha muda, o valor guardado deixa de valer na hora
 * (nunca aparece valor velho) e o cupom é simulado de novo; se deixar de valer, sai com o aviso. O cupom
 * entra na escolha da chave de idempotência, porque o servidor recusa a mesma chave com cupom diferente.
 * O desconto vale só na primeira cobrança, e o resumo diz isso e o preço da renovação.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { iniciarAssinatura, simularCupom } from "@/app/actions/settings/compraDoPlano";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import { randomId } from "@/lib/random-id";
import { VERSAO_DOS_TERMOS } from "@/lib/legal/versao-dos-termos";

import type { PlanoParaVenda } from "@/lib/billing/asaas/leitura";
import type { ResultadoIniciarCompra } from "@/lib/billing/asaas/compra";
import type { SimulacaoDeCupom } from "@/lib/billing/asaas/cupom";
import type { OpcaoDeParcelas } from "@/lib/billing/asaas/parcelamento";

import {
  chaveParaProximaTentativaDeCompra,
  ciclosDisponiveis,
  classificarDesfechoDaTentativa,
  montarPagadorDoFormulario,
  precoDoCiclo,
  resumoDoCiclo,
  urlDeRedirecionamentoEhSegura,
  type CamposDoFormularioDoPagador,
  type CicloDeCompra,
  type DadosDoPagador,
  type DesfechoDaTentativaDeCompra,
  type EscolhaDeCompra,
} from "../_logica-compra";
import { PixPendente } from "./_pix-pendente";
import { AceiteDosTermos, CAMPOS_VAZIOS, FormularioDoPagador, formatarReais } from "./_comuns";

type Passo = 1 | 2 | 3 | 4;
type Metodo = "CREDIT_CARD" | "PIX";
type OpcoesDoPlano = { semiannual: OpcaoDeParcelas[]; yearly: OpcaoDeParcelas[] };

const SEM_OPCOES: OpcoesDoPlano = { semiannual: [], yearly: [] };

/** O cupom aplicado e a escolha para a qual o banco simulou o valor (`escolha`); outra escolha, valor velho. */
type CupomAplicado = { codigo: string; escolha: string; simulacao: SimulacaoDeCupom };

const MENSAGEM_CUPOM_VAZIO = "Digite o código do cupom.";
const MENSAGEM_CUPOM_FALHOU = "Não foi possível conferir o cupom agora. Tente novamente em instantes.";

/** Classe da "caixa de escolha" (ciclo, forma de pagamento, parcela): a borda marca a escolhida e o foco do teclado aparece. */
function classeDaEscolha(ativa: boolean): string {
  return cn(
    "flex cursor-pointer gap-3 rounded-lg border p-4 text-sm transition-colors focus-within:ring-2 focus-within:ring-ring",
    ativa ? "border-primary bg-primary/5" : "hover:bg-muted/50",
  );
}

export function AssinarPlanoPassoAPasso({
  planos,
  opcoesDeParcelas,
  taxaMensalPercentual,
  precisaPagador,
  planoAtualCode,
}: {
  planos: PlanoParaVenda[];
  opcoesDeParcelas: Record<string, OpcoesDoPlano>;
  taxaMensalPercentual: number | null;
  precisaPagador: boolean;
  planoAtualCode: string | null;
}) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();

  const [passo, setPasso] = useState<Passo>(1);
  const [planCode, setPlanCode] = useState<string | null>(null);
  const [ciclo, setCiclo] = useState<CicloDeCompra>("monthly");
  const [metodo, setMetodo] = useState<Metodo>("CREDIT_CARD");
  const [parcelas, setParcelas] = useState(1);
  const [pagador, setPagador] = useState<CamposDoFormularioDoPagador>(CAMPOS_VAZIOS);
  const [aceitouTermos, setAceitouTermos] = useState(false);
  const [pendente, setPendente] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [resultado, setResultado] = useState<ResultadoIniciarCompra | null>(null);
  // Chave de idempotência (decisão 13 do plano da fase): estável entre repetições da MESMA escolha
  // depois de "aguarde"; nova a cada mudança de plano/ciclo/método/parcelas ou a cada desfecho terminal.
  const [chave, setChave] = useState<string>(() => randomId());
  const tentativaAnteriorRef = useRef<{ escolha: EscolhaDeCompra; desfecho: DesfechoDaTentativaDeCompra } | null>(null);
  // Cupom de desconto: o campo aberto, o código digitado, o cupom aplicado e o aviso (erro ou "cupom removido").
  const [cupomAberto, setCupomAberto] = useState(false);
  const [codigoDoCupom, setCodigoDoCupom] = useState("");
  const [aplicandoCupom, setAplicandoCupom] = useState(false);
  const [cupom, setCupom] = useState<CupomAplicado | null>(null);
  const [avisoDoCupom, setAvisoDoCupom] = useState<{ mensagem: string; removido: boolean } | null>(null);

  // Foco no título do passo novo (nunca na primeira pintura da tela).
  const tituloRef = useRef<HTMLHeadingElement>(null);
  const primeiraPintura = useRef(true);
  useEffect(() => {
    if (primeiraPintura.current) {
      primeiraPintura.current = false;
      return;
    }
    tituloRef.current?.focus();
  }, [passo]);

  const plano = planos.find((p) => p.code === planCode) ?? null;
  const opcoesDoPlano = (plano && opcoesDeParcelas[plano.code]) || SEM_OPCOES;

  // D-177: só o cartão no semestral e no anual parcela; o mensal e o Pix ficam à vista.
  const opcoesDoCiclo = ciclo === "semiannual" ? opcoesDoPlano.semiannual : ciclo === "yearly" ? opcoesDoPlano.yearly : [];
  const mostraParcelas = metodo === "CREDIT_CARD" && opcoesDoCiclo.length > 1;
  const parcelasEfetivas = mostraParcelas ? parcelas : 1;
  const opcaoEscolhida = mostraParcelas ? opcoesDoCiclo.find((o) => o.parcelas === parcelasEfetivas) ?? null : null;

  // O cupom só vale para a escolha em que foi simulado. Escolha diferente: o valor guardado é velho, nunca se mostra.
  const escolhaDoCupom = plano ? `${plano.code}|${ciclo}|${metodo}|${parcelasEfetivas}` : "";
  const simulacaoDoCupom = cupom && cupom.escolha === escolhaDoCupom ? cupom.simulacao : null;
  const reconferindoCupom = cupom !== null && simulacaoDoCupom === null;

  // Trocou plano, ciclo, forma de pagamento ou parcelas com cupom aplicado: simula de novo. Se o cupom
  // deixou de valer, sai com o aviso. A resposta de uma escolha que já foi trocada é descartada.
  useEffect(() => {
    if (!cupom || !plano || cupom.escolha === escolhaDoCupom) return;
    let descartada = false;
    simularCupom({ codigo: cupom.codigo, planCode: plano.code, ciclo, metodo, parcelas: parcelasEfetivas })
      .then((r) => {
        if (descartada) return;
        if (r.tipo === "ok") {
          setCupom({ codigo: r.codigo, escolha: escolhaDoCupom, simulacao: r });
        } else {
          setCupom(null);
          setAvisoDoCupom({ mensagem: r.mensagem, removido: true });
          setCupomAberto(true);
        }
      })
      .catch(() => {
        if (descartada) return;
        setCupom(null);
        setAvisoDoCupom({ mensagem: MENSAGEM_CUPOM_FALHOU, removido: true });
        setCupomAberto(true);
      });
    return () => {
      descartada = true;
    };
  }, [cupom, plano, escolhaDoCupom, ciclo, metodo, parcelasEfetivas]);

  const rotuloDoCiclo: Record<CicloDeCompra, string> = {
    monthly: t("Mensal"),
    semiannual: t("Semestral"),
    yearly: t("Anual"),
  };
  const rotuloDoMetodo: Record<Metodo, string> = { CREDIT_CARD: t("Cartão de crédito"), PIX: t("Pix") };

  function irPara(novo: Passo) {
    setErro(null);
    setPasso(novo);
  }

  function escolherPlano(code: string) {
    if (code !== planCode) {
      setPlanCode(code);
      setCiclo("monthly");
      setMetodo("CREDIT_CARD");
      setParcelas(1);
    }
    irPara(2);
  }

  function escolherCiclo(novo: CicloDeCompra) {
    setCiclo(novo);
    setParcelas(1);
    if (novo === "monthly") setMetodo("CREDIT_CARD");
  }

  function escolherMetodo(novo: Metodo) {
    setMetodo(novo);
    if (novo === "PIX") setParcelas(1);
  }

  /** Do pagamento para o resumo: o formulário do pagador (primeira compra) é conferido já aqui, no passo dele. */
  function avancarDoPagamento() {
    if (precisaPagador) {
      const montado = montarPagadorDoFormulario(pagador);
      if (!montado.ok) {
        setErro(t(montado.erro));
        toast.error(t(montado.erro));
        return;
      }
    }
    irPara(4);
  }

  async function aplicarCupom() {
    if (!plano || aplicandoCupom) return;
    const codigo = codigoDoCupom.trim();
    if (codigo === "") {
      setAvisoDoCupom({ mensagem: MENSAGEM_CUPOM_VAZIO, removido: false });
      return;
    }
    setAvisoDoCupom(null);
    setAplicandoCupom(true);
    try {
      const r = await simularCupom({ codigo, planCode: plano.code, ciclo, metodo, parcelas: parcelasEfetivas });
      if (r.tipo === "erro") {
        setAvisoDoCupom({ mensagem: r.mensagem, removido: false });
        return;
      }
      setCupom({ codigo: r.codigo, escolha: escolhaDoCupom, simulacao: r });
      setCodigoDoCupom("");
      setCupomAberto(false);
    } catch {
      setAvisoDoCupom({ mensagem: MENSAGEM_CUPOM_FALHOU, removido: false });
    } finally {
      setAplicandoCupom(false);
    }
  }

  function removerCupom() {
    setCupom(null);
    setAvisoDoCupom(null);
    setCupomAberto(false);
  }

  async function assinar() {
    if (!plano || reconferindoCupom) return;
    const cupomDestaCompra = simulacaoDoCupom ? simulacaoDoCupom.codigo : undefined;
    const escolhaAtual: EscolhaDeCompra = {
      tipo: "assinatura",
      planCode: plano.code,
      ciclo,
      metodo,
      parcelas: parcelasEfetivas,
      ...(cupomDestaCompra ? { cupom: cupomDestaCompra } : {}),
    };
    const chaveDestaTentativa = chaveParaProximaTentativaDeCompra({
      chaveAtual: chave,
      escolhaAtual,
      tentativaAnterior: tentativaAnteriorRef.current,
    });
    if (chaveDestaTentativa !== chave) setChave(chaveDestaTentativa);

    let entradaDoPagador: DadosDoPagador | undefined;

    if (precisaPagador) {
      const montado = montarPagadorDoFormulario(pagador);
      if (!montado.ok) {
        toast.error(t(montado.erro));
        tentativaAnteriorRef.current = { escolha: escolhaAtual, desfecho: "terminal" };
        // O erro é do formulário do pagador: a pessoa volta ao passo dele, onde o campo está.
        setPasso(3);
        setErro(t(montado.erro));
        return;
      }
      entradaDoPagador = montado.pagador;
    }

    setErro(null);
    setPendente(true);
    try {
      const r = await iniciarAssinatura({
        planCode: plano.code,
        ciclo,
        metodo,
        // D-177: só vai quando parcela; à vista a entrada segue exatamente como antes.
        ...(parcelasEfetivas > 1 ? { parcelas: parcelasEfetivas } : {}),
        // 0955: só o código; o desconto quem calcula é o banco, na criação do pedido.
        ...(cupomDestaCompra ? { cupom: cupomDestaCompra } : {}),
        chave: chaveDestaTentativa,
        pagador: entradaDoPagador,
        termosVersao: VERSAO_DOS_TERMOS,
      });
      tentativaAnteriorRef.current = { escolha: escolhaAtual, desfecho: classificarDesfechoDaTentativa(r) };

      if (r.tipo === "erro") {
        // A frase de recusa da troca de plano (0942) tem es e zh-CN no dicionário; as demais
        // mensagens da ação seguem em português, como antes (t() devolve a própria frase quando
        // não há tradução).
        toast.error(t(r.mensagem));
        setErro(t(r.mensagem));
        setPendente(false);
        return;
      }

      if (r.tipo === "redirecionar") {
        if (!urlDeRedirecionamentoEhSegura(r.url)) {
          const mensagem = t("Não foi possível continuar: o endereço de pagamento não é reconhecido.");
          toast.error(mensagem);
          setErro(mensagem);
          setPendente(false);
          return;
        }
        window.location.assign(r.url);
        return;
      }

      setResultado(r);
      setPendente(false);
    } catch {
      tentativaAnteriorRef.current = { escolha: escolhaAtual, desfecho: "terminal" };
      const mensagem = t("Não foi possível concluir a compra agora. Tente novamente em instantes.");
      toast.error(mensagem);
      setErro(mensagem);
      setPendente(false);
    }
  }

  if (resultado?.tipo === "pix") {
    return <PixPendente pedidoId={resultado.pedidoId} qr={resultado.qr} />;
  }

  const rotulosDosPassos = [t("Plano"), t("Ciclo"), t("Pagamento"), t("Resumo")];

  const alertaDeErro = erro ? (
    <div role="alert" data-testid="erro-do-passo" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
      {erro}
    </div>
  ) : null;

  const tituloDoPasso = (texto: string) => (
    <h3 ref={tituloRef} tabIndex={-1} className="text-base font-semibold outline-hidden" data-testid="titulo-do-passo">
      {texto}
    </h3>
  );

  return (
    <div className="space-y-6">
      <nav aria-label={t("Etapas da assinatura")}>
        <ol className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          {rotulosDosPassos.map((rotulo, i) => {
            const numero = i + 1;
            const atual = numero === passo;
            const feito = numero < passo;
            return (
              <li
                key={numero}
                data-testid={`indicador-passo-${numero}`}
                aria-current={atual ? "step" : undefined}
                className={cn("flex items-center gap-2", atual ? "font-medium text-foreground" : "text-muted-foreground")}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex h-6 w-6 items-center justify-center rounded-full border text-xs",
                    atual && "border-primary bg-primary text-primary-foreground",
                    feito && "border-primary text-primary",
                  )}
                >
                  {numero}
                </span>
                <span>{rotulo}</span>
              </li>
            );
          })}
        </ol>
      </nav>

      {passo === 1 && (
        <div className="space-y-4" data-testid="passo-plano">
          {tituloDoPasso(t("Escolha o plano"))}
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(15rem,1fr))]">
            {planos.map((p) => {
              const ciclosDoPlano = ciclosDisponiveis(p);
              const escolhido = p.code === planCode;
              return (
                <Card key={p.code} data-testid={`plano-${p.code}`} className={cn("flex flex-col", escolhido && "border-primary")}>
                  <CardHeader>
                    <CardTitle className="flex flex-wrap items-center justify-between gap-2">
                      <span>{p.name}</span>
                      {p.code === planoAtualCode && <Badge variant="success">{t("Plano atual")}</Badge>}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-1 flex-col justify-between gap-4">
                    <div className="space-y-2">
                      <p>
                        <span className="block text-xs text-muted-foreground">{t("a partir de")}</span>
                        <span className="text-2xl font-semibold">{formatarReais(p.priceMonthlyCents, tagDoIdioma)}</span>{" "}
                        <span className="text-sm text-muted-foreground">{t("por mês")}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t("Ciclos disponíveis")}:{" "}
                        {ciclosDoPlano.map((c) => rotuloDoCiclo[c]).join(", ")}
                      </p>
                      <p className="text-xs text-muted-foreground" data-testid={`conexoes-${p.code}`}>
                        <span className="font-medium text-foreground">
                          {p.conexoes === null ? t("Conexões ilimitadas") : `${p.conexoes} ${t("Conexões")}`}
                        </span>{" "}
                        ({t("WhatsApp, Instagram e Messenger somados")})
                      </p>
                      <a
                        href="/#planos"
                        target="_blank"
                        rel="noopener noreferrer"
                        data-testid={`ver-incluso-${p.code}`}
                        className="inline-block text-xs font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {t("Ver tudo incluso do plano")}
                      </a>
                    </div>
                    <Button
                      data-testid={`escolher-${p.code}`}
                      aria-label={`${t("Escolher")} ${p.name}`}
                      variant={escolhido ? "default" : "outline"}
                      onClick={() => escolherPlano(p.code)}
                    >
                      {t("Escolher")}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {passo === 2 && plano && (
        <div className="space-y-4" data-testid="passo-ciclo">
          {tituloDoPasso(t("Escolha o ciclo de cobrança"))}
          <p className="text-sm text-muted-foreground">{plano.name}</p>
          {/* Só os ciclos com preço no catálogo aparecem (D-176): o plano sem preço semestral ou anual não oferece esse. */}
          <div role="radiogroup" aria-label={t("Ciclo")} className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(13rem,1fr))]">
            {ciclosDisponiveis(plano).map((opcao) => {
              const resumo = resumoDoCiclo(plano, opcao);
              const ativo = ciclo === opcao;
              return (
                <label key={opcao} data-testid={`ciclo-${plano.code}-${opcao}`} className={cn(classeDaEscolha(ativo), "flex-col gap-1")}>
                  <input
                    type="radio"
                    name={`ciclo-${plano.code}`}
                    className="sr-only"
                    checked={ativo}
                    onChange={() => escolherCiclo(opcao)}
                  />
                  <span className="font-medium">{rotuloDoCiclo[opcao]}</span>
                  <span className="text-xl font-semibold">{formatarReais(precoDoCiclo(plano, opcao) as number, tagDoIdioma)}</span>
                  {opcao === "monthly" ? (
                    <span className="text-xs text-muted-foreground">{t("por mês")}</span>
                  ) : (
                    resumo && (
                      <span className="space-y-0.5" data-testid={`resumo-${plano.code}-${opcao}`}>
                        <span className="block text-xs text-muted-foreground">
                          {t("Total do período")} ({resumo.meses} {t("meses")})
                        </span>
                        {resumo.economiaCents > 0 && (
                          <span className="block text-xs font-medium text-success-fg">
                            {t("Economia de")} {formatarReais(resumo.economiaCents, tagDoIdioma)} ({resumo.economiaPercentual}%){" "}
                            {t("em relação ao mensal")}
                          </span>
                        )}
                      </span>
                    )
                  )}
                </label>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" data-testid="voltar" onClick={() => irPara(1)}>
              {t("Voltar")}
            </Button>
            <Button data-testid="continuar" onClick={() => irPara(3)}>
              {t("Continuar")}
            </Button>
          </div>
        </div>
      )}

      {passo === 3 && plano && (
        <div className="space-y-5" data-testid="passo-pagamento">
          {tituloDoPasso(t("Como você quer pagar"))}

          <div className="space-y-2">
            <span className="text-sm font-medium">{t("Forma de pagamento")}</span>
            {ciclo === "monthly" ? (
              // O mensal só existe no cartão (renova sozinho): não há o que escolher.
              <p className="text-sm" data-testid="metodo-unico">
                {rotuloDoMetodo.CREDIT_CARD}
              </p>
            ) : (
              <div role="radiogroup" aria-label={t("Forma de pagamento")} className="grid gap-3 sm:grid-cols-2">
                {(["CREDIT_CARD", "PIX"] as const).map((opcao) => (
                  <label key={opcao} data-testid={`metodo-${opcao}`} className={classeDaEscolha(metodo === opcao)}>
                    <input
                      type="radio"
                      name={`metodo-${plano.code}`}
                      className="sr-only"
                      checked={metodo === opcao}
                      onChange={() => escolherMetodo(opcao)}
                    />
                    <span className="font-medium">{rotuloDoMetodo[opcao]}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {mostraParcelas && (
            <div className="space-y-2" data-testid={`parcelas-${plano.code}`}>
              <span className="text-sm font-medium">{t("Parcelamento")}</span>
              <div className="space-y-1">
                {opcoesDoCiclo.map((opcao) => {
                  const ultimaDiferente = opcao.ultimaParcelaCents !== opcao.parcelaCents;
                  return (
                    <label
                      key={opcao.parcelas}
                      className={cn(classeDaEscolha(parcelas === opcao.parcelas), "items-start gap-2 p-2")}
                      data-testid={`parcelas-${plano.code}-${opcao.parcelas}`}
                    >
                      <input
                        type="radio"
                        name={`parcelas-${plano.code}`}
                        checked={parcelas === opcao.parcelas}
                        onChange={() => setParcelas(opcao.parcelas)}
                        className="mt-1"
                      />
                      <span>
                        <span className="font-medium">
                          {opcao.parcelas}x {formatarReais(opcao.parcelaCents, tagDoIdioma)}
                        </span>{" "}
                        <span className="text-muted-foreground">
                          {opcao.comJuros
                            ? `${t("com juros de")} ${taxaMensalPercentual === null ? "" : taxaMensalPercentual.toLocaleString(tagDoIdioma)}% ${t("ao mês")}`
                            : t("sem juros")}
                        </span>
                        {ultimaDiferente && (
                          <span className="block text-xs text-muted-foreground">
                            {t("última parcela")}: {formatarReais(opcao.ultimaParcelaCents, tagDoIdioma)}
                          </span>
                        )}
                        <span className="block text-xs text-muted-foreground">
                          {t("Total a pagar")}: {formatarReais(opcao.totalCents, tagDoIdioma)}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {precisaPagador && (
            <FormularioDoPagador pagador={pagador} onChange={setPagador} idPrefixo={`pagador-plano-${plano.code}`} />
          )}

          <AceiteDosTermos id={`termos-plano-${plano.code}`} aceito={aceitouTermos} onChange={setAceitouTermos} />

          {alertaDeErro}

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" data-testid="voltar" onClick={() => irPara(2)}>
              {t("Voltar")}
            </Button>
            <Button data-testid="continuar" disabled={!aceitouTermos} onClick={avancarDoPagamento}>
              {t("Continuar")}
            </Button>
          </div>
        </div>
      )}

      {passo === 4 && plano && (
        <div className="space-y-5" data-testid="passo-resumo">
          {tituloDoPasso(t("Revise e confirme"))}

          <dl className="divide-y rounded-lg border text-sm">
            <LinhaDoResumo
              testid="resumo-plano"
              rotulo={t("Plano")}
              valor={plano.name}
              alterar={() => irPara(1)}
              rotuloDoBotao={t("Alterar")}
            />
            <LinhaDoResumo
              testid="resumo-ciclo"
              rotulo={t("Ciclo")}
              valor={rotuloDoCiclo[ciclo]}
              alterar={() => irPara(2)}
              rotuloDoBotao={t("Alterar")}
            />
            <LinhaDoResumo
              testid="resumo-metodo"
              rotulo={t("Forma de pagamento")}
              valor={rotuloDoMetodo[metodo]}
              alterar={() => irPara(3)}
              rotuloDoBotao={t("Alterar")}
            />
            {mostraParcelas && (
              <LinhaDoResumo
                testid="resumo-parcelas"
                rotulo={t("Parcelamento")}
                valor={
                  opcaoEscolhida && opcaoEscolhida.parcelas > 1 ? (
                    <>
                      {opcaoEscolhida.parcelas}x{simulacaoDoCupom ? "" : ` ${formatarReais(opcaoEscolhida.parcelaCents, tagDoIdioma)}`}{" "}
                      <span className="text-muted-foreground">
                        {opcaoEscolhida.comJuros
                          ? `${t("com juros de")} ${taxaMensalPercentual === null ? "" : taxaMensalPercentual.toLocaleString(tagDoIdioma)}% ${t("ao mês")}`
                          : t("sem juros")}
                      </span>
                      {!simulacaoDoCupom && opcaoEscolhida.ultimaParcelaCents !== opcaoEscolhida.parcelaCents && (
                        <span className="block text-xs text-muted-foreground">
                          {t("última parcela")}: {formatarReais(opcaoEscolhida.ultimaParcelaCents, tagDoIdioma)}
                        </span>
                      )}
                    </>
                  ) : (
                    t("À vista")
                  )
                }
                alterar={() => irPara(3)}
                rotuloDoBotao={t("Alterar")}
              />
            )}
            {simulacaoDoCupom && (
              <>
                <div className="flex items-center justify-between gap-3 p-3" data-testid="resumo-preco-cheio">
                  <dt className="text-muted-foreground">{t("Preço cheio")}</dt>
                  <dd className="text-muted-foreground line-through">{formatarReais(simulacaoDoCupom.precoCheioCents, tagDoIdioma)}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 p-3" data-testid="resumo-cupom">
                  <dt>
                    {t("Cupom")} <span className="font-medium">{simulacaoDoCupom.codigo}</span>
                    {simulacaoDoCupom.tipoDoDesconto === "percentual" && ` (${simulacaoDoCupom.valor}%)`}
                  </dt>
                  <div className="flex items-center gap-2">
                    <dd className="font-medium text-success-fg">-{formatarReais(simulacaoDoCupom.descontoCents, tagDoIdioma)}</dd>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="cupom-remover"
                      aria-label={`${t("Remover")}: ${t("Cupom")} ${simulacaoDoCupom.codigo}`}
                      onClick={removerCupom}
                    >
                      {t("Remover")}
                    </Button>
                  </div>
                </div>
              </>
            )}
            <div className="flex items-center justify-between gap-3 p-3 font-medium" data-testid="resumo-total">
              <dt>{simulacaoDoCupom ? t("Total da primeira cobrança") : t("Total a pagar")}</dt>
              <dd>
                {formatarReais(
                  simulacaoDoCupom
                    ? simulacaoDoCupom.totalFinalCents
                    : opcaoEscolhida
                      ? opcaoEscolhida.totalCents
                      : (precoDoCiclo(plano, ciclo) as number),
                  tagDoIdioma,
                )}
                {ciclo === "monthly" && !simulacaoDoCupom && (
                  <span className="font-normal text-muted-foreground"> {t("por mês")}</span>
                )}
              </dd>
            </div>
          </dl>

          {simulacaoDoCupom && (
            <p className="text-sm text-muted-foreground" data-testid="cupom-renovacao">
              {t("O desconto vale só na primeira cobrança. A partir da renovação,")}{" "}
              {formatarReais(simulacaoDoCupom.precoCheioCents, tagDoIdioma)}{" "}
              {ciclo === "monthly" ? t("por mês") : ciclo === "semiannual" ? t("por semestre") : t("por ano")}.
            </p>
          )}

          {reconferindoCupom && (
            <p role="status" className="text-sm text-muted-foreground" data-testid="cupom-conferindo">
              {t("Conferindo o cupom...")}
            </p>
          )}

          {!cupom && (
            <div className="space-y-2" data-testid="cupom-bloco">
              {cupomAberto ? (
                <>
                  <Label htmlFor="cupom-codigo">{t("Código do cupom")}</Label>
                  <div className="flex flex-wrap gap-2">
                    <Input
                      id="cupom-codigo"
                      data-testid="cupom-codigo"
                      className="w-56"
                      value={codigoDoCupom}
                      maxLength={40}
                      autoComplete="off"
                      disabled={aplicandoCupom}
                      onChange={(e) => setCodigoDoCupom(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void aplicarCupom();
                        }
                      }}
                    />
                    <Button variant="outline" data-testid="cupom-aplicar" disabled={aplicandoCupom} onClick={() => void aplicarCupom()}>
                      {aplicandoCupom ? t("Aplicando...") : t("Aplicar")}
                    </Button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  data-testid="cupom-abrir"
                  className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                  onClick={() => setCupomAberto(true)}
                >
                  {t("Tem um cupom?")}
                </button>
              )}
              {avisoDoCupom && (
                <p role="alert" data-testid="cupom-erro" className="text-sm text-destructive">
                  {avisoDoCupom.removido ? `${t("Cupom removido.")} ` : ""}
                  {t(avisoDoCupom.mensagem)}
                </p>
              )}
            </div>
          )}

          {metodo === "CREDIT_CARD" && (
            <p className="text-xs text-muted-foreground">
              {t("Os dados do cartão são informados na fatura do Asaas, nunca neste sistema.")}
            </p>
          )}

          {alertaDeErro}

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" data-testid="voltar" disabled={pendente} onClick={() => irPara(3)}>
              {t("Voltar")}
            </Button>
            <Button data-testid={`assinar-${plano.code}`} disabled={pendente || !aceitouTermos || reconferindoCupom || aplicandoCupom} onClick={() => void assinar()}>
              {pendente ? t("Enviando...") : t("Assinar")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function LinhaDoResumo({
  testid,
  rotulo,
  valor,
  alterar,
  rotuloDoBotao,
}: {
  testid: string;
  rotulo: string;
  valor: ReactNode;
  alterar: () => void;
  rotuloDoBotao: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 p-3" data-testid={testid}>
      <div>
        <dt className="text-xs text-muted-foreground">{rotulo}</dt>
        <dd className="font-medium">{valor}</dd>
      </div>
      <Button variant="ghost" size="sm" aria-label={`${rotuloDoBotao}: ${rotulo}`} onClick={alterar}>
        {rotuloDoBotao}
      </Button>
    </div>
  );
}
