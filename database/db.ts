import { Pool } from 'pg';

// 加载 .env(若存在)。Node 20.12+ 内置 loadEnvFile;缺失时用各处默认值。
export function loadEnv(): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    // .env 不存在:V0 各处均有默认值(见 .env.example),不阻塞。
  }
}
loadEnv();

const configuredDatabaseUrl = process.env.DATABASE_URL?.trim();
if (process.env.NODE_ENV === 'production' && !configuredDatabaseUrl) {
  throw new Error('DATABASE_URL is required when NODE_ENV=production');
}

// 单一连接池:所有 DB 访问经此。
const connectionString = configuredDatabaseUrl || 'postgres://localhost:5432/user_research_ai';

export let pool = new Pool({ connectionString });

export async function closePool(): Promise<void> {
  const previous = pool;
  await previous.end();
  pool = new Pool({ connectionString });
}
