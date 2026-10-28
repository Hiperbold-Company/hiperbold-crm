"use client";

/**
 * Barra de filtros global de Desempenho: período, funil e atendente. O estado
 * mora na URL (`lib/metrics/desempenho.ts` lê e escreve), então o link copiado
 * abre a mesma visão e o voltar do navegador volta o filtro.
 *
 * O seletor de atendente só aparece para gerente e admin: o atendente já vê só
 * os próprios números (a RLS escopa), e escolher outra pessoa não lhe mostraria
 * nada.
 */
import { useT } from "@/hooks/i18n/useT";
import { useTeamMembers } from "@/hooks/team/useTeamMembers";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type Atalho, type FiltrosDaTela, janelaDosFiltros, paraDiaLocal } from "@/lib/metrics/desempenho";

const TODOS = "__todos__";

export interface FunilDoFiltro {
  id: string;
  name: string;
}

export function FiltrosDeDesempenho({
  filtros,
  onChange,
  funis,
  podeEscolherAtendente,
  currentUserId,
}: {
  filtros: FiltrosDaTela;
  onChange: (f: FiltrosDaTela) => void;
  funis: FunilDoFiltro[];
  podeEscolherAtendente: boolean;
  currentUserId: string;
}) {
  const t = useT();
  const equipe = useTeamMembers({ enabled: podeEscolherAtendente });

  const rotulos: Record<Atalho, string> = {
    hoje: t("Hoje"),
    "7d": t("Últimos 7 dias"),
    "30d": t("Últimos 30 dias"),
    "90d": t("Últimos 90 dias"),
    mes: t("Este mês"),
    mes_anterior: t("Mês passado"),
    personalizado: t("Personalizado"),
  };

  const escolherAtalho = (valor: string) => {
    const atalho = valor as Atalho;
    if (atalho === "personalizado") {
      // Começa do que está na tela, para a troca não pular o período.
      const { from, to } = janelaDosFiltros(filtros);
      const ultimo = new Date(to.getTime());
      ultimo.setDate(ultimo.getDate() - 1);
      onChange({ ...filtros, atalho, de: paraDiaLocal(from), ate: paraDiaLocal(ultimo) });
      return;
    }
    onChange({ ...filtros, atalho, de: null, ate: null });
  };

  const mudarDia = (campo: "de" | "ate", valor: string) => {
    if (!valor) return;
    const proximo = { ...filtros, [campo]: valor };
    if (proximo.de && proximo.ate && proximo.de > proximo.ate) return;
    onChange(proximo);
  };

  return (
    <div
      className="flex flex-col gap-3 rounded-xl border bg-card p-3 shadow-sm sm:flex-row sm:flex-wrap sm:items-end"
      data-testid="desempenho-filtros"
    >
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {t("Período")}
        <Select value={filtros.atalho} onValueChange={escolherAtalho}>
          <SelectTrigger className="w-full sm:w-48" aria-label={t("Período")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(rotulos) as Atalho[]).map((a) => (
              <SelectItem key={a} value={a}>
                {rotulos[a]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      {filtros.atalho === "personalizado" ? (
        <div className="flex gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t("De")}
            <Input
              type="date"
              value={filtros.de ?? ""}
              max={filtros.ate ?? undefined}
              onChange={(e) => mudarDia("de", e.target.value)}
              className="w-40"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            {t("Até")}
            <Input
              type="date"
              value={filtros.ate ?? ""}
              min={filtros.de ?? undefined}
              onChange={(e) => mudarDia("ate", e.target.value)}
              className="w-40"
            />
          </label>
        </div>
      ) : null}

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        {t("Funil")}
        <Select
          value={filtros.funil ?? TODOS}
          onValueChange={(v) => onChange({ ...filtros, funil: v === TODOS ? null : v })}
        >
          <SelectTrigger className="w-full sm:w-56" aria-label={t("Funil")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={TODOS}>{t("Todos os funis")}</SelectItem>
            {funis.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      {podeEscolherAtendente ? (
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t("Atendente")}
          <Select
            value={filtros.atendente ?? TODOS}
            onValueChange={(v) => onChange({ ...filtros, atendente: v === TODOS ? null : v })}
          >
            <SelectTrigger className="w-full sm:w-56" aria-label={t("Atendente")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={TODOS}>{t("Todos os atendentes")}</SelectItem>
              {(equipe.data?.data ?? [])
                .filter((m) => m.role !== "viewer" && !m.revoked_at)
                .map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.full_name ?? m.email ?? m.user_id.slice(0, 8)}
                    {m.user_id === currentUserId ? ` ${t("(você)")}` : ""}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </label>
      ) : null}
    </div>
  );
}
