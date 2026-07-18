/**
 * Webhook 送信先を事前検証し、接続時の DNS 解決も同じポリシーで制限する。
 *
 * 汎用の SSRF 対策ライブラリや素の global fetch には置き換えない。接続確立時点での
 * DNS 再検査、`all: true` による全 DNS 応答の検査、`allowedCidrs` を優先しつつ
 * blocked destination を弾く判定順序、redirect の拒否は Hubble の security contract
 * であり、これらを外部ライブラリの API 形状に合わせて再実装すると契約が暗黙化する。
 * DNS lookup は URL 解決時 (`lookup`) と実際の TCP 接続時 (`connectionLookup`) の
 * 2 段階で行う。前者だけでは DNS rebinding (許可判定後にレコードを社内アドレスへ
 * 差し替える攻撃) を防げないため、undici の `Agent` に渡す `connectionLookup` でも
 * 同じ allow/deny 判定をやり直す。
 */
import { lookup as dnsLookup } from 'node:dns';
import { lookup as dnsLookupPromise } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent, type Dispatcher } from 'undici';
import { cidrContains, parseAddress, parseCidrList, type ParsedCidr } from '../auth/cidr';

const BLOCKED_DESTINATIONS = parseCidrList(
  [
    '127.0.0.0/8',
    '::1/128',
    '169.254.0.0/16',
    'fe80::/10',
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    'fc00::/7',
    '0.0.0.0/8',
    '::/128',
    '100.64.0.0/10',
  ].join(','),
);

/** 事前検証でホスト名を全アドレスへ解決する関数。 */
export type WebhookLookup = (hostname: string) => Promise<readonly LookupAddress[]>;

/** egress ガードのポリシーとテスト用依存。 */
export interface SafeFetchOptions {
  fetchImpl?: typeof fetch;
  allowedCidrs: readonly ParsedCidr[];
  allowHttp: boolean;
  timeoutMs: number;
  lookup?: WebhookLookup;
  connectionLookup?: LookupFunction;
}

/** 接続プールを明示終了できる fetch 互換関数。 */
export interface SafeFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

class WebhookEgressError extends Error {}

function isAddressAllowed(address: string, allowedCidrs: readonly ParsedCidr[]): boolean {
  if (parseAddress(address) === undefined) return false;
  if (allowedCidrs.some((cidr) => cidrContains(cidr, address))) return true;
  return !BLOCKED_DESTINATIONS.some((cidr) => cidrContains(cidr, address));
}

function assertAddressesAllowed(
  addresses: readonly LookupAddress[],
  allowedCidrs: readonly ParsedCidr[],
): void {
  if (
    addresses.length === 0 ||
    addresses.some((address) => !isAddressAllowed(address.address, allowedCidrs))
  ) {
    throw new WebhookEgressError('Webhook destination is not allowed');
  }
}

function toUrl(input: string | URL | Request): URL {
  try {
    return new URL(input instanceof Request ? input.url : input);
  } catch (err) {
    throw new WebhookEgressError('Webhook URL is invalid', { cause: err });
  }
}

function findEgressError(error: unknown): WebhookEgressError | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current instanceof WebhookEgressError) return current;
    current = current.cause;
  }
  return undefined;
}

function isRedirectError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.cause instanceof Error &&
    error.cause.message === 'unexpected redirect'
  );
}

async function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** 不要な response body を解放し、解放失敗では元の配送結果を変更しない。 */
export async function cancelResponseBodyBestEffort(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Webhook は status だけで成否を決めるため、body 解放失敗による再配送は行わない。
  }
}

/** Webhook 向け egress ガード付き fetch を生成する。 */
export function createSafeFetch(options: SafeFetchOptions): SafeFetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookup =
    options.lookup ?? ((hostname: string) => dnsLookupPromise(hostname, { all: true }));
  const connectionLookup = options.connectionLookup ?? dnsLookup;

  const guardedConnectionLookup: LookupFunction = (hostname, lookupOptions, callback) => {
    connectionLookup(hostname, { ...lookupOptions, all: true }, (error, result) => {
      if (error) {
        callback(
          new WebhookEgressError('Webhook destination could not be verified', { cause: error }),
          [],
        );
        return;
      }
      if (!Array.isArray(result)) {
        callback(new WebhookEgressError('Webhook destination could not be verified'), []);
        return;
      }
      try {
        assertAddressesAllowed(result, options.allowedCidrs);
        callback(null, result);
      } catch (err) {
        callback(err as Error, []);
      }
    });
  };
  const dispatcher = new Agent({ connect: { lookup: guardedConnectionLookup } });

  const safeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = toUrl(input);
    if (url.protocol !== 'https:' && !(options.allowHttp && url.protocol === 'http:')) {
      throw new WebhookEgressError('Webhook URL scheme is not allowed');
    }

    const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    try {
      const literal = parseAddress(url.hostname);
      if (literal === undefined) {
        let addresses: readonly LookupAddress[];
        try {
          addresses = await waitWithSignal(lookup(url.hostname), signal);
        } catch (err) {
          if (timeoutSignal.aborted) throw err;
          throw new WebhookEgressError('Webhook destination could not be verified', {
            cause: err,
          });
        }
        assertAddressesAllowed(addresses, options.allowedCidrs);
      } else {
        assertAddressesAllowed(
          [{ address: url.hostname, family: literal.version }],
          options.allowedCidrs,
        );
      }

      const requestInit = {
        ...init,
        redirect: 'error' as const,
        signal,
        dispatcher,
      } satisfies RequestInit & { dispatcher: Dispatcher };
      const response = await fetchImpl(input, requestInit);
      if (response.status >= 300 && response.status < 400) {
        await cancelResponseBodyBestEffort(response);
        throw new WebhookEgressError('Webhook redirect is not allowed');
      }
      return response;
    } catch (err) {
      if (timeoutSignal.aborted) {
        throw new WebhookEgressError('Webhook request timed out', { cause: err });
      }
      if (isRedirectError(err)) {
        throw new WebhookEgressError('Webhook redirect is not allowed', { cause: err });
      }
      const egressError = findEgressError(err);
      if (egressError) throw egressError;
      throw err;
    }
  };
  return Object.assign(safeFetch, {
    close: async () => {
      if (dispatcher.closed || dispatcher.destroyed) return;
      await dispatcher.close();
    },
  });
}
