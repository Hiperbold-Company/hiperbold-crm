"use client";

import { usePathname } from "next/navigation";

import { useT } from "@/hooks/i18n/useT";
import { Check } from "@/lib/ui/icons";

import type { PassoVisivel } from "./Stepper";

/**
 * O PRIMEIRO ACESSO NO V49 (onda 2 do redesign) — só com a chave ligada.
 *
 * Os passos são os de `lib/onboarding/passos.ts` (os mesmos do `Stepper`), e
 * o atual sai da rota, como lá. Nada de lista fixa: o protótipo mostra seis
 * passos, mas quantos e quais dependem da instalação.
 */
function usePassoAtual(passos: PassoVisivel[]): number {
  const pathname = usePathname() ?? "";
  return passos.findIndex((p) => pathname.includes(`/${p.segmento}`));
}

/** "Passo N de M", no cabeçalho. Fora de um passo conhecido, não inventa número. */
export function PassoAtualDoPrimeiroAcesso({ passos }: { passos: PassoVisivel[] }) {
  const t = useT();
  const idx = usePassoAtual(passos);
  if (idx < 0) return null;
  return (
    <span data-rd-entrar="passo">
      {t("Passo")} {idx + 1} {t("de")} {passos.length}
    </span>
  );
}

/** A barra fina sob o cabeçalho. */
export function BarraDoPrimeiroAcesso({ passos }: { passos: PassoVisivel[] }) {
  const t = useT();
  const idx = usePassoAtual(passos);
  if (idx < 0) return null;
  const feito = Math.round(((idx + 1) / passos.length) * 100);
  return (
    <div
      role="progressbar"
      aria-label={t("Progresso do primeiro acesso")}
      aria-valuemin={1}
      aria-valuemax={passos.length}
      aria-valuenow={idx + 1}
      data-rd-entrar="progresso"
    >
      <span style={{ width: `${feito}%` }} />
    </div>
  );
}

/** O trilho à esquerda: "Seu primeiro acesso", com o cumprido marcado e o atual destacado. */
export function TrilhoDoPrimeiroAcesso({ passos }: { passos: PassoVisivel[] }) {
  const t = useT();
  const idx = usePassoAtual(passos);
  return (
    <nav aria-label={t("Seu primeiro acesso")} data-rd-entrar="trilho">
      <p data-rd-entrar="trilho-titulo">{t("Seu primeiro acesso")}</p>
      <ol>
        {passos.map((p, i) => {
          const atual = i === idx;
          return (
            <li key={p.segmento} aria-current={atual ? "step" : undefined} data-cumprido={p.cumprido ? "true" : "false"}>
              <span data-rd-entrar="trilho-marca" aria-hidden="true">
                {p.cumprido && !atual ? <Check weight="bold" /> : i + 1}
              </span>
              <span>{t(p.rotulo)}</span>
            </li>
          );
        })}
      </ol>
      <p data-rd-entrar="trilho-dica">{t("Pode sair a qualquer momento: o que você já fez fica salvo.")}</p>
    </nav>
  );
}
