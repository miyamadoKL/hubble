/**
 * ワークフロー run 一括エクスポート用の zip エントリ名と Excel/Sheets シート名を生成する。
 */

/** zip 内 CSV エントリ名向けに step 名を安全化する。 */
export function sanitizeZipEntryBase(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
}

/** Excel/Sheets のシート名向けに step 名を安全化する。 */
export function sanitizeSheetBase(name: string): string {
  const replaced = name.replace(/[\\/?*[\]:]/g, '_').replace(/^'+|'+$/g, '');
  return replaced.slice(0, 31);
}

/** 対象ステップ列から zip 内 CSV エントリ名を生成する。 */
export function buildZipEntryNames(steps: ReadonlyArray<{ name: string }>): string[] {
  const used = new Set<string>();
  return steps.map((step, index) => {
    const stem = `${String(index + 1).padStart(2, '0')}_${sanitizeZipEntryBase(step.name)}`;
    return uniquifyZipEntry(stem, used);
  });
}

/** 対象ステップ列から Excel/Sheets 用シート名を生成する。 */
export function buildSheetNames(steps: ReadonlyArray<{ name: string }>): string[] {
  const used = new Set<string>();
  return steps.map((step, index) => {
    let base = sanitizeSheetBase(step.name);
    if (base.length === 0) base = `Step ${index + 1}`;
    return uniquifySheetName(base, used);
  });
}

function uniquifyZipEntry(stem: string, used: Set<string>): string {
  let candidate = `${stem}.csv`;
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let n = 2;
  while (true) {
    candidate = `${stem}_${n}.csv`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    n += 1;
  }
}

function uniquifySheetName(base: string, used: Set<string>): string {
  let candidate = base.slice(0, 31);
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let n = 2;
  while (true) {
    const suffix = `~${n}`;
    const trimmed = base.slice(0, Math.max(0, 31 - suffix.length));
    candidate = `${trimmed}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    n += 1;
  }
}
