"use client";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useConnectOfficialChannel,
  useRegistrarWebhookOficial,
  type OfficialChannelState,
} from "@/hooks/channels/useOfficialChannel";
import { useT } from "@/hooks/i18n/useT";
import type { BloqueioDoBotao } from "@/lib/billing/planos/estado-do-bloqueio";
import { copyToClipboard } from "@/lib/clipboard";
import { AvisoDeLimiteDeConexoes } from "./AvisoDeLimiteDeConexoes";
import { ParaIntegrar } from "./ParaIntegrar";

/**
 * As peças TÉCNICAS da conexão oficial (webhook, dados para integrar, credencial à mão).
 *
 * Saíram de `CanalOficialClient` para servirem às duas telas: o onboarding (que mostra tudo, como
 * sempre) e o Gerenciar da tela em cartões, onde ficam num bloco "Avançado" fechado e visível só
 * para o administrador da plataforma: cliente comum nunca lê "URL de callback" nem "endpoint".
 *
 * `channelSessionId` diz qual conexão (várias contas oficiais por organização, 17/11/2026);
 * ausente, a rota responde pela mais antiga, que é o comportamento do onboarding.
 */

/** Campo somente-leitura com botão de copiar — o que o operador cola na Meta. */
function ParaColar({
  rotulo,
  valor,
  semValor,
}: {
  rotulo: string;
  valor: string | null;
  /** O que dizer quando não há valor para mostrar — que nem sempre é "falta configurar". */
  semValor?: React.ReactNode;
}) {
  const t = useT();
  if (!valor) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {rotulo}
        </span>
        {semValor}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {rotulo}
      </span>
      <div className="flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs">
          {valor}
        </code>
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            await copyToClipboard(valor);
            toast.success(t("Copiado."));
          }}
        >
          {t("Copiar")}
        </Button>
      </div>
    </div>
  );
}

/** O webhook do número: o que colar na Meta, ou a confirmação de que o CRM já registrou. */
export function WebhookDoNumeroOficial({
  estado,
  channelSessionId,
}: {
  estado: OfficialChannelState;
  channelSessionId?: string;
}) {
  const t = useT();
  const registrarWebhook = useRegistrarWebhookOficial(channelSessionId);
  if (!estado.webhook) return null;
  return (
    <Card className="flex flex-col gap-3 p-4" data-testid="webhook-do-numero-oficial">
      <div>
        <h2 className="font-medium">
          {estado.webhookRegistro?.registrado
            ? t("Webhook registrado pela instalação")
            : t("Cole isto no painel da Meta")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {estado.webhookRegistro?.registrado ? (
            t(
              "O CRM apontou o webhook deste número para cá — não é preciso colar nada no painel da Meta. Os valores abaixo ficam para conferência.",
            )
          ) : (
            <>
              {t("Em")} <strong>WhatsApp → {t("Configuração")}</strong>
              {t(", na seção de Webhook. Sem esse passo o canal envia, mas")}{" "}
              <strong>{t("não recebe")}</strong>
              {t(" — as respostas do cliente não chegam e a janela de 24 horas nunca abre.")}
            </>
          )}
        </p>
      </div>

      {/*
        O aviso só aparece quando o CRM TENTOU registrar e não conseguiu. Nulo
        (banco sem a migration 0311) cai no passo manual acima, que continua
        verdadeiro — a tela nunca diz "registrado" sem ter registrado.
      */}
      {estado.webhookRegistro && !estado.webhookRegistro.registrado ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning-bg p-3">
          <Badge variant="outline" className="border-warning/60 font-normal text-warning-fg">
            {t("Webhook pendente")}
          </Badge>
          <span className="text-sm">
            {estado.webhookRegistro.erro ?? t("o registro ainda não foi feito")}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => registrarWebhook.mutate()}
            disabled={registrarWebhook.isPending}
          >
            {registrarWebhook.isPending ? t("Tentando…") : t("Tentar de novo")}
          </Button>
        </div>
      ) : null}

      {estado.webhook.callbackUrl ? (
        <>
          <ParaColar rotulo={t("URL de callback")} valor={estado.webhook.callbackUrl} />
          <ParaColar
            rotulo={t("Token de verificação")}
            valor={estado.webhook.verifyToken ?? null}
            semValor={
              // Desde a 0257 o token vive na tela de administração da instalação
              // e é mostrado UMA vez, quando é gerado. Mandar "definir no
              // servidor" quem já cadastrou tudo por lá seria mandá-lo editar um
              // arquivo que ele não precisa abrir — e o valor do arquivo nem é
              // mais o que a Meta precisa receber.
              <span className="flex flex-col items-start gap-1">
                {estado.webhook.verifyTokenOrigem === "instalacao" ? (
                  <span className="text-sm text-muted-foreground" data-testid="token-na-instalacao">
                    {t(
                      "Já cadastrado na administração da instalação. Ele aparece uma vez só, quando é gerado — se não foi guardado, quem administra a instalação gera outro em Admin › API Oficial (Meta).",
                    )}
                  </span>
                ) : (
                  <span className="text-sm text-destructive" data-testid="token-nao-configurado">
                    {t(
                      "Ainda não configurado. Quem administra a instalação cadastra em Admin › API Oficial (Meta), e o token aparece lá pronto para copiar.",
                    )}
                  </span>
                )}
                {estado.webhook.configurarEm ? (
                  <Link
                    href={estado.webhook.configurarEm}
                    data-testid="abrir-app-da-meta"
                    className="text-sm font-medium underline underline-offset-2"
                  >
                    {t("Abrir API Oficial (Meta) na administração")}
                  </Link>
                ) : null}
              </span>
            }
          />
        </>
      ) : null}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t("Campos a assinar")}
        </span>
        <div className="flex flex-wrap gap-1">
          {estado.webhook.fields.map((f) => (
            <Badge key={f} variant="outline" className="font-mono text-xs">
              {f}
            </Badge>
          ))}
        </div>
      </div>
    </Card>
  );
}

