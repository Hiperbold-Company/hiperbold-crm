"use client";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { fraseDoMotivo } from "@/lib/channels/meta-social/motivos";
import type { BloqueioDoBotao } from "@/lib/billing/planos/estado-do-bloqueio";
import { AvisoDeLimiteDeConexoes } from "./AvisoDeLimiteDeConexoes";

/**
 * Redes sociais: Instagram Direct e Facebook Messenger pela conexão OFICIAL e
 * direta com a Meta (plano aprovado em 30/10/2026). Substitui a integração
 * anterior por intermediário, que pedia chave de API e perfil.
 *
 * Conectar é navegação de página inteira para a rota que monta o OAuth; a volta
 * chega em `/app/connections?aba=sociais&meta_social=ok|erro|parcial&motivo=&n=&recusadas=`. O
 * aviso da volta é lido UMA vez e os parâmetros saem da URL, para um F5 não
 * repetir "conta conectada".
 */

export type PlataformaSocial = "instagram" | "messenger";

export type ContaSocial = {
  id: string;
  plataforma: PlataformaSocial;
  nome: string | null;
  usuario: string | null;
  conectado_em: string;
  token_expira_em: string | null;
  status: string;
};

export type EstadoMetaSocial = {
  configurado: Record<PlataformaSocial, boolean>;
  contas: ContaSocial[];
};

const ROTA = "/api/v1/channels/meta-social";
const SETE_DIAS_MS = 7 * 24 * 60 * 60 * 1000;

/** Status que o backend usa para conta funcionando. Qualquer outro vira "precisa de atenção". */
const STATUS_SAUDAVEIS = new Set(["ativo", "ativa", "active", "connected", "conectado", "conectada", "working", "ok"]);

export function urlDeConectar(plataforma: PlataformaSocial): string {
  return `${ROTA}/conectar?plataforma=${plataforma}`;
}

/** A conta precisa ser reconectada: status de erro ou token que vence em menos de 7 dias. */
export function precisaReconectar(conta: ContaSocial, agora: number = Date.now()): boolean {
  if (!STATUS_SAUDAVEIS.has(conta.status.trim().toLowerCase())) return true;
  if (!conta.token_expira_em) return false;
  const vence = Date.parse(conta.token_expira_em);
  return Number.isFinite(vence) && vence - agora < SETE_DIAS_MS;
}

type Aviso = { tipo: "ok" | "erro" | "parcial"; texto: string; limite?: boolean };

const inteiro = (v: string | null): number => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

/**
 * A frase da volta. Os códigos de `motivo` e as frases são os de
 * `lib/channels/meta-social/motivos.ts` — o mesmo conjunto que o backend emite.
 */
export function lerAviso(params: URLSearchParams, t: (s: string) => string): Aviso | null {
  const resultado = params.get("meta_social");
  if (resultado === "ok") {
    const n = inteiro(params.get("n"));
    const texto =
      n > 1
        ? `${n} ${t("contas conectadas. As novas mensagens passam a chegar no Chat.")}`
        : t("Conta conectada. As novas mensagens passam a chegar no Chat.");
    return { tipo: "ok", texto };
  }
  const motivo = params.get("motivo") ?? "";
  if (resultado === "parcial") {
    const n = inteiro(params.get("n"));
    const x = inteiro(params.get("recusadas"));
    const conectadas =
      n === 1 ? t("1 conta conectada") : `${n} ${t("contas conectadas")}`;
    const recusadas =
      x === 1
        ? t("1 não pôde ser conectada")
        : x > 1
          ? `${x} ${t("não puderam ser conectadas")}`
          : t("outras não puderam ser conectadas");
    return {
      tipo: "parcial",
      texto: `${conectadas}; ${recusadas}: ${t(fraseDoMotivo(motivo))}`,
      limite: motivo === "limite_do_plano",
    };
  }
  if (resultado === "erro") {
    return {
      tipo: "erro",
      texto: t(fraseDoMotivo(motivo)),
      limite: motivo === "limite_do_plano",
    };
  }
  return null;
}

