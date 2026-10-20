"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirMembroDaAgencia } from "@/app/actions/admin/membrosDaAgencia";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";

export interface MembroDaAgenciaLinha {
  userId: string;
  email: string | null;
  nome: string | null;
}

interface Props {
  organizationId: string;
  membros: MembroDaAgenciaLinha[];
  /** Só o admin da plataforma de escopo `full` altera; a action confere de novo no servidor. */
  podeEscrever: boolean;
}

/**
 * "Membros da agência" na página da organização, no painel da plataforma (migration 0974).
 * O vínculo é permanente, não ocupa vaga do plano e o cliente não o remove.
 */
export function MembrosDaAgencia({ organizationId, membros, podeEscrever }: Props) {
  const t = useT();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [pendente, iniciar] = useTransition();

  function executar(alvoEmail: string, ativo: boolean) {
    iniciar(async () => {
      const r = await definirMembroDaAgencia({ organizationId, email: alvoEmail, ativo });
      if (!r.ok) {
        toast.error(t(r.error));
        return;
      }
      toast.success(ativo ? t("Membro da agência adicionado.") : t("Membro da agência removido."));
      if (ativo) setEmail("");
      router.refresh();
    });
  }

  return (
    <Card data-testid="membros-da-agencia">
      <CardHeader>
        <CardTitle className="text-base">{t("Membros da agência")}</CardTitle>
        <CardDescription>
          {t(
            "Acesso permanente da agência que opera este CRM. Não ocupa vaga do plano, não sai quando o dono assume e o cliente não consegue remover.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {membros.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Nenhum membro da agência nesta organização.")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {membros.map((m) => (
              <li key={m.userId} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{m.nome ?? m.email ?? m.userId.slice(0, 8)}</div>
                  {m.email ? <div className="truncate text-xs text-muted-foreground">{m.email}</div> : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant="info">{t("Agência")}</Badge>
                  {podeEscrever && m.email ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      disabled={pendente}
                      onClick={() => executar(m.email as string, false)}
                    >
                      {t("Remover")}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        {podeEscrever ? (
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              if (email.trim()) executar(email.trim(), true);
            }}
          >
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="membro-agencia-email">{t("E-mail do usuário")}</Label>
              <Input
                id="membro-agencia-email"
                type="email"
                placeholder="pessoa@agencia.com.br"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={pendente || !email.trim()}>
              {t("Adicionar membro da agência")}
            </Button>
          </form>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("Seu acesso de suporte só permite ver a lista.")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
