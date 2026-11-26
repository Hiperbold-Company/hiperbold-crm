"use server";
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { audit } from '@/lib/audit';
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from '@/lib/auth/server';
import { podeAdministrarEmpresa } from '@/lib/auth/pode-administrar-empresa';
import { ROLE_RANK } from '@/lib/auth/types';
import { supportWriteError } from '@/lib/impersonate/support';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Liga/desliga a transcrição dos áudios recebidos (decisão do dono do produto,
 * 25/11/2026). Gerente para cima, o piso da tela de Atendimento. Ausente
 * continua LIGADO; quem lê é `transcreverAudiosLigado` (worker de mídia e
 * catálogo de recursos opcionais).
 */
export async function definirTranscreverAudios(ligar: boolean): Promise<{ ok: boolean; error?: string }> {
  const entrada = z.boolean().safeParse(ligar);
  if (!entrada.success) return { ok: false, error: 'Entrada inválida.' };
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: 'Sua sessão expirou. Entre de novo.' };
  if (supportWriteError(user.support)) return { ok: false, error: 'Acesso somente leitura.' };
  const org = await resolveActiveOrg(user);
  if (!org || (!podeAdministrarEmpresa(user, org) && ROLE_RANK[org.role] < ROLE_RANK.manager)) {
    return { ok: false, error: 'Só um gerente ou administrador pode mudar esta opção.' };
  }
  if (await mfaEmDivida()) return { ok: false, error: 'Confirme o segundo fator para salvar.' };
  const admin = createAdminClient();
  const { data, error: leitura } = await admin.from('organizations').select('settings').eq('id', org.orgId).maybeSingle();
  if (leitura || !data) return { ok: false, error: 'Não foi possível ler a configuração.' };
  const atual = (data.settings ?? {}) as Record<string, unknown>;
  const crm = (atual.crm ?? {}) as Record<string, unknown>;
  const { data: salva, error } = await admin.from('organizations')
    .update({ settings: { ...atual, crm: { ...crm, transcrever_audios: entrada.data } } })
    .eq('id', org.orgId).eq('settings', JSON.stringify(atual)).select('id').maybeSingle();
  if (error || !salva) return { ok: false, error: 'A configuração mudou ou não pôde ser salva. Recarregue e tente de novo.' };
  await audit({ action: 'crm.transcrever_audios_alterado', actorUserId: user.id, organizationId: org.orgId,
    resourceType: 'organization', resourceId: org.orgId, metadata: { ligado: entrada.data } });
  revalidatePath('/app/settings/atendimento');
  revalidatePath('/app/settings/recursos');
  return { ok: true };
}
