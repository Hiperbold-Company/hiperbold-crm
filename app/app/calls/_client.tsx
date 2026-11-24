"use client";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTelefoneExemplo } from "@/hooks/contacts/useTelefoneExemplo";
import { useT } from "@/hooks/i18n/useT";
import { useCallsQuery, useDialCall, type CallRow } from "@/hooks/calls/useCallsQuery";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { ListaPadrao } from "@/components/redesign/ListaPadrao";
import { useRedesign } from "@/lib/redesign/contexto";

function fmtDate(iso: string | null, idioma: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(idioma, { hour12: false });
  } catch {
    return iso;
  }
}

function fmtDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const STATUS_LABEL: Record<CallRow["status"], string> = {
  ringing: "Chamando",
  in_progress: "Em andamento",
  completed: "Concluída",
  no_answer: "Não atendida",
  busy: "Ocupado",
  failed: "Falhou",
  canceled: "Cancelada",
};

/** Número de quem ligou/foi ligado — o CLIENTE, não a linha da clínica. */
function counterpartNumber(call: CallRow): string {
  return call.direction === "outbound" ? call.to_number : call.from_number;
}

/** Identificador de ligações: nome do contato, com fallback pro número — regra única em rotuloDoContato. */
function counterpartLabel(call: CallRow): string {
  return rotuloDoContato({
    display_name: call.contact?.display_name,
    name: call.contact?.name,
    phone_number: counterpartNumber(call),
  });
}

