"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { ArrowsClockwise, CheckCircle, CircleNotch } from "@/lib/ui/icons";
import { PairingOptions } from "./PairingOptions";

/**
 * Pareamento de uma conexão por QR que vive como SESSÃO no serviço de WhatsApp da instalação
 * (rotas de `/api/v1/channel-sessions/[id]`): status até WORKING, QR que se renova, código de
 * pareamento e "Gerar novo QR" quando o aparelho foi desvinculado.
 *
 * Saiu do `QrDialog` de `ConnectionsClient.tsx` sem mudar o comportamento (Hiperbold, 18/11/2026):
 * a tela de Conexões em cartões reaproveita o MESMO corpo no Criar e no Gerenciar, e o diálogo
 * antigo passou a ser só a moldura dele.
 */

/** `padrao` chega já traduzido: o literal fica em cada chamada, onde a cerca de i18n o lê. */
function errMsg(err: unknown, padrao: string, t: (texto: string) => string): string {
  return err instanceof ApiError && err.message ? t(err.message) : padrao;
}

export function PareamentoPorSessao({
  sessionId,
  ativo = true,
  onConnected,
  onForcePair,
}: {
  sessionId: string;
  /** `false` = o serviço da instalação não está configurado: não pergunta nada. */
  ativo?: boolean;
  onConnected: () => void;
  onForcePair: (sessionId: string) => Promise<void>;
}) {
  const t = useT();
  const [status, setStatus] = useState<string>("STARTING");
  const [tick, setTick] = useState(0);
  const [pairing, setPairing] = useState(false);
  const done = useRef(false);
  // Em ref: quem monta recria a função a cada render, e o polling não pode reiniciar por isso.
  const onConnectedRef = useRef(onConnected);
  useEffect(() => {
    onConnectedRef.current = onConnected;
  });

  useEffect(() => {
    if (!ativo) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await apiClient.get<{ data: { status: string } }>(
          `/api/v1/channel-sessions/${sessionId}`,
        );
        if (cancelled) return;
        const s = res.data.status;
        setStatus(s);
        if (s === "WORKING" && !done.current) {
          done.current = true;
          onConnectedRef.current();
        }
      } catch {
        // erro transitório de rede — o próximo tick tenta de novo
      }
    };
    void poll();
    const iv = setInterval(() => {
      // ABA OCULTA NÃO PERGUNTA (refs #2821, a convenção da casa): o pareamento
      // é uma tela de espera — com a aba escondida ninguém está escaneando QR
      // nenhum, e cada tick de 3 s custa uma consulta ao transporte. A guarda é
      // a mesma do refetch de segurança (hooks/realtime/useRefetchDeSeguranca.ts):
      // quem volta para a aba vê o estado no tick seguinte, em no máximo 3 s.
      if (document.visibilityState !== "visible") return;
      void poll();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [sessionId, ativo]);

  // O QR do WhatsApp EXPIRA — medido, a imagem muda a cada ~20s. Carregar uma vez
  // só deixava um código morto na tela: quem demorasse a pegar o celular escaneava
  // algo que o WhatsApp já tinha invalidado. Recarregamos a cada 15s enquanto
  // estivermos em SCAN_QR_CODE, com folga sobre a expiração.
  // A primeira imagem não precisa de tick novo: o <img> só é montado quando o
  // status vira SCAN_QR_CODE, e essa montagem já busca o QR do momento. O
  // intervalo cuida só das renovações seguintes.
  useEffect(() => {
    if (status !== "SCAN_QR_CODE") return;
    const iv = setInterval(() => setTick((v) => v + 1), 15_000);
    return () => clearInterval(iv);
  }, [status]);

  return (
    <div className="flex min-h-[16rem] flex-col items-center justify-center gap-3 py-2" data-testid="pareamento-por-sessao">
      {status === "SCAN_QR_CODE" ? (
        <PairingOptions key={sessionId} sessionId={sessionId} qr={
        // Sem `key={tick}`: trocar só o src reaproveita o mesmo <img>, e o
        // browser segura o frame anterior até decodificar o novo. Remontar o
        // elemento a cada refresh é o que causaria o flash branco.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/v1/channel-sessions/${sessionId}/qr?t=${tick}`}
          alt={t("QR Code para conectar WhatsApp")}
          className="h-64 w-64 rounded-md border bg-white p-2"
        />
        } />
      ) : status === "WORKING" ? (
        <div className="flex flex-col items-center gap-2 text-sm font-medium text-success-fg">
          <CheckCircle size={28} weight="fill" aria-hidden />
          {t("Conectado!")}
        </div>
      ) : status === "FAILED" || status === "STOPPED" ? (
        // Chegar aqui quase sempre significa credencial revogada: o número
        // foi desvinculado pelo celular e o engine não tem como voltar
        // sozinho. A tela oferece a única ação que de fato resolve.
        <div className="flex flex-col items-center gap-3 text-center">
          <p className="text-sm text-error-fg">
            {t(
              "Este número foi desvinculado do WhatsApp. Para usá-lo de novo é preciso parear outra vez.",
            )}
          </p>
          <Button
            size="sm"
            disabled={pairing}
            onClick={async () => {
              setPairing(true);
              try {
                await onForcePair(sessionId);
                setStatus("STARTING");
              } catch (err) {
                toast.error(errMsg(err, t("Não foi possível gerar um novo QR."), t));
              } finally {
                setPairing(false);
              }
            }}
          >
            {pairing ? (
              <CircleNotch size={14} className="animate-spin" aria-hidden />
            ) : (
              <ArrowsClockwise size={14} aria-hidden />
            )}
            {t("Gerar novo QR")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
          <CircleNotch size={28} className="animate-spin" aria-hidden />
          {t("Preparando o código…")}
        </div>
      )}
    </div>
  );
}

export function QrDialog({
  sessionId,
  title,
  ativo,
  onClose,
  onConnected,
  onForcePair,
}: {
  sessionId: string;
  title: string;
  ativo: boolean;
  onClose: () => void;
  onConnected: () => void;
  onForcePair: (sessionId: string) => Promise<void>;
}) {
  const t = useT();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t(
              "Escolha QR Code ou código de pareamento e confirme no WhatsApp do celular.",
            )}
          </DialogDescription>
        </DialogHeader>
        <PareamentoPorSessao
          sessionId={sessionId}
          ativo={ativo}
          onConnected={onConnected}
          onForcePair={onForcePair}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Reconectar, no Gerenciar, uma conexão por sessão que caiu: a mesma reconexão suave da tela
 * antiga (`POST /api/v1/channel-sessions/[id]/reconnect`, sem descartar a credencial pareada) e,
 * em seguida, o pareamento acima. O modo que DESCARTA a credencial (`force`) só aparece dentro do
 * pareamento, depois que o suave falhou ("Gerar novo QR").
 */
export function ReconectarPorSessao({
  conexaoId,
  abrirAoMontar = false,
  aoConectar,
  aoAbrirSozinho,
}: {
  conexaoId: string;
  /** Veio da faixa de conexão caída (`?reconectar=<id>`): já pede a reconexão. */
  abrirAoMontar?: boolean;
  aoConectar: () => void;
  aoAbrirSozinho?: () => void;
}) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const abriuSozinho = useRef(false);
  const aoAbrirSozinhoRef = useRef(aoAbrirSozinho);
  useEffect(() => {
    aoAbrirSozinhoRef.current = aoAbrirSozinho;
  });
  const rota = `/api/v1/channel-sessions/${encodeURIComponent(conexaoId)}/reconnect`;

  const pedir = async () => {
    setOcupado(true);
    try {
      await apiClient.post(rota, {});
      setAberto(true);
    } catch (err) {
      toast.error(errMsg(err, t("Não foi possível reconectar."), t));
    } finally {
      setOcupado(false);
    }
  };
  const pedirRef = useRef(pedir);
  useEffect(() => {
    pedirRef.current = pedir;
  });

  useEffect(() => {
    if (!abrirAoMontar || abriuSozinho.current) return;
    abriuSozinho.current = true;
    void pedirRef.current();
    aoAbrirSozinhoRef.current?.();
  }, [abrirAoMontar]);

  return (
    <div className="flex flex-col gap-3" data-testid="reconectar-por-sessao">
      {aberto ? (
        <>
          <PareamentoPorSessao
            sessionId={conexaoId}
            onConnected={() => {
              toast.success(t("WhatsApp conectado!"));
              setAberto(false);
              aoConectar();
            }}
            onForcePair={async (id) => {
              await apiClient.post(`/api/v1/channel-sessions/${encodeURIComponent(id)}/reconnect`, { force: true });
            }}
          />
          <div>
            <Button variant="outline" onClick={() => setAberto(false)}>
              {t("Fechar")}
            </Button>
          </div>
        </>
      ) : (
        <div>
          <Button size="sm" onClick={() => void pedir()} disabled={ocupado} data-testid="reconectar-por-sessao-botao">
            {ocupado ? <CircleNotch size={14} className="animate-spin" aria-hidden /> : <ArrowsClockwise size={14} aria-hidden />}
            {t("Reconectar")}
          </Button>
        </div>
      )}
    </div>
  );
}
