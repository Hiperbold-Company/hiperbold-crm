"use client";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useOfficialChannel } from "@/hooks/channels/useOfficialChannel";
import type { BloqueioDoBotao } from "@/lib/billing/planos/estado-do-bloqueio";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ChannelAiAccess } from "./ChannelAiAccess";
import { ConectarComAMeta } from "./ConectarComAMeta";
import { EtiquetaDaConexao } from "./EtiquetaDaConexao";
import { RenomearConexao } from "./RenomearConexao";
import { rotuloDoCanalDaConversa } from "@/lib/channels/estado";
import { NumeroOficialCard } from "./NumeroOficialCard";
import { FormularioOficialManual, ParaIntegrarOficial, WebhookDoNumeroOficial } from "./OficialAvancado";

export function CanalOficialClient({
  bloqueio,
}: {
  /**
   * Fase F3, tarefa 9. Só trava a PRIMEIRA conexão (`!estado?.connected`
   * abaixo): trocar a credencial de um canal já conectado não cria linha
   * nova em `channel_sessions` e não deve ser barrado pelo teto.
   */
  bloqueio?: BloqueioDoBotao;
} = {}) {
  const t = useT();
  const qc = useQueryClient();
  const { data, isPending } = useOfficialChannel();
  const [confirmandoRemocao, setConfirmandoRemocao] = useState(false);
  const [removendo, setRemovendo] = useState(false);
  // Esconde o botão; quem barra é a rota (`DELETE /api/v1/channel-sessions/[id]` exige admin).
  const podeRemover = usePermission("settings.write");

  const estado = data?.data;

  async function remover(id: string) {
    // Dois cliques, como nas conexões por QR: remover desfaz o webhook do número na Meta.
    if (!confirmandoRemocao) {
      setConfirmandoRemocao(true);
      return;
    }
    setConfirmandoRemocao(false);
    setRemovendo(true);
    try {
      await apiClient.delete(`/api/v1/channel-sessions/${encodeURIComponent(id)}`);
      toast.success(t("Conexão removida."));
      await qc.invalidateQueries({ queryKey: ["official-channel"] });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    } catch (e) {
      toast.error(e instanceof Error ? t(e.message) : t("Não foi possível remover."));
    } finally {
      setRemovendo(false);
    }
  }

  if (isPending) return <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>;

  return (
    <div className="flex flex-col gap-4" data-testid="canal-oficial-root">
      {estado?.connected ? (
        <Card className="p-4" data-testid="canal-conectado">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{estado.displayName}</span>
            {estado.phoneNumber ? (
              <Badge variant="outline" className="font-mono text-xs">
                {estado.phoneNumber}
              </Badge>
            ) : null}
            <Badge>{estado.status ?? "—"}</Badge>
            {/* Mostra que o token EXISTE, nunca qual é. */}
            <Badge variant={estado.hasToken ? "outline" : "destructive"}>
              {estado.hasToken ? t("credencial guardada") : t("sem credencial")}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            WABA <span className="font-mono">{estado.wabaId}</span> · {t("número")}{" "}
            <span className="font-mono">{estado.phoneNumberId}</span>
          </p>
          {rotuloDoCanalDaConversa({ display_name: estado.displayName, phone_number: estado.phoneNumber }, t) && (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              {t("No Chat:")}
              <EtiquetaDaConexao
                texto={rotuloDoCanalDaConversa({ display_name: estado.displayName, phone_number: estado.phoneNumber }, t) ?? ""}
                cor={estado.labelColor}
              />
            </div>
          )}
          {estado.channel_session_id && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <RenomearConexao
                channelId={estado.channel_session_id}
                currentName={estado.displayName}
                comCor
                currentColor={estado.labelColor ?? null}
                onSaved={async () => {
                  await qc.invalidateQueries({ queryKey: ["official-channel"] });
                  void qc.invalidateQueries({ queryKey: ["conversations"] });
                }}
              />
              {podeRemover ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={removendo}
                  onClick={() => void remover(estado.channel_session_id as string)}
                  data-testid="btn-remover-conexao-oficial"
                >
                  {confirmandoRemocao ? t("Clique de novo para remover") : t("Remover conexão")}
                </Button>
              ) : null}
            </div>
          )}
        </Card>
      ) : null}
      {estado?.connected ? <NumeroOficialCard /> : null}
      {estado?.channel_session_id && <ChannelAiAccess channelId={estado.channel_session_id} />}

      {estado ? <WebhookDoNumeroOficial estado={estado} /> : null}
      {estado ? <ParaIntegrarOficial estado={estado} /> : null}

      <ConectarComAMeta bloqueio={bloqueio} />

      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("Ou conecte à mão")}
      </p>
      <FormularioOficialManual
        bloqueio={bloqueio}
        jaConectado={Boolean(estado?.connected)}
        hasToken={Boolean(estado?.hasToken)}
      />
    </div>
  );
}
