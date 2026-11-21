# Sauvegarde et restauration

Un hébergement gratuit n'est pas une sauvegarde : un compte peut être suspendu, un quota dépassé,
une offre retirée. Les sauvegardes SPTF sont **indépendantes des fournisseurs** : des fichiers
ordinaires sur un disque que l'entreprise contrôle, restaurables vers n'importe quel PostgreSQL
et n'importe quel stockage compatible S3.

## Ce qui est sauvegardé

| Donnée | Automatique | Manuel |
|---|---|---|
| Base (comptes, espaces, dossiers, droits, versions, journal) | Chaque nuit par GitHub Actions, conservée 90 jours | `npm run backup` |
| Fichiers des utilisateurs | **Non** | `npm run backup` |

Non sauvegardés, volontairement : sessions, compteurs de limitation, imports en cours, journal
d'erreurs techniques.

**Limite à connaître :** la sauvegarde des fichiers n'est pas automatisable gratuitement de façon
fiable (volume, plafond de téléchargement B2 de 1 Go par jour). Elle doit être lancée depuis un
poste de l'entreprise. Sans elle, une perte du compte Backblaze serait définitive.

## Sauvegarde complète

Sur un poste de l'entreprise, avec le dépôt cloné et un fichier `.env` contenant `DIRECT_URL`
(Neon), les quatre variables `S3_*` de production et `BACKUP_DIR` (disque externe ou partage
réseau, de préférence chiffré) :

```bash
npm run backup
```

Résultat :

```
BACKUP_DIR/
  objects/…                       fichiers des utilisateurs (copiés une seule fois chacun)
  snapshots/<date>/tables/*.jsonl une table par fichier
  snapshots/<date>/manifest.json  inventaire et empreintes SHA-256
```

Le script :

- ne retélécharge que les fichiers nouveaux (les suivantes sont rapides) ;
- compare chaque fichier à l'empreinte enregistrée lors de l'import ;
- **se termine en erreur si un seul élément manque ou diffère**. Il n'affiche « Sauvegarde écrite
  et contrôlée » qu'après relecture.

La première sauvegarde d'un stockage de plusieurs gigaoctets peut buter sur le plafond journalier
de B2 : relancez-la le lendemain, elle reprend où elle s'était arrêtée.

**Rythme conseillé :** une fois par semaine au minimum (Planificateur de tâches Windows ou cron),
avec une seconde copie du dossier hors des locaux une fois par mois.

## Vérification

```bash
npm run backup:verify              # relit la dernière sauvegarde, recalcule toutes les empreintes
npm run backup:verify -- --live    # contrôle en plus que chaque fichier existe bien en production
```

À faire après chaque sauvegarde et avant toute restauration. Un code de sortie non nul signifie
que la sauvegarde ne doit pas être considérée comme valable.

## Récupérer la sauvegarde nocturne de la base

GitHub → **Actions → Exploitation** → dernière exécution réussie → artefact `spt-base-…`.
Décompressez-le dans `BACKUP_DIR/snapshots/`.

## Restauration

Cas d'usage : perte de la base, perte du stockage, erreur humaine massive, changement de
fournisseur.

1. Préparez une base PostgreSQL **vide** et un bucket (ceux d'origine ou de nouveaux).
2. Pointez `.env` vers eux (`DATABASE_URL`, `S3_*`).
3. Vérifiez la sauvegarde : `npm run backup:verify -- --snapshot <dossier>`.
4. Créez le schéma : `npm run db:deploy`.
5. Restaurez :

   ```bash
   npm run restore -- --snapshot backups/snapshots/<date> --yes
   ```

   Options : `--db-only`, `--files-only`, `--objects <dossier>`.
6. Contrôlez : `npm run verify:prod -- <adresse>`.

Garde-fous : le script exige `--yes`, refuse d'écrire dans une base qui contient déjà des
utilisateurs, compare le nombre de lignes de chaque table au manifeste et confirme chaque fichier
envoyé. Après restauration, les utilisateurs se reconnectent avec leur mot de passe habituel.

**Restaurer un seul fichier** supprimé par erreur au-delà de la corbeille : retrouvez sa clé dans
`tables/fileVersion.jsonl` (champ `storageKey`), puis récupérez l'objet dans `objects/<clé>` — c'est
le fichier d'origine, à renommer avec son extension.

## Exercice de restauration

Une sauvegarde jamais restaurée n'est pas une sauvegarde. Une fois par trimestre, restaurez dans
une base Neon de test (branche gratuite) et un bucket de test, puis ouvrez quelques documents.
Ce scénario est aussi rejoué à chaque exécution des tests automatisés (`test/backup.test.ts`).
