# Migration vers un serveur propriétaire

L'application n'a pas à être réécrite : la version Node.js (`apps/api/src/node.ts`) est celle qui
sert au développement et aux tests. Seuls changent l'hébergement et des variables d'environnement.

## Ce qui dépend d'un fournisseur aujourd'hui

| Élément | Lié à | Équivalent sur serveur propriétaire |
|---|---|---|
| `src/worker.ts`, `wrangler.jsonc` | Cloudflare | `src/node.ts` (déjà présent) |
| Base | Neon | PostgreSQL 15 ou plus, installé sur le serveur |
| Fichiers | Backblaze B2 | MinIO sur le serveur, ou conserver B2 / tout stockage S3 |
| Cron de maintenance | Cron Trigger Workers | Minuterie intégrée à `node.ts` (toutes les 6 h) |
| HTTPS | Cloudflare | Caddy ou Nginx avec Let's Encrypt |

Le code métier (`src/app.ts`, `src/routes`, `src/lib`) est identique dans les deux cas.

## Étapes

### 1. Préparer le serveur

Linux (Ubuntu ou Debian), Node.js 22, PostgreSQL, un nom de domaine. Un VPS de 2 Go de mémoire
suffit pour quelques centaines d'utilisateurs.

```bash
sudo -u postgres createuser --pwprompt spt
sudo -u postgres createdb --owner spt --encoding UTF8 spt
```

Pour les fichiers, installez MinIO (un binaire) avec un bucket privé, ou gardez le bucket B2
existant : dans ce second cas, l'étape 3 ne restaure que la base (`--db-only`).

### 2. Installer l'application

```bash
git clone <dépôt> /opt/spt && cd /opt/spt
npm ci
cp .env.example .env      # puis renseignez les valeurs de production
npm run build
npm run db:deploy
```

Valeurs importantes de `.env` : `NODE_ENV=production`, `DATABASE_URL`, `APP_ORIGIN=https://…`,
`COOKIE_SECURE=true`, `TRUST_PROXY=true`, les `S3_*`, `PASSWORD_ITERATIONS=100000`,
et des quotas à la mesure du disque (`STORAGE_QUOTA_BYTES`, `DATABASE_QUOTA_BYTES`).

### 3. Transférer les données

1. Annoncez une courte interruption, puis passez l'ancienne instance en lecture seule de fait
   (suspendez les imports en prévenant les utilisateurs).
2. Depuis un poste configuré sur l'**ancienne** infrastructure : `npm run backup` puis
   `npm run backup:verify -- --live`.
3. Copiez `BACKUP_DIR` sur le serveur, puis, avec le `.env` de la **nouvelle** infrastructure :

   ```bash
   npm run restore -- --snapshot backups/snapshots/<date> --yes
   ```

Les mots de passe sont conservés. Comme `PASSWORD_ITERATIONS` passe de 10 000 à 100 000, chaque
empreinte est renforcée automatiquement à la première connexion de son propriétaire.

### 4. Lancer en service

`/etc/systemd/system/spt.service` :

```ini
[Unit]
Description=SPTF
After=network.target postgresql.service

[Service]
User=spt
WorkingDirectory=/opt/spt/apps/api
ExecStart=/usr/bin/node --env-file=/opt/spt/.env dist/node.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now spt
```

Proxy HTTPS avec Caddy (`/etc/caddy/Caddyfile`) :

```
spt.entreprise.fr {
    reverse_proxy 127.0.0.1:8787
}
```

Si MinIO est exposé aux navigateurs, donnez-lui son propre sous-domaine en HTTPS et indiquez-le
dans `S3_ENDPOINT`.

### 5. Vérifier puis basculer

```bash
VERIFY_EMAIL=… VERIFY_PASSWORD=… npm run verify:prod -- https://spt.entreprise.fr
```

Une fois tous les contrôles réussis, communiquez la nouvelle adresse. Conservez l'ancienne
infrastructure intacte une à deux semaines avant de la supprimer.

### 6. Après la migration

- Sauvegardes : `npm run backup` par cron vers un disque distinct du serveur, plus une copie hors
  site. Sur serveur propriétaire, `pg_dump` peut s'y ajouter.
- Mises à jour : `git pull && npm ci && npm run build && npm run db:deploy && sudo systemctl restart spt`.
- Les limites des offres gratuites disparaissent : relevez `MAX_FILE_SIZE_BYTES` et les quotas.

## Changer un seul fournisseur

- **Stockage seul** (par exemple B2 → R2) : `npm run backup`, changez les `S3_*`, puis
  `npm run restore -- --snapshot … --files-only --yes`.
- **Base seule** (Neon → autre PostgreSQL) : `npm run backup -- --db-only`, changez
  `DATABASE_URL`, `npm run db:deploy`, puis `npm run restore -- --snapshot … --db-only --yes`.
- **Hébergement seul** : déployez la version Node.js ailleurs avec les mêmes variables ; base et
  fichiers ne bougent pas.