function DialerDialog() {
  const t = useT();
  // O exemplo do número é do país da organização, não « +55 » em duro.
  const telefoneExemplo = useTelefoneExemplo();
  const [open, setOpen] = useState(false);
  const [toNumber, setToNumber] = useState("");
  const dial = useDialCall();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    dial.mutate(
      { toNumber },
      {
        onSuccess: () => {
          setOpen(false);
          setToNumber("");
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>{t("Nova ligação")}</Button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t("Nova ligação")}</DialogTitle>
            <DialogDescription>
              {t("A IA liga pra esse número e conduz a chamada — falar você mesmo ainda não está disponível.")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 py-4">
            <Label htmlFor="dialer-number">{t("Número")}</Label>
            <Input
              id="dialer-number"
              type="tel"
              placeholder={telefoneExemplo}
              value={toNumber}
              onChange={(e) => setToNumber(e.target.value)}
              autoFocus
              required
              minLength={8}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={dial.isPending || toNumber.trim().length < 8}>
              {dial.isPending ? t("Ligando…") : t("Ligar com IA")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CallsClient() {
  const t = useT();
  // A data segue o idioma de quem lê — `tests/unit/i18n-a-data-segue-o-idioma`
  // reprova `toLocaleString("pt-BR")` fixo.
  const idioma = useTagDeIdioma();
  const { data: calls, isLoading } = useCallsQuery();
  const [selected, setSelected] = useState<CallRow | null>(null);
  const ligado = useRedesign();

  if (ligado) {
    const todas = calls ?? [];
    const atendidas = todas.filter((c) => c.answered_at != null).length;
    const feitasPelaIa = todas.filter((c) => c.handled_by !== "human").length;
    const statusPresentes = (Object.keys(STATUS_LABEL) as CallRow["status"][]).filter((st) =>
      todas.some((c) => c.status === st),
    );
    return (
      <ListaPadrao<CallRow>
        rotulo={t("Chamadas")}
        descricao={t("Histórico de ligações (voz por IA) com transcrição.")}
        acoes={<DialerDialog />}
        resumo={[
          { rotulo: t("Chamadas na lista"), valor: String(todas.length) },
          { rotulo: t("Atendidas"), valor: String(atendidas) },
          { rotulo: t("Feitas pela IA"), valor: String(feitasPelaIa) },
        ]}
        busca={{ placeholder: t("Buscar por contato ou transcrição") }}
        pilulas={[
          { id: "todas", rotulo: t("Todas"), contagem: todas.length },
          ...statusPresentes.map((st) => ({
            id: st,
            rotulo: t(STATUS_LABEL[st]),
            contagem: todas.filter((c) => c.status === st).length,
          })),
        ]}
        colunas={[
          {
            id: "contato",
            titulo: t("Contato"),
            celula: (c) => <span className="font-semibold">{counterpartLabel(c)}</span>,
          },
          { id: "direcao", titulo: t("Direção"), celula: (c) => (c.direction === "outbound" ? t("Saída") : t("Entrada")) },
          { id: "status", titulo: t("Status"), celula: (c) => t(STATUS_LABEL[c.status]) },
          { id: "por", titulo: t("Atendido por"), celula: (c) => (c.handled_by === "ai" ? t("IA") : t("Humano")) },
          { id: "duracao", titulo: t("Duração"), celula: (c) => fmtDuration(c.duration_seconds) },
          { id: "quando", titulo: t("Quando"), celula: (c) => fmtDate(c.started_at, idioma) },
        ]}
        linhas={todas}
        chave={(c) => c.id}
        filtrar={(c, { busca, pilula }) => {
          if (pilula !== "todas" && c.status !== pilula) return false;
          const q = busca.trim().toLowerCase();
          if (!q) return true;
          return (
            counterpartLabel(c).toLowerCase().includes(q) ||
            counterpartNumber(c).toLowerCase().includes(q) ||
            (c.transcript ?? []).some((turn) => turn.text.toLowerCase().includes(q))
          );
        }}
        tituloDoPainel={(c) => `${t("Chamada com")} ${counterpartLabel(c)}`}
        painel={(c) => (
          <div className="space-y-5">
            <dl className="m-0 flex flex-col text-sm">
              {[
                [t("Quando"), fmtDate(c.started_at, idioma)],
                [t("Direção"), c.direction === "outbound" ? t("Saída") : t("Entrada")],
                [t("Status"), t(STATUS_LABEL[c.status])],
                [t("Atendido por"), c.handled_by === "ai" ? t("IA") : t("Humano")],
                [t("Duração"), fmtDuration(c.duration_seconds)],
              ].map(([rotulo, valor]) => (
                <div
                  key={rotulo}
                  className="flex justify-between gap-4 border-b border-[var(--color-border)] py-2 last:border-b-0"
                >
                  <dt className="text-[var(--color-text-muted)]">{rotulo}</dt>
                  <dd className="m-0 text-right font-medium">{valor}</dd>
                </div>
              ))}
            </dl>
            <section>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                {t("Transcrição")}
              </h3>
              {c.transcript && c.transcript.length > 0 ? (
                <div className="flex flex-col gap-3">
                  {c.transcript.map((turn, i) => (
                    <div
                      key={i}
                      className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                        turn.speaker === "agent"
                          ? "self-start bg-[var(--color-surface-elevated)]"
                          : "self-end bg-[var(--color-accent-600)] text-[var(--color-accent-fg)]"
                      }`}
                    >
                      <div className="mb-1 text-xs opacity-70">
                        {turn.speaker === "agent" ? "Iara" : counterpartLabel(c)}
                      </div>
                      {turn.text || <span className="italic opacity-60">{t("(sem áudio detectado)")}</span>}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="py-6 text-center text-sm text-[var(--color-text-muted)]">
                  {t("Sem transcrição pra esta chamada.")}
                </p>
              )}
            </section>
          </div>
        )}
        vazio={isLoading ? <Skeleton className="mx-auto h-10 w-full" /> : t("Nenhuma chamada ainda.")}
      />
    );
  }

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("Chamadas")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Histórico de ligações (voz por IA) com transcrição.")}
          </p>
        </div>
        <DialerDialog />
      </header>

      <Card className="overflow-hidden">
        {isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Data")}</TableHead>
                <TableHead>{t("Direção")}</TableHead>
                <TableHead>{t("Quem é")}</TableHead>
                <TableHead>{t("Status")}</TableHead>
                <TableHead>{t("Atendido por")}</TableHead>
                <TableHead>{t("Duração")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(calls ?? []).map((call) => (
                <TableRow
                  key={call.id}
                  className="cursor-pointer"
                  onClick={() => setSelected(call)}
                >
                  <TableCell>{fmtDate(call.started_at, idioma)}</TableCell>
                  <TableCell>{call.direction === "outbound" ? t("Saída") : t("Entrada")}</TableCell>
                  <TableCell className="font-medium">{counterpartLabel(call)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{t(STATUS_LABEL[call.status])}</Badge>
                  </TableCell>
                  <TableCell>{call.handled_by === "ai" ? t("IA") : t("Humano")}</TableCell>
                  <TableCell>{fmtDuration(call.duration_seconds)}</TableCell>
                </TableRow>
              ))}
              {(calls ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    {t("Nenhuma chamada ainda.")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </Card>

      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-lg">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {t("Chamada com")} {counterpartLabel(selected)}
                </DialogTitle>
                <DialogDescription>
                  {fmtDate(selected.started_at, idioma)} ·{" "}
                  {selected.direction === "outbound" ? t("Saída") : t("Entrada")} ·{" "}
                  {t(STATUS_LABEL[selected.status])}
                </DialogDescription>
              </DialogHeader>
              <ScrollArea className="max-h-[60vh] pr-4">
                {selected.transcript && selected.transcript.length > 0 ? (
                  <div className="flex flex-col gap-3 py-2">
                    {selected.transcript.map((turn, i) => (
                      <div
                        key={i}
                        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                          turn.speaker === "agent"
                            ? "self-start bg-muted"
                            : "self-end bg-primary text-primary-foreground"
                        }`}
                      >
                        <div className="mb-1 text-xs opacity-70">
                          {turn.speaker === "agent"
                            ? "Iara"
                            : counterpartLabel(selected)}
                        </div>
                        {turn.text || <span className="italic opacity-60">{t("(sem áudio detectado)")}</span>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    {t("Sem transcrição pra esta chamada.")}
                  </p>
                )}
              </ScrollArea>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
