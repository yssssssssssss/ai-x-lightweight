import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { closePool, pool } from './db.ts';
import { runDatabaseMigrations } from './migration-entry.ts';
import { planMigrations } from './migration-runner.ts';
import { createPostgresMigrationDatabase } from './postgres-migration-database.ts';

const migrationsDir = resolve(
  process.env.MIGRATIONS_DIR?.trim() || 'database/migrations',
);

export async function main(): Promise<void> {
  if (process.argv.includes('--dry-run')) {
    const plan = planMigrations(migrationsDir);
    console.log(`migration dry-run: ${plan.migrations.length} files`);
    for (const migration of plan.migrations) {
      console.log(`  [plan] ${migration.version} ${migration.fileName} ${migration.checksum}`);
    }
    return;
  }

  console.log('running migrations...');
  const result = await runDatabaseMigrations(
    createPostgresMigrationDatabase(pool),
    migrationsDir,
    console.log,
  );
  console.log(`done. applied=${result.applied.length} skipped=${result.skipped.length}`);
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  main()
    .catch((err) => {
      console.error('migration failed:', err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(closePool);
}
