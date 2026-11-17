"use client";
/**
 * A ABA "Templates do WhatsApp" do painel de mensagens do chat (17/11/2026).
 *
 * ─── A conta é a DA CONVERSA ────────────────────────────────────────────────
 *
 * A organização pode ter várias contas oficiais, e cada uma aprova os próprios
 * modelos. A lista vem de `GET /api/v1/channels/templates?channel_session_id=`
 * com a conexão da conversa, e o "Novo modelo" cria na MESMA conta. Sem conexão
 * conhecida, a rota cai na conta de sempre (a mais antiga).
 *
 * ─── Enviar ─────────────────────────────────────────────────────────────────
 *
 * Só modelo APROVADO sai. O envio é o do seletor da janela fechada
 * (`JanelaFechadaAviso`): `useSendMessage` com `type: "template"`, o texto do
 * corpo e os valores por `valueKey` — a cadeia de envio de modelo que já existe.
 * 2xx com a linha `failed` NÃO é "saiu", pelo mesmo motivo de lá.
 *
 * ─── Novo modelo ────────────────────────────────────────────────────────────
 *
 * O formulário é o das Conexões (`FormularioDaDefinicao`): nome, categoria,
 * idioma, cabeçalho de texto, corpo com `{{n}}` e exemplos, rodapé, botões e a
 * prévia em balão ao lado. A aba "JSON" exporta o que está no formulário e
 * importa o JSON colado, validado no formato da Meta (`importarModeloJson`).
 * Enviar para aprovação vai pela rota de criação que já existe (papel gerente).
 * WhatsApp Flows fica fora, por decisão do dono do produto.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { PreviaDoModelo } from "@/components/channels/PreviaDoModelo";
import {
  FormularioDaDefinicao,
  type CorpoDoModelo,
  type ModeloEmEdicao,
} from "@/components/connections/FormularioDaDefinicao";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import type { TemplatesPayload, TemplateView } from "@/hooks/channels/useTemplates";
import { useT } from "@/hooks/i18n/useT";
import { useSendMessage } from "@/hooks/inbox/useSendMessage";
import { apiClient } from "@/lib/api/client";
import { exportarModeloJson, importarModeloJson } from "@/lib/channels/meta/modelo-json";
import { renderTemplatePreview } from "@/lib/channels/meta/render-template";
import { lerConteudo } from "@/lib/channels/template-conteudo";
import { rotaDeTemplates } from "@/lib/channels/templates-fonte";
import { motivoDaFalhaDaMensagem } from "@/lib/inbox/motivo-da-falha";
import { cn } from "@/lib/utils";

const ROTA = rotaDeTemplates("oficial");

const CAMPO =
  "h-9 rounded-md border border-input bg-background px-2 text-sm focus:outline-hidden focus:ring-1 focus:ring-ring";

/** Rótulo de tela do status da Meta. Desconhecido aparece como veio. */
function rotuloDoStatus(status: string, t: (s: string) => string): string {
  const s = status.toUpperCase();
  if (s === "APPROVED") return t("Aprovado");
  if (s === "PENDING" || s === "IN_APPEAL") return t("Em análise");
  if (s === "REJECTED") return t("Reprovado");
  if (s === "PAUSED") return t("Pausado");
  if (s === "DISABLED") return t("Desativado");
  return status;
}

function rotuloDaCategoria(categoria: string | null, t: (s: string) => string): string {
  const c = (categoria ?? "").toUpperCase();
  if (c === "MARKETING") return t("Marketing");
  if (c === "UTILITY") return t("Utilidade");
  if (c === "AUTHENTICATION") return t("Autenticação");
  return categoria ?? "—";
}

