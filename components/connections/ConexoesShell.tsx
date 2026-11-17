"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useConexoes, type CartaoDaConexao } from "@/hooks/channels/useConexoes";
import { useT } from "@/hooks/i18n/useT";
import type { BloqueioDoBotao } from "@/lib/billing/planos/estado-do-bloqueio";
import { funcaoOculta } from "@/lib/hiperbold/funcoes-ocultas";
import { MagnifyingGlass, Plus } from "@/lib/ui/icons";
import { CartaoDeConexao, tituloDaConexao } from "./CartaoDeConexao";
import { CriarConexao, type SubDoCriar, type TipoDoCriar } from "./CriarConexao";
import { GerenciarConexao, type AbaDoGerenciar } from "./GerenciarConexao";
import { lerAviso } from "./RedesSociaisClient";

/**
 * Conexões — TODOS os canais numa grade só de cartões (decisão do dono do produto, 17/11/2026).
 *
 * ─── Por que cartões e não abas ─────────────────────────────────────────────
 * Com várias contas oficiais por organização, "a aba da oficial" deixou de ter uma conexão só.
 * A pergunta que a tela responde continua sendo "por onde meu negócio fala com o cliente", e a
 * resposta é a lista das conexões, cada uma com o seu status, não um mapa do nosso código.
 * Conectar uma nova é "Criar" (o tipo se escolhe lá dentro); cuidar de uma é o "Gerenciar" dela,
 * sempre pelo id da conexão.
 *
 * ─── Os links antigos continuam abrindo onde deviam ─────────────────────────
 * `?reconectar=<id>` (faixa de conexão caída) abre o Gerenciar daquela conexão já no QR.
 * `?aba=oficial&sub=templates` (rotas antigas de Configurações) abre os Templates da Meta da
 * primeira conta oficial. `?aba=<tipo>` (volta do OAuth das redes sociais, do parceiro, link do
 * admin da Meta) abre o Criar naquele tipo, que lê os avisos da volta como antes.
 */

/** O `?aba=` antigo vira o tipo do Criar. A aba da instância era a entrada: não abre nada. */
const TIPO_DA_ABA_ANTIGA: Record<string, TipoDoCriar> = {
  oficial: "whatsapp_oficial",
  sociais: "instagram",
  parceiro: "parceiro",
  graph: "graph",
  telefonia: "telefonia",
  voz: "voz",
};

/** Os parâmetros que a tela consome: saem da URL quando o diálogo fecha. */
const PARAMETROS_DA_TELA = ["aba", "sub", "reconectar"];

type PedidoDaUrl =
  | { kind: "criar"; tipo: TipoDoCriar; sub: SubDoCriar }
  | { kind: "reconectar"; id: string }
  | { kind: "templates-oficial" }
  | { kind: "oficial" }
  | {
      kind: "social";
      plataforma: "instagram" | "messenger";
      aviso: { tipo: "ok" | "erro" | "parcial"; texto: string };
    };

/** O que a URL pede à tela. `null` = nada (a grade, só). */
function pedidoDaUrl(params: URLSearchParams, t: (s: string) => string): PedidoDaUrl | null {
  const reconectar = params.get("reconectar");
  if (reconectar) return { kind: "reconectar", id: reconectar };
  const aba = params.get("aba");
  const sub: SubDoCriar = params.get("sub") === "templates" ? "templates" : "conexao";
  if (aba === "oficial") return sub === "templates" ? { kind: "templates-oficial" } : { kind: "oficial" };
  const plataforma = params.get("plataforma") === "messenger" ? "messenger" : "instagram";
  if (aba === "sociais") {
    const aviso = lerAviso(params, t);
    if (aviso) return { kind: "social", plataforma, aviso };
    return { kind: "criar", tipo: plataforma, sub: "conexao" };
  }
  const tipo = aba ? TIPO_DA_ABA_ANTIGA[aba] : undefined;
  return tipo ? { kind: "criar", tipo, sub } : null;
}