/** "Para integrar": endpoint e IDs da conta, para outro sistema falar com o mesmo número. */
export function ParaIntegrarOficial({ estado }: { estado: OfficialChannelState }) {
  const t = useT();
  if (!estado.connected) return null;
  return (
    <ParaIntegrar
      campos={[
        { rotulo: t("Endpoint da API"), valor: estado.endpoint ?? null },
        { rotulo: t("ID do número de telefone"), valor: estado.phoneNumberId ?? null },
        { rotulo: t("ID da conta do WhatsApp Business"), valor: estado.wabaId ?? null },
      ]}
      ajuda={
        <div className="space-y-1.5">
          <p>
            {t(
              "O token de acesso é criado no painel da Meta: Configurações do Business → Usuários do sistema → gerar token permanente.",
            )}
          </p>
          <p>
            {t(
              "O webhook de um número aponta para um só destino. Para os dois CRMs receberem ao mesmo tempo, um deles precisa reencaminhar as mensagens ao outro.",
            )}
          </p>
        </div>
      }
      aviso={
        <>
          {t("Um número tem um único webhook.")}{" "}
          {t("Para operar em dois CRMs ao mesmo tempo, configure o reencaminhamento de mensagens.")}
        </>
      }
    />
  );
}

/**
 * Conectar (ou trocar a credencial) à mão, com os três valores do app na Meta.
 *
 * `channelSessionId` presente = troca a credencial DAQUELA conexão (Gerenciar); ausente = o número
 * decide (mesmo número, mesma linha; número novo, conexão nova). Só a conexão NOVA é barrada pelo teto
 * do plano: trocar a credencial de uma que já existe não cria linha.
 */
export function FormularioOficialManual({
  bloqueio,
  jaConectado = false,
  hasToken = false,
  channelSessionId,
}: {
  bloqueio?: BloqueioDoBotao;
  /** A conexão já existe: o título passa a "Trocar credencial" e o teto do plano não vale. */
  jaConectado?: boolean;
  hasToken?: boolean;
  channelSessionId?: string;
}) {
  const t = useT();
  const conectar = useConnectOfficialChannel();
  const [form, setForm] = useState({ phone_number_id: "", waba_id: "", token: "" });
  const travadoPeloPlano = !jaConectado && Boolean(bloqueio?.desabilitado);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    const r = await conectar.mutateAsync(
      channelSessionId ? { ...form, channel_session_id: channelSessionId } : form,
    );
    toast.success(`${t("Conectado:")} ${r.data.displayName} ${r.data.phoneNumber ?? ""}`.trim());
    // O token some do formulário assim que grava — deixá-lo na tela seria mantê-lo
    // em memória do navegador sem motivo, e ele não volta em nenhum GET.
    setForm((f) => ({ ...f, token: "" }));
  }

  return (
    <Card className="p-4" data-testid="formulario-oficial-manual">
      <h2 className="font-medium">
        {jaConectado ? t("Trocar credencial") : t("Conectar canal oficial")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("Os três valores vêm do seu app na Meta (")}
        <strong>WhatsApp → {t("Configuração da API")}</strong>
        {t("). A credencial é")} <strong>{t("validada com a Meta antes de ser gravada")}</strong>
        {t(" — se o número não responder, nada é salvo.")}
      </p>

      <form onSubmit={enviar} className="mt-4 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`pnid${channelSessionId ?? ""}`}>{t("ID do número de telefone")}</Label>
          <Input
            id={`pnid${channelSessionId ?? ""}`}
            value={form.phone_number_id}
            onChange={(e) => setForm((f) => ({ ...f, phone_number_id: e.target.value }))}
            placeholder="1103328999528818"
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`waba${channelSessionId ?? ""}`}>
            {t("ID da conta do WhatsApp Business")}
          </Label>
          <Input
            id={`waba${channelSessionId ?? ""}`}
            value={form.waba_id}
            onChange={(e) => setForm((f) => ({ ...f, waba_id: e.target.value }))}
            placeholder="2434045433735175"
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`tok${channelSessionId ?? ""}`}>{t("Token de acesso")}</Label>
          <Input
            id={`tok${channelSessionId ?? ""}`}
            type="password"
            value={form.token}
            onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
            placeholder={hasToken ? t("•••• (já guardado — preencha para trocar)") : "EAAG…"}
            required
          />
          <span className="text-xs text-muted-foreground">
            {t("Guardado cifrado. Não é exibido de volta em nenhum momento.")}
          </span>
        </div>
        <Button
          type="submit"
          disabled={conectar.isPending || travadoPeloPlano}
          title={travadoPeloPlano ? (bloqueio?.motivo ?? undefined) : undefined}
          data-testid="btn-conectar"
        >
          {conectar.isPending ? t("Validando com a Meta…") : t("Validar e conectar")}
        </Button>
        {travadoPeloPlano && (
          <AvisoDeLimiteDeConexoes motivo={bloqueio?.motivo} className="text-xs text-destructive" />
        )}
      </form>
    </Card>
  );
}
