"use client";
import { useState } from "react";
import { toast } from "sonner";

import { useBarraDeSalvar } from "@/components/configuracoes/grupo-de-salvar";
import { SecaoDaConfiguracao } from "@/components/configuracoes/secao-da-configuracao";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updateProfile } from "@/app/actions/settings/updateProfile";
import { useT } from "@/hooks/i18n/useT";
import { IDIOMAS_COM_TEXTO, IDIOMAS_VISIVEIS } from "@/lib/i18n/registro";
import {
  profileSchema,
  SEM_PREFERENCIA_DE_IDIOMA,
  type Locale,
} from "@/lib/schemas/settings";
import { FUSOS_OFERECIDOS } from "@/lib/tempo/fusos";

// A mesma lista de toda tela de fuso — ver `lib/tempo/fusos.ts`.
const TIMEZONES = FUSOS_OFERECIDOS.map((f) => f.codigo);

interface Props {
  email: string;
  initialFullName: string | null;
  initialAvatarUrl: string | null;
  initialLocale: Locale | typeof SEM_PREFERENCIA_DE_IDIOMA;
  initialTimezone: string;
}

export function ProfileForm({
  email,
  initialFullName,
  initialAvatarUrl,
  initialLocale,
  initialTimezone,
}: Props) {
  const t = useT();
  const inicial = {
    fullName: initialFullName ?? "",
    locale: initialLocale,
    timezone: initialTimezone,
    avatarUrl: initialAvatarUrl ?? "",
  };
  const [salvo, setSalvo] = useState(inicial);
  const [fullName, setFullName] = useState(inicial.fullName);
  const [locale, setLocale] = useState<Locale | typeof SEM_PREFERENCIA_DE_IDIOMA>(inicial.locale);
  const [timezone, setTimezone] = useState(inicial.timezone);
  const [avatarUrl, setAvatarUrl] = useState(inicial.avatarUrl);

  const sujo =
    fullName !== salvo.fullName ||
    locale !== salvo.locale ||
    timezone !== salvo.timezone ||
    avatarUrl !== salvo.avatarUrl;

  const { barra, enviar, salvando } = useBarraDeSalvar({
    sujo,
    descartar: () => {
      setFullName(salvo.fullName);
      setLocale(salvo.locale);
      setTimezone(salvo.timezone);
      setAvatarUrl(salvo.avatarUrl);
    },
    salvar: async () => {
      const parsed = profileSchema.safeParse({
        full_name: fullName || null,
        locale,
        timezone,
        avatar_url: avatarUrl || null,
      });
      if (!parsed.success) {
        toast.error(t("Dados inválidos."));
        return "invalido";
      }
      const r = await updateProfile(parsed.data);
      if (r.ok) {
        setSalvo({ fullName, locale, timezone, avatarUrl });
        toast.success(t("Perfil atualizado."));
        return "salvo";
      }
      toast.error(`${t("Erro")}: ${r.error}`);
      return "falhou";
    },
  });

  return (
    <form onSubmit={enviar} className="flex max-w-xl flex-col gap-6">
      <SecaoDaConfiguracao id="sec-dados" titulo={t("Seus dados")}>
        <div className="space-y-2">
          <Label htmlFor="email">{t("Email")}</Label>
          <Input id="email" value={email} disabled />
          <p className="text-xs text-muted-foreground">
            {t("Trocar email — em breve.")}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="full_name">{t("Nome completo")}</Label>
          <Input
            id="full_name"
            value={fullName}
            disabled={salvando}
            onChange={(e) => setFullName(e.target.value)}
            maxLength={120}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="avatar_url">{t("Avatar URL")}</Label>
          <Input
            id="avatar_url"
            type="url"
            placeholder="https://…"
            value={avatarUrl}
            disabled={salvando}
            onChange={(e) => setAvatarUrl(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {t("Upload de arquivo — em breve. Cole uma URL pública.")}
          </p>
        </div>
      </SecaoDaConfiguracao>

      <SecaoDaConfiguracao id="sec-idioma" titulo={t("Idioma e fuso horário")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="locale">{t("Idioma")}</Label>
            <Select value={locale} onValueChange={(v) => setLocale(v as Locale)} disabled={salvando}>
              <SelectTrigger id="locale">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SEM_PREFERENCIA_DE_IDIOMA}>
                  {t("Seguir o idioma da empresa")}
                </SelectItem>
                {/* A lista vem do registro, e só com o que o nível deixa
                    aparecer. Oferecer um idioma que não muda a tela é prometer
                    o que ela não cumpre — `en-US` saiu por isso, e um idioma
                    em construção fica fora pela mesma razão. */}
                {idiomasDoSeletor(initialLocale).map(({ codigo, nomeNativo }) => (
                  <SelectItem key={codigo} value={codigo}>
                    {nomeNativo}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="timezone">{t("Fuso horário")}</Label>
            <Select value={timezone} onValueChange={setTimezone} disabled={salvando}>
              <SelectTrigger id="timezone">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </SecaoDaConfiguracao>

      {barra}
    </form>
  );
}

// Espanhol e inglês saíram do seletor (17/11/2026), mas quem já tinha um deles gravado
// continua vendo-o aqui: sem isso o Select mostraria pt-BR e salvar outro campo
// trocaria o idioma da conta sem a pessoa ter pedido.
function idiomasDoSeletor(gravado: string) {
  if (IDIOMAS_VISIVEIS.some((i) => i.codigo === gravado)) return IDIOMAS_VISIVEIS;
  // Só um idioma que o produto ainda escreve (`IDIOMAS`: es, en); nunca tr nem zh-CN.
  const extra = IDIOMAS_COM_TEXTO.find((i) => i.codigo === gravado);
  return extra ? [...IDIOMAS_VISIVEIS, extra] : IDIOMAS_VISIVEIS;
}
