"use client";
/**
 * O botão de calendário do compositor e o selo "Agendada para…" (migration 1017).
 *
 * O botão abre data e hora NO FUSO DA ORGANIZAÇÃO (não no do navegador): é a
 * hora que a equipe combina com o cliente. Escolher não envia nada — o selo
 * aparece no campo, e o Enviar passa a agendar. O X do selo volta ao envio
 * imediato.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { instanteDaParede, paredeDoInstante, rotuloDoHorario } from "@/lib/mensagens-agendadas/horario";
import { horarioValido, PRAZO_MAXIMO_DIAS } from "@/lib/mensagens-agendadas/regras";
import { CalendarBlank, X } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

const CAMPO =
  "h-11 rounded-md border border-input bg-background px-2 text-base md:text-sm lg:h-9 focus:outline-hidden focus:ring-1 focus:ring-ring";

export function AgendarMensagemButton({
  disabled,
  fuso,
  onEscolher,
}: {
  disabled?: boolean;
  fuso: string;
  onEscolher: (quando: Date) => void;
}) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [data, setData] = useState("");
  const [hora, setHora] = useState("");

  const quando = instanteDaParede(data, hora, fuso);
  // A conta da tela é a mesma do servidor (`horarioValido`): recusar depois do clique seria pior.
  const valido = quando !== null && horarioValido(quando, new Date());

  function abrir(proximo: boolean) {
    if (proximo) {
      // Sugere daqui a uma hora, já no fuso da organização. Lido ao abrir, e não
      // no `useState`, para o servidor e o navegador desenharem a mesma coisa.
      const sugestao = paredeDoInstante(new Date(Date.now() + 60 * 60 * 1000), fuso);
      setData(sugestao.data);
      setHora(sugestao.hora);
    }
    setAberto(proximo);
  }

  return (
    <Popover open={aberto} onOpenChange={abrir}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="shrink-0"
          aria-label={t("Agendar mensagem")}
          title={t("Agendar mensagem")}
          disabled={disabled}
        >
          <CalendarBlank size={18} weight="regular" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-72 space-y-3">
        <p className="text-sm font-medium">{t("Agendar mensagem")}</p>
        <div className="flex gap-2">
          <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
            {t("Data")}
            <input type="date" value={data} onChange={(e) => setData(e.target.value)} className={CAMPO} />
          </label>
          <label className="flex w-28 flex-col gap-1 text-xs text-muted-foreground">
            {t("Hora")}
            <input type="time" value={hora} onChange={(e) => setHora(e.target.value)} className={CAMPO} />
          </label>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {t("No fuso da empresa ({fuso}). Até {dias} dias.")
            .replace("{fuso}", fuso)
            .replace("{dias}", String(PRAZO_MAXIMO_DIAS))}
        </p>
        <Button
          type="button"
          size="sm"
          className="w-full"
          disabled={!valido}
          onClick={() => {
            if (!quando || !valido) return;
            onEscolher(quando);
            setAberto(false);
          }}
        >
          {t("Escolher horário")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

export function SeloDeAgendamento({
  quando,
  fuso,
  onTirar,
  className,
}: {
  quando: Date;
  fuso: string;
  onTirar: () => void;
  className?: string;
}) {
  const t = useT();
  const tag = useTagDeIdioma();
  const rotulo = rotuloDoHorario(quando, fuso, tag);
  return (
    <span
      data-testid="selo-de-agendamento"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 py-0.5 pl-2.5 pr-1 text-xs font-medium text-primary",
        className,
      )}
    >
      <CalendarBlank size={14} weight="regular" aria-hidden />
      {t("Agendada para {data} às {hora}").replace("{data}", rotulo.data).replace("{hora}", rotulo.hora)}
      <button
        type="button"
        onClick={onTirar}
        aria-label={t("Tirar o agendamento")}
        className="inline-flex size-6 items-center justify-center rounded-full hover:bg-primary/20"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </span>
  );
}
