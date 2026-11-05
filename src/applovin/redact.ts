export type Redactor = (text: string) => string;

export const REDACTED = '[REDACTED]';

/** Query parameters that carry credentials in AppLovin URLs. */
const SECRET_QUERY_PARAM = /\b(api_key|apikey|management_key)=([^&\s"'<>]+)/gi;

/**
 * Builds a function that strips every known secret, plus any credential-looking
 * query parameter, from free text. Apply it to anything that may reach the LLM,
 * the MCP client or the logs: error messages, response snippets, URLs.
 */
export function createRedactor(secrets: ReadonlyArray<string | undefined>): Redactor {
  // Very short values would redact unrelated text; real AppLovin keys are long.
  const known = secrets
    .filter((s): s is string => typeof s === 'string' && s.length >= 8)
    .sort((a, b) => b.length - a.length);

  return (text: string): string => {
    let out = text.replace(SECRET_QUERY_PARAM, (_m, name: string) => `${name}=${REDACTED}`);
    for (const secret of known) {
      out = out.split(secret).join(REDACTED);
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) out = out.split(encoded).join(REDACTED);
    }
    return out;
  };
}

/** Redacts a URL for logging: credentials removed, everything else kept. */
export function redactUrl(url: URL, redact: Redactor): string {
  return redact(url.toString());
}
