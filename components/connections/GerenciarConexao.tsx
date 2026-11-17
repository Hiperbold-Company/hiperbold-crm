"use client";
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth, usePermission } from "@/hooks/auth/AuthProvider";
import type { CartaoDaConexao } from "@/hooks/channels/useConexoes";
import { useOfficialChannel } from "@/hooks/channels/useOfficialChannel";
import { usePacingKnobs } from "@/hooks/channels/usePacingKnobs";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { rotuloDoCanalDaConversa } from "@/lib/channels/estado";
import { fonteDeTemplates, rotaDeTemplates } from "@/lib/channels/templates-fonte";
import { ShieldCheck } from "@/lib/ui/icons";
import { AntiBanSheet } from "./AntiBanSheet";
import { ICONE_DO_TIPO, StatusDaConexaoBadge, tituloDaConexao } from "./CartaoDeConexao";
import { ChannelAiAccess } from "./ChannelAiAccess";
import { EtiquetaDaConexao } from "./EtiquetaDaConexao";
import { NumeroOficialCard } from "./NumeroOficialCard";
import { FormularioOficialManual, ParaIntegrarOficial, WebhookDoNumeroOficial } from "./OficialAvancado";
import { ReconectarConexao } from "./ReconectarConexao";
import { precisaReconectar, urlDeConectar, type EstadoMetaSocial } from "./RedesSociaisClient";
import { RemoverConexao } from "./RemoverConexao";
import { RenomearConexao } from "./RenomearConexao";
import { TemplatesClient } from "./TemplatesClient";
import { TemplatesParceiroClient } from "./TemplatesParceiroClient";

/**
 * "Gerenciar" de UMA conexão da tela em cartões (decisão do dono do produto, 17/11/2026).
 *
 * Reaproveita as peças que já existiam nas abas (renomear, acesso da IA, proteção de envio,
 * reconectar, número na Meta, modelos), sempre pelo `channel_session_id` da conexão: com várias
 * contas oficiais na mesma organização, nenhuma chamada pode cair na "oficial mais antiga".
 *
 * ⚠️ O bloco "Avançado" (webhook, URL de callback, endpoint, IDs, credencial à mão) só existe para
 * o administrador da plataforma (`is_platform_admin && !support`, a mesma régua da barra lateral):
 * cliente comum nunca lê esses termos. Esconder aqui é apresentação; quem barra é cada rota.
 */

export type AbaDoGerenciar = "conexao" | "templates";

/** O que esta tela precisa da lista de `/api/v1/channels/instancia` (a cor, o webhook, o status vivo). */
interface ConexaoPorInstancia {
  id: string;
  display_name: string | null;
  label_color?: string | null;
  phone_number: string | null;
  status: string | null;
  webhook_registrado: boolean;
}

function useAdminDaPlataforma(): boolean {
  const { user } = useAuth();
  return Boolean(user.is_platform_admin && !user.support);
}

function ErroAoCarregar({ aoTentar }: { aoTentar: () => void }) {
  const t = useT();
  return (
    <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive" data-testid="gerenciar-erro">
      {t("Não foi possível carregar esta conexão. Tente de novo.")}{" "}
      <Button variant="link" className="h-auto p-0" onClick={aoTentar}>
        {t("Tentar de novo")}
      </Button>
    </p>
  );
}

