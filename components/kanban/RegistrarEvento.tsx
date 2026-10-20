"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Plus } from "@/lib/ui/icons";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useRegistrarEvento } from "@/hooks/leads/useRegistrarEvento";
import { useT } from "@/hooks/i18n/useT";
import {
  FOLGA_DE_RELOGIO_MS,
  ROTULO_DO_SUBTIPO,
  SUBTIPOS_DE_EVENTO_MANUAL,
  TEXTO_MAXIMO_DO_EVENTO,
  type SubtipoDeEventoManual,
} from "@/lib/leads/evento-manual";

/** `YYYY-MM-DDTHH:mm` no fuso do navegador — o formato do `datetime-local`. */
export function paraCampoDeData(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * "Registrar evento": a equipe anota na linha do tempo o que aconteceu fora do
 * CRM. Tipo, texto (até 2000 caracteres) e data/hora — agora por padrão, passado
 * permitido, futuro não. O servidor repete as mesmas regras; aqui elas só evitam a
 * ida e volta.
 */
export function RegistrarEvento({
  leadId,
  onRegistrado,
}: {
  leadId: string;
  /** Depois de gravado: a ficha usa para paginar até o evento, que pode ser retroativo. */
  onRegistrado?: (id: string) => Promise<void> | void;
}) {
  const t = useT();
  const registrar = useRegistrarEvento(leadId);
  const [aberto, setAberto] = useState(false);
  const [subtype, setSubtype] = useState<SubtipoDeEventoManual>("nota");
  const [text, setText] = useState("");
  const [quando, setQuando] = useState(() => paraCampoDeData(new Date()));
  // O teto do seletor (agora + folga) é fixado ao abrir: `Date.now()` no render
  // mudaria a cada redesenho.
  const [limite, setLimite] = useState(() => paraCampoDeData(new Date(Date.now() + FOLGA_DE_RELOGIO_MS)));
  const [erro, setErro] = useState<string | null>(null);

  function abrir() {
    // A hora de "agora" é a de quando se ABRE o formulário, não a de quando a
    // tela foi montada: o dossiê fica aberto por horas.
    setQuando(paraCampoDeData(new Date()));
    setLimite(paraCampoDeData(new Date(Date.now() + FOLGA_DE_RELOGIO_MS)));
    setAberto(true);
  }

  function fechar() {
    setAberto(false);
    setErro(null);
  }

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    const corpo = text.trim();
    if (corpo.length === 0) {
      setErro(t("Escreva o que aconteceu."));
      return;
    }
    if (corpo.length > TEXTO_MAXIMO_DO_EVENTO) {
      setErro(t("Use até 2000 caracteres."));
      return;
    }
    const instante = new Date(quando);
    if (Number.isNaN(instante.getTime())) {
      setErro(t("Data e hora inválidas."));
      return;
    }
    if (instante.getTime() > Date.now() + FOLGA_DE_RELOGIO_MS) {
      setErro(t("A data do evento não pode ser no futuro."));
      return;
    }
    setErro(null);
    try {
      const res = await registrar.mutateAsync({
        subtype,
        text: corpo,
        occurred_at: instante.toISOString(),
      });
      toast.success(t("Evento registrado"));
      setText("");
      setSubtype("nota");
      setAberto(false);
      const id = res?.data?.id;
      if (id) await onRegistrado?.(id);
    } catch {
      // o toast do erro já foi mostrado pelo hook
    }
  }

  if (!aberto) {
    return (
      <Button type="button" size="sm" className="mb-2 h-7 text-xs" onClick={abrir}>
        <Plus size={12} weight="bold" className="mr-1" aria-hidden />
        {t("Registrar evento")}
      </Button>
    );
  }

  return (
    <form
      onSubmit={enviar}
      // A validação é nossa (mensagem no idioma da tela); a nativa do `max` do
      // datetime-local bloquearia o envio com um balão do navegador em outro idioma.
      noValidate
      aria-label={t("Registrar evento")}
      className="mb-3 space-y-2 rounded-md border border-border p-3"
    >
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="evento-tipo" className="text-xs">
            {t("Tipo")}
          </Label>
          <Select value={subtype} onValueChange={(v) => setSubtype(v as SubtipoDeEventoManual)}>
            <SelectTrigger id="evento-tipo" className="h-8 text-xs" aria-label={t("Tipo")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SUBTIPOS_DE_EVENTO_MANUAL.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(ROTULO_DO_SUBTIPO[s])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="evento-quando" className="text-xs">
            {t("Data e hora")}
          </Label>
          <input
            id="evento-quando"
            type="datetime-local"
            value={quando}
            max={limite}
            onChange={(e) => setQuando(e.target.value)}
            className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="evento-texto" className="text-xs">
          {t("O que aconteceu")}
        </Label>
        <Textarea
          id="evento-texto"
          rows={3}
          maxLength={TEXTO_MAXIMO_DO_EVENTO}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="text-xs"
        />
        <p className="text-right text-[11px] text-text-muted">
          {text.length}/{TEXTO_MAXIMO_DO_EVENTO}
        </p>
      </div>
      {erro && (
        <p role="alert" className="text-xs text-error-fg">
          {erro}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={fechar} disabled={registrar.isPending}>
          {t("Cancelar")}
        </Button>
        <Button type="submit" size="sm" disabled={registrar.isPending}>
          {registrar.isPending ? t("Salvando…") : t("Registrar")}
        </Button>
      </div>
    </form>
  );
}
