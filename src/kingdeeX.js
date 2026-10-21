import { allowedDatabase, departmentFormId, customerObjectId, lookupDefaults, guidSetting, assertWritesEnabled } from './scope.js';
import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sql from 'mssql';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const targetFormId = departmentFormId;
const targetFormName = '部门（扩展表单）';
const targetTable = 'T_BD_DEPARTMENT';
const writerLogin = 'mcp_kingdeex_deptmeta';
const config = {
  server: required('SQLSERVER_HOST'),
  port: optionalNumber('SQLSERVER_PORT'),
  database: process.env.SQLSERVER_DATABASE || 'master',
  user: required('SQLSERVER_USER'),
  password: required('SQLSERVER_PASSWORD'),
  connectionTimeout: numberOr('SQLSERVER_CONNECTION_TIMEOUT_MS', 15000),
  requestTimeout: numberOr('SQLSERVER_QUERY_TIMEOUT_MS', 30000),
  pool: { max: 2, min: 0, idleTimeoutMillis: 30000 },
  options: {
    encrypt: boolOr('SQLSERVER_ENCRYPT', true),
    trustServerCertificate: boolOr('SQLSERVER_TRUST_SERVER_CERTIFICATE', false),
    instanceName: process.env.SQLSERVER_INSTANCE || undefined,
    enableArithAbort: true,
  },
};

