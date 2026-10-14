# Serviço `backup` do EasyPanel: backup diário do banco de produção (Supabase Cloud),
# cifrado com age e enviado ao Google Drive. A imagem é montada pelo GitHub Actions
# (.github/workflows/backup-image.yml); a VPS só baixa.
#
# postgres:17-alpine porque o pg_dump tem de ser da mesma major do banco (17).
FROM postgres:17-alpine

RUN apk add --no-cache rclone age tzdata bash

COPY rodar.sh /usr/local/bin/rodar.sh
RUN chmod 755 /usr/local/bin/rodar.sh \
 && mkdir -p /backups \
 && chown postgres:postgres /backups

# Roda como o usuário `postgres` da imagem (não root). Volume nomeado montado em
# /backups herda o dono desta pasta e funciona. Se o EasyPanel montar o volume como
# root (bind mount), ajuste a permissão do volume ou rode o serviço com `user: root`.
USER postgres
ENTRYPOINT ["/usr/local/bin/rodar.sh"]
