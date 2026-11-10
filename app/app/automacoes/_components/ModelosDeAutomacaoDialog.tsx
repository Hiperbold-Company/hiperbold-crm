"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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
import { useT } from "@/hooks/i18n/useT";
import { MODELOS_DE_AUTOMACAO } from "@/lib/automacoes/modelos";
import { randomId } from "@/lib/random-id";

export type OpcaoDeEtapa = { id: string; nome: string };
export type OpcaoDeCampo = { key: string; label: string };

const SELECT = "h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm";

/**
 * "Usar um modelo" (lote 5): escolhe o modelo, responde só o indispensável e
 * cria um RASCUNHO, que abre no editor. Nada é publicado aqui.
 */
export function ModelosDeAutomacaoDialog({
  aberto,
  onAberto,
  etapas,
  camposDeData,
}: {
  aberto: boolean;
  onAberto: (v: boolean) => void;
  etapas: OpcaoDeEtapa[];
  camposDeData: OpcaoDeCampo[];
}) {
  const t = useT();
  const router = useRouter();
  const [modeloId, setModeloId] = useState(MODELOS_DE_AUTOMACAO[0]!.id);
  const [etapa, setEtapa] = useState("");
  const [campo, setCampo] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  // Uma chave por abertura do diálogo: o duplo clique não cria dois rascunhos.
  const [chave, setChave] = useState(() => randomId());
  const modelo = MODELOS_DE_AUTOMACAO.find((m) => m.id === modeloId)!;
  const falta = (modelo.pede === "etapa" && !etapa) || (modelo.pede === "campo_de_data" && !campo);

  const criar = async () => {
    setErro(null);
    setEnviando(true);
    try {
      const resp = await fetch("/api/v1/automacoes/modelos", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": chave },
        body: JSON.stringify({
          model_id: modelo.id,
          ...(modelo.pede === "etapa" ? { stage_id: etapa } : {}),
          ...(modelo.pede === "campo_de_data" ? { campo_de_data: campo } : {}),
        }),
      });
      const corpo = (await resp.json().catch(() => null)) as {
        data?: { id: string };
        error?: { message?: string };
      } | null;
      if (!resp.ok || !corpo?.data) {
        setErro(corpo?.error?.message ?? t("Não consegui criar a automação. Tente de novo."));
        return;
      }
      router.push(`/app/automacoes/${corpo.data.id}`);
    } catch {
      setErro(t("Não consegui criar a automação. Tente de novo."));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <Dialog
      open={aberto}
      onOpenChange={(v) => {
        if (!v) {
          setErro(null);
          setChave(randomId());
        }
        onAberto(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Usar um modelo")}</DialogTitle>
          <DialogDescription>
            {t("Nasce como rascunho. Você lê os textos no editor antes de publicar.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <fieldset className="space-y-2" data-testid="modelos-de-automacao">
            {MODELOS_DE_AUTOMACAO.map((m) => (
              <label
                key={m.id}
                className="flex cursor-pointer gap-2 rounded-md border border-border p-3 text-sm"
              >
                <input
                  type="radio"
                  name="modelo"
                  value={m.id}
                  checked={modeloId === m.id}
                  onChange={() => setModeloId(m.id)}
                  data-testid={`modelo-${m.id}`}
                />
                <span>
                  <span className="block font-medium">{t(m.nome)}</span>
                  <span className="block text-text-muted">{t(m.resumo)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {modelo.pede === "etapa" && (
            <div className="space-y-2">
              <Label htmlFor="modelo-etapa">{t("Para qual etapa o negócio vai")}</Label>
              <select
                id="modelo-etapa"
                className={SELECT}
                value={etapa}
                onChange={(e) => setEtapa(e.target.value)}
              >
                <option value="">{t("Escolha a etapa")}</option>
                {etapas.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.nome}
                  </option>
                ))}
              </select>
            </div>
          )}
          {modelo.pede === "campo_de_data" && (
            <div className="space-y-2">
              <Label htmlFor="modelo-campo">{t("Campo de data do negócio")}</Label>
              {camposDeData.length === 0 ? (
                <p className="text-sm text-text-muted">
                  {t(
                    "Nenhum funil tem campo de data. Crie um campo do tipo data no funil antes de usar este modelo.",
                  )}
                </p>
              ) : (
                <select
                  id="modelo-campo"
                  className={SELECT}
                  value={campo}
                  onChange={(e) => setCampo(e.target.value)}
                >
                  <option value="">{t("Escolha o campo")}</option>
                  {camposDeData.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          {erro && (
            <p role="alert" className="text-sm text-error-fg">
              {erro}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onAberto(false)}
            disabled={enviando}
          >
            {t("Cancelar")}
          </Button>
          <Button
            type="button"
            onClick={criar}
            disabled={enviando || falta}
            data-testid="criar-de-modelo"
          >
            {enviando ? t("Criando…") : t("Criar rascunho")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
