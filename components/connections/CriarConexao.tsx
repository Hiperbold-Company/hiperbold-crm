"use client";
import { useState, type ComponentType } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import type { BloqueioDoBotao } from "@/lib/billing/planos/estado-do-bloqueio";
import { ROTULO_DO_QR_POR_SESSAO } from "@/lib/channels/rotulo-do-qr-por-sessao";
import { rotaDeTemplates } from "@/lib/channels/templates-fonte";
import { InstagramLogo, MessengerLogo, Microphone, Phone, Plugs, QrCode, WhatsappLogo } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { CanalGraphParceiroClient } from "./CanalGraphParceiroClient";
import { CanalInstanciaClient } from "./CanalInstanciaClient";
import { CanalParceiroClient } from "./CanalParceiroClient";
import { CanalPorSessaoClient } from "./CanalPorSessaoClient";
import { CanalVozClient } from "./CanalVozClient";
import { ConectarComAMeta } from "./ConectarComAMeta";
import { FormularioOficialManual } from "./OficialAvancado";
import { RedesSociaisClient } from "./RedesSociaisClient";
import { TelefoniaClient } from "./TelefoniaClient";
import { TemplatesParceiroClient } from "./TemplatesParceiroClient";

/**
 * "Criar" da tela de Conexões em cartões (decisão do dono do produto, 17/11/2026): a lista de
 * tipos à esquerda (em cima no celular) e, à direita, o caminho de conectar daquele tipo.
 *
 * Nenhum recurso das abas antigas some: provedor parceiro, telefone e chamada de voz continuam
 * aqui como tipos, com os mesmos componentes de antes (e os modelos do parceiro ao lado).
 *
 * O teto do plano (`bloqueio`) é repassado a cada componente, que decide sozinho se o botão que
 * ele mostra cria uma conexão NOVA.
 */

export type TipoDoCriar =
  | "whatsapp_oficial"
  | "whatsapp_qr"
  | "whatsapp_qr_sessao"
  | "instagram"
  | "messenger"
  | "parceiro"
  | "graph"
  | "telefonia"
  | "voz";

export type SubDoCriar = "conexao" | "templates";

type Icone = ComponentType<{ size?: number; "aria-hidden"?: boolean }>;

// Rótulos em tabela de topo: a cerca de i18n resolve t(TABELA[chave]) e cobra o espanhol de cada valor.
// `graph` e `whatsapp_qr_sessao` ficam fora: o rótulo deles nomeia o serviço e vem de `lib/channels/`.
const ROTULO_DO_TIPO: Record<Exclude<TipoDoCriar, "graph" | "whatsapp_qr_sessao">, string> = {
  whatsapp_oficial: "WhatsApp oficial",
  whatsapp_qr: "WhatsApp por QR Code",
  instagram: "Instagram",
  messenger: "Messenger",
  parceiro: "Provedor parceiro",
  telefonia: "Telefone",
  voz: "Chamada de voz",
};

const DESCRICAO_DO_TIPO: Record<TipoDoCriar, string> = {
  whatsapp_oficial: "Número pela API oficial da Meta.",
  whatsapp_qr: "Leia o QR Code com o celular do número.",
  whatsapp_qr_sessao: "Leia o QR Code com o celular do número.",
  instagram: "Mensagens do Direct no Chat.",
  messenger: "Mensagens da sua Página do Facebook.",
  parceiro: "WhatsApp oficial por um intermediário.",
  graph: "WhatsApp oficial por um intermediário.",
  telefonia: "Ligações pelo CRM.",
  voz: "Chamadas de voz pelo WhatsApp.",
};

const ICONE: Record<TipoDoCriar, Icone> = {
  whatsapp_oficial: WhatsappLogo,
  whatsapp_qr: QrCode,
  whatsapp_qr_sessao: QrCode,
  instagram: InstagramLogo,
  messenger: MessengerLogo,
  parceiro: Plugs,
  graph: Plugs,
  telefonia: Phone,
  voz: Microphone,
};

