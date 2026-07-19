/**
 * 認証ゲート（AuthGate / AuthRequired）で使う文言の辞書。
 * AuthRequired.tsx は元々 ja 固定文言のみでハードコードされていた
 * （en フォールバックが存在しないバグ）。ここでの en 文言は、
 * 既存の ja 文言の意味を保ったまま新規に起こしたもの。
 */
import { defineDictionary } from '../t';

export const authMessages = defineDictionary({
  verifyingIdentity: { ja: '認証情報を確認中…', en: 'Verifying identity…' },
  verifyIdentityFailed: {
    ja: '本人確認ができませんでした。',
    en: 'Unable to verify your identity.',
  },
  retryButton: { ja: '再試行', en: 'Retry' },
  authRequiredTitle: { ja: '認証が必要です', en: 'Authentication required' },
  authRequiredDescription: {
    ja: 'このセッションは認証されていません。シングルサインオンでログインし直してください。',
    en: "This session isn't authenticated. Please sign in again through single sign-on.",
  },
  reloadButton: { ja: '再読み込み', en: 'Reload' },
} as const);