export function ConexoesShell({
  wahaConfigured: _wahaConfigured,
  wacallsConfigured,
  bloqueio,
  graphParceiro = null,
  podeEditarProtecao,
  pareamentoQr = false,
  redesSociaisLiberadas = false,
}: {
  /** Sem uso na Hiperbold (sem canal por QR do motor antigo); mantido para a página do autor não mudar. */
  wahaConfigured: boolean;
  wacallsConfigured: boolean;
  /** O teto de "conexões" do plano, para todos os canais que criam `channel_sessions`. */
  bloqueio?: BloqueioDoBotao;
  /**
   * O canal parceiro que espelha a Cloud API é OPCIONAL DA INSTALAÇÃO e nasce desligado.
   * `null` = o tipo nem aparece no Criar. O rótulo vem do servidor (a tela não nomeia provider).
   */
  graphParceiro?: { label: string } | null;
  /** Proteção de envio no Gerenciar da conexão por QR: `true` edita, `false` só lê, `undefined` não oferece. */
  podeEditarProtecao?: boolean;
  /** A instalação tem o servidor de WhatsApp: o Criar por QR oferece ler o QR Code. */
  pareamentoQr?: boolean;
  /**
   * Instagram e Messenger aparecem no Criar mesmo com a função oculta (calculado no servidor):
   * para o administrador da plataforma e para as organizações com acesso antecipado.
   */
  redesSociaisLiberadas?: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const conexoes = useConexoes();

  // Hiperbold (16/10/2026): opções de conexão ocultas (hiperbold/FUNCOES.md).
  const mostrar = {
    parceiro: !funcaoOculta("conexao-provedor-parceiro"),
    telefonia: !funcaoOculta("conexao-telefone"),
    sociais: !funcaoOculta("conexao-redes-sociais") || redesSociaisLiberadas,
    voz: !funcaoOculta("voz-whatsapp"),
  };

  const [busca, setBusca] = useState("");
  const [criar, setCriar] = useState<{ tipo: TipoDoCriar | null; sub: SubDoCriar; chave: number } | null>(null);
  const [gerenciar, setGerenciar] = useState<{
    id: string;
    aba: AbaDoGerenciar;
    reconectar: boolean;
    avancado: boolean;
  } | null>(null);
  /** O pedido da URL que depende da lista (qual conta, se a conexão existe) espera ela chegar. */
  const [pedido, setPedido] = useState<PedidoDaUrl | null>(null);
  const [destaque, setDestaque] = useState<string | null>(null);
  /** Aviso a mostrar UMA vez (toast): a chave muda a cada aviso novo. */
  const [aviso, setAviso] = useState<{ chave: number; tipo: "ok" | "erro" | "parcial"; texto: string } | null>(null);
  const avisoMostrado = useRef<number | null>(null);
  const [contador, setContador] = useState(0);

  // A URL é lida A CADA MUDANÇA, não só no primeiro render: a faixa de conexão caída leva a
  // `?reconectar=<id>` estando já na tela, e voltar/avançar no navegador troca os parâmetros.
  // Ajuste de estado durante o render (e não num efeito), uma vez por URL nova.
  const qs = params.toString();
  const [urlVista, setUrlVista] = useState<string | null>(null);
  if (urlVista !== qs) {
    setUrlVista(qs);
    const lido = pedidoDaUrl(new URLSearchParams(qs), t);
    const n = contador + 1;
    setContador(n);
    if (lido?.kind === "criar") {
      setGerenciar(null);
      setCriar({ tipo: lido.tipo, sub: lido.sub, chave: n });
    } else if (lido?.kind === "social") {
      // Volta do OAuth: o Criar não abre; o desfecho vira aviso e o cartão novo ganha destaque.
      setCriar(null);
      setAviso({ chave: n, tipo: lido.aviso.tipo, texto: lido.aviso.texto });
      if (lido.aviso.tipo !== "erro") setPedido(lido);
    } else if (lido) {
      setPedido(lido);
    }
  }

  const lista = useMemo(() => conexoes.data ?? [], [conexoes.data]);

  // O pedido que precisava da lista se resolve quando ela chega (também no render, uma vez).
  if (pedido && conexoes.data) {
    const dados = conexoes.data;
    const primeiraOficial = dados.find((c) => c.tipo === "whatsapp_oficial" && c.via === "meta");
    setPedido(null);
    if (pedido.kind === "reconectar") {
      if (dados.some((c) => c.id === pedido.id)) {
        setCriar(null);
        setGerenciar({ id: pedido.id, aba: "conexao", reconectar: true, avancado: false });
      } else {
        setAviso({ chave: contador + 1, tipo: "erro", texto: t("Conexão não encontrada.") });
        setContador(contador + 1);
      }
    } else if (pedido.kind === "templates-oficial" || pedido.kind === "oficial") {
      if (primeiraOficial) {
        setCriar(null);
        setGerenciar({
          id: primeiraOficial.id,
          aba: pedido.kind === "templates-oficial" ? "templates" : "conexao",
          reconectar: false,
          // O link do admin da Meta (`?aba=oficial`) leva ao webhook e aos IDs: o Avançado já abre.
          avancado: pedido.kind === "oficial",
        });
      } else {
        setCriar({ tipo: "whatsapp_oficial", sub: "conexao", chave: contador + 1 });
        setContador(contador + 1);
      }
    } else if (pedido.kind === "social") {
      const daPlataforma = dados
        .filter((c) => c.tipo === pedido.plataforma)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      setDestaque(daPlataforma[0]?.id ?? null);
    }
  }

  // O toast sai num efeito (efeito externo), uma vez por aviso.
  useEffect(() => {
    if (!aviso || avisoMostrado.current === aviso.chave) return;
    avisoMostrado.current = aviso.chave;
    if (aviso.tipo === "ok") toast.success(aviso.texto);
    else if (aviso.tipo === "parcial") toast.warning(aviso.texto);
    else toast.error(aviso.texto);
  }, [aviso]);

  // O resultado da volta do OAuth sai da URL: um F5 não repete o aviso. `replaceState` e não
  // `router.replace`: limpar a query não é navegar (o mesmo que a lista de redes sociais fazia).
  useEffect(() => {
    const atual = new URLSearchParams(window.location.search);
    if (!atual.has("meta_social")) return;
    for (const k of ["aba", "meta_social", "motivo", "n", "recusadas", "plataforma"]) atual.delete(k);
    const resto = atual.toString();
    window.history.replaceState(null, "", resto ? `/app/connections?${resto}` : "/app/connections");
  }, [qs]);

  const filtradas = useMemo(() => {
    const termo = busca.trim().toLocaleLowerCase();
    if (!termo) return lista;
    return lista.filter((c) =>
      [c.nome, c.numero_ou_handle, t(tituloDaConexao(c))]
        .filter((v): v is string => Boolean(v))
        .some((v) => v.toLocaleLowerCase().includes(termo)),
    );
  }, [busca, lista, t]);

  const conexaoGerenciada: CartaoDaConexao | null =
    gerenciar ? (lista.find((c) => c.id === gerenciar.id) ?? null) : null;

  const limparUrl = () => {
    const q = new URLSearchParams(params.toString());
    let mudou = false;
    for (const k of PARAMETROS_DA_TELA) {
      if (q.has(k)) {
        q.delete(k);
        mudou = true;
      }
    }
    if (!mudou) return;
    const qs = q.toString();
    // `scroll: false`: fechar um diálogo não é navegar para outra página.
    router.replace(qs ? `/app/connections?${qs}` : "/app/connections", { scroll: false });
  };

  const atualizarGrade = () => qc.invalidateQueries({ queryKey: ["conexoes"] });

  const abrirCriar = () => {
    setContador(contador + 1);
    setCriar({ tipo: null, sub: "conexao", chave: contador + 1 });
  };

  const total = filtradas.length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <MagnifyingGlass
            size={16}
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder={t("Pesquisar...")}
            aria-label={t("Pesquisar conexões")}
            className="pl-9"
            data-testid="busca-conexoes"
          />
        </div>
        <div className="flex items-center justify-between gap-4 sm:justify-end">
          <span className="text-sm text-muted-foreground" role="status" data-testid="contador-conexoes">
            {total} {total === 1 ? t("resultado") : t("resultados")}
          </span>
          <Button onClick={() => abrirCriar()} data-testid="btn-criar-conexao">
            <Plus size={16} aria-hidden />
            {t("Criar")}
          </Button>
        </div>
      </div>

      {conexoes.isPending ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t("Carregando…")}
        </p>
      ) : conexoes.isError ? (
        <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">
          {t("Não foi possível carregar as conexões.")}{" "}
          <Button variant="link" className="h-auto p-0" onClick={() => void conexoes.refetch()}>
            {t("Tentar de novo")}
          </Button>
        </p>
      ) : lista.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 rounded-xl border-dashed p-10 text-center shadow-none" data-testid="conexoes-vazio">
          <h2 className="text-base font-semibold">{t("Nenhuma conexão ainda")}</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            {t("Conecte o WhatsApp, o Instagram ou o Messenger do seu negócio para atender os clientes pelo Chat.")}
          </p>
          <Button onClick={() => abrirCriar()}>
            <Plus size={16} aria-hidden />
            {t("Criar")}
          </Button>
        </Card>
      ) : filtradas.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="conexoes-sem-resultado">
          {t("Nenhuma conexão encontrada para esta pesquisa.")}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="grade-de-conexoes">
          {filtradas.map((c) => (
            <CartaoDeConexao
              key={c.id}
              conexao={c}
              destacado={c.id === destaque}
              aoGerenciar={() => {
                setDestaque(null);
                setGerenciar({ id: c.id, aba: "conexao", reconectar: false, avancado: false });
              }}
            />
          ))}
        </div>
      )}

      {criar ? (
        <CriarConexao
          key={criar.chave}
          aberto
          aoFechar={() => {
            setCriar(null);
            limparUrl();
            void atualizarGrade();
          }}
          tipoInicial={criar.tipo}
          subInicial={criar.sub}
          mostrar={mostrar}
          bloqueio={bloqueio}
          graphParceiro={graphParceiro}
          wacallsConfigured={wacallsConfigured}
          pareamentoQr={pareamentoQr}
          temConexaoOficial={lista.some((c) => c.tipo === "whatsapp_oficial" && c.via === "meta")}
          aoMudar={() => void atualizarGrade()}
        />
      ) : null}

      {/* A `key` remonta o Gerenciar a cada conexão: a aba e o reconectar nascem do pedido. */}
      <GerenciarConexao
        key={gerenciar ? `${gerenciar.id}:${gerenciar.aba}` : "fechado"}
        conexao={conexaoGerenciada}
        abaInicial={gerenciar?.aba ?? "conexao"}
        reconectarAoAbrir={Boolean(gerenciar?.reconectar)}
        avancadoAberto={Boolean(gerenciar?.avancado)}
        aoConsumirReconectar={() => {
          // O QR abriu sozinho uma vez: o pedido é consumido (reabrir o Gerenciar não pede outro QR).
          setGerenciar((g) => (g ? { ...g, reconectar: false } : g));
          limparUrl();
        }}
        podeEditarProtecao={podeEditarProtecao}
        aoFechar={() => {
          setGerenciar(null);
          limparUrl();
          void atualizarGrade();
        }}
        aoMudar={atualizarGrade}
        // A faixa vermelha do topo vem do layout de /app (servidor): só um refresh a recalcula.
        aoReconectar={() => router.refresh()}
      />
    </div>
  );
}
