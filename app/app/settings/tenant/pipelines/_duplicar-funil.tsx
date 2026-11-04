"use client";

/**
 * O diálogo "Duplicar funil": escolher a origem, dar o nome, salvar.
 *
 * Chama `POST /api/v1/pipelines/[id]/duplicate` (a regra do que é copiado mora em `lib/pipelines/duplicar.ts`).
 * O nome nasce "<origem> (cópia)" e acompanha a troca de origem ENQUANTO a pessoa não o editou — depois de
 * editado, trocar a origem não apaga o que ela escreveu. A chave de idempotência é uma por diálogo aberto: o
 * duplo clique em Salvar não cria dois funis.
 */
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { nomeDaCopia } from "@/lib/followup/nome-da-copia";

export interface FunilDeOrigem {
  id: string;
  name: string;
  slug: string;
  is_default?: boolean;
}

/**
 * A frase do erro, sempre em português. A da API já vem pronta (e traduzida pelo idioma da pessoa) nos casos
 * que esta tela alcança: 402 do plano, 403 de permissão, 409/422 de nome. Quando não vem (`HTTP 500` cru, ou
 * um 403 de outra origem, como o do token de agente, que fala inglês), a tela diz o que houve com as palavras
 * dela.
 */
export function fraseDoErro(e: unknown, t: (texto: string) => string): string {
  if (!(e instanceof ApiError)) return t("Não consegui duplicar o funil agora. Tente de novo.");
  const daApi = e.message && !/^HTTP \d+$/.test(e.message) && e.message !== e.code ? e.message : null;
  if (e.status === 403) {
    return e.code === "forbidden_permission" && daApi
      ? daApi
      : t("Seu perfil não pode duplicar funis nesta organização. Peça a um administrador.");
  }
  if (e.status === 402) {
    return daApi ?? t("O plano desta organização chegou ao limite de funis ou de etapas. Fale com quem cuida da assinatura.");
  }
  return daApi ?? t("Não consegui duplicar o funil agora. Tente de novo.");
}

/** O mesmo teto do nome de funil na API. */
const MAX_NOME = 80;

export function DialogoDuplicarFunil({
  funis,
  origemInicial,
  onFechar,
  onDuplicado,
}: {
  funis: FunilDeOrigem[];
  origemInicial: string;
  onFechar: () => void;
  onDuplicado: (novoId: string) => void;
}) {
  const t = useT();
  const router = useRouter();
  const ocupados = useMemo(() => funis.map((f) => f.name), [funis]);
  const sugestao = (id: string) => {
    const f = funis.find((x) => x.id === id);
    return f ? nomeDaCopia(f.name, ocupados) : "";
  };

  const [origemId, setOrigemId] = useState(origemInicial);
  const [nome, setNome] = useState(() => sugestao(origemInicial));
  const [editado, setEditado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [chave] = useState(() => crypto.randomUUID());

  const nomeLimpo = nome.trim();
  const podeSalvar = !!origemId && nomeLimpo.length > 0 && nomeLimpo.length <= MAX_NOME && !salvando;

  async function salvar() {
    if (!podeSalvar) return;
    setSalvando(true);
    setErro(null);
    try {
      const r = await apiClient.post<{ data: { id: string; name: string } }>(
        `/api/v1/pipelines/${encodeURIComponent(origemId)}/duplicate`,
        { name: nomeLimpo },
        { idempotencyKey: chave },
      );
      toast.success(`«${r.data.name}» ${t("foi criado com as etapas e a configuração do funil de origem.")}`);
      router.refresh();
      onDuplicado(r.data.id);
    } catch (e) {
      setErro(fraseDoErro(e, t));
      setSalvando(false);
    }
  }

  return (
    <Dialog open onOpenChange={(aberto) => !aberto && !salvando && onFechar()}>
      <DialogContent data-testid="dialogo-duplicar-funil">
        <DialogHeader>
          <DialogTitle>{t("Duplicar funil")}</DialogTitle>
          <DialogDescription>
            {t(
              "Copia as etapas, os motivos de perda e de ganho, os campos do lead e o mapeamento do assistente. Negócios, automações e formulários não são copiados.",
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void salvar();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="duplicar-origem">{t("Funil de origem")}</Label>
            <Select
              value={origemId}
              onValueChange={(id) => {
                setOrigemId(id);
                if (!editado) setNome(sugestao(id));
              }}
            >
              <SelectTrigger id="duplicar-origem" data-testid="duplicar-origem">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {funis.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="duplicar-nome">{t("Nome do novo funil")}</Label>
            <Input
              id="duplicar-nome"
              data-testid="duplicar-nome"
              value={nome}
              maxLength={MAX_NOME}
              onChange={(e) => {
                setNome(e.target.value);
                setEditado(true);
              }}
            />
          </div>
          {erro && (
            <p role="alert" className="text-sm text-destructive" data-testid="duplicar-erro">
              {erro}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onFechar} disabled={salvando}>
              {t("Cancelar")}
            </Button>
            <Button type="submit" disabled={!podeSalvar} data-testid="duplicar-salvar">
              {salvando ? t("Salvando…") : t("Salvar")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
