import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

export function requiredSetting(name) {
  const value = process.env[name]?.trim();
  if (!value || /^(YOUR_|CHANGE_ME|REPLACE_)/i.test(value)) {
    throw new Error(`Configure ${name} locally before using kingdeeX.`);
  }
  return value;
}

export function guidSetting(name, required = false) {
  const value = process.env[name]?.trim();
  if (!value && !required) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '')
      || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)) {
    throw new Error(`Configure a valid local metadata GUID for ${name}.`);
  }
  return value;
}

export const allowedDatabase = requiredSetting('KINGDEEX_ALLOWED_DATABASE').toLowerCase();
if (!/^[a-z0-9_\-\u4e00-\u9fff]+$/i.test(allowedDatabase)
    || ['master', 'tempdb', 'model', 'msdb'].includes(allowedDatabase)) {
  throw new Error('KINGDEEX_ALLOWED_DATABASE must identify one non-system test database.');
}
if (requiredSetting('SQLSERVER_DATABASE').toLowerCase() !== allowedDatabase) {
  throw new Error('SQLSERVER_DATABASE must match KINGDEEX_ALLOWED_DATABASE.');
}

export const departmentFormId = guidSetting('KINGDEEX_DEPARTMENT_FORM_ID', true);
export const customerObjectId = guidSetting('KINGDEEX_CUSTOMER_OBJECT_ID');
export const lookupDefaults = {
  OrgField: guidSetting('KINGDEEX_ORG_OBJECT_ID'),
  UserField: guidSetting('KINGDEEX_USER_OBJECT_ID'),
  UnitField: guidSetting('KINGDEEX_UNIT_OBJECT_ID'),
};

export function assertWritesEnabled() {
  if (process.env.KINGDEEX_ENABLE_WRITES?.toLowerCase() !== 'true') {
    throw new Error('Writes are disabled. Enable KINGDEEX_ENABLE_WRITES only for the reviewed test database.');
  }
}

export function assertProvisioning() {
  assertWritesEnabled();
  if (!process.argv.includes('--apply')) {
    throw new Error('Review the local test scope, then explicitly pass --apply to run this setup/repair script.');
  }
}
