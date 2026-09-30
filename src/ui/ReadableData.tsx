import { Check, X } from 'lucide-react';

/*
 * Structured results (a job's output, a demo brief) as a readable list instead of raw JSON
 * (docs/COPY_GLOSSARY.md: raw payloads only under Details). Pure rendering; the values stay untrusted text.
 */

/** "sourceCharacters" → "Source characters", "follow_up" → "Follow up". */
export function readableKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .toLowerCase()
    .trim();
  const special: Record<string, string> = {
    'source urls': 'Sources',
    urls: 'Links',
    'source characters': 'Length of the text',
    'key points': 'Key points',
  };
  return special[words] ?? words.charAt(0).toUpperCase() + words.slice(1);
}

/** Fields that describe how a result was made rather than what it says. */
const HIDDEN = new Set(['execution', 'schema', 'version', 'capability']);

function Value({ value, depth }: { value: unknown; depth: number }) {
  if (value === null || value === undefined || value === '') return <span>None</span>;
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  if (typeof value === 'number' || typeof value === 'string') return <span>{String(value)}</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span>None</span>;
    return (
      <ul className="readable-list">
        {value.slice(0, 50).map((item, index) => (
          <li key={index}>
            <Item value={item} depth={depth + 1} />
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === 'object' && depth < 3)
    return <Fields data={value as Record<string, unknown>} depth={depth + 1} />;
  return <span>More detail is in the raw data below.</span>;
}

/** One list entry: a check ("name" + "passed"), a key/value pair, or a plain value. */
function Item({ value, depth }: { value: unknown; depth: number }) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.name === 'string' && typeof record.passed === 'boolean')
      return (
        <span>
          {record.passed ? (
            <Check size={13} aria-label="Passed" />
          ) : (
            <X size={13} aria-label="Not passed" />
          )}{' '}
          {record.name}
        </span>
      );
    if (typeof record.key === 'string' && 'value' in record)
      return (
        <span>
          <strong>{record.key}:</strong> {String(record.value ?? '')}
        </span>
      );
  }
  return <Value value={value} depth={depth} />;
}

function Fields({ data, depth }: { data: Record<string, unknown>; depth: number }) {
  const entries = Object.entries(data).filter(([key]) => !HIDDEN.has(key));
  if (!entries.length) return <span>None</span>;
  return (
    <dl className={depth === 0 ? 'detail-list readable-data' : 'readable-data'}>
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{readableKey(key)}</dt>
          <dd>
            <Value value={value} depth={depth} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A result in plain form, with the raw data one click away for people who need it. */
export function ReadableData({ data, label }: { data: Record<string, unknown>; label: string }) {
  return (
    <div className="readable" role="group" aria-label={label}>
      <Fields data={data} depth={0} />
      <details className="readable-raw">
        <summary>Raw data</summary>
        <pre className="result-json" tabIndex={0}>
          {JSON.stringify(data, null, 2)}
        </pre>
      </details>
    </div>
  );
}
