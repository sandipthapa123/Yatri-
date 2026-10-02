import type { AdminPermission } from '@yatri/types';

/**
 * The console's navigation, in one list: where each page lives and the single permission the API
 * needs for it. The menu shows only what the signed-in administrator may open (the API still
 * decides; this only avoids offering doors that are locked).
 */
export interface NavItem {
  href: string;
  label: string;
  permission: AdminPermission;
}

export const NAV: readonly NavItem[] = [
  { href: '/', label: 'Dashboard', permission: 'OPERATIONS_VIEW' },
  { href: '/rides', label: 'Rides', permission: 'OPERATIONS_VIEW' },
  { href: '/availability', label: 'Driver availability', permission: 'OPERATIONS_VIEW' },
  { href: '/cities', label: 'Cities and service areas', permission: 'OPERATIONS_VIEW' },
  { href: '/campaigns', label: 'Campaigns and rewards', permission: 'GROWTH_VIEW' },
  { href: '/disability', label: 'Disability benefit verification', permission: 'DISABILITY_VERIFICATION_VIEW' },
  { href: '/navigation', label: 'Routes and arrival times', permission: 'OPERATIONS_VIEW' },
  { href: '/accessibility', label: 'Accessible rides', permission: 'ACCESSIBILITY_VIEW' },
  { href: '/jobs', label: 'Background jobs', permission: 'OPERATIONS_VIEW' },
  { href: '/providers', label: 'Service providers', permission: 'SETTINGS_VIEW' },
  { href: '/operations', label: 'Demand, zones and pricing', permission: 'OPERATIONS_VIEW' },
  { href: '/fleet', label: 'Fleets and driver operations', permission: 'FLEET_VIEW' },
  { href: '/organizations', label: 'Business accounts', permission: 'ORGANIZATIONS_VIEW' },
  { href: '/risk', label: 'Fraud and risk', permission: 'RISK_VIEW' },
  { href: '/drivers', label: 'Driver verification', permission: 'DRIVERS_REVIEW' },
  { href: '/vehicles', label: 'Vehicles', permission: 'DRIVERS_REVIEW' },
  { href: '/users', label: 'Users', permission: 'USERS_VIEW' },
  { href: '/payments', label: 'Payments and earnings', permission: 'FINANCE_VIEW' },
  { href: '/payouts', label: 'Driver payouts', permission: 'PAYOUTS_VIEW' },
  { href: '/analytics', label: 'Analytics', permission: 'ANALYTICS_VIEW' },
  { href: '/safety', label: 'Safety', permission: 'SAFETY_REVIEW' },
  { href: '/support', label: 'Support and disputes', permission: 'DISPUTES_MANAGE' },
  { href: '/compliance', label: 'Privacy and compliance', permission: 'COMPLIANCE_MANAGE' },
  { href: '/notifications', label: 'Notifications', permission: 'NOTIFICATIONS_VIEW' },
  { href: '/settings', label: 'Settings', permission: 'SETTINGS_VIEW' },
  { href: '/audit', label: 'Audit log', permission: 'AUDIT_VIEW' },
  { href: '/admins', label: 'Administrators', permission: 'ADMINS_MANAGE' },
];
