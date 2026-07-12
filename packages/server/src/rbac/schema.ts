/**
 * rbac.yaml の zod スキーマ定義。
 */
import { z } from 'zod';
import { guardModeSchema, guardOnUnknownSchema, permissionSchema } from '@hubble/contracts';
import { datasourceIdPattern } from '../datasource/schema';

/** ロール名の許容パターン（小文字英字始まり、最大 63 文字）。 */
export const roleNamePattern = /^[a-z][a-z0-9-]{0,62}$/;

const roleNameSchema = z.string().regex(roleNamePattern, 'must match /^[a-z][a-z0-9-]{0,62}$/');

const uniquePermissionsSchema = z.array(permissionSchema).superRefine((permissions, ctx) => {
  const seen = new Set<string>();
  for (const [index, permission] of permissions.entries()) {
    if (seen.has(permission)) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate permission '${permission}'`,
        path: [index],
      });
    }
    seen.add(permission);
  }
});

/** ロールごとの Query Guard 上書き（任意フィールドのみ）。 */
export const roleGuardSchema = z
  .object({
    mode: guardModeSchema.optional(),
    maxScanBytes: z.number().int().nonnegative().optional(),
    maxScanRows: z.number().int().nonnegative().optional(),
    onUnknown: guardOnUnknownSchema.optional(),
  })
  .strict();

const datasourceAllowlistEntrySchema = z.union([
  z.literal('*'),
  z.string().regex(datasourceIdPattern, 'must match /^[a-z][a-z0-9-]{0,62}$/ or be "*"'),
]);

const roleDatasourcesSchema = z
  .array(datasourceAllowlistEntrySchema)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (seen.has(entry)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate datasource '${entry}'`,
          path: [index],
        });
      }
      seen.add(entry);
    }
  })
  .optional();

const roleDefinitionSchema = z
  .object({
    permissions: uniquePermissionsSchema,
    guard: roleGuardSchema.optional(),
    datasources: roleDatasourcesSchema,
  })
  .strict();

const assignmentSchema = z
  .object({
    email: z.string().min(1).optional(),
    user: z.string().min(1).optional(),
    emailDomain: z.string().min(1).optional(),
    group: z.string().min(1).optional(),
    priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    role: roleNameSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = [value.email, value.user, value.emailDomain, value.group].filter(
      (v) => v !== undefined,
    );
    if (keys.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'exactly one of email, user, emailDomain, or group must be set',
        path: ['email'],
      });
    }
  });

/** rbac.yaml 全体のスキーマ。 */
export const rbacFileSchema = z
  .object({
    roles: z
      .record(roleNameSchema, roleDefinitionSchema)
      .refine((roles) => Object.keys(roles).length >= 1, {
        message: 'roles must contain at least one entry',
      }),
    assignments: z.array(assignmentSchema).default([]),
    defaultRole: roleNameSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const roleNames = new Set(Object.keys(value.roles));
    if (!roleNames.has(value.defaultRole)) {
      ctx.addIssue({
        code: 'custom',
        message: `defaultRole '${value.defaultRole}' is not defined in roles`,
        path: ['defaultRole'],
      });
    }
    for (const [index, assignment] of value.assignments.entries()) {
      if (!roleNames.has(assignment.role)) {
        ctx.addIssue({
          code: 'custom',
          message: `assignments[${index}].role '${assignment.role}' is not defined in roles`,
          path: ['assignments', index, 'role'],
        });
      }
    }

    const assignmentKeys = new Map<string, number>();
    for (const [index, assignment] of value.assignments.entries()) {
      const matcher = ['email', 'user', 'emailDomain', 'group'].find(
        (key) => assignment[key as keyof typeof assignment] !== undefined,
      );
      if (matcher === undefined) continue;
      const matchValue = String(assignment[matcher as keyof typeof assignment]).toLowerCase();
      const key = `${assignment.priority ?? 0}\0${matcher}\0${matchValue}`;
      const previous = assignmentKeys.get(key);
      if (previous !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicates assignments[${previous}] at the same priority`,
          path: ['assignments', index],
        });
      } else {
        assignmentKeys.set(key, index);
      }
    }
  });

export type RbacFile = z.infer<typeof rbacFileSchema>;
