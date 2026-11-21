# Guide de déploiement (offres gratuites)

Durée : environ une heure. Aucun moyen de paiement n'est nécessaire.
Les quotas cités sont ceux relevés en novembre 2026 : revérifiez-les à l'ouverture des comptes.

## 1. Comptes à créer

| Service | Usage | Adresse |
|---|---|---|
| GitHub | Code, déploiement automatique, sauvegarde nocturne | github.com |
| Neon | Base PostgreSQL | neon.com |
| Backblaze B2 | Stockage des fichiers | backblaze.com |
| Cloudflare | Hébergement de l'application | cloudflare.com |

Utilisez une adresse e-mail de l'entreprise et activez la double authentification partout :
ces quatre comptes donnent accès à tous les documents.

## 2. Base de données (Neon)

1. Créez un projet, région européenne (Francfort), PostgreSQL 17.
2. Dans **Connect**, relevez deux chaînes de connexion :
   - **Pooled** (hôte contenant `-pooler`) → ce sera `DATABASE_URL` ;
   - **Direct** → ce sera `DIRECT_URL` (migrations et sauvegardes).

## 3. Stockage (Backblaze B2)

1. Créez un bucket **privé**, par exemple `spt-fichiers-<entreprise>`, chiffrement activé.
   Notez son **Endpoint** (ex. `s3.eu-central-003.backblazeb2.com`) ; la région est la partie
   centrale (`eu-central-003`).
2. **Application Keys → Add a New Application Key**, limitée à ce bucket, lecture et écriture.
   Notez `keyID` (→ `S3_ACCESS_KEY_ID`) et `applicationKey` (→ `S3_SECRET_ACCESS_KEY`),
   affichée une seule fois.
3. Autorisez le navigateur à envoyer les fichiers directement (règle CORS). Avec l'outil `b2` :

   ```bash
   b2 bucket update --cors-rules '[{
     "corsRuleName": "spt",
     "allowedOrigins": ["https://spt.VOTRE-SOUS-DOMAINE.workers.dev"],
     "allowedOperations": ["s3_put", "s3_get", "s3_head"],
     "allowedHeaders": ["*"],
     "exposeHeaders": ["ETag"],
     "maxAgeSeconds": 3600
   }]' spt-fichiers-<entreprise> allPrivate
   ```

   Sans cette règle, les imports échouent depuis le navigateur.
4. Dans **Caps & Alerts**, renseignez un e-mail d'alerte. Sans moyen de paiement, un plafond
   atteint provoque des erreurs jusqu'au lendemain, jamais une facture.

## 4. Configuration

Dans `apps/api/wrangler.jsonc`, section `vars`, adaptez :

- `APP_ORIGIN` : adresse publique de l'application (connue après le premier déploiement,
  de la forme `https://spt.<sous-domaine>.workers.dev`) ;
- `S3_ENDPOINT` (avec `https://`), `S3_REGION`, `S3_BUCKET`.

## 5. Premier déploiement

```bash
npm install
npx wrangler login

# Schéma de la base (URL directe)
#   PowerShell : $env:DIRECT_URL="postgresql://..." ; npm run db:deploy
DIRECT_URL="postgresql://..." npm run db:deploy

# Secrets (jamais dans le dépôt)
cd apps/api
npx wrangler secret put DATABASE_URL            # URL « pooled »
npx wrangler secret put S3_ACCESS_KEY_ID
npx wrangler secret put S3_SECRET_ACCESS_KEY
npx wrangler secret put MAINTENANCE_TOKEN       # 64 caractères aléatoires
cd ../..

npm run deploy:cloudflare
```

Wrangler affiche l'adresse publique. Si elle diffère de `APP_ORIGIN`, corrigez `wrangler.jsonc`
et la règle CORS du bucket, puis relancez `npm run deploy:cloudflare`.

## 6. Premier administrateur

```bash
# PowerShell : $env:DIRECT_URL="postgresql://..." ; $env:PASSWORD_ITERATIONS="10000" ; npm run create-admin
DIRECT_URL="postgresql://..." PASSWORD_ITERATIONS=10000 npm run create-admin
```

Connectez-vous : les collaborateurs peuvent dès lors demander un accès, que vous validez dans
**Administration → Inscriptions**.

## 7. Vérification — obligatoire

```bash
# PowerShell : $env:VERIFY_EMAIL="..." ; $env:VERIFY_PASSWORD="..." ; npm run verify:prod -- https://...
VERIFY_EMAIL="admin@entreprise.fr" VERIFY_PASSWORD="..." npm run verify:prod -- https://spt.<sous-domaine>.workers.dev
```

Le script contrôle la santé, les en-têtes de sécurité, puis exécute un cycle réel : cinq
connexions, un import par URL signée, un téléchargement comparé octet pour octet, une suppression.
**Ne considérez pas l'application en production tant qu'il n'affiche pas « Tous les contrôles
exécutés ont réussi ».** Testez ensuite un import de plus de 16 Mo depuis le navigateur (envoi en
plusieurs parties).

### Si la limite CPU de Workers Free est dépassée

Symptôme : erreur 1102 ou « Worker exceeded resource limits ». Dans l'ordre :

