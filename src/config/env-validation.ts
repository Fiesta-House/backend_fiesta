const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'GROQ_API_KEY',
  'AUTH_JWT_SECRET',
] as const;

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^your_/i,
  /^changeme$/i,
  /^example$/i,
  /^placeholder$/i,
  /^test$/i,
  /^dummy$/i,
  /^<.*>$/,
  /\.{3}/,
];

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function validateGoogleServiceKey(rawValue: string): string[] {
  const errors: string[] = [];

  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== 'object') {
      errors.push('GOOGLE_SERVICE_ACCOUNT_KEY must be valid JSON object');
      return errors;
    }

    if (!parsed.client_email) {
      errors.push('GOOGLE_SERVICE_ACCOUNT_KEY is missing client_email');
    }

    if (!parsed.private_key || !String(parsed.private_key).includes('BEGIN PRIVATE KEY')) {
      errors.push('GOOGLE_SERVICE_ACCOUNT_KEY is missing a valid private_key');
    }
  } catch {
    errors.push('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON');
  }

  return errors;
}

export function validateStartupEnv(): void {
  const errors: string[] = [];

  for (const key of REQUIRED_ENV_VARS) {
    const value = process.env[key];
    if (!value || !value.trim()) {
      errors.push(`${key} is required`);
      continue;
    }
    if (isPlaceholder(value)) {
      errors.push(`${key} is using a placeholder value`);
    }
  }

  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey && !groqKey.startsWith('gsk_')) {
    errors.push('GROQ_API_KEY must start with gsk_');
  }
  const groqBackupKey = process.env.GROQ_2;
  if (groqBackupKey && !groqBackupKey.startsWith('gsk_')) {
    errors.push('GROQ_2 must start with gsk_');
  }

  const authJwtSecret = process.env.AUTH_JWT_SECRET;
  if (authJwtSecret && authJwtSecret.length < 32) {
    errors.push('AUTH_JWT_SECRET must be at least 32 characters long');
  }

  const chatSessionSecret = process.env.CHAT_SESSION_SECRET;
  if (chatSessionSecret && chatSessionSecret.trim() && chatSessionSecret.trim().length < 32) {
    errors.push('CHAT_SESSION_SECRET must be at least 32 characters long');
  }

  // M-Pesa callback hardening. Daraja does not sign callbacks, so production
  // must carry a secret in the callback URL (see middleware/mpesa-callback-guard.ts).
  const mpesaCallbackUrl = process.env.MPESA_CALLBACK_URL?.trim();
  const mpesaCallbackSecret = process.env.MPESA_CALLBACK_SECRET?.trim();
  const mpesaProduction =
    String(process.env.MPESA_ENVIRONMENT || '').trim().toLowerCase() === 'production' ||
    String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
  if (mpesaProduction) {
    if (mpesaCallbackUrl && !isPlaceholder(mpesaCallbackUrl)) {
      if (!mpesaCallbackSecret || mpesaCallbackSecret.length < 24) {
        errors.push('MPESA_CALLBACK_SECRET (at least 24 characters) is required in production when MPESA_CALLBACK_URL is set');
      } else if (!mpesaCallbackUrl.includes(`/callback/${mpesaCallbackSecret}`)) {
        errors.push('MPESA_CALLBACK_URL must end with /api/mpesa/callback/<MPESA_CALLBACK_SECRET> in production');
      }
    } else if (!mpesaCallbackSecret) {
      console.warn('[ENV] MPESA_CALLBACK_SECRET is not set: the M-Pesa callback endpoint will reject every request in production.');
    }
  }

  const pineconeKey = process.env.PINECONE_API_KEY;
  if (pineconeKey && isPlaceholder(pineconeKey)) {
    errors.push('PINECONE_API_KEY is using a placeholder value');
  }

  const googleServiceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (googleServiceAccountKey && googleServiceAccountKey.trim()) {
    errors.push(...validateGoogleServiceKey(googleServiceAccountKey));
  }

  if (errors.length > 0) {
    console.error('\n[ENV] Startup configuration validation failed:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    console.error('\n[ENV] Tip: copy values from .env.example and fill real credentials.');
    process.exit(1);
  }

  const dbConfigured = Boolean(process.env.DATABASE_URL);
  const pineconeConfigured = Boolean(process.env.PINECONE_API_KEY);
  const groqConfigured = Boolean(groqKey);
  const groqBackupConfigured = Boolean(groqBackupKey);
  const geminiConfigured = Boolean(process.env.GEMINI_API_KEY);
  const geminiBackupConfigured = Boolean(process.env.GEMINI_BACKUP2);
  const openrouterConfigured = Boolean(process.env.OPENROUTER_API_KEY);
  console.log(`[ENV] Validation passed (DATABASE_URL=${dbConfigured}, GROQ_API_KEY=${groqConfigured}, GROQ_2=${groqBackupConfigured}, GEMINI_API_KEY=${geminiConfigured}, GEMINI_BACKUP2=${geminiBackupConfigured}, OPENROUTER=${openrouterConfigured}, PINECONE_API_KEY=${pineconeConfigured})`);
}
