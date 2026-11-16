"use client";
import { useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useT } from "@/hooks/i18n/useT";
import { useMinhasConexoes } from "@/hooks/inbox/useMinhasConexoes";
import {
  MENSAGEM_CONEXAO_PROPRIA_OBRIGATORIA,
  avisoDeConexaoAlheia,
  conversaAberta,
  envioPermitidoPelaConexao,
  nomeDaConexao,
} from "@/lib/inbox/conexao-ao-abrir";

interface ConversaDoAviso {
  channel_session_id: string | null | undefined;
  status?: string | null;
  assigned_to_user_id?: string | null;
}

/**
 * O motivo para travar a RESPOSTA no modo "só a conexão própria": a mesma
 * `envioPermitidoPelaConexao` que o servidor aplica no envio. `null` = pode
 * responder (ou ainda não se sabe — o servidor recusa de qualquer forma).
 */
export function useBloqueioPelaConexao(
  conversa: ConversaDoAviso | null | undefined,
  userId: string | null | undefined,
): string | null {
  const t = useT();
  const minhas = useMinhasConexoes();
  if (!conversa?.channel_session_id || !minhas?.restrito) return null;
  const sid = conversa.channel_session_id;
  const permitido = envioPermitidoPelaConexao({
    restrito: true,
    sessaoEhMinha: minhas.minhas_conexoes_ids.includes(sid),
    sessaoTemResponsaveis: minhas.conexoes_com_responsavel_ids.includes(sid),
    // Quem tem número próprio CONECTADO não tem a exceção da transferência: no
    // servidor, a guarda do número (#3642) recusa antes e aponta a conversa
    // que continua no número dele.
    conversaAbertaEMinha:
      !minhas.minha_conexao?.conectada &&
      conversaAberta(conversa.status) &&
      !!userId &&
      conversa.assigned_to_user_id === userId,
  });
  return permitido ? null : t(MENSAGEM_CONEXAO_PROPRIA_OBRIGATORIA);
}

/**
 * "Você está respondendo pela conexão <nome>" — acima da caixa de texto, quando
 * a conversa aberta NÃO está numa conexão vinculada a quem está vendo.
 *
 * Responder a conversa existente continua pela conexão DELA (uma atendente
 * cobre a outra); o aviso só torna visível o número que o cliente vai ver.
 * Quem não tem conexão vinculada não vê aviso nenhum. Quando o modo "só a
 * conexão própria" trava a resposta, o motivo aparece aqui no lugar.
 */
export function AvisoDeConexao({
  conversa,
  userId,
}: {
  conversa: ConversaDoAviso;
  userId: string | null | undefined;
}) {
  const t = useT();
  const minhas = useMinhasConexoes();
  const { data: sessoes } = useChannelSessions();
  const bloqueio = useBloqueioPelaConexao(conversa, userId);

  if (bloqueio) {
    return (
      <p
        role="status"
        data-testid="aviso-de-conexao-bloqueio"
        className="border-t border-border bg-amber-50/60 px-4 py-1.5 text-xs text-foreground dark:bg-amber-900/10"
      >
        {bloqueio}
      </p>
    );
  }
  if (!avisoDeConexaoAlheia(minhas?.minhas_conexoes_ids, conversa.channel_session_id)) return null;
  const sessao = sessoes?.find((s) => s.id === conversa.channel_session_id);
  if (!sessao) return null;
  const nome = t(nomeDaConexao(sessao));

  return (
    <p
      role="note"
      data-testid="aviso-de-conexao"
      className="border-t border-border bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground"
    >
      {t("Você está respondendo pela conexão")} <strong className="font-medium text-foreground">{nome}</strong>
    </p>
  );
}
