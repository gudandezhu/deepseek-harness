export interface RequestHeader {
  name: string
  value: string
}

const COMMENT_PREFIX = '#'
const PAIR_SEPARATOR = ':'

export function parseRequestHeaders(text: string): RequestHeader[] {
  const headers: RequestHeader[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith(COMMENT_PREFIX))
      continue
    const at = line.indexOf(PAIR_SEPARATOR)
    if (at < 0) {
      headers.push({ name: line, value: '' })
      continue
    }
    headers.push({ name: line.slice(0, at).trim(), value: line.slice(at + 1).trim() })
  }
  return headers
}

export function requestHeadersRecord(headers: readonly RequestHeader[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (const header of headers)
    record[header.name] = header.value
  return record
}

export function requestHeadersText(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return ''
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, headerValue]) => `${name}${PAIR_SEPARATOR} ${headerValue}`)
    .join('\n')
}
