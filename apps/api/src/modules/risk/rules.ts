import { RISK_RULES, riskRuleDef, type AdminRiskRuleBody, type RiskRuleInfo } from '@yatri/types';

import { recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';

/**
 * The rules, as configured now. Definitions and defaults are in @yatri/types (RISK_RULES); the database holds
 * only what an administrator changed (`risk_rule_overrides`). Putting a rule back to its defaults removes its
 * override, so "customised" always means "differs from the defaults".
 */
interface OverrideRow {
  rule_code: string;
  enabled: boolean;
  points: number;
  threshold: number;
  window_hours: number;
}

export async function effectiveRules(): Promise<RiskRuleInfo[]> {
  const r = await query<OverrideRow>('SELECT * FROM risk_rule_overrides');
  const overrides = new Map(r.rows.map((o) => [o.rule_code, o]));
  return RISK_RULES.map((def) => {
    const o = overrides.get(def.code);
    return {
      ...def,
      enabled: o?.enabled ?? true,
      points: o?.points ?? def.points,
      threshold: o?.threshold ?? def.threshold,
      windowHours: o?.window_hours ?? def.windowHours,
      customised: !!o,
      defaults: { points: def.points, threshold: def.threshold, windowHours: def.windowHours },
    };
  });
}

export async function updateRule(
  code: string,
  body: AdminRiskRuleBody,
  adminId: string,
): Promise<RiskRuleInfo> {
  const def = riskRuleDef(code);
  if (!def) throw new HttpError(404, 'NOT_FOUND', 'Rule not found.');
  const before = (await effectiveRules()).find((r) => r.code === code);
  const isDefault =
    body.enabled &&
    body.points === def.points &&
    body.threshold === def.threshold &&
    body.windowHours === def.windowHours;
  if (isDefault) {
    await query('DELETE FROM risk_rule_overrides WHERE rule_code = $1', [code]);
  } else {
    await query(
      `INSERT INTO risk_rule_overrides (rule_code, enabled, points, threshold, window_hours, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (rule_code) DO UPDATE
         SET enabled = $2, points = $3, threshold = $4, window_hours = $5, updated_by = $6, updated_at = now()`,
      [code, body.enabled, body.points, body.threshold, body.windowHours, adminId],
    );
  }
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'RISK_RULE_CHANGED',
    subjectType: 'risk_rule',
    subjectIds: null,
    detail: {
      rule: code,
      reason: body.reason,
      from: before && {
        enabled: before.enabled,
        points: before.points,
        threshold: before.threshold,
        windowHours: before.windowHours,
      },
      to: {
        enabled: body.enabled,
        points: body.points,
        threshold: body.threshold,
        windowHours: body.windowHours,
      },
    },
  });
  return (await effectiveRules()).find((r) => r.code === code) as RiskRuleInfo;
}
