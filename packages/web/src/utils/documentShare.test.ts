import { describe, expect, test } from 'vitest';
import {
  canPersistNotebookToServer,
  findDuplicateShareIndices,
  isDocumentOwner,
  isSharedWithMe,
  sharePermissionLabel,
  type ShareDraftRow,
} from './documentShare';

describe('isDocumentOwner', () => {
  test('treats undefined as owner (legacy data)', () => {
    expect(isDocumentOwner(undefined)).toBe(true);
  });

  test('recognizes owner permission', () => {
    expect(isDocumentOwner('owner')).toBe(true);
  });

  test('rejects view and edit share permissions', () => {
    expect(isDocumentOwner('view')).toBe(false);
    expect(isDocumentOwner('edit')).toBe(false);
  });
});

describe('isSharedWithMe', () => {
  test('detects view and edit shares', () => {
    expect(isSharedWithMe('view')).toBe(true);
    expect(isSharedWithMe('edit')).toBe(true);
  });

  test('rejects owner and undefined', () => {
    expect(isSharedWithMe('owner')).toBe(false);
    expect(isSharedWithMe(undefined)).toBe(false);
  });
});

describe('findDuplicateShareIndices', () => {
  const rows: ShareDraftRow[] = [
    { subjectType: 'user', subjectValue: 'alice', permission: 'view' },
    { subjectType: 'group', subjectValue: 'eng', permission: 'edit' },
  ];

  test('returns null when all subjects are unique', () => {
    expect(findDuplicateShareIndices(rows)).toBeNull();
  });

  test('detects duplicate subjectType + subjectValue pairs', () => {
    const dup: ShareDraftRow[] = [
      ...rows,
      { subjectType: 'user', subjectValue: 'alice', permission: 'edit' },
    ];
    expect(findDuplicateShareIndices(dup)).toEqual([0, 2]);
  });

  test('ignores blank subjectValue rows when checking duplicates', () => {
    const withBlank: ShareDraftRow[] = [
      { subjectType: 'user', subjectValue: '', permission: 'view' },
      { subjectType: 'user', subjectValue: '', permission: 'edit' },
    ];
    expect(findDuplicateShareIndices(withBlank)).toBeNull();
  });
});

describe('canPersistNotebookToServer', () => {
  test('allows draft notebooks', () => {
    expect(canPersistNotebookToServer({ draft: true, myPermission: 'view' })).toBe(true);
  });

  test('blocks view-only saved notebooks', () => {
    expect(canPersistNotebookToServer({ draft: false, myPermission: 'view' })).toBe(false);
  });

  test('allows edit and owner saved notebooks', () => {
    expect(canPersistNotebookToServer({ draft: false, myPermission: 'edit' })).toBe(true);
    expect(canPersistNotebookToServer({ draft: false, myPermission: 'owner' })).toBe(true);
    expect(canPersistNotebookToServer({ draft: false, myPermission: undefined })).toBe(true);
  });
});

describe('sharePermissionLabel', () => {
  test('maps permissions to UI labels', () => {
    expect(sharePermissionLabel('view')).toBe('Can view');
    expect(sharePermissionLabel('edit')).toBe('Can edit');
  });
});
