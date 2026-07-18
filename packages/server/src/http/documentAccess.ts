/**
 * 共有対象ドキュメントの認可判定と結果変換を共通化する。
 */
import type { Principal } from '../auth/principal';
import { AppError } from '../errors';
import type { Services } from '../services';
import type { DocumentType, ShareAccessor, StoreForbidden } from '../store/documentShares';

const documentLabels: Record<DocumentType, string> = {
  notebook: 'Notebook',
  saved_query: 'Saved query',
  dashboard: 'Dashboard',
};

/** principalから共有permission解決用accessorを組み立てる。 */
export function toShareAccessor(principal: Principal): ShareAccessor {
  return {
    user: principal.user,
    groups: principal.groups ?? [],
    role: principal.role.name,
  };
}

/** ドキュメント種別ごとの所有者を取得する。 */
async function getOwner(
  services: Services,
  type: DocumentType,
  id: string,
): Promise<string | undefined> {
  switch (type) {
    case 'notebook':
      return services.notebooks.getOwner(id);
    case 'saved_query':
      return services.savedQueries.getOwner(id);
    case 'dashboard':
      return services.dashboards.getOwner(id);
  }
}

function notFoundMessage(type: DocumentType, id: string): string {
  return `${documentLabels[type]} ${id} not found`;
}

/** owner以外は403、存在しないまたはアクセス不能な文書は404にする。 */
export async function requireDocumentOwner(
  services: Services,
  type: DocumentType,
  id: string,
  accessor: ShareAccessor,
): Promise<void> {
  const owner = await getOwner(services, type, id);
  if (!owner) throw AppError.notFound(notFoundMessage(type, id));
  if (owner === accessor.user) return;

  // 共有 permission を持つ非 owner (文書の存在をすでに知っている) には 403 を返して
  // よいが、共有もされていない accessor には 404 を返し文書の存在自体を隠す。
  // ここで一律 403 にすると、存在しない文書 ID と「存在するが見えない」文書 ID を
  // 応答コードから区別できてしまい、総当たりで文書 ID の存在を探索できてしまう。
  const permission = await services.documentShares.resolvePermission(type, id, accessor);
  if (permission) throw AppError.forbidden('Only the document owner can manage shares');
  throw AppError.notFound(notFoundMessage(type, id));
}

/** 更新結果をHTTPエラーへ変換する。 */
export function throwUpdateResult<T>(
  result: T | undefined | StoreForbidden,
  type: DocumentType,
  id: string,
): T {
  if (result === 'forbidden') {
    throw AppError.forbidden('Insufficient permission to update this document');
  }
  if (!result) throw AppError.notFound(notFoundMessage(type, id));
  return result;
}

/** 削除結果をHTTPエラーへ変換する。 */
export function throwDeleteResult(
  result: boolean | StoreForbidden,
  type: DocumentType,
  id: string,
): void {
  if (result === 'forbidden') {
    throw AppError.forbidden('Only the document owner can delete this document');
  }
  if (!result) throw AppError.notFound(notFoundMessage(type, id));
}