let readerPoolPromise;
let writerPoolPromise;
const server = new McpServer({ name: 'kingdeeX-metadata-test', version: '1.0.0' });

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
function numberOr(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function optionalNumber(name) {
  return process.env[name] ? numberOr(name, undefined) : undefined;
}
function boolOr(name, fallback) {
  const value = process.env[name]?.toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}
function getReaderPool() {
  readerPoolPromise ??= new sql.ConnectionPool(config).connect().catch((error) => {
    readerPoolPromise = undefined;
    throw new Error(`SQL Server read connection failed: ${error.message}`);
  });
  return readerPoolPromise;
}
function getWriterPool() {
  if (config.database.toLowerCase() !== allowedDatabase) {
    throw new Error(`kingdeeX only operates in the configured test database, not ${config.database}.`);
  }
  const password = required('SQLSERVER_KINGDEEX_WRITE_PASSWORD');
  writerPoolPromise ??= new sql.ConnectionPool({
    ...config,
    user: writerLogin,
    password,
    pool: { max: 1, min: 0, idleTimeoutMillis: 30000 },
  }).connect().catch((error) => {
    writerPoolPromise = undefined;
    throw new Error(`kingdeeX restricted write connection failed: ${error.message}`);
  });
  return writerPoolPromise;
}
function resultText(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
const fieldArgs = {
  fieldKey: z.string().regex(/^F_KINGDIEX_[A-Z0-9_]{1,40}$/).describe('Unique field key; must start with F_KINGDIEX_, for example F_KINGDIEX_TEST_01.'),
  displayName: z.string().trim().min(1).max(128).describe('Chinese field caption to add to the department form.'),
};

async function inspectCandidate({ fieldKey, displayName }) {
  if (config.database.toLowerCase() !== allowedDatabase) {
    throw new Error(`Refusing to inspect outside the configured test database (configured database: ${config.database}).`);
  }
  const pool = await getReaderPool();
  const result = await pool.request()
    .input('formId', sql.VarChar(36), targetFormId)
    .input('fieldKey', sql.NVarChar(128), fieldKey)
    .input('tableName', sql.NVarChar(128), targetTable)
    .query(`
      SELECT TOP (1) o.FID AS form_id, o.FVERSION AS form_version,
             o.FBASEOBJECTID AS base_object_id,
             CASE WHEN o.FKERNELXML.exist('/FormMetadata/BusinessInfo/BusinessInfo/Elements/child::*[Key=sql:variable("@fieldKey")]') = 1 THEN 1 ELSE 0 END AS key_exists_in_metadata,
             CASE WHEN o.FKERNELXML.exist('/FormMetadata/LayoutInfos/LayoutInfo/Appearances/child::*[Key=sql:variable("@fieldKey")]') = 1 THEN 1 ELSE 0 END AS key_exists_in_layout,
             ISNULL(layout.max_top, 201) + 32 AS layout_top,
             CASE WHEN c.column_id IS NULL THEN 0 ELSE 1 END AS column_exists
      FROM dbo.T_META_OBJECTTYPE o
      OUTER APPLY (
        SELECT MAX(TRY_CONVERT(int, A.N.value('(Top/text())[1]','nvarchar(20)'))) AS max_top
        FROM o.FKERNELXML.nodes('/FormMetadata/LayoutInfos/LayoutInfo/Appearances/child::node()') A(N)
        WHERE A.N.value('(Container/text())[1]','nvarchar(128)')=N'FTAB_PBASE'
      ) layout
      LEFT JOIN sys.columns c ON c.object_id = OBJECT_ID(N'dbo.' + @tableName)
        AND UPPER(c.name) = UPPER(@fieldKey)
      WHERE o.FID = @formId
    `);
  if (!result.recordset.length) throw new Error(`Target Kingdee form metadata not found: ${targetFormId}`);
  const row = result.recordset[0];
  const canApply = row.key_exists_in_metadata === 0 && row.key_exists_in_layout === 0 && row.column_exists === 0;
  return {
    can_apply: canApply,
    database: allowedDatabase,
    form_id: targetFormId,
    form_name: targetFormName,
    base_object_id: row.base_object_id,
    physical_table: targetTable,
    field_key: fieldKey,
    display_name: displayName,
    field_type: 'TextField',
    physical_column: 'nvarchar(255) NULL',
    layout: { container: 'FTAB_PBASE', left: 12, top: row.layout_top },
    key_exists_in_metadata: Boolean(row.key_exists_in_metadata),
    key_exists_in_layout: Boolean(row.key_exists_in_layout),
    physical_column_exists: Boolean(row.column_exists),
    current_form_version: row.form_version,
    warning: 'Direct database metadata experiment. This bypasses BOS/SVN history; export the object in BOS before using this outside the test copy.',
  };
}

async function inspectConfiguredForm() {
  if (config.database.toLowerCase() !== allowedDatabase) {
    throw new Error(`Refusing to inspect outside the configured test database (configured database: ${config.database}).`);
  }
  const pool = await getReaderPool();
  const formResult = await pool.request()
    .input('formCode', sql.NVarChar(128), required('KINGDEEX_INSPECT_FORM_CODE'))
    .query(`
      SELECT TOP (5)
             FID AS form_id,
             FBASEOBJECTID AS base_object_id,
             FVERSION AS form_version,
             LEFT(CONVERT(nvarchar(max), FKERNELXML), 100000) AS metadata_xml_preview,
             CASE WHEN DATALENGTH(CONVERT(nvarchar(max), FKERNELXML)) > 200000 THEN 1 ELSE 0 END AS metadata_xml_truncated
      FROM dbo.T_META_OBJECTTYPE
      WHERE CONVERT(nvarchar(max), FKERNELXML) LIKE N'%' + @formCode + N'%'
    `);
  const tableResult = await pool.request()
    .input('namePattern', sql.NVarChar(128), required('KINGDEEX_INSPECT_TABLE_PATTERN'))
    .query(`
      SELECT s.name AS schema_name,
             t.name AS table_name,
             c.column_id,
             c.name AS column_name,
             ty.name AS data_type,
             c.max_length,
             c.precision,
             c.scale,
             c.is_nullable
      FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.columns c ON c.object_id = t.object_id
      JOIN sys.types ty ON ty.user_type_id = c.user_type_id
      WHERE t.name LIKE @namePattern
      ORDER BY s.name, t.name, c.column_id
    `);

  return {
    database: config.database,
    requested_form_code: required('KINGDEEX_INSPECT_FORM_CODE'),
    read_only: true,
    forms: formResult.recordset,
    physical_table_candidates: tableResult.recordset,
    note: formResult.recordset.length
      ? 'Metadata XML is included as a bounded preview. Confirm the exact head/entry table mapping in BOS before adding fields.'
      : 'No exact FNUMBER match was found. The table candidates are discovery hints only; no writes were performed.',
  };
}

function customerCandidate(candidate) {
  return {
    ...candidate,
    field_type: 'BaseDataField',
    referenced_form_id: 'BD_Customer',
    referenced_object_id: customerObjectId,
    physical_column: 'int NULL',
    warning: 'Customer lookup field is a direct database metadata experiment. BOS must save/publish the object to synchronize runtime metadata and references; this bypasses BOS/SVN history.',
  };
}

const typedFieldSqlTypes = {
  TextField: 'nvarchar(255) NULL',
  IntegerField: 'int NULL',
  DecimalField: 'decimal(23,10) NULL',
  AmountField: 'decimal(23,10) NULL',
  QtyField: 'decimal(23,10) NULL',
  BaseQtyField: 'decimal(23,10) NULL',
  DateField: 'datetime NULL',
  DateTimeField: 'datetime NULL',
  TimeField: 'datetime NULL',
  CheckBoxField: 'bit NULL',
  ComboField: 'varchar(100) NULL',
  BaseDataField: 'int NULL',
  OrgField: 'int NULL',
  UserField: 'int NULL',
  UnitField: 'int NULL',
  AssistantField: 'int NULL',
};
const defaultLookupObjectIds = lookupDefaults;
const lookupFieldTypes = new Set(['BaseDataField', 'OrgField', 'UserField', 'UnitField', 'AssistantField']);
const typedFieldOptions = z.array(z.object({
  value: z.string().trim().regex(/^[A-Za-z0-9_-]{1,100}$/),
  caption: z.string().trim().min(1).max(200),
})).max(50).optional();

function typedCandidate(candidate, { fieldType, precision, scale, lookupObjectId, orgFieldKey, enumOptions, controlFieldKey, baseQtyFieldKey, isRequired }) {
  let physicalColumn = typedFieldSqlTypes[fieldType];
  if (['DecimalField', 'AmountField', 'QtyField', 'BaseQtyField'].includes(fieldType)) {
    physicalColumn = `decimal(${precision},${scale}) NULL`;
  }
  return {
    ...candidate,
    field_type: fieldType,
    is_required: isRequired === true,
    physical_column: physicalColumn,
    ...(lookupFieldTypes.has(fieldType) ? {
      referenced_object_id: lookupObjectId,
      organization_field_key: orgFieldKey || null,
    } : {}),
    ...(fieldType === 'ComboField' ? { options: enumOptions } : {}),
    ...(controlFieldKey ? { control_field_key: controlFieldKey } : {}),
    ...(baseQtyFieldKey ? { base_quantity_field_key: baseQtyFieldKey } : {}),
    warning: 'This writes test metadata directly. BOS must save the object to synchronize runtime metadata, lookup references, and enum definitions; the change bypasses BOS/SVN history.',
  };
}

server.registerTool('kingdeeX', {
  description: 'Experimental metadata MCP. Department-field actions remain restricted to the department extension form in test database the configured test database. Also provides read-only inspection for an explicitly configured form code and table pattern. Direct database edits bypass BOS/SVN history. Add actions require apply=true.',
  inputSchema: {
    action: z.enum(['inspect_form_metadata', 'preview_add_department_text_field', 'add_department_text_field', 'preview_add_department_customer_field', 'add_department_customer_field', 'preview_add_department_typed_field', 'add_department_typed_field']),
    fieldKey: fieldArgs.fieldKey.optional(),
    displayName: fieldArgs.displayName.optional(),
    fieldType: z.enum(Object.keys(typedFieldSqlTypes)).optional().describe('For typed-field actions: TextField, IntegerField, DecimalField, AmountField, QtyField, BaseQtyField, DateField, DateTimeField, TimeField, CheckBoxField, ComboField, BaseDataField, OrgField, UserField, UnitField, or AssistantField.'),
    isRequired: z.boolean().optional().describe('For typed-field actions: set true to mark the field required in BOS metadata.'),
    precision: z.number().int().min(1).max(23).optional().describe('Numeric field precision; defaults to 23.'),
    scale: z.number().int().min(0).max(10).optional().describe('Numeric field scale; defaults to 10.'),
    lookupObjectId: z.string().regex(/^[0-9a-fA-F-]{36}$/).optional().describe('Lookup object ID for BaseDataField or AssistantField. Optional OrgField, UserField, and UnitField defaults come from local configuration.'),
    orgFieldKey: z.string().regex(/^F[A-Za-z0-9_]{1,63}$/).optional().describe('Optional organization field key used to scope a reference field.'),
    controlFieldKey: z.string().regex(/^F[A-Za-z0-9_]{1,63}$/).optional().describe('Optional linked currency/unit field key for AmountField or QtyField.'),
    baseQtyFieldKey: z.string().regex(/^F[A-Za-z0-9_]{1,63}$/).optional().describe('Optional base quantity field key for QtyField.'),
    enumOptions: typedFieldOptions.describe('Required for ComboField: two or more {value, caption} options.'),
    apply: z.literal(true).optional().describe('Required and must be true for add_department_text_field; omitted for preview.'),
  },
}, async ({ action, fieldKey, displayName, fieldType, isRequired, precision, scale, lookupObjectId, orgFieldKey, controlFieldKey, baseQtyFieldKey, enumOptions, apply }) => {
  if (action === 'inspect_form_metadata') {
    return resultText(await inspectConfiguredForm());
  }
  if (!fieldKey || !displayName) {
    throw new Error('fieldKey and displayName are required for department field actions. No changes were made.');
  }
  const isTyped = action.endsWith('_typed_field');
  const isCustomer = action.endsWith('_customer_field');
  const effectiveFieldType = isTyped ? fieldType : isCustomer ? 'BaseDataField' : 'TextField';
  if (isTyped && !fieldType) throw new Error('fieldType is required for typed-field actions. No changes were made.');
  if (!typedFieldSqlTypes[effectiveFieldType]) throw new Error(`Unsupported field type: ${effectiveFieldType}`);
  if (!isTyped && isRequired === true) throw new Error('isRequired is only accepted for typed-field actions. No changes were made.');
  const effectivePrecision = precision ?? 23;
  const effectiveScale = scale ?? 10;
  if (effectiveScale > effectivePrecision) throw new Error('scale cannot exceed precision. No changes were made.');
  if (effectiveFieldType === 'ComboField') {
    if (!enumOptions || enumOptions.length < 2) throw new Error('ComboField requires at least two enumOptions. No changes were made.');
    const values = enumOptions.map((item) => item.value);
    if (new Set(values).size !== values.length) throw new Error('ComboField option values must be unique. No changes were made.');
  } else if (enumOptions?.length) {
    throw new Error('enumOptions are only accepted for ComboField. No changes were made.');
  }
  let effectiveLookupObjectId = isCustomer
    ? guidSetting('KINGDEEX_CUSTOMER_OBJECT_ID', true)
    : lookupObjectId || defaultLookupObjectIds[effectiveFieldType];
  if (lookupFieldTypes.has(effectiveFieldType) && !effectiveLookupObjectId) {
    throw new Error('Configure a local lookup object GUID or pass lookupObjectId for this reference field.');
  }
  if (effectiveFieldType === 'BaseDataField' && !effectiveLookupObjectId) {
    throw new Error('BaseDataField requires lookupObjectId. No changes were made.');
  }
  if (effectiveFieldType === 'AssistantField' && !effectiveLookupObjectId) {
    throw new Error('AssistantField requires its specific lookupObjectId. No changes were made.');
  }
  if (!lookupFieldTypes.has(effectiveFieldType) && lookupObjectId) {
    throw new Error('lookupObjectId is only accepted for lookup field types. No changes were made.');
  }
  if (!lookupFieldTypes.has(effectiveFieldType) && orgFieldKey) {
    throw new Error('orgFieldKey is only accepted for lookup field types. No changes were made.');
  }
  if (!['AmountField', 'QtyField', 'BaseQtyField'].includes(effectiveFieldType) && controlFieldKey) {
    throw new Error('controlFieldKey is only accepted for AmountField, QtyField, and BaseQtyField. No changes were made.');
  }
  if (effectiveFieldType !== 'QtyField' && baseQtyFieldKey) {
    throw new Error('baseQtyFieldKey is only accepted for QtyField. No changes were made.');
  }
  const baseCandidate = await inspectCandidate({ fieldKey, displayName });
  const candidate = isTyped
    ? typedCandidate(baseCandidate, {
      fieldType: effectiveFieldType,
      precision: effectivePrecision,
      scale: effectiveScale,
      lookupObjectId: effectiveLookupObjectId,
      orgFieldKey,
      enumOptions,
      controlFieldKey,
      baseQtyFieldKey,
      isRequired,
    })
    : isCustomer ? customerCandidate(baseCandidate) : baseCandidate;
  if (action.startsWith('preview_')) return resultText(candidate);
  if (apply !== true) throw new Error('Set apply=true to add the test field. No changes were made.');
  assertWritesEnabled();
  if (!candidate.can_apply) throw new Error('Field key or physical column already exists. No changes were made.');

  const reader = await getReaderPool();
  const snapshot = await reader.request()
    .input('formId', sql.VarChar(36), targetFormId)
    .query('SELECT CONVERT(nvarchar(max), FKERNELXML) AS metadata_xml, FVERSION AS form_version FROM dbo.T_META_OBJECTTYPE WHERE FID=@formId');
  const source = snapshot.recordset?.[0];
  if (!source?.metadata_xml) throw new Error('Could not snapshot the current form XML. No changes were made.');

  const backupDir = path.resolve(fileURLToPath(new URL('../.kingdeeX-backups/', import.meta.url)));
  await mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${targetFormId}.xml`);
  await writeFile(backupPath, source.metadata_xml, { encoding: 'utf8', flag: 'wx' });

  const version = (BigInt(Date.now()) * 10000n + 621355968000000000n).toString();
  const writer = await getWriterPool();
  const request = writer.request()
    .input('FieldKey', sql.NVarChar(128), fieldKey)
    .input('DisplayName', sql.NVarChar(128), displayName)
    .input('ExpectedVersion', sql.VarChar(100), String(source.form_version))
    .input('ScopeFormId', sql.VarChar(36), targetFormId)
    .input('NewVersion', sql.VarChar(100), version);
  if (isTyped) {
    request
      .input('FieldType', sql.VarChar(32), effectiveFieldType)
      .input('FieldPrecision', sql.Int, effectivePrecision)
      .input('FieldScale', sql.Int, effectiveScale)
      .input('LookupObjectId', sql.VarChar(36), effectiveLookupObjectId || null)
      .input('OrgFieldKey', sql.VarChar(64), orgFieldKey || null)
      .input('ControlFieldKey', sql.VarChar(64), controlFieldKey || null)
      .input('BaseQtyFieldKey', sql.VarChar(64), baseQtyFieldKey || null)
      .input('IsRequired', sql.Bit, isRequired === true)
      .input('EnumOptionsJson', sql.NVarChar(sql.MAX), enumOptions ? JSON.stringify(enumOptions) : null);
  }
  const applied = await request.execute(isTyped
    ? 'dbo.MCP_KINGDEEX_AddDeptTypedField'
    : isCustomer ? 'dbo.MCP_KINGDEEX_AddDeptCustomerField' : 'dbo.MCP_KINGDEEX_AddDeptTextField');

  return resultText({
    applied: true,
    ...candidate,
    can_apply: false,
    key_exists_in_metadata: true,
    key_exists_in_layout: true,
    physical_column_exists: true,
    new_form_version: version,
    backup_file: backupPath,
    result: applied.recordset?.[0] ?? null,
    next_step: isCustomer || lookupFieldTypes.has(effectiveFieldType) || effectiveFieldType === 'ComboField'
      ? 'Open the department object in BOS and save it to synchronize runtime metadata, references, and enum definitions, then reopen the front-end department form.'
      : 'Open the department object in BOS and save it to synchronize runtime metadata, then reopen the department form.',
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.on('SIGINT', async () => {
  await Promise.allSettled([readerPoolPromise, writerPoolPromise]);
  await (await readerPoolPromise)?.close();
  await (await writerPoolPromise)?.close();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await Promise.allSettled([readerPoolPromise, writerPoolPromise]);
  await (await readerPoolPromise)?.close();
  await (await writerPoolPromise)?.close();
  process.exit(0);
});
