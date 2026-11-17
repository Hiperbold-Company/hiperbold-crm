"use client";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";

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

  const abaAntiga = params.get("aba");
  const subAntiga: SubDoCriar = params.get("sub") === "templates" ? "templates" : "conexao";
  const reconectarId = params.get("reconectar");
  // Os Templates da Meta eram uma sub-aba da oficial: agora moram no Gerenciar de cada conta.
  const [pedeTemplatesDaOficial, setPedeTemplatesDaOficial] = useState(
    abaAntiga === "oficial" && subAntiga === "templates",
  );

  const [busca, setBusca] = useState("");
  const [criar, setCriar] = useState<{ tipo: TipoDoCriar | null; sub: SubDoCriar } | null>(() => {
    if (abaAntiga === "oficial" && subAntiga === "templates") return null;
    const tipo = abaAntiga ? TIPO_DA_ABA_ANTIGA[abaAntiga] : undefined;
    return tipo ? { tipo, sub: subAntiga } : null;
  });
  const [gerenciar, setGerenciar] = useState<{ id: string; aba: AbaDoGerenciar; reconectar: boolean } | null>(
    () => (reconectarId ? { id: reconectarId, aba: "conexao", reconectar: true } : null),
  );

  const lista = useMemo(() => conexoes.data ?? [], [conexoes.data]);

  // `?aba=oficial&sub=templates`: espera a lista para saber qual conta abrir. Sem oficial, o Criar dela.
  // Ajuste de estado durante o render (e não num efeito): acontece uma vez, quando a lista chega.
  if (pedeTemplatesDaOficial && conexoes.data) {
    const oficial = conexoes.data.find((c) => c.tipo === "whatsapp_oficial" && c.via === "meta");
    setPedeTemplatesDaOficial(false);
    if (oficial) setGerenciar({ id: oficial.id, aba: "templates", reconectar: false });
    else setCriar({ tipo: "whatsapp_oficial", sub: "conexao" });
  }

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
          <Button onClick={() => setCriar({ tipo: null, sub: "conexao" })} data-testid="btn-criar-conexao">
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
          <Button onClick={() => setCriar({ tipo: null, sub: "conexao" })}>
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
              aoGerenciar={() => setGerenciar({ id: c.id, aba: "conexao", reconectar: false })}
            />
          ))}
        </div>
      )}

      {criar ? (
        <CriarConexao
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
          aoMudar={() => void atualizarGrade()}
        />
      ) : null}

      {/* A `key` remonta o Gerenciar a cada conexão: a aba e o reconectar nascem do pedido. */}
      <GerenciarConexao
        key={gerenciar ? `${gerenciar.id}:${gerenciar.aba}` : "fechado"}
        conexao={conexaoGerenciada}
        abaInicial={gerenciar?.aba ?? "conexao"}
        reconectarAoAbrir={Boolean(gerenciar?.reconectar)}
        aoConsumirReconectar={limparUrl}
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
