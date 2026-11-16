"use client";
import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/hooks/i18n/useT";
import { useMinhasConexoes } from "@/hooks/inbox/useMinhasConexoes";
import {
  decidirAbertura,
  type ConexaoResumo,
  type ConversaDoContatoNaConexao,
  type DecisaoDeAbertura,
  type MotivoDaRecusa,
  type OpcoesDeAbertura,
} from "@/lib/inbox/conexao-ao-abrir";

/**
 * "Abrir conversa" pela conexão de QUEM CLICA — o gesto do card do funil e da
 * ficha do negócio (cliente real, 16/11/2026: a vendedora respondeu pelo número
 * da colega porque o card levava direto à conversa que existia).
 *
 * A cada clique a tela pergunta ao servidor (`GET …/open-with-contact/opcoes`)
 * e aplica `decidirAbertura`, a mesma regra que o POST confere. Por que a cada
 * clique e não no carregamento do quadro: a resposta depende das conversas do
 * contato, e buscar isso para todo card do quadro custaria uma consulta por
 * card para um gesto que a maioria não faz.
 *
 * Em nova aba, a aba nasce DENTRO do clique (aberta depois do `await` o
 * navegador a bloquearia). Quando a resposta pede a janela de escolha, essa aba
 * fecha, e a confirmação da janela — outro clique — abre a dela.
 *
 * Falha ao ler as opções: quem sabidamente não tem conexão vinculada (e não
 * está no modo restrito) segue como antes; os demais não navegam e veem o
 * motivo — abrir "como antes" seria abrir pela conexão da colega.
 */
export interface AlvoDaAbertura {
  contactId?: string | null;
  phone?: string | null;
  leadId?: string | null;
  /** A conversa que o card mostra (a mais recente do contato), se houver. */
  conversaId?: string | null;
}

type Escolha =
  | { tipo: "iniciar"; channelSessionId: string }
  | { tipo: "continuar"; conversationId: string };

const TEXTO_DA_RECUSA: Record<MotivoDaRecusa, string> = {
  conexao_alheia: "Nesta empresa, você só inicia conversa pela sua conexão.",
  contato_de_outro: "Este contato é atendido pela conexão de outro atendente.",
  sem_conexao: "Você não tem conexão própria e não há número geral para iniciar esta conversa.",
};

const FALHA_DA_CONFERENCIA = "Não foi possível conferir a conexão. Tente de novo.";