export function AbaDeModelosDoWhatsApp({
  conversationId,
  channelSessionId,
  podeCriar,
  onEnviado,
}: {
  conversationId: string;
  channelSessionId: string | null;
  podeCriar: boolean;
  onEnviado?: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const send = useSendMessage();
  const [busca, setBusca] = useState("");
  const [escolhido, setEscolhido] = useState<string | null>(null);
  const [valores, setValores] = useState<Record<string, string>>({});
  const [criando, setCriando] = useState(false);

  const chave = ["templates-da-conversa", "oficial", channelSessionId ?? "padrao"] as const;
  const url = channelSessionId ? `${ROTA}?channel_session_id=${encodeURIComponent(channelSessionId)}` : ROTA;
  const { data, isLoading, isError } = useQuery({
    queryKey: chave,
    queryFn: async () => apiClient.get<{ data: TemplatesPayload }>(url),
    staleTime: 30_000,
  });

  const todos = data?.data.templates ?? [];
  const q = busca.trim().toLowerCase();
  const lista = q ? todos.filter((m) => m.name.toLowerCase().includes(q)) : todos;
  const atual = todos.find((m) => `${m.name}|${m.language}` === escolhido) ?? null;

  if (criando) {
    return (
      <NovoModelo
        channelSessionId={channelSessionId}
        onCancelar={() => setCriando(false)}
        onCriado={() => {
          setCriando(false);
          void qc.invalidateQueries({ queryKey: ["templates-da-conversa"] });
          void qc.invalidateQueries({ queryKey: ["channel-templates"] });
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center gap-2">
        <input
          type="search"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder={t("Buscar modelo…")}
          aria-label={t("Buscar modelo")}
          className={cn(CAMPO, "min-w-0 flex-1")}
        />
        {podeCriar && (
          <Button type="button" size="sm" variant="outline" onClick={() => setCriando(true)}>
            {t("Novo modelo")}
          </Button>
        )}
      </div>

      {isLoading ? (
        <p className="px-1 text-xs text-muted-foreground">{t("Carregando modelos…")}</p>
      ) : isError ? (
        <p role="alert" className="px-1 text-xs text-destructive">
          {t("Não consegui carregar os modelos desta conta.")}
        </p>
      ) : lista.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">{t("Nenhum modelo nesta conta do WhatsApp.")}</p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label={t("Templates do WhatsApp")}>
          {lista.map((m) => {
            const id = `${m.name}|${m.language}`;
            const aprovado = m.status.toUpperCase() === "APPROVED";
            return (
              <li key={id}>
                <button
                  type="button"
                  data-modelo={m.name}
                  aria-pressed={escolhido === id}
                  disabled={!aprovado}
                  title={aprovado ? undefined : t("Só modelo aprovado pode ser enviado.")}
                  onClick={() => {
                    setEscolhido(id);
                    setValores({ ...(m.savedValues ?? {}) });
                  }}
                  className={cn(
                    "flex w-full flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-70",
                    escolhido === id ? "border-ring bg-muted" : "border-transparent hover:bg-muted",
                  )}
                >
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className="break-all font-mono text-xs font-medium">
                      {m.name} <span className="text-muted-foreground">({m.language})</span>
                    </span>
                    <span
                      data-status={m.status.toUpperCase()}
                      className={cn(
                        "shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium",
                        aprovado ? "bg-success-bg text-success-fg" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {rotuloDoStatus(m.status, t)}
                    </span>
                  </span>
                  <span className="text-[11px] text-muted-foreground">{rotuloDaCategoria(m.category, t)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {atual && (
        <EnvioDoModelo
          key={`${atual.name}|${atual.language}`}
          modelo={atual}
          valores={valores}
          setValores={setValores}
          enviando={send.isPending}
          onEnviar={() =>
            send.mutate(
              {
                conversation_id: conversationId,
                type: "template",
                template_name: atual.name,
                template_language: atual.language,
                body: lerConteudo(atual.components ?? []).body?.trim() || atual.name,
                template_values: valores,
              },
              {
                onSuccess: (res) => {
                  const enviada = res.data;
                  if (enviada?.status === "failed") {
                    toast.error(t("Não consegui enviar o modelo."), {
                      description: motivoDaFalhaDaMensagem(enviada, t),
                    });
                    return;
                  }
                  setEscolhido(null);
                  setValores({});
                  toast.success(t("Modelo enviado."));
                  onEnviado?.();
                },
                onError: (e: unknown) =>
                  toast.error(e instanceof Error ? e.message : t("Não consegui enviar o modelo.")),
              },
            )
          }
        />
      )}
    </div>
  );
}

/** Os valores do modelo escolhido, a prévia e o Enviar. */
function EnvioDoModelo({
  modelo,
  valores,
  setValores,
  enviando,
  onEnviar,
}: {
  modelo: TemplateView;
  valores: Record<string, string>;
  setValores: (fn: (v: Record<string, string>) => Record<string, string>) => void;
  enviando: boolean;
  onEnviar: () => void;
}) {
  const t = useT();
  const slots = modelo.slots ?? [];
  const faltando = slots.filter((s) => !(valores[s.valueKey] ?? "").trim());
  const previa = renderTemplatePreview(modelo.components ?? [], valores, {
    name: modelo.name,
    language: modelo.language,
  });
  const desabilitado = enviando || faltando.length > 0;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-2" data-envio-do-modelo>
      {previa && <PreviaDoModelo previa={previa} tom="neutro" />}
      {slots.map((slot) => {
        const midia = slot.expects === "image" || slot.expects === "video" || slot.expects === "document";
        return (
          <label key={slot.valueKey} className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">
              {slot.onde} — {midia ? t("link público do arquivo") : `{{${slot.key}}}`}
            </span>
            <input
              type={midia ? "url" : "text"}
              value={valores[slot.valueKey] ?? ""}
              onChange={(e) => setValores((v) => ({ ...v, [slot.valueKey]: e.target.value }))}
              placeholder={midia ? "https://…" : ""}
              disabled={enviando}
              className={CAMPO}
            />
          </label>
        );
      })}
      <div className="flex justify-end">
        <Button type="button" size="sm" onClick={onEnviar} disabled={desabilitado}>
          {enviando ? t("Enviando…") : t("Enviar modelo")}
        </Button>
      </div>
    </div>
  );
}

/** "Novo modelo": o formulário das Conexões + a aba JSON. */
export function NovoModelo({
  channelSessionId,
  onCancelar,
  onCriado,
}: {
  channelSessionId: string | null;
  onCancelar: () => void;
  onCriado: () => void;
}) {
  const t = useT();
  const [aba, setAba] = useState<"formulario" | "json">("formulario");
  const [semente, setSemente] = useState<ModeloEmEdicao | null>(null);
  const [versao, setVersao] = useState(0);
  const [rascunho, setRascunho] = useState<CorpoDoModelo | null>(null);
  const [json, setJson] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  function abrirJson() {
    setJson(
      rascunho
        ? exportarModeloJson({
            name: rascunho.name,
            language: rascunho.language,
            category: rascunho.category ?? "UTILITY",
            components: rascunho.components,
          })
        : "",
    );
    setErro(null);
    setAba("json");
  }

  function importar() {
    const r = importarModeloJson(json);
    if (!r.ok) {
      setErro(r.campo ? `${t(r.erro)} (${r.campo})` : t(r.erro));
      return;
    }
    setErro(null);
    setSemente({
      name: r.modelo.name,
      language: r.modelo.language,
      category: r.modelo.category,
      components: r.modelo.components,
    });
    setVersao((v) => v + 1);
    setAba("formulario");
    toast.success(t("JSON importado para o formulário."));
  }

  async function enviar(corpo: CorpoDoModelo) {
    setSalvando(true);
    try {
      await apiClient.post(ROTA, {
        ...corpo,
        ...(channelSessionId ? { channel_session_id: channelSessionId } : {}),
      });
      toast.success(t("Modelo enviado para aprovação."));
      onCriado();
    } catch (e) {
      showApiError(e);
    } finally {
      setSalvando(false);
    }
  }

  const abaBase =
    "rounded-md px-3 py-1.5 text-xs font-medium focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div className="flex flex-col gap-2 p-2" data-novo-modelo>
      <div className="flex items-center gap-1">
        <div role="tablist" aria-label={t("Novo modelo")} className="flex flex-1 gap-1">
          <button
            type="button"
            role="tab"
            aria-selected={aba === "formulario"}
            onClick={() => setAba("formulario")}
            className={cn(abaBase, aba === "formulario" ? "bg-muted" : "text-muted-foreground hover:bg-muted")}
          >
            {t("Formulário")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={aba === "json"}
            onClick={abrirJson}
            className={cn(abaBase, aba === "json" ? "bg-muted" : "text-muted-foreground hover:bg-muted")}
          >
            JSON
          </button>
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={onCancelar}>
          {t("Voltar")}
        </Button>
      </div>

      {/* O formulário fica montado nas duas abas: trocar para o JSON não pode
          perder o que foi digitado. A semente nova (JSON importado) o remonta. */}
      <div hidden={aba !== "formulario"}>
        <FormularioDaDefinicao
          key={versao}
          semente={semente}
          salvando={salvando}
          rotaDeMidia="/api/v1/channels/templates/media"
          onRascunho={setRascunho}
          onEnviar={(corpo) => void enviar(corpo)}
        />
      </div>

      {aba === "json" && (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] text-muted-foreground">
            {t("O modelo no formato da Meta. Copie para guardar, ou cole um JSON e importe para o formulário.")}
          </p>
          <textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            aria-label={t("JSON do modelo")}
            spellCheck={false}
            rows={12}
            className="min-h-48 rounded-md border border-input bg-background p-2 font-mono text-xs focus:outline-hidden focus:ring-1 focus:ring-ring"
          />
          {erro && (
            <p role="alert" data-erro-do-json className="text-xs font-medium text-destructive">
              {erro}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!json.trim()}
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(json)
                  .then(() => toast.success(t("JSON copiado.")))
                  .catch(() => toast.error(t("Não consegui copiar. Selecione o texto e copie.")));
              }}
            >
              {t("Copiar JSON")}
            </Button>
            <Button type="button" size="sm" disabled={!json.trim()} onClick={importar}>
              {t("Importar para o formulário")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
