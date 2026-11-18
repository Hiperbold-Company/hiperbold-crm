"use client";

import { useState } from "react";
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
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { CHAVE_MINHAS_CONEXOES } from "@/hooks/inbox/useMinhasConexoes";
import { apiClient } from "@/lib/api/client";
import { ROLE_RANK, type Role } from "@/lib/auth/types";
import { UserCircle } from "@/lib/ui/icons";

/**
 * "Membro responsável" da conexão (migration 1019, pedido do dono do produto em 18/11/2026):
 * UM membro da equipe a quem a conexão pertence, ou nenhum. No painel do negócio, o seletor de
 * conexão já vem marcado com a conexão de quem está logado.
 *
 * Só gerente e administrador alteram (a rota `PATCH …/responsible` barra os demais; esconder o
 * botão aqui é apresentação). Não mexe no roteamento de Configurações › Atendimento.
 */
export function MembroResponsavelDaConexao({
  channelId,
  responsavelUserId,
  onSaved,
}: {
  channelId: string;
  responsavelUserId: string | null;
  onSaved: () => void | Promise<unknown>;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { user, activeOrg } = useAuth();
  const podeEditar =
    Boolean(user.is_platform_admin && !user.support) ||
    (ROLE_RANK[(activeOrg?.role ?? "viewer") as Role] ?? 0) >= ROLE_RANK.manager;
  // O valor salvo, mantido aqui: a grade se refaz depois, e a linha não pisca o valor antigo.
  const [atual, setAtual] = useState<string | null>(responsavelUserId);
  const [aberto, setAberto] = useState(false);
  const [escolhido, setEscolhido] = useState<string>(responsavelUserId ?? "");
  const [salvando, setSalvando] = useState(false);
  const membros = useAssignableMembers(true);
  const lista = membros.data ?? [];

  const nomeDe = (id: string) => lista.find((m) => m.user_id === id)?.full_name?.trim() || t("Membro sem nome");
  const rotuloAtual = atual === null ? t("Nenhum") : membros.isPending ? t("Carregando…") : nomeDe(atual);

  function abrir() {
    setEscolhido(atual ?? "");
    setAberto(true);
  }

  async function salvar() {
    setSalvando(true);
    try {
      const novo = escolhido === "" ? null : escolhido;
      await apiClient.patch(`/api/v1/channel-sessions/${channelId}/responsible`, { user_id: novo });
      setAtual(novo);
      toast.success(t("Membro responsável atualizado."));
      setAberto(false);
      void qc.invalidateQueries({ queryKey: ["conexoes"] });
      void qc.invalidateQueries({ queryKey: CHAVE_MINHAS_CONEXOES });
      await onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? t(error.message) : t("Não foi possível salvar o membro responsável."));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground" data-testid="membro-responsavel-atual">
        {t("Membro responsável:")} <span className="font-medium text-foreground">{rotuloAtual}</span>
      </div>
      {podeEditar ? (
        <Button variant="outline" size="sm" onClick={abrir} data-testid="membro-responsavel-botao">
          <UserCircle size={14} aria-hidden />
          {t("Membro responsável")}
        </Button>
      ) : null}
      <Dialog open={aberto} onOpenChange={(v) => (v ? abrir() : setAberto(false))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Membro responsável pela conexão")}</DialogTitle>
            <DialogDescription>
              {t(
                "Escolha quem da equipe usa esta conexão. No painel do negócio, a conversa dessa pessoa já abre por esta conexão. Cada conexão tem no máximo um membro.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`membro-da-conexao-${channelId}`}>{t("Membro da equipe")}</Label>
            <select
              id={`membro-da-conexao-${channelId}`}
              value={escolhido}
              onChange={(e) => setEscolhido(e.target.value)}
              disabled={salvando}
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              data-testid="membro-responsavel-seletor"
            >
              <option value="">{t("Nenhum")}</option>
              {lista.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.full_name?.trim() || t("Membro sem nome")}
                </option>
              ))}
            </select>
            {membros.isError ? (
              <p role="alert" className="text-xs text-destructive">
                {t("Não foi possível carregar a equipe. Tente de novo.")}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAberto(false)} disabled={salvando}>
              {t("Cancelar")}
            </Button>
            <Button onClick={() => void salvar()} disabled={salvando || membros.isPending}>
              {salvando ? t("Salvando…") : t("Salvar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