/** Fechado por padrão: o que está aqui é para quem instala, não para quem atende. */
function Avancado({ children, abertoAoMontar = false }: { children: ReactNode; abertoAoMontar?: boolean }) {
  const t = useT();
  const [aberto, setAberto] = useState(abertoAoMontar);
  return (
    <details
      className="rounded-lg border p-3"
      data-testid="gerenciar-avancado"
      open={aberto}
      onToggle={(e) => setAberto(e.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium">{t("Avançado")}</summary>
      <div className="mt-3 flex flex-col gap-4">{children}</div>
    </details>
  );
}

/** Nome (e etiqueta), renomear, remover e o acesso da IA: o que toda conexão tem. */
function BlocoComum({
  conexao,
  nome,
  cor,
  comCor,
  rotaDeRemover,
  podeRemover,
  aoMudar,
  aoRemovida,
  acoes,
}: {
  conexao: CartaoDaConexao;
  nome: string | null;
  cor?: string | null;
  /** A cor da etiqueta só é oferecida quando a tela sabe a cor atual. */
  comCor: boolean;
  rotaDeRemover: string;
  podeRemover: boolean;
  aoMudar: () => void | Promise<unknown>;
  aoRemovida: () => void | Promise<unknown>;
  acoes?: ReactNode;
}) {
  const t = useT();
  // A mesma etiqueta que a lista do Chat mostra para esta conexão.
  const etiqueta = rotuloDoCanalDaConversa({ display_name: nome, phone_number: conexao.numero_ou_handle }, t);
  return (
    <>
      <Card className="flex flex-col gap-3 p-4" data-testid="gerenciar-bloco-comum">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{t("Nome da conexão")}</span>
          <span className="font-medium">{nome ?? t("Conexão sem nome")}</span>
          {conexao.numero_ou_handle ? (
            <span className="text-sm text-muted-foreground">{conexao.numero_ou_handle}</span>
          ) : null}
          {etiqueta ? (
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              {t("No Chat:")}
              <EtiquetaDaConexao texto={etiqueta} cor={cor ?? null} />
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {acoes}
          <RenomearConexao
            channelId={conexao.id}
            currentName={nome}
            comCor={comCor}
            currentColor={cor ?? null}
            onSaved={aoMudar}
          />
          {podeRemover ? <RemoverConexao rota={rotaDeRemover} aoRemover={aoRemovida} /> : null}
        </div>
      </Card>
      <ChannelAiAccess channelId={conexao.id} />
    </>
  );
}

function GerenciarOficialMeta({
  conexao,
  abaInicial,
  avancadoAberto,
  aoMudar,
  aoRemovida,
}: {
  conexao: CartaoDaConexao;
  abaInicial: AbaDoGerenciar;
  avancadoAberto: boolean;
  aoMudar: () => void | Promise<unknown>;
  aoRemovida: () => void | Promise<unknown>;
}) {
  const t = useT();
  const adminDaPlataforma = useAdminDaPlataforma();
  // `DELETE /api/v1/channel-sessions/[id]` exige admin: o botão some para quem a rota recusaria.
  const podeRemover = usePermission("settings.write");
  const qc = useQueryClient();
  const [aba, setAba] = useState<AbaDoGerenciar>(abaInicial);
  const { data, isPending, isError, refetch } = useOfficialChannel(conexao.id);
  const estado = data?.data;
  // O nome e a etiqueta moram no estado da oficial e na lista do Chat: os dois se refazem.
  const atualizar = async () => {
    await aoMudar();
    void qc.invalidateQueries({ queryKey: ["official-channel"] });
    void qc.invalidateQueries({ queryKey: ["conversations"] });
  };

  return (
    <Tabs value={aba} onValueChange={(v) => setAba(v as AbaDoGerenciar)} className="flex flex-col gap-4">
      <TabsList className="self-start">
        <TabsTrigger value="conexao">{t("Conexão")}</TabsTrigger>
        {/* "Templates da Meta", não "Templates": a barra lateral já tem "Templates" (respostas rápidas). */}
        <TabsTrigger value="templates">{t("Templates da Meta")}</TabsTrigger>
      </TabsList>
      <TabsContent value="conexao" className="mt-0 flex flex-col gap-4">
        {isPending ? (
          <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
        ) : isError ? (
          <ErroAoCarregar aoTentar={() => void refetch()} />
        ) : (
          <>
            <BlocoComum
              conexao={conexao}
              nome={estado?.displayName ?? conexao.nome}
              cor={estado?.labelColor ?? null}
              comCor={Boolean(estado)}
              rotaDeRemover={`/api/v1/channel-sessions/${encodeURIComponent(conexao.id)}`}
              podeRemover={podeRemover}
              aoMudar={atualizar}
              aoRemovida={async () => {
                void qc.invalidateQueries({ queryKey: ["official-channel"] });
                void qc.invalidateQueries({ queryKey: ["conversations"] });
                await aoRemovida();
              }}
            />
            {estado?.connected ? <NumeroOficialCard channelSessionId={conexao.id} /> : null}
            {adminDaPlataforma && estado ? (
              <Avancado abertoAoMontar={avancadoAberto}>
                <WebhookDoNumeroOficial estado={estado} channelSessionId={conexao.id} />
                <ParaIntegrarOficial estado={estado} />
                <FormularioOficialManual jaConectado hasToken={estado.hasToken} channelSessionId={conexao.id} />
              </Avancado>
            ) : null}
          </>
        )}
      </TabsContent>
      <TabsContent value="templates" className="mt-0">
        <TemplatesClient channelSessionId={conexao.id} />
      </TabsContent>
    </Tabs>
  );
}

function GerenciarPorQr({
  conexao,
  reconectarAoAbrir,
  aoConsumirReconectar,
  podeEditarProtecao,
  aoMudar,
  aoReconectar,
  aoRemovida,
}: {
  conexao: CartaoDaConexao;
  reconectarAoAbrir: boolean;
  aoConsumirReconectar?: () => void;
  podeEditarProtecao?: boolean;
  aoMudar: () => void | Promise<unknown>;
  aoReconectar?: () => void;
  aoRemovida: () => void | Promise<unknown>;
}) {
  const t = useT();
  const qc = useQueryClient();
  const podeRemoverSessao = usePermission("settings.write");
  const adminDaPlataforma = useAdminDaPlataforma();
  const [protecaoAberta, setProtecaoAberta] = useState(false);
  const oferecerProtecao = podeEditarProtecao !== undefined;
  const lista = useQuery({
    queryKey: ["canal-instancia"],
    queryFn: async () =>
      (await apiClient.get<{ data: { conexoes: ConexaoPorInstancia[] } }>("/api/v1/channels/instancia")).data,
  });
  const pacingItems = usePacingKnobs(oferecerProtecao).data?.items ?? [];

  if (lista.isPending) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  if (lista.isError) return <ErroAoCarregar aoTentar={() => void lista.refetch()} />;
  // A instância é a conexão por QR que o CRM sabe reconectar e apagar no servidor; fora da lista
  // (outro motor por QR), ficam o nome, o acesso da IA e o remover pela rota geral.
  const c = lista.data?.conexoes.find((x) => x.id === conexao.id) ?? null;

  const mudou = async () => {
    await aoMudar();
    void qc.invalidateQueries({ queryKey: ["canal-instancia"] });
    void qc.invalidateQueries({ queryKey: ["conversations"] });
  };

  return (
    <div className="flex flex-col gap-4">
      {/* "Endereço público do CRM" e "token" são termos de quem instala: só o administrador da plataforma lê. */}
      {c && !c.webhook_registrado && adminDaPlataforma ? (
        <p className="rounded-md border border-warning/40 bg-warning-bg p-3 text-sm text-warning-fg">
          {t("A entrada de mensagens não está ligada. Reconecte com o mesmo token depois de configurar o endereço público do CRM.")}
        </p>
      ) : null}

      {c && c.status !== "WORKING" ? (
        <Card className="p-4" data-testid="gerenciar-reconectar">
          <ReconectarConexao
            conexaoId={c.id}
            abrirAoMontar={reconectarAoAbrir}
            aoConectar={() => {
              void mudou();
              void qc.invalidateQueries({ queryKey: ["pacing-knobs"] });
              aoReconectar?.();
            }}
            aoAbrirSozinho={reconectarAoAbrir ? aoConsumirReconectar : undefined}
          />
        </Card>
      ) : null}

      <BlocoComum
        conexao={conexao}
        nome={c ? c.display_name : conexao.nome}
        cor={c?.label_color ?? null}
        comCor={Boolean(c)}
        rotaDeRemover={
          c
            ? `/api/v1/channels/instancia?id=${encodeURIComponent(c.id)}`
            : `/api/v1/channel-sessions/${encodeURIComponent(conexao.id)}`
        }
        // A rota da instância aceita gerente; a geral, só admin.
        podeRemover={c ? true : podeRemoverSessao}
        aoMudar={mudou}
        aoRemovida={async () => {
          void qc.invalidateQueries({ queryKey: ["canal-instancia"] });
          void qc.invalidateQueries({ queryKey: ["pacing-knobs"] });
          await aoRemovida();
        }}
        acoes={
          oferecerProtecao ? (
            <Button variant="outline" size="sm" onClick={() => setProtecaoAberta(true)}>
              <ShieldCheck size={14} aria-hidden />
              {t("Proteção de envio")}
            </Button>
          ) : null
        }
      />

      {oferecerProtecao && protecaoAberta ? (
        <AntiBanSheet
          item={pacingItems.find((i) => i.channel_session.id === conexao.id) ?? null}
          canWrite={Boolean(podeEditarProtecao)}
          onClose={() => setProtecaoAberta(false)}
        />
      ) : null}
    </div>
  );
}

function GerenciarRedeSocial({
  conexao,
  aoMudar,
  aoRemovida,
}: {
  conexao: CartaoDaConexao;
  aoMudar: () => void | Promise<unknown>;
  aoRemovida: () => void | Promise<unknown>;
}) {
  const t = useT();
  const qc = useQueryClient();
  // A mesma chave e a mesma rota da lista de redes sociais: as duas telas leem um cache só.
  const lista = useQuery({
    queryKey: ["meta-social"],
    queryFn: async () => (await apiClient.get<{ data: EstadoMetaSocial }>("/api/v1/channels/meta-social")).data,
  });
  if (lista.isPending) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;
  const conta = lista.data?.contas.find((c) => c.id === conexao.id) ?? null;
  const plataforma = conexao.tipo === "messenger" ? "messenger" : "instagram";
  const configurado = Boolean(lista.data?.configurado?.[plataforma]);
  const atencao = conta ? precisaReconectar(conta) : conexao.status !== "conectado";

  const mudou = async () => {
    await aoMudar();
    void qc.invalidateQueries({ queryKey: ["meta-social"] });
    void qc.invalidateQueries({ queryKey: ["conversations"] });
  };

  return (
    <div className="flex flex-col gap-4">
      {atencao ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4" data-testid="gerenciar-reconectar">
          <p className="text-sm">{t("Reconecte para continuar recebendo mensagens.")}</p>
          {configurado ? (
            <Button asChild size="sm">
              <a href={urlDeConectar(plataforma)}>{t("Reconectar")}</a>
            </Button>
          ) : null}
        </Card>
      ) : null}
      <BlocoComum
        conexao={conexao}
        nome={conta?.apelido ?? conexao.nome}
        cor={conta?.cor ?? null}
        comCor={Boolean(conta)}
        rotaDeRemover={`/api/v1/channels/meta-social/${encodeURIComponent(conexao.id)}`}
        podeRemover
        aoMudar={mudou}
        aoRemovida={async () => {
          void qc.invalidateQueries({ queryKey: ["meta-social"] });
          await aoRemovida();
        }}
      />
    </div>
  );
}

/** Oficial por parceiro e os demais canais: o comum, mais os modelos quando o canal os tem. */
function GerenciarOutros({
  conexao,
  abaInicial,
  aoMudar,
  aoRemovida,
}: {
  conexao: CartaoDaConexao;
  abaInicial: AbaDoGerenciar;
  aoMudar: () => void | Promise<unknown>;
  aoRemovida: () => void | Promise<unknown>;
}) {
  const t = useT();
  const podeRemover = usePermission("settings.write");
  const [aba, setAba] = useState<AbaDoGerenciar>(abaInicial);
  const fonte = fonteDeTemplates(conexao.provider);
  const comum = (
    <BlocoComum
      conexao={conexao}
      nome={conexao.nome}
      comCor={false}
      rotaDeRemover={`/api/v1/channel-sessions/${encodeURIComponent(conexao.id)}`}
      podeRemover={podeRemover}
      aoMudar={aoMudar}
      aoRemovida={aoRemovida}
    />
  );
  if (!fonte || fonte === "oficial") return <div className="flex flex-col gap-4">{comum}</div>;
  return (
    <Tabs value={aba} onValueChange={(v) => setAba(v as AbaDoGerenciar)} className="flex flex-col gap-4">
      <TabsList className="self-start">
        <TabsTrigger value="conexao">{t("Conexão")}</TabsTrigger>
        <TabsTrigger value="templates">{t("Modelos do parceiro")}</TabsTrigger>
      </TabsList>
      <TabsContent value="conexao" className="mt-0 flex flex-col gap-4">
        {comum}
      </TabsContent>
      <TabsContent value="templates" className="mt-0">
        <TemplatesParceiroClient rota={rotaDeTemplates(fonte)} />
      </TabsContent>
    </Tabs>
  );
}

export function GerenciarConexao({
  conexao,
  aoFechar,
  abaInicial = "conexao",
  avancadoAberto = false,
  reconectarAoAbrir = false,
  aoConsumirReconectar,
  podeEditarProtecao,
  aoMudar,
  aoReconectar,
}: {
  /** `null` = fechado. */
  conexao: CartaoDaConexao | null;
  aoFechar: () => void;
  abaInicial?: AbaDoGerenciar;
  /** Veio do link do admin da Meta (`?aba=oficial`): o bloco Avançado já abre (se a pessoa o vê). */
  avancadoAberto?: boolean;
  /** Veio da faixa de conexão caída (`?reconectar=<id>`): o QR já abre sozinho. */
  reconectarAoAbrir?: boolean;
  aoConsumirReconectar?: () => void;
  podeEditarProtecao?: boolean;
  /** Algo mudou na conexão: quem monta refaz a grade. */
  aoMudar: () => void | Promise<unknown>;
  /** Depois de reconectar: a faixa do topo vem do servidor, e só um refresh a recalcula. */
  aoReconectar?: () => void;
}) {
  const t = useT();
  const Icone = conexao ? ICONE_DO_TIPO[conexao.tipo] : null;
  const removida = async () => {
    await aoMudar();
    aoFechar();
  };

  return (
    <Dialog open={conexao !== null} onOpenChange={(aberto) => !aberto && aoFechar()}>
      <DialogContent className="max-w-3xl gap-0 p-0" data-testid="gerenciar-conexao">
        {conexao && Icone ? (
          <>
            <DialogHeader className="border-b px-6 py-5 pr-12">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Icone size={22} aria-hidden />
                </span>
                <div className="min-w-0 text-left">
                  <DialogTitle className="truncate">
                    {conexao.nome ?? conexao.numero_ou_handle ?? t("Conexão sem nome")}
                  </DialogTitle>
                  <DialogDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>{t(tituloDaConexao(conexao))}</span>
                    <StatusDaConexaoBadge status={conexao.status} />
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className="min-w-0 px-6 py-5">
              {conexao.tipo === "whatsapp_oficial" && conexao.via === "meta" ? (
                <GerenciarOficialMeta
                  conexao={conexao}
                  abaInicial={abaInicial}
                  avancadoAberto={avancadoAberto}
                  aoMudar={aoMudar}
                  aoRemovida={removida}
                />
              ) : conexao.tipo === "whatsapp_qr" ? (
                <GerenciarPorQr
                  conexao={conexao}
                  reconectarAoAbrir={reconectarAoAbrir}
                  aoConsumirReconectar={aoConsumirReconectar}
                  podeEditarProtecao={podeEditarProtecao}
                  aoMudar={aoMudar}
                  aoReconectar={aoReconectar}
                  aoRemovida={removida}
                />
              ) : conexao.tipo === "instagram" || conexao.tipo === "messenger" ? (
                <GerenciarRedeSocial conexao={conexao} aoMudar={aoMudar} aoRemovida={removida} />
              ) : (
                <GerenciarOutros
                  conexao={conexao}
                  abaInicial={abaInicial}
                  aoMudar={aoMudar}
                  aoRemovida={removida}
                />
              )}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
