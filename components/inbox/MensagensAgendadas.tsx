"use client";
/**
 * Os balões "agendada" no fim da conversa (migration 1017).
 *
 * Um balão por mensagem que ainda vai sair, com a hora (no fuso da organização),
 * o texto e os botões Editar e Cancelar. Some quando a mensagem sai e vira a
 * mensagem real da conversa. A que falhou ANTES de virar mensagem (janela
 * fechada sem modelo, contato bloqueado, quem agendou saiu da equipe) fica com o
 * motivo e o botão Dispensar; a que falhou no canal aparece como a bolha de falha
 * da própria mensagem.
 *
 * Editar e cancelar só para quem agendou, ou gerente e acima — a mesma régua da
 * rota, que é quem decide de verdade.
 */
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useFusoDaOrganizacao } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import {
  useCancelarAgendada,
  useEditarAgendada,
  useMensagensAgendadas,
  type MensagemAgendada,
} from "@/hooks/inbox/useMensagensAgendadas";
import { FUSO_PADRAO, instanteDaParede, paredeDoInstante, rotuloDoHorario } from "@/lib/mensagens-agendadas/horario";
import { horarioValido } from "@/lib/mensagens-agendadas/regras";
import { MENSAGEM_HORARIO_INVALIDO } from "@/lib/mensagens-agendadas/textos";
import { CalendarBlank } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

const CAMPO =
  "rounded-md border border-input bg-background px-2 text-base md:text-sm focus:outline-hidden focus:ring-1 focus:ring-ring";

export function MensagensAgendadas({
  conversationId,
  usuarioId,
  gerente,
}: {
  conversationId: string;
  usuarioId: string | null;
  gerente: boolean;
}) {
  const { data } = useMensagensAgendadas(conversationId);
  const fuso = useFusoDaOrganizacao() ?? FUSO_PADRAO;
  if (!data || data.length === 0) return null;
  return (
    <div data-testid="mensagens-agendadas" className="space-y-1 pt-1">
      {data.map((agendada) => (
        <BalaoAgendado
          key={agendada.id}
          agendada={agendada}
          fuso={fuso}
          podeMudar={gerente || (usuarioId !== null && agendada.created_by === usuarioId)}
        />
      ))}
    </div>
  );
}

export function BalaoAgendado({
  agendada,
  fuso,
  podeMudar,
}: {
  agendada: MensagemAgendada;
  fuso: string;
  podeMudar: boolean;
}) {
  const t = useT();
  const tag = useTagDeIdioma();
  const editar = useEditarAgendada();
  const cancelar = useCancelarAgendada();
  const [editando, setEditando] = useState(false);
  const [texto, setTexto] = useState("");
  const [data, setData] = useState("");
  const [hora, setHora] = useState("");

  const quando = new Date(agendada.send_at);
  const rotulo = rotuloDoHorario(quando, fuso, tag);
  const falhou = agendada.status === "falhou";
  const enviando = agendada.status === "enviando";

  function abrirEdicao() {
    const parede = paredeDoInstante(quando, fuso);
    setTexto(agendada.body);
    setData(parede.data);
    setHora(parede.hora);
    setEditando(true);
  }

  function salvar() {
    const novoQuando = instanteDaParede(data, hora, fuso);
    const trocouHorario = novoQuando !== null && novoQuando.getTime() !== quando.getTime();
    if (trocouHorario && !horarioValido(novoQuando, new Date())) {
      toast.error(t(MENSAGEM_HORARIO_INVALIDO));
      return;
    }
    const novoTexto = texto.trim();
    editar.mutate(
      {
        agendada,
        ...(novoTexto && novoTexto !== agendada.body ? { body: novoTexto } : {}),
        ...(trocouHorario ? { sendAt: novoQuando } : {}),
      },
      {
        onSuccess: () => {
          setEditando(false);
          toast.success(t("Mensagem agendada atualizada."));
        },
      },
    );
  }

  return (
    <div className="flex justify-end">
      <div
        data-testid="balao-agendado"
        className={cn(
          "max-w-[85%] rounded-lg border border-dashed px-3 py-2 text-sm",
          falhou
            ? "border-destructive/50 bg-destructive/5"
            : "border-primary/50 bg-primary/5",
        )}
      >
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <CalendarBlank size={13} weight="regular" aria-hidden />
          {falhou
            ? t("Agendada para {data} às {hora} · não enviada").replace("{data}", rotulo.data).replace("{hora}", rotulo.hora)
            : enviando
              ? t("Enviando agora…")
              : t("Agendada para {data} às {hora}").replace("{data}", rotulo.data).replace("{hora}", rotulo.hora)}
        </div>

        {editando ? (
          <div className="space-y-2">
            <textarea
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              rows={3}
              aria-label={t("Texto da mensagem agendada")}
              className={cn(CAMPO, "w-full resize-y py-1.5")}
            />
            <div className="flex gap-2">
              <input
                type="date"
                value={data}
                onChange={(e) => setData(e.target.value)}
                aria-label={t("Data")}
                className={cn(CAMPO, "h-9 flex-1")}
              />
              <input
                type="time"
                value={hora}
                onChange={(e) => setHora(e.target.value)}
                aria-label={t("Hora")}
                className={cn(CAMPO, "h-9 w-28")}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditando(false)}>
                {t("Voltar")}
              </Button>
              <Button type="button" size="sm" onClick={salvar} disabled={editar.isPending || !texto.trim()}>
                {editar.isPending ? t("Salvando…") : t("Salvar")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="whitespace-pre-wrap break-words">{agendada.body}</p>
            {agendada.template && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("Se a janela de 24 horas estiver fechada, sai o modelo {modelo}.").replace(
                  "{modelo}",
                  agendada.template.name,
                )}
              </p>
            )}
            {agendada.status === "agendada" && agendada.adiada_ate && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("Fora do horário de envio da conexão: sai quando ele abrir.")}
              </p>
            )}
            {falhou && agendada.motivo && (
              <p role="status" className="mt-1 text-xs text-destructive">
                {t(agendada.motivo)}
              </p>
            )}
            {podeMudar && !enviando && (
              <div className="mt-2 flex justify-end gap-2">
                {!falhou && (
                  <Button type="button" size="sm" variant="ghost" onClick={abrirEdicao}>
                    {t("Editar")}
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={cancelar.isPending}
                  onClick={() =>
                    cancelar.mutate(agendada, {
                      onSuccess: () =>
                        toast.success(falhou ? t("Aviso dispensado.") : t("Mensagem agendada cancelada.")),
                    })
                  }
                >
                  {falhou ? t("Dispensar") : t("Cancelar")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
