"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import type { BloqueioDoBotao } from "@/lib/billing/planos/estado-do-bloqueio";
import { randomId } from "@/lib/random-id";
import { CircleNotch, Plus } from "@/lib/ui/icons";
import { AvisoDeLimiteDeConexoes } from "./AvisoDeLimiteDeConexoes";
import { PareamentoPorSessao } from "./PareamentoPorSessao";

/**
 * Criar uma conexão de WhatsApp por QR Code pelo serviço de WhatsApp da INSTALAÇÃO (a terceira
 * forma de conexão, Hiperbold 18/11/2026). Só aparece no Criar quando a instalação tem o serviço
 * configurado (calculado no servidor, `app/app/connections/page.tsx`).
 *
 * O caminho é o que a tela antiga já fazia: `POST /api/v1/channel-sessions` (com
 * `Idempotency-Key`, para o clique repetido não abrir duas sessões) e, em seguida, o pareamento
 * (QR que se renova, código de pareamento, status até WORKING).
 *
 * O teto de conexões do plano vale aqui como nos outros tipos: o botão fica desabilitado com o
 * motivo, e quem barra de verdade é o banco (gatilho `trg_billing_trava_channel_sessions`), que a
 * rota devolve como 409. As rotas de sessão exigem administrador (e a verificação em duas etapas):
 * para quem não é, o botão não é oferecido.
 */

/** `padrao` chega já traduzido: o literal fica em cada chamada, onde a cerca de i18n o lê. */
function errMsg(err: unknown, padrao: string, t: (texto: string) => string): string {
  return err instanceof ApiError && err.message ? t(err.message) : padrao;
}

export function CanalPorSessaoClient({
  bloqueio,
  aoMudar,
}: {
  bloqueio?: BloqueioDoBotao;
  /** Uma conexão foi criada ou conectou: quem monta refaz a grade. */
  aoMudar: () => void;
}) {
  const t = useT();
  const podeConectar = usePermission("settings.write");
  const [criando, setCriando] = useState(false);
  const [sessao, setSessao] = useState<string | null>(null);
  const chave = useRef<string | null>(null);

  async function conectar() {
    setCriando(true);
    try {
      const res = await apiClient.post<{ data: { id: string } }>(
        "/api/v1/channel-sessions",
        {},
        { idempotencyKey: (chave.current ??= randomId()), timeoutMs: 120_000 },
      );
      chave.current = null;
      setSessao(res.data.id);
      aoMudar();
    } catch (err) {
      toast.error(errMsg(err, t("Não foi possível iniciar a conexão."), t));
      aoMudar();
    } finally {
      setCriando(false);
    }
  }

  if (sessao) {
    return (
      <div className="flex flex-col gap-3" data-testid="criar-por-sessao-pareando">
        <p className="text-sm text-muted-foreground">
          {t("Escolha QR Code ou código de pareamento e confirme no WhatsApp do celular.")}
        </p>
        <PareamentoPorSessao
          sessionId={sessao}
          onConnected={() => {
            toast.success(t("WhatsApp conectado!"));
            aoMudar();
          }}
          onForcePair={async (id) => {
            await apiClient.post(`/api/v1/channel-sessions/${id}/reconnect`, { force: true });
            aoMudar();
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="criar-por-sessao">
      <p className="text-sm text-muted-foreground">
        {t("Novos canais começam em modo de teste, sem respostas automáticas até você autorizar números ou liberar o público.")}
      </p>
      {podeConectar ? (
        <div>
          <Button
            onClick={() => void conectar()}
            disabled={criando || Boolean(bloqueio?.desabilitado)}
            title={bloqueio?.desabilitado ? (bloqueio.motivo ?? undefined) : undefined}
            data-testid="criar-por-sessao-conectar"
          >
            {criando ? <CircleNotch size={14} className="animate-spin" aria-hidden /> : <Plus size={14} aria-hidden />}
            {t("Conectar novo WhatsApp")}
          </Button>
          {bloqueio?.desabilitado ? <AvisoDeLimiteDeConexoes motivo={bloqueio.motivo} /> : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="criar-por-sessao-so-admin">
          {t("Só o administrador da conta conecta um número por este caminho.")}
        </p>
      )}
    </div>
  );
}
