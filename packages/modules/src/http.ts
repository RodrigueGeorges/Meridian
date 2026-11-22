// Transport HTTP des modules : distingue erreur réseau (issue inconnue) et erreur du PSP (issue connue).

export class NetError extends Error {
  constructor(message: string, public causeCode?: string) {
    super(message);
  }
  /** Connexion refusée : la requête n'a pas pu être reçue par le PSP. */
  get refused(): boolean {
    return this.causeCode === 'ECONNREFUSED';
  }
}

export class RemoteError extends Error {
  constructor(public status: number, public code: string | undefined, public body: unknown) {
    super(`PSP ${status}${code ? ` ${code}` : ''}`);
  }
}

function encodeForm(obj: Record<string, unknown>, prefix = '', out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x) => out.append(`${key}[]`, String(x)));
    else if (typeof v === 'object') encodeForm(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  encoding: 'json' | 'form';
  timeoutMs: number;
  errorCodePath: string;
  acceptText?: boolean;
}

export type Fetcher = typeof fetch;

export async function httpCall(req: HttpRequest, fetcher: Fetcher = fetch): Promise<Record<string, unknown>> {
  const headers = { ...req.headers };
  let payload: string | undefined;
  if (req.body && req.method !== 'GET') {
    if (req.encoding === 'form') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = encodeForm(req.body).toString();
    } else {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(req.body);
    }
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
  let res: Response;
  try {
    res = await fetcher(req.url, { method: req.method, headers, body: payload, signal: ctrl.signal });
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause;
    throw new NetError((e as Error).message, cause?.code ?? ((e as Error).name === 'AbortError' ? 'TIMEOUT' : undefined));
  } finally {
    clearTimeout(timer);
  }
  let json: Record<string, unknown> = {};
  const text = await res.text().catch(() => '');
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    if (res.ok && req.acceptText) return { _text: text };
    if (res.ok) throw new NetError('Réponse illisible', 'BAD_BODY');
  }
  if (!res.ok) {
    const code = req.errorCodePath.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), json);
    throw new RemoteError(res.status, typeof code === 'string' ? code : undefined, json);
  }
  return json;
}
