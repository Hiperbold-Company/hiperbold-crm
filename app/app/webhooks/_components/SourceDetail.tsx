"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { formatDistanceToNowStrict } from "date-fns";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { copyToClipboard } from "@/lib/clipboard";
import { Copy, Trash, CaretDown, PencilSimple } from "@/lib/ui/icons";
import { usePermission } from "@/hooks/auth/AuthProvider";
import { EditSourceDialog } from "./EditSourceDialog";
import { cn } from "@/lib/utils";
import {
  useDeleteWebhookSource,
  useUpdateWebhookSource,
  useWebhookSourceEvents,
  type WebhookSourceRow,
} from "@/hooks/webhooks/useWebhookSources";
import type { BloqueioDoBotao } from "@/lib/billing/planos/estado-do-bloqueio";
import { useT } from "@/hooks/i18n/useT";

interface Props {
  source: WebhookSourceRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Fase F3, tarefa 9. Só trava LIGAR uma fonte pausada (`!source.is_active`
   * abaixo): pausar não cria linha nova, não conta contra o teto.
   */
  bloqueio?: BloqueioDoBotao;
}

function publicUrl(pathToken: string): string {
  // window.location.origin > env: NEXT_PUBLIC_APP_URL é inlined no build e num
  // Docker self-host fica congelada no placeholder do Dockerfile — a origem da
  // página é o único valor confiável em runtime.
  const base =
    typeof window !== "undefined"
      ? window.location.origin
      : (process.env.NEXT_PUBLIC_APP_URL ?? "");
  return `${base}/api/v1/webhooks/in/${pathToken}`;
}

function formSnippet(url: string, t: (texto: string) => string): string {
  return `<form action="${url}" method="POST">
  <input name="nome" placeholder="${t("Seu nome")}" required />
  <input name="telefone" placeholder="${t("Seu WhatsApp")}" required />
  <input name="email" type="email" placeholder="${t("Seu e-mail")}" />
  <button type="submit">${t("Quero receber contato")}</button>
</form>`;
}

function curlSnippet(url: string): string {
  return `curl -X POST ${url} \\\n  -H 'Content-Type: application/json' \\\n  -d '{"nome":"...","telefone":"..."}'`;
}

async function copy(text: string, label: string, t: (texto: string) => string): Promise<void> {
  const ok = await copyToClipboard(text);
  if (ok) toast.success(label);
  else toast.error(t("Não foi possível copiar — selecione e copie manualmente."));
}

function relativeReceivedAt(iso: string, locale: Locale): string {
  return formatDistanceToNowStrict(new Date(iso), { addSuffix: true, locale: locale });
}