export function useAbrirPelaConexao(alvo: AlvoDaAbertura): {
  abrir: (novaAba: boolean) => Promise<void>;
  abrindo: boolean;
  janela: ReactNode;
} {
  const t = useT();
  const router = useRouter();
  const qc = useQueryClient();
  // O que a pessoa tem, lido uma vez para a tela toda: decide o que fazer
  // quando a leitura da hora do clique falha.
  const minhas = useMinhasConexoes();
  // Trava por REF: o estado só muda no próximo render, e um duplo clique rápido
  // passaria pelos dois `if (abrindo)` antes dele.
  const travado = useRef(false);
  const [abrindo, setAbrindo] = useState(false);
  const [pendente, setPendente] = useState<{
    padrao: ConexaoResumo;
    existentes: ConversaDoContatoNaConexao[];
    novaAba: boolean;
  } | null>(null);
  const [marcada, setMarcada] = useState<string>("");

  const telefone = alvo.phone?.trim() ?? "";

  function travar(): boolean {
    if (travado.current) return false;
    travado.current = true;
    setAbrindo(true);
    return true;
  }
  function destravar() {
    travado.current = false;
    setAbrindo(false);
  }

  function navegar(aba: Window | null, novaAba: boolean, conversationId: string) {
    const destino = `/app/inbox?id=${conversationId}`;
    if (aba) {
      aba.opener = null;
      aba.location.href = destino;
    } else if (novaAba) {
      // Pop-up bloqueado: abre aqui, para o clique não ficar mudo.
      window.location.assign(destino);
    } else {
      router.push(destino);
    }
  }

  function avisarSeDesconectada(conexao: ConexaoResumo) {
    if (!conexao.conectada) {
      toast.info(
        `${t("A conexão")} ${t(conexao.nome)} ${t("não está conectada agora: a mensagem só sai quando ela voltar.")}`,
      );
    }
  }

  async function iniciar(channelSessionId: string | undefined): Promise<string> {
    const res = await fetch("/api/v1/conversations/open-with-contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contact_id: alvo.contactId || undefined,
        phone_number: telefone || undefined,
        ...(channelSessionId ? { channel_session_id: channelSessionId } : {}),
        ...(alvo.leadId ? { lead_id: alvo.leadId } : {}),
      }),
    });
    const json = (await res.json()) as {
      data?: { conversation_id: string };
      error?: { message?: string };
    };
    if (!res.ok || !json.data?.conversation_id) {
      throw new Error(json.error?.message ?? "Não foi possível abrir a conversa.");
    }
    // O quadro é a fonte do card E da ficha: sem invalidar, a linha seguiria
    // mostrando a conversa antiga.
    await qc.invalidateQueries({ queryKey: ["board"] });
    return json.data.conversation_id;
  }

  /** `null` = a leitura falhou. */
  async function lerDecisao(): Promise<DecisaoDeAbertura | null> {
    if (!alvo.contactId && !telefone) return { tipo: "como_hoje" };
    try {
      const qs = new URLSearchParams();
      if (alvo.contactId) qs.set("contact_id", alvo.contactId);
      else qs.set("phone", telefone);
      if (alvo.leadId) qs.set("lead_id", alvo.leadId);
      const res = await fetch(`/api/v1/conversations/open-with-contact/opcoes?${qs.toString()}`);
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: OpcoesDeAbertura };
      return json.data ? decidirAbertura(json.data) : null;
    } catch {
      return null;
    }
  }

  async function abrir(novaAba: boolean) {
    if (!travar()) return;
    // Uma aba só por clique, criada DENTRO do gesto.
    const aba = novaAba ? window.open("", "_blank") : null;
    try {
      let decisao = await lerDecisao();
      if (!decisao) {
        // Sem a conferência, só segue como antes quem SABIDAMENTE não tem
        // conexão vinculada e não está no modo restrito.
        const semVinculo = minhas && minhas.minhas_conexoes_ids.length === 0 && !minhas.restrito;
        if (!semVinculo) {
          aba?.close();
          toast.error(t(FALHA_DA_CONFERENCIA));
          return;
        }
        decisao = { tipo: "como_hoje" };
      }
      switch (decisao.tipo) {
        case "abrir":
          navegar(aba, novaAba, decisao.conversationId);
          return;
        case "iniciar":
          navegar(aba, novaAba, await iniciar(decisao.conexao.id));
          avisarSeDesconectada(decisao.conexao);
          return;
        case "recusar":
          aba?.close();
          toast.error(t(TEXTO_DA_RECUSA[decisao.motivo]));
          return;
        case "escolher":
          aba?.close();
          setMarcada(`iniciar:${decisao.padrao.id}`);
          setPendente({ padrao: decisao.padrao, existentes: decisao.existentes, novaAba });
          return;
        case "como_hoje":
          if (alvo.conversaId) {
            navegar(aba, novaAba, alvo.conversaId);
          } else {
            navegar(aba, novaAba, await iniciar(undefined));
          }
          return;
      }
    } catch (err) {
      aba?.close();
      toast.error(err instanceof Error ? t(err.message) : t("Não foi possível abrir a conversa."));
    } finally {
      destravar();
    }
  }

  async function confirmar() {
    if (!pendente) return;
    const escolha: Escolha | null = marcada.startsWith("iniciar:")
      ? { tipo: "iniciar", channelSessionId: marcada.slice("iniciar:".length) }
      : marcada.startsWith("continuar:")
        ? { tipo: "continuar", conversationId: marcada.slice("continuar:".length) }
        : null;
    if (!escolha || !travar()) return;
    const { novaAba, padrao } = pendente;
    const aba = novaAba ? window.open("", "_blank") : null;
    try {
      const id =
        escolha.tipo === "continuar" ? escolha.conversationId : await iniciar(escolha.channelSessionId);
      setPendente(null);
      navegar(aba, novaAba, id);
      if (escolha.tipo === "iniciar") avisarSeDesconectada(padrao);
    } catch (err) {
      aba?.close();
      toast.error(err instanceof Error ? t(err.message) : t("Não foi possível abrir a conversa."));
    } finally {
      destravar();
    }
  }

  const janela = (
    <JanelaDeConexao
      aberta={pendente !== null}
      padrao={pendente?.padrao ?? null}
      existentes={pendente?.existentes ?? []}
      marcada={marcada}
      onMarcar={setMarcada}
      onConfirmar={() => void confirmar()}
      onFechar={() => setPendente(null)}
      ocupado={abrindo}
    />
  );

  return { abrir, abrindo, janela };
}