1. Baissez `PASSWORD_ITERATIONS` à `2000` dans `wrangler.jsonc` et redéployez. La protection
   principale reste l'étirement fait par le navigateur (600 000 itérations) ; les empreintes
   existantes sont recalculées à la connexion suivante.
2. Si des routes autres que la connexion échouent, l'offre gratuite ne suffit pas pour Prisma :
   passez à Workers Paid (5 $/mois, 30 s de CPU) ou hébergez la version Node.js
   (voir [MIGRATION.md](MIGRATION.md)) — le code est le même.

## 8. Automatisation (GitHub)

Poussez le dépôt sur GitHub (dépôt **privé**), puis dans **Settings → Secrets and variables →
Actions** ajoutez :

| Secret | Valeur |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Jeton créé avec le modèle « Edit Cloudflare Workers » |
| `CLOUDFLARE_ACCOUNT_ID` | Identifiant du compte Cloudflare |
| `DIRECT_URL` | URL directe Neon |
| `APP_URL` | Adresse publique de l'application |

Dès lors : chaque poussée sur `main` teste puis déploie (`deploy.yml`) ; la disponibilité est
contrôlée toutes les 6 heures et la base sauvegardée chaque nuit (`exploitation.yml`). Un échec
envoie un e-mail au propriétaire du dépôt. La maintenance quotidienne (corbeille, imports
abandonnés) est assurée par le cron du Worker.

## 9. Surveillance au quotidien

**Administration → État** affiche la santé de la base et du stockage, les taux de remplissage, les
erreurs récentes et les alertes de saturation (75 % et 90 %).

Points à surveiller sur les offres gratuites :

| Limite | Conséquence | Parade |
|---|---|---|
| Neon : 5 Go de transfert et 100 CU-h par mois | Base suspendue jusqu'au mois suivant | L'application ne fait transiter aucun fichier par la base ; surveillez le tableau de bord Neon |
| Neon : 1 Go de données | Écritures bloquées | Alerte dans État ; le journal d'activité est le principal consommateur |
| B2 : 1 Go de téléchargement par jour | Téléchargements en erreur jusqu'à minuit GMT | Prévenir les utilisateurs ; étaler les sauvegardes complètes |
| B2 : 10 Go stockés | Imports refusés par l'application à 9 Go | Purger la corbeille, ajuster `STORAGE_QUOTA_BYTES` |
| Workers : 100 000 requêtes par jour | Application indisponible jusqu'à minuit UTC | Très au-delà de l'usage d'une PME ; visible dans le tableau de bord Cloudflare |

## 10. Variante : serveur local de l'entreprise

L'application ne dépend d'aucun fournisseur : les sections 1 à 9 décrivent la mise en ligne sur
des offres gratuites, mais le même code tourne sur un serveur de l'entreprise. Les points 2 et 3
(Neon, Backblaze) sont alors remplacés par des services installés sur place.

**Prérequis sur le serveur**

| Composant | Rôle | Remarque |
|---|---|---|
| Node.js 22 ou plus | Exécution de l'application | `node --version` |
| PostgreSQL 16 ou plus | Base de données | Une base et un utilisateur dédiés |
| Un stockage compatible S3 (MinIO, Garage, Ceph) | Fichiers déposés | Un compartiment dédié ; l'application ne stocke rien sur le disque local |

**Mise en service**

```
npm ci
npm run build                 # interface + API (apps/api/dist/node.js)
npm run db:deploy             # schéma de la base
npm run create-admin          # premier compte administrateur
npm run start -w apps/api     # démarrage (port défini par PORT, 8787 par défaut)
```

Le processus sert à la fois l'API et l'interface web : un seul port à exposer. Confiez son
redémarrage automatique à un service système (`systemd` sous Linux, NSSM sous Windows).

**Configuration** — reprendre `.env.example` à la racine, en adaptant :

| Variable | Valeur sur un serveur interne |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | URL du PostgreSQL local |
| `S3_ENDPOINT` | Adresse du stockage S3 interne |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Identifiants du compartiment |
| `APP_ORIGIN` | Adresse exacte par laquelle les postes accèdent à l'application |
| `COOKIE_SECURE` | `true` dès que l'accès se fait en HTTPS |
| `TRUST_PROXY` | `true` uniquement derrière un reverse proxy interne (nginx, Caddy) |
| `STORAGE_QUOTA_BYTES`, `DATABASE_QUOTA_BYTES` | Capacité réelle du serveur — les quotas gratuits ne s'appliquent plus |

**Ce qui change par rapport à l'hébergement Cloudflare**

- `deploy.yml` (Workers) ne sert plus : la mise à jour se fait par `git pull` puis les commandes
  ci-dessus. Le workflow reste dans le dépôt, en déclenchement manuel.
- Les tâches planifiées de `exploitation.yml` sont à remplacer par des tâches du serveur
  (sauvegardes : voir `docs/SAUVEGARDE.md`).
- Les limites du tableau de la section 9 disparaissent ; la capacité devient celle du disque.
- Prévoyez une sauvegarde hors du serveur : base **et** fichiers (`npm run backup`).
