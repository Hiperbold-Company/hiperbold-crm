"use client";
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { definirTranscreverAudios } from '@/app/actions/settings/definirTranscreverAudios';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { traduzir } from '@/lib/i18n/dicionario';
import type { Idioma } from '@/lib/i18n/idiomas';

/** Interruptor da empresa: ausente = ligado (`transcreverAudiosLigado`). Gerente para cima. */
export function TranscreverAudios({ ligada, podeMudar, idioma }: { ligada: boolean; podeMudar: boolean; idioma: Idioma }) {
  const [valor, setValor] = useState(ligada);
  const [pendente, startTransition] = useTransition();
  const router = useRouter();
  const t = (texto: string) => traduzir(texto, idioma);
  return <Card className="p-6">
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor="transcrever_audios">{t('Transcrever áudios')}</Label>
        <p className="max-w-2xl text-xs text-muted-foreground">{t('Cada minuto de áudio transcrito pela chave da plataforma desconta 6.000 tokens do plano, e cada áudio conta no máximo 10 minutos. Vale também para a fala dos vídeos. Com a chave da própria empresa em Provedores de IA, nada é descontado do plano.')}</p>
        <p className="text-xs">{valor ? t('Ligado: os áudios recebidos e a fala dos vídeos viram texto na conversa, e o agente de IA lê a transcrição.') : t('Desligado: o áudio e a fala dos vídeos ficam na conversa sem texto, e o agente de IA não recebe a transcrição (os vídeos ainda são lidos pelas imagens).')}</p>
      </div>
      <Switch id="transcrever_audios" checked={valor} disabled={pendente || !podeMudar}
        onCheckedChange={(novo) => startTransition(async () => {
          const r = await definirTranscreverAudios(novo);
          if (!r.ok) { toast.error(t(r.error ?? 'Não foi possível salvar.')); return; }
          setValor(novo); toast.success(t('Opção salva.')); router.refresh();
        })} />
    </div>
  </Card>;
}