export interface TiposVisiveis {
  parceiro: boolean;
  telefonia: boolean;
  sociais: boolean;
  voz: boolean;
  /**
   * A terceira forma de conexão (QR Code pelo serviço de WhatsApp da instalação): só quando a
   * instalação o tem configurado (calculado no servidor). Ausente = não aparece.
   */
  qrPorSessao?: boolean;
}

export function tiposDoCriar(mostrar: TiposVisiveis, graphParceiro: { label: string } | null): TipoDoCriar[] {
  const tipos: TipoDoCriar[] = ["whatsapp_oficial", "whatsapp_qr"];
  if (mostrar.qrPorSessao) tipos.push("whatsapp_qr_sessao");
  if (mostrar.sociais) tipos.push("instagram", "messenger");
  if (mostrar.parceiro) tipos.push("parceiro");
  if (graphParceiro) tipos.push("graph");
  if (mostrar.telefonia) tipos.push("telefonia");
  if (mostrar.voz) tipos.push("voz");
  return tipos;
}

/** Conectar e gerenciar os modelos do parceiro são tarefas diferentes: duas abas, como antes. */
function ComModelos({
  sub,
  setSub,
  rotuloDosModelos,
  conexao,
  modelos,
}: {
  sub: SubDoCriar;
  setSub: (s: SubDoCriar) => void;
  rotuloDosModelos: string;
  conexao: React.ReactNode;
  modelos: React.ReactNode;
}) {
  const t = useT();
  return (
    <Tabs value={sub} onValueChange={(v) => setSub(v as SubDoCriar)} className="flex flex-col gap-4">
      <TabsList className="self-start">
        <TabsTrigger value="conexao">{t("Conexão")}</TabsTrigger>
        <TabsTrigger value="templates">{rotuloDosModelos}</TabsTrigger>
      </TabsList>
      <TabsContent value="conexao" className="mt-0">
        {conexao}
      </TabsContent>
      <TabsContent value="templates" className="mt-0">
        {modelos}
      </TabsContent>
    </Tabs>
  );
}

