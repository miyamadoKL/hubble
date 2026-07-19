/**
 * ホバー/フォーカス時に説明ラベルを表示する軽量なツールチップコンポーネントを
 * 提供するモジュール。ポータルを使わず、ローカルな state のみで開閉を管理する。
 * トリガーが画面端付近にあるとき（例: TopBar 右端のロケール切替）、中央寄せの
 * ツールチップがビューポート外へはみ出す問題があったため、表示直後に実測して
 * はみ出し分だけ位置を寄せるクランプ処理を持つ。
 */
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../utils/cn';

/** ツールチップを表示する方向。 */
export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

/**
 * Tooltip コンポーネントの props。
 */
interface TooltipProps {
  /** ツールチップ内に表示する説明内容。 */
  label: ReactNode;
  /** ツールチップの対象となる要素（トリガー）。 */
  children: ReactNode;
  /** ツールチップを表示する方向。デフォルトは 'bottom'。 */
  side?: TooltipSide;
}

// side ごとに、トリガー要素に対するツールチップの位置決めクラスを定義。
// 中央寄せの軸（top/bottom は水平、left/right は垂直）はビューポート境界での
// クランプ対象になるため、対応する translate クラスをここに含めず、実測結果を
// もとに inline style で付与する（下記 clampStyle を参照）。
const sideClasses: Record<TooltipSide, string> = {
  top: 'bottom-full left-1/2 mb-1.5',
  bottom: 'top-full left-1/2 mt-1.5',
  left: 'right-full top-1/2 mr-1.5',
  right: 'left-full top-1/2 ml-1.5',
};

// 中央寄せの軸ごとに、クランプ計算に使う開始/終了座標プロパティとビューポート
// サイズの取得方法を分ける（top/bottom は横方向、left/right は縦方向）。
const centeredAxis: Record<TooltipSide, 'x' | 'y'> = {
  top: 'x',
  bottom: 'x',
  left: 'y',
  right: 'y',
};

// ビューポート端からツールチップを離す最小余白（px）。
const VIEWPORT_MARGIN = 8;

/**
 * 要素の開始/終了座標を、ビューポート境界（両端に margin を確保）へ収めるために
 * 必要な平行移動量を計算する純関数。DOM に依存しないため単体テストしやすい。
 *
 * @param start - 要素の開始座標（クランプ前、viewport 原点基準）。
 * @param end - 要素の終了座標（クランプ前、viewport 原点基準）。
 * @param viewportSize - ビューポートの幅または高さ。
 * @param margin - 境界から確保する最小余白。
 * @returns 適用すべき平行移動量（px）。はみ出しがなければ 0。
 */
export function clampToViewport(
  start: number,
  end: number,
  viewportSize: number,
  margin: number = VIEWPORT_MARGIN,
): number {
  if (end > viewportSize - margin) {
    return viewportSize - margin - end;
  }
  if (start < margin) {
    return margin - start;
  }
  return 0;
}

// Radix Primitives（radix-ui@1.6.2）の Tooltip primitive への置換 PoC は完了した
// （本ファイルを77行から49行へ削減し、useState、useId、4つの event handler を
// 削除できた）が、bundle 全体が8,780,236 bytesから8,826,622 bytesへ46,386 bytes
// 増え、AppShell chunk も404,558 bytesから451,250 bytesへ46,692 bytes増えた。
// production 28行削減に対して lockfile が403行増え、初期 bundle の25KB上限も
// 超えたため、依存と実装差分を撤去してこの手書き実装に戻した。
/**
 * 軽量なツールチップ。ホバーまたはフォーカス時にローカル state (`open`) を
 * 切り替えて表示する（シェル用途のためポータルは使用しない）。
 * 150msのフェードでモーションバジェットに合わせている。
 *
 * @param label - ツールチップ内に表示する説明。
 * @param children - ツールチップを紐づける対象要素。
 * @param side - 表示位置（top/bottom/left/right）。デフォルトは 'bottom'。
 */
export function Tooltip({ label, children, side = 'bottom' }: TooltipProps) {
  // ツールチップの表示/非表示を管理する state
  const [open, setOpen] = useState(false);
  // aria-describedby に使う一意なID（アクセシビリティ用）
  const id = useId();
  // ビューポート境界クランプ用の実測結果（中央寄せ軸方向の追加オフセット px）。
  // 実測前・はみ出しなしのときは 0 で、通常の中央寄せ（-50%）のまま表示される。
  const [clampOffset, setClampOffset] = useState(0);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const axis = centeredAxis[side];

  // 表示直後にツールチップの実サイズと位置を測り、ビューポートからはみ出す分だけ
  // clampOffset を設定する。非表示時は測定不要なので何もしない（clampOffset は
  // 下記の centerTransform 計算側で open が false のときに無視する）。開閉のたびに
  // 再計算するため、トリガー位置が変わる（スクロール、レイアウト変更）場合にも
  // 次回表示時に追随する。
  useLayoutEffect(() => {
    if (!open) return;
    const el = tooltipRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const offset =
      axis === 'x'
        ? clampToViewport(rect.left, rect.right, window.innerWidth)
        : clampToViewport(rect.top, rect.bottom, window.innerHeight);
    setClampOffset(offset);
  }, [open, axis]);

  // 非表示中は実測を行わないため、直前の clampOffset が残っていても中央寄せ
  // （オフセット 0）として扱う。close() が clampOffset 自体も 0 に戻すため
  // 通常は不要な冗長ガードだが、念のため二重に防御しておく。
  const effectiveOffset = open ? clampOffset : 0;
  const centerTransform =
    axis === 'x'
      ? `translateX(calc(-50% + ${effectiveOffset}px))`
      : `translateY(calc(-50% + ${effectiveOffset}px))`;

  // 閉じるときに clampOffset を必ず 0 へリセットする。リセットしないと、
  // 2回目以降の表示で「前回クランプ済みの座標」を基準に再測定してしまい、
  // その座標がすでにビューポート内に収まっているためクランプ不要と判定され、
  // 結果としてクランプが解除された状態（自然な中央寄せ）で再描画されて
  // 再びはみ出す（指摘: 初回 -58px → 再表示で 0px に戻りはみ出す）。閉じる
  // たびに基準をリセットしておけば、次に開いたときの実測は常に「自然な
  // 中央寄せ位置」を基準に行われ、クランプが安定して再適用される。
  const close = () => {
    setOpen(false);
    setClampOffset(0);
  };

  return (
    <span
      className="relative inline-flex"
      // マウスホバーとフォーカスの開始/終了に応じて open を切り替える
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={close}
      onFocus={() => setOpen(true)}
      onBlur={close}
    >
      {/* トリガーとなる子要素。表示中のみ aria-describedby でツールチップに関連付ける */}
      <span aria-describedby={open ? id : undefined} className="inline-flex">
        {children}
      </span>
      {/* ツールチップ本体。open の値に応じて opacity を切り替えてフェード表示する。
          中央寄せの transform は実測ベースの clampOffset を反映した inline style で
          与え、画面端でのはみ出しを防ぐ（sideClasses 側には含めない）。 */}
      <span
        ref={tooltipRef}
        id={id}
        role="tooltip"
        style={{ transform: centerTransform }}
        className={cn(
          'pointer-events-none absolute z-50 whitespace-nowrap rounded-sm border border-border-strong',
          'bg-surface-overlay px-2 py-1 text-2xs font-medium text-ink-base shadow-md',
          'transition-opacity duration-150',
          sideClasses[side],
          open ? 'opacity-100' : 'opacity-0',
        )}
      >
        {label}
      </span>
    </span>
  );
}