/**
 * A janela: "Iniciar pela conexão <minha>" (já marcada) ou "Continuar na conexão
 * <existente>", uma linha por conversa. Sempre o NOME DA CONEXÃO, nunca o nome
 * da pessoa — é ele que o cliente dá em Conexões e reconhece.
 */
export function JanelaDeConexao({
  aberta,
  padrao,
  existentes,
  marcada,
  onMarcar,
  onConfirmar,
  onFechar,
  ocupado,
}: {
  aberta: boolean;
  padrao: ConexaoResumo | null;
  existentes: ConversaDoContatoNaConexao[];
  marcada: string;
  onMarcar: (v: string) => void;
  onConfirmar: () => void;
  onFechar: () => void;
  ocupado: boolean;
}) {
  const t = useT();
  const opcoes: Array<{ valor: string; rotulo: string }> = [
    ...(padrao ? [{ valor: `iniciar:${padrao.id}`, rotulo: `${t("Iniciar pela conexão")} ${t(padrao.nome)}` }] : []),
    ...existentes.map((c) => ({
      valor: `continuar:${c.conversation_id}`,
      rotulo: `${t("Continuar na conexão")} ${t(c.conexao_nome)}`,
    })),
  ];
  return (
    <Dialog open={aberta} onOpenChange={(v) => (!v ? onFechar() : undefined)}>
      <DialogContent
        // O card do funil é arrastável e clicável: o clique dentro da janela não
        // pode chegar a ele.
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        data-testid="janela-de-conexao"
      >
        <DialogHeader>
          <DialogTitle>{t("Por qual conexão abrir a conversa?")}</DialogTitle>
          <DialogDescription>
            {t("Este contato já conversou por outra conexão. O cliente recebe a mensagem pelo número da conexão escolhida.")}
          </DialogDescription>
        </DialogHeader>
        {padrao && !padrao.conectada ? (
          <p data-testid="aviso-conexao-desconectada" className="rounded-md border border-amber-500/40 bg-amber-50/60 p-2 text-xs dark:bg-amber-900/10">
            {t("A conexão")} {t(padrao.nome)}{" "}
            {t("não está conectada agora: a mensagem só sai quando ela voltar.")}
          </p>
        ) : null}
        <div role="radiogroup" className="space-y-2">
          {opcoes.map((o) => {
            const ativa = marcada === o.valor;
            return (
              <label
                key={o.valor}
                className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm transition-colors ${
                  ativa ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
                }`}
              >
                <input
                  type="radio"
                  name="conexao-ao-abrir"
                  value={o.valor}
                  checked={ativa}
                  onChange={() => onMarcar(o.valor)}
                  disabled={ocupado}
                  className="h-4 w-4 shrink-0 accent-primary"
                />
                <span>{o.rotulo}</span>
              </label>
            );
          })}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onFechar} disabled={ocupado}>
            {t("Cancelar")}
          </Button>
          <Button type="button" onClick={onConfirmar} disabled={ocupado || !marcada}>
            {ocupado ? t("Abrindo…") : t("Abrir conversa")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
