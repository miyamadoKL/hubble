/**
 * rbac.yaml の zod スキーマ定義。
 */
import { z } from 'zod';
import { guardModeSchema, guardOnUnknownSchema, permissionSchema } from '@hubble/contracts';

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

const roleDefinitionSchema = z
  .object({
    permissions: uniquePermissionsSchema,
    guard: roleGuardSchema.optional(),
  })
  .strict();

const assignmentSchema = z
  .object({
    email: z.string().min(1).optional(),
    user: z.string().min(1).optional(),
    emailDomain: z.string().min(1).optional(),
    role: roleNameSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = [value.email, value.user, value.emailDomain].filter((v) => v !== undefined);
    if (keys.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'exactly one of email, user, or emailDomain must be set',
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
  });

export type RbacFile = z.infer<typeof rbacFileSchema>;
