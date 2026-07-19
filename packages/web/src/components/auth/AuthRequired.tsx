/**
 * 「認証が必要」画面コンポーネントを定義するモジュール。
 *
 * API から 401 UNAUTHENTICATED が返された際に、AuthGate から呼び出される
 * 全画面表示のコンポーネントを提供する。ユーザーに再ログインを促す。
 */
import { ShieldAlert } from 'lucide-react';
import { Logo } from '../layout/Logo';
import { EmptyState } from '../common/EmptyState';
import { Button } from '../common/Button';
import { useT } from '../../i18n/t';
import { authMessages } from '../../i18n/messages/auth';

/**
 * 全画面表示の「認証が必要です」状態を表すコンポーネント。
 * API リクエストが 401 UNAUTHENTICATED を返した場合、すなわち
 * oauth2-proxy を経由しない直接アクセスや SSO セッションの期限切れが
 * 発生した場合に表示される。EmptyState の見た目のトーンとデザイン
 * トークンのみを再利用しており、生の HEX 値は使用していない。
 * 「再読み込み」ボタンでページをリロードすると、プロキシの認証フローに
 * 再度入ることになる。
 *
 * このコンポーネントは props を受け取らない。
 */
export function AuthRequired() {
  const t = useT(authMessages);
  return (
    // 画面全体を覆うコンテナ。ロゴと空状態表示を縦に中央揃えで配置する。
    <div className="flex h-screen flex-col items-center justify-center gap-8 bg-surface-base px-6 text-ink-base">
      {/* アプリのロゴ表示 */}
      <Logo />
      {/* 認証が必要である旨のメッセージと、再読み込みを促すアクションボタン */}
      <EmptyState
        icon={ShieldAlert}
        title={t('authRequiredTitle')}
        description={t('authRequiredDescription')}
        action={
          <Button variant="primary" onClick={() => window.location.reload()}>
            {t('reloadButton')}
          </Button>
        }
      />
    </div>
  );
}