export function SourceDetail({ source, open, onOpenChange, bloqueio }: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const update = useUpdateWebhookSource();
  const del = useDeleteWebhookSource();
  const { data: eventsRes, refetch: refetchEvents } = useWebhookSourceEvents(
    open ? source.id : null,
  );
  const [testing, setTesting] = React.useState(false);
  const [testOk, setTestOk] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  // Esconde o que a rota recusaria (PATCH/DELETE exigem `automacoes.gerenciar`).
  // Não é autorização: quem barra é a rota.
  const podeGerenciar = usePermission("automacoes.gerenciar");

  const url = publicUrl(source.path_token);
  const events = eventsRes?.data ?? [];

  const sendTestLead = async () => {
    setTesting(true);
    setTestOk(false);
    try {
      // URL relativa de propósito: o teste bate no host que está servindo a
      // página, mesmo que NEXT_PUBLIC_APP_URL (usada na URL exibida p/ forms
      // externos) esteja desalinhada num self-host atrás de proxy.
      const res = await fetch(`/api/v1/webhooks/in/${source.path_token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nome: "Lead de Teste", telefone: "11999990000", utm_source: "teste" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(
          t(
            body?.error?.message ??
              "Não funcionou. Confira se a fonte está ativa e se o funil/estágio ainda existem.",
          ),
        );
        return;
      }
      toast.success(t("Funcionou! Um lead de teste entrou no seu funil."));
      setTestOk(true);
      void refetchEvents();
    } catch {
      toast.error(t("Não conseguimos falar com o endereço. Confira sua internet e tente de novo."));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <SheetTitle>{source.name}</SheetTitle>
            <Badge variant={source.is_active ? "success" : "neutral"}>
              {source.is_active ? t("Ativa") : t("Pausada")}
            </Badge>
          </div>
          <SheetDescription>
            {t("Cada envio para o endereço abaixo vira um lead no seu funil, automaticamente.")}{" "}
            {t(
              "Se a pessoa já tiver um lead aberto neste funil, o CRM não cria outro: registra o recadastro no histórico e mantém a etapa.",
            )}
          </SheetDescription>
          {podeGerenciar ? (
            <div>
              <Button type="button" variant="secondary" onClick={() => setEditOpen(true)}>
                <PencilSimple /> {t("Editar")}
              </Button>
            </div>
          ) : null}
        </SheetHeader>
        {podeGerenciar ? (
          <EditSourceDialog source={source} open={editOpen} onOpenChange={setEditOpen} />
        ) : null}

        <div className="mt-6 space-y-6">
          <section className="space-y-2">
            <p className="text-sm font-medium text-text">{t("Endereço da fonte")}</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-sm border border-border bg-muted px-3 py-2 text-xs">
                {url}
              </code>
              <Button
                type="button"
                variant="secondary"
                size="icon"
                onClick={() => copy(url, t("Endereço copiado."), t)}
              >
                <Copy />
              </Button>
            </div>
          </section>

          <section className="space-y-2">
            <p className="text-sm font-medium text-text">
              {t("Formulário pronto para colar no seu site")}
            </p>
            <Textarea readOnly rows={6} value={formSnippet(url, t)} className="font-mono text-xs" />
            <Button
              type="button"
              variant="secondary"
              onClick={() => copy(formSnippet(url, t), t("Formulário copiado."), t)}
            >
              <Copy /> {t("Copiar formulário")}
            </Button>
          </section>

          <section className="space-y-2 rounded-sm border border-border">
            <details className="group p-3">
              <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-text">
                {t("Como conectar no seu caso")}
                <CaretDown className="transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-3 space-y-4 text-sm text-muted-foreground">
                <div>
                  <p className="font-medium text-text">WordPress / Elementor</p>
                  <p>
                    {t(
                      "No Elementor Pro: Ações após o envio › Webhook, e cole o endereço acima na URL do webhook. Contact Form 7 precisa de um plugin de webhook (ex.: CF7 to Webhook); Fluent Forms Pro e WPForms Pro têm integração por Webhook.",
                    )}
                  </p>
                </div>
                <div>
                  <p className="font-medium text-text">Zapier / n8n</p>
                  <p>{t('Use a ação "Webhooks" → POST, apontando para o endereço acima.')}</p>
                </div>
                <div>
                  <p className="font-medium text-text">{t("Formulário próprio")}</p>
                  <p>{t("Use o HTML pronto logo acima — já aponta para o endereço certo.")}</p>
                </div>
              </div>
            </details>
          </section>

          <details className="rounded-sm border border-border p-3">
            <summary className="cursor-pointer list-none text-sm font-medium text-text">
              {t("Para desenvolvedores")}
            </summary>
            <pre className="mt-3 overflow-x-auto rounded-sm bg-muted p-3 text-xs">
              <code>{curlSnippet(url)}</code>
            </pre>
          </details>

          <section className="space-y-3">
            <Button type="button" onClick={sendTestLead} disabled={testing}>
              {testing ? t("Enviando…") : t("Enviar lead de teste")}
            </Button>
            {testOk ? (
              <p className="text-sm">
                <Link href="/app/kanban" className="text-accent underline underline-offset-4">
                  {t("Ver no Kanban")}
                </Link>
              </p>
            ) : null}
          </section>

          <section className="space-y-2">
            <p className="text-sm font-medium text-text">{t("Últimos recebimentos")}</p>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("Ainda não chegou nada por aqui.")}</p>
            ) : (
              <ul className="space-y-1">
                {events.map((ev) => (
                  <li key={ev.id} className="flex items-center gap-2 text-sm">
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        ev.valid_signature === false ? "bg-error" : "bg-success",
                      )}
                    />
                    <span className="text-muted-foreground">{relativeReceivedAt(ev.created_at, localeDaData)}</span>
                    {ev.valid_signature === false ? (
                      <span className="text-xs text-error">{t("assinatura inválida")}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {podeGerenciar ? (
          <>
          <section className="flex items-center justify-between gap-3 rounded-sm border border-border p-3">
            <div>
              <p className="text-sm font-medium text-text">{t("Fonte ativa")}</p>
              {/* A rota de entrada responde 404 à fonte pausada ANTES de gravar
                  qualquer registro — por isso o envio não aparece em Leads recebidos. */}
              <p className="text-xs text-muted-foreground">
                {!source.is_active && bloqueio?.desabilitado
                  ? bloqueio.motivo
                  : t(
                      "Pausada, o endereço recusa os envios: nenhum lead novo entra, e os envios recusados não aparecem em Leads recebidos.",
                    )}
              </p>
            </div>
            <Switch
              checked={source.is_active}
              disabled={update.isPending || (!source.is_active && bloqueio?.desabilitado)}
              title={
                !source.is_active && bloqueio?.desabilitado ? bloqueio.motivo ?? undefined : undefined
              }
              onCheckedChange={(checked) =>
                update.mutate(
                  { id: source.id, is_active: checked },
                  {
                    onSuccess: () =>
                      toast.success(checked ? t("Fonte ativada.") : t("Fonte pausada.")),
                  },
                )
              }
            />
          </section>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="destructive">
                <Trash /> {t("Excluir fonte")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("Excluir esta fonte?")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t(
                    "O endereço para de funcionar na hora: formulários que ainda enviam para ele deixam de criar leads. Os leads e contatos que já chegaram continuam no funil, e o histórico em Leads recebidos guarda o nome da fonte. Essa ação não pode ser desfeita.",
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
                <AlertDialogAction
                  disabled={del.isPending}
                  onClick={async () => {
                    try {
                      await del.mutateAsync(source.id);
                    } catch {
                      // A mensagem da API já foi mostrada pelo showApiError do hook;
                      // a fonte continua aberta, porque ela continua existindo.
                      return;
                    }
                    toast.success(t("Fonte excluída."));
                    onOpenChange(false);
                  }}
                >
                  {t("Excluir")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
