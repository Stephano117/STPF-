import { defineConfig } from 'prisma/config';

// L'URL n'est requise que pour les commandes qui touchent la base (migrate, studio).
// `prisma generate` fonctionne sans elle.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // DIRECT_URL (connexion non poolée) est préférable pour les migrations Neon.
    url: process.env.DIRECT_URL || process.env.DATABASE_URL || 'postgresql://stf:stf@localhost:5432/stf',
  },
});
