/**
 * 認証ゲートコンポーネントを定義するモジュール。
 *
 * アプリ全体を認証状態でゲートし、未認証時には子要素の代わりに
 * 「認証が必要」画面 (AuthRequired) を表示する役割を持つ。認証の判定は
 * `/api/me` エンドポイントの結果 (useMe) に基づいて行う。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useMe, isUnauthenticated } from '../../hooks/useMe';
import { activatePrincipalStorage } from '../../storage/principalStorage';
import { AuthRequired } from './AuthRequired';
import { useT } from '../../i18n/t';
import { authMessages } from '../../i18n/messages/auth';
import { useHydrateLocaleFromPrincipalStorage } from '../../i18n/locale';

/** identity が同じ page lifetime 内で変わった場合に全 client state を破棄する。 */
function reloadForIdentityChange(): void {
  window.location.reload();
}

interface AuthGateProps {
  children: ReactNode;
  /** テストで page reload を観測するための注入点。 */
  onIdentityChange?: () => void;
}

interface ReadyIdentity {
  principal: string;
  scope: string;
}

/**
 * アプリ全体を認証状態に応じて出し分けるコンポーネント。
 * `/api/me` を認証状態の正規のプローブとして扱う。`proxy` モードでは、
 * 直接アクセスやセッション期限切れなど未認証のリクエストは 401
 * UNAUTHENTICATED を返すため、その場合はアプリ全体の UI を「認証が必要」
 * 画面に差し替える。`none` モードでは `/api/me` が常に成功するため、この
 * ゲートは実質的に素通り (透過) になる。
 *
 * プローブと principal namespace の準備が終わるまでは子要素を描画しない。
 * 認証主体が決まる前に前利用者の browser state を復元しないためである。
 *
 * @param children ゲートを通過した場合に描画する子要素 (アプリ本体)。
 * @param onIdentityChange 同じ page 内で認証主体が変わった場合の再読み込み処理。
 */
export function AuthGate({ children, onIdentityChange = reloadForIdentityChange }: AuthGateProps) {
  const t = useT(authMessages);
  const { data, error, refetch } = useMe();
  const [readyIdentity, setReadyIdentity] = useState<ReadyIdentity | null>(null);
  const [failedPrincipal, setFailedPrincipal] = useState<string | null>(null);
  const [activationAttempt, setActivationAttempt] = useState(0);
  const principal = data?.user;
  const storageScope = data?.storageScope;
  const authMode = data?.authMode;
  const activationError = principal !== undefined && failedPrincipal === principal;

  useEffect(() => {
    if (!principal || !storageScope || !authMode) return;
    let active = true;
    void Promise.resolve()
      .then(() => activatePrincipalStorage(principal, storageScope, authMode))
      .then((result) => {
        if (!active) return;
        if (result.kind === 'identity-changed') {
          onIdentityChange();
          return;
        }
        setFailedPrincipal(null);
        setReadyIdentity({
          principal,
          scope: result.scope,
        });
      })
      .catch(() => {
        if (active) setFailedPrincipal(principal);
      });
    return () => {
      active = false;
    };
  }, [activationAttempt, authMode, onIdentityChange, principal, storageScope]);

  // principal storage の有効化が完了したかどうか（子要素を描画する条件と同じ判定）。
  // LocaleProvider は AuthGate より外側にマウントされるため、その初期化
  // （detectInitialLocale）は有効化前に走り保存済みロケールを読めない。
  // 有効化完了のこのタイミングで一度だけ、保存済みロケールを読み直して反映する
  // （レビュー指摘対応、i18n/locale.tsx 冒頭コメント参照）。
  const identityReady =
    Boolean(data) &&
    readyIdentity?.principal === data?.user &&
    readyIdentity?.scope === data?.storageScope;
  useHydrateLocaleFromPrincipalStorage(identityReady);

  // エラーが「未認証」を示す場合は、アプリ本体の代わりに認証要求画面を表示する。
  if (isUnauthenticated(error)) return <AuthRequired />;

  if (
    !data ||
    readyIdentity?.principal !== data.user ||
    readyIdentity.scope !== data.storageScope
  ) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-surface-base text-sm text-ink-muted">
        <span>{activationError || error ? t('verifyIdentityFailed') : t('verifyingIdentity')}</span>
        {(activationError || error) && (
          <button
            type="button"
            className="rounded border border-border-base px-3 py-1.5 text-ink-base"
            onClick={() => {
              if (activationError) setActivationAttempt((attempt) => attempt + 1);
              else void refetch();
            }}
          >
            {t('retryButton')}
          </button>
        )}
      </div>
    );
  }

  // 認証済み主体の storage namespace が確定した後だけ子要素を描画する。
  return <>{children}</>;
}