export function CriarConexao({
  aberto,
  aoFechar,
  tipoInicial,
  subInicial = "conexao",
  mostrar,
  bloqueio,
  graphParceiro = null,
  wacallsConfigured,
  pareamentoQr = false,
  temConexaoOficial = false,
  aoMudar,
}: {
  aberto: boolean;
  aoFechar: () => void;
  /** Tipo aberto ao montar (link antigo `?aba=`); ausente = o primeiro da lista. */
  tipoInicial?: TipoDoCriar | null;
  subInicial?: SubDoCriar;
  mostrar: TiposVisiveis;
  bloqueio?: BloqueioDoBotao;
  graphParceiro?: { label: string } | null;
  wacallsConfigured: boolean;
  pareamentoQr?: boolean;
  /** A organização já tem conexão oficial: no teto do plano, reautenticar o mesmo número segue livre. */
  temConexaoOficial?: boolean;
  /** Uma conexão foi criada: quem monta refaz a grade. */
  aoMudar: () => void;
}) {
  const t = useT();
  const { user } = useAuth();
  // A mesma régua da barra lateral: o formulário de credenciais é para quem instala.
  const adminDaPlataforma = Boolean(user.is_platform_admin && !user.support);
  const tipos = tiposDoCriar(mostrar, graphParceiro);
  const primeiro: TipoDoCriar = tipos[0] ?? "whatsapp_oficial";
  const [escolhido, setEscolhido] = useState<TipoDoCriar>(
    tipoInicial && tipos.includes(tipoInicial) ? tipoInicial : primeiro,
  );
  const [sub, setSub] = useState<SubDoCriar>(subInicial);
  const tipo = tipos.includes(escolhido) ? escolhido : primeiro;

  const rotulo = (k: TipoDoCriar): string =>
    k === "graph"
      ? (graphParceiro?.label ?? t("Provedor parceiro"))
      : k === "whatsapp_qr_sessao"
        ? t(ROTULO_DO_QR_POR_SESSAO)
        : t(ROTULO_DO_TIPO[k]);

  function conteudo() {
    switch (tipo) {
      case "whatsapp_oficial":
        return (
          <div className="flex flex-col gap-4">
            <ConectarComAMeta bloqueio={bloqueio} temConexaoOficial={temConexaoOficial} />
            {adminDaPlataforma ? (
              <details className="rounded-lg border p-3" data-testid="criar-oficial-credenciais">
                <summary className="cursor-pointer text-sm font-medium">
                  {t("Conectar com credenciais (avançado)")}
                </summary>
                <div className="mt-3">
                  <FormularioOficialManual bloqueio={bloqueio} />
                </div>
              </details>
            ) : null}
          </div>
        );
      case "whatsapp_qr":
        return (
          <CanalInstanciaClient
            bloqueio={bloqueio}
            pareamentoQr={pareamentoQr}
            somenteConectar
            aoMudar={aoMudar}
            // Servidor e token da instância são termos de quem instala, não de quem atende.
            servidorProprio={adminDaPlataforma}
          />
        );
      case "whatsapp_qr_sessao":
        return <CanalPorSessaoClient bloqueio={bloqueio} aoMudar={aoMudar} />;
      case "instagram":
        return <RedesSociaisClient bloqueio={bloqueio} plataformas={["instagram"]} semContas />;
      case "messenger":
        return <RedesSociaisClient bloqueio={bloqueio} plataformas={["messenger"]} semContas />;
      case "parceiro":
        // "Modelos do parceiro" e não "Templates": a barra lateral já tem "Templates", que é outra coisa.
        return (
          <ComModelos
            sub={sub}
            setSub={setSub}
            rotuloDosModelos={t("Modelos do parceiro")}
            conexao={<CanalParceiroClient bloqueio={bloqueio} />}
            modelos={
              <TemplatesParceiroClient />
            }
          />
        );
      case "graph":
        // Editar e apagar valem aqui como no outro parceiro (#1734): o mesmo cliente, outra rota.
        return (
          <ComModelos
            sub={sub}
            setSub={setSub}
            rotuloDosModelos={t("Modelos")}
            conexao={<CanalGraphParceiroClient />}
            modelos={<TemplatesParceiroClient rota={rotaDeTemplates("graph")} />}
          />
        );
      case "telefonia":
        return <TelefoniaClient />;
      case "voz":
        return <CanalVozClient wacallsConfigured={wacallsConfigured} />;
    }
  }

  return (
    <Dialog open={aberto} onOpenChange={(v) => !v && aoFechar()}>
      {/* No celular o diálogo deixa 1rem de cada lado (o `w-full` da base encostava na borda), e os
          tipos QUEBRAM LINHA em vez de rolar de lado: numa faixa rolável, "WhatsApp por QR Code"
          ficava fora da tela e quem não sabe que a faixa rola não o achava. */}
      <DialogContent className="w-[calc(100%-2rem)] max-w-5xl gap-0 p-0" data-testid="criar-conexao">
        <DialogHeader className="border-b px-6 py-5 pr-12">
          <DialogTitle>{t("Criar conexão")}</DialogTitle>
          <DialogDescription>{t("Escolha por onde o seu negócio vai falar com o cliente.")}</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 md:grid-cols-[240px_minmax(0,1fr)]">
          <nav
            aria-label={t("Tipos de conexão")}
            className="flex flex-wrap gap-1 border-b p-3 md:flex-col md:flex-nowrap md:border-r md:border-b-0"
          >
            {tipos.map((k) => {
              const Icon = ICONE[k];
              const ativo = k === tipo;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setEscolhido(k);
                    setSub("conexao");
                  }}
                  aria-current={ativo ? "true" : undefined}
                  data-testid={`criar-tipo-${k}`}
                  className={cn(
                    "flex shrink-0 items-start gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
                    ativo ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  <span className="mt-0.5 shrink-0">
                    <Icon size={18} aria-hidden />
                  </span>
                  <span className="flex flex-col">
                    <span className={cn("whitespace-nowrap", ativo && "font-medium")}>{rotulo(k)}</span>
                    <span className="hidden text-xs text-muted-foreground md:block">{t(DESCRICAO_DO_TIPO[k])}</span>
                  </span>
                </button>
              );
            })}
          </nav>
          <div className="min-w-0 p-6" data-testid={`criar-conteudo-${tipo}`}>
            {conteudo()}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