const CARTOES: { plataforma: PlataformaSocial; titulo: string; descricao: string }[] = [
  {
    plataforma: "instagram",
    titulo: "Instagram Direct",
    descricao: "Receba e responda as mensagens do Direct no Chat do CRM.",
  },
  {
    plataforma: "messenger",
    titulo: "Facebook Messenger",
    descricao: "Receba e responda as mensagens da sua Página do Facebook no Chat do CRM.",
  },
];

export function RedesSociaisClient({
  bloqueio,
}: {
  /**
   * O limite de Conexões do plano (D-188). Conectar conta NOVA cria canal, então
   * "Conectar" fica travado; "Reconectar" renova uma conta que já existe e não é
   * barrado pelo teto.
   */
  bloqueio?: BloqueioDoBotao;
} = {}) {
  const t = useT();
  const tagDeIdioma = useTagDeIdioma();
  const params = useSearchParams();
  const caminho = usePathname();
  const qc = useQueryClient();
  const [aviso, setAviso] = useState<Aviso | null>(() => lerAviso(new URLSearchParams(params.toString()), t));
  const [paraDesconectar, setParaDesconectar] = useState<ContaSocial | null>(null);

  const query = useQuery({
    queryKey: ["meta-social"],
    queryFn: async () => (await apiClient.get<{ data: EstadoMetaSocial }>(ROTA)).data,
  });

  // Tira da URL o resultado da volta do OAuth, mantendo a aba. `replaceState`, e
  // não `router.replace`: limpar a query não é navegar e não precisa refazer o
  // componente de servidor.
  useEffect(() => {
    const atual = new URLSearchParams(window.location.search);
    if (!atual.has("meta_social")) return;
    for (const k of ["meta_social", "motivo", "n", "recusadas"]) atual.delete(k);
    const qs = atual.toString();
    window.history.replaceState(null, "", qs ? `${caminho}?${qs}` : caminho);
  }, [caminho]);

  const desconectar = useMutation({
    mutationFn: async (id: string) => apiClient.delete(`${ROTA}/${encodeURIComponent(id)}`),
    onSuccess: async () => {
      toast.success(t("Conta desconectada."));
      await qc.invalidateQueries({ queryKey: ["meta-social"] });
    },
    onError: () => {
      toast.error(t("Não foi possível desconectar a conta. Tente de novo."));
    },
    onSettled: () => setParaDesconectar(null),
  });

  const estado = query.data;
  const bloqueado = !!bloqueio?.desabilitado;
  const formatarData = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(tagDeIdioma);
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">{t("Redes sociais")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("Conecte o Instagram e o Facebook da empresa e atenda as mensagens no Chat.")}
        </p>
      </div>

      {aviso && (
        <div
          role={aviso.tipo === "ok" ? "status" : "alert"}
          data-testid="aviso-meta-social"
          data-tipo={aviso.tipo}
          className={
            aviso.tipo === "ok"
              ? "flex items-start justify-between gap-3 rounded-md border p-3 text-sm"
              : aviso.tipo === "parcial"
                ? "flex items-start justify-between gap-3 rounded-md border border-warning/40 bg-warning-bg p-3 text-sm"
                : "flex items-start justify-between gap-3 rounded-md border border-destructive p-3 text-sm text-destructive"
          }
        >
          <div>
            <p>{aviso.texto}</p>
            {aviso.limite && <AvisoDeLimiteDeConexoes motivo={bloqueio?.motivo} />}
          </div>
          <Button variant="ghost" size="sm" onClick={() => setAviso(null)}>
            {t("Fechar")}
          </Button>
        </div>
      )}

      {query.error && (
        <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">
          {t("Não foi possível carregar as redes sociais.")}{" "}
          <Button variant="link" className="h-auto p-0" onClick={() => void query.refetch()}>
            {t("Tentar de novo")}
          </Button>
        </p>
      )}
      {!estado && !query.error && <p role="status">{t("Carregando…")}</p>}

      {estado && (
        <div className="grid gap-4 xl:grid-cols-2">
          {CARTOES.map(({ plataforma, titulo, descricao }) => {
            const configurado = !!estado.configurado?.[plataforma];
            const contas = (estado.contas ?? []).filter((c) => c.plataforma === plataforma);
            return (
              <Card
                key={plataforma}
                className="flex flex-col gap-3 p-4"
                data-testid={`cartao-${plataforma}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">{titulo}</h3>
                    <p className="text-sm text-muted-foreground">{t(descricao)}</p>
                  </div>
                  {configurado && !bloqueado ? (
                    <Button asChild>
                      <a href={urlDeConectar(plataforma)}>{t("Conectar")}</a>
                    </Button>
                  ) : (
                    <Button
                      disabled
                      title={!configurado ? t("A conexão ainda não foi liberada nesta instalação.") : bloqueio?.motivo ?? undefined}
                    >
                      {t("Conectar")}
                    </Button>
                  )}
                </div>
                {!configurado && (
                  <p className="text-xs text-muted-foreground">
                    {t("A conexão ainda não foi liberada nesta instalação.")}
                  </p>
                )}
                {configurado && bloqueado && (
                  <AvisoDeLimiteDeConexoes motivo={bloqueio?.motivo} className="text-xs text-destructive" />
                )}

                {contas.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("Nenhuma conta conectada.")}</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {contas.map((conta) => {
                      const atencao = precisaReconectar(conta);
                      return (
                        <li key={conta.id} className="flex flex-col gap-2 rounded-md border p-3">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate font-medium">
                                {conta.nome ?? (conta.usuario ? `@${conta.usuario}` : t("Conta sem nome"))}
                              </p>
                              {conta.usuario && conta.nome && (
                                <p className="truncate text-sm text-muted-foreground">@{conta.usuario}</p>
                              )}
                              <p className="text-xs text-muted-foreground">
                                {t("Conectada desde")} {formatarData(conta.conectado_em)}
                              </p>
                            </div>
                            <Badge variant={atencao ? "outline" : "secondary"}>
                              {atencao ? t("Precisa de atenção") : t("Conectada")}
                            </Badge>
                          </div>
                          {atencao && (
                            <p role="status" className="text-sm text-destructive">
                              {t("Reconecte para continuar recebendo mensagens.")}
                            </p>
                          )}
                          <div className="flex flex-wrap gap-2">
                            {atencao && configurado && (
                              <Button asChild size="sm">
                                <a href={urlDeConectar(plataforma)}>{t("Reconectar")}</a>
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={desconectar.isPending}
                              onClick={() => setParaDesconectar(conta)}
                            >
                              {t("Desconectar")}
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <details className="rounded-lg border p-3 text-sm" data-testid="requisitos-redes-sociais">
        <summary className="cursor-pointer font-medium">{t("O que é preciso para conectar")}</summary>
        <div className="mt-3 flex flex-col gap-3">
          <div>
            <p className="font-medium">Instagram</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>{t("A conta precisa ser profissional (Empresa ou Criador de conteúdo).")}</li>
              <li>
                {t(
                  "No aplicativo do Instagram, ligue \"Permitir acesso às mensagens\" em Configurações > Mensagens e respostas de stories > Ferramentas conectadas.",
                )}
              </li>
              <li>
                {t(
                  "A conta precisa estar num portfólio de negócios da Meta. Se ainda não estiver, o login da Meta guia você nesse passo.",
                )}
              </li>
            </ul>
          </div>
          <div>
            <p className="font-medium">Messenger</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>{t("Você precisa ser administrador da Página do Facebook.")}</li>
            </ul>
          </div>
          <p className="text-muted-foreground">
            {t("A Meta só permite responder até 24 horas depois da última mensagem do cliente.")}
          </p>
        </div>
      </details>

      <AlertDialog open={!!paraDesconectar} onOpenChange={(aberto) => !aberto && setParaDesconectar(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Desconectar esta conta?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("As novas mensagens deixam de chegar. As mensagens já recebidas continuam no Chat.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={desconectar.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (paraDesconectar) desconectar.mutate(paraDesconectar.id);
              }}
            >
              {t("Desconectar")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
