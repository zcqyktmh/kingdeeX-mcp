import { allowedDatabase, departmentFormId, assertProvisioning } from './scope.js';
import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sql from 'mssql';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const database = process.env.SQLSERVER_DATABASE || 'master';
const formId = departmentFormId;
const fieldKey = process.env.KINGDEEX_REPAIR_FIELD_KEY || '';
if (!/^F_KINGDIEX_[A-Z0-9_]{1,40}$/.test(fieldKey)) throw new Error('Configure KINGDEEX_REPAIR_FIELD_KEY explicitly.');
assertProvisioning();
if (database.toLowerCase() !== allowedDatabase) {
  throw new Error(`Refusing to upgrade outside the configured test database (configured database: ${database}).`);
}

const pool = await new sql.ConnectionPool({
  server: required('SQLSERVER_HOST'),
  port: optionalNumber('SQLSERVER_PORT'),
  database,
  user: process.env.KINGDEEX_ADMIN_USER || 'sa',
  password: required('KINGDEEX_ADMIN_PASSWORD'),
  connectionTimeout: numberOr('SQLSERVER_CONNECTION_TIMEOUT_MS', 15000),
  requestTimeout: numberOr('SQLSERVER_QUERY_TIMEOUT_MS', 30000),
  pool: { max: 1, min: 0, idleTimeoutMillis: 30000 },
  options: {
    encrypt: boolOr('SQLSERVER_ENCRYPT', true),
    trustServerCertificate: boolOr('SQLSERVER_TRUST_SERVER_CERTIFICATE', false),
    instanceName: process.env.SQLSERVER_INSTANCE || undefined,
    enableArithAbort: true,
  },
}).connect();

try {
  const state = await pool.request().query(`
    SELECT DB_NAME() AS database_name,
           IS_SRVROLEMEMBER('sysadmin') AS is_sysadmin,
           OBJECT_DEFINITION(OBJECT_ID(N'dbo.MCP_KINGDEEX_AddDeptTextField')) AS procedure_definition
  `);
  const system = state.recordset?.[0];
  if (system?.database_name?.toLowerCase() !== allowedDatabase || system?.is_sysadmin !== 1) {
    throw new Error('The local admin connection did not confirm sysadmin access to the configured test database.');
  }

  let procedure = system.procedure_definition;
  if (!procedure) throw new Error('The dedicated field-add procedure was not found.');
  let procedureUpdated = false;
  const hasSeparateAppearanceId = procedure.includes('DECLARE @AppearanceId nvarchar(32)')
    && procedure.includes('@AppearanceId AS [Id]');
  if (!hasSeparateAppearanceId) {
    if (procedure.startsWith('CREATE PROCEDURE dbo.MCP_KINGDEEX_AddDeptTextField')) {
      procedure = replaceOnce(procedure, 'CREATE PROCEDURE dbo.MCP_KINGDEEX_AddDeptTextField', 'ALTER PROCEDURE dbo.MCP_KINGDEEX_AddDeptTextField');
    } else if (!procedure.startsWith('ALTER PROCEDURE dbo.MCP_KINGDEEX_AddDeptTextField')) {
      throw new Error('The stored procedure header did not match the expected safe upgrade pattern.');
    }
    procedure = replaceOnce(
      procedure,
      "DECLARE @ElementId nvarchar(32)=REPLACE(CONVERT(nvarchar(36),NEWID()),N'-',N'');",
      "DECLARE @ElementId nvarchar(32)=REPLACE(CONVERT(nvarchar(36),NEWID()),N'-',N'');\n  DECLARE @AppearanceId nvarchar(32)=REPLACE(CONVERT(nvarchar(36),NEWID()),N'-',N'');",
    );
    procedure = replaceOnce(
      procedure,
      '@DisplayName AS [Caption],\n           @ElementId AS [Id]\n    FOR XML PATH(\'TextFieldAppearance\'), TYPE',
      '@DisplayName AS [Caption],\n           @AppearanceId AS [Id]\n    FOR XML PATH(\'TextFieldAppearance\'), TYPE',
    );
    await pool.request()
      .input('definition', sql.NVarChar(sql.MAX), procedure)
      .query('EXEC sys.sp_executesql @definition');
    procedureUpdated = true;
  }

  const snapshot = await pool.request()
    .input('formId', sql.VarChar(36), formId)
    .input('fieldKey', sql.NVarChar(128), fieldKey)
    .query(`
      SELECT CONVERT(nvarchar(max), FKERNELXML) AS metadata_xml,
             FVERSION AS form_version,
             FKERNELXML.value('(/FormMetadata/BusinessInfo/BusinessInfo/Elements/TextField[Key=sql:variable("@fieldKey")]/Id/text())[1]','nvarchar(64)') AS business_id,
             FKERNELXML.value('(/FormMetadata/LayoutInfos/LayoutInfo/Appearances/TextFieldAppearance[Key=sql:variable("@fieldKey")]/Id/text())[1]','nvarchar(64)') AS appearance_id,
             FKERNELXML.exist('/FormMetadata/BusinessInfo/BusinessInfo/Elements/TextField[Key=sql:variable("@fieldKey")]') AS has_business_node,
             FKERNELXML.exist('/FormMetadata/LayoutInfos/LayoutInfo/Appearances/TextFieldAppearance[Key=sql:variable("@fieldKey")]') AS has_appearance_node,
             CASE WHEN EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'dbo.T_BD_DEPARTMENT') AND name=@fieldKey) THEN 1 ELSE 0 END AS has_physical_column
      FROM dbo.T_META_OBJECTTYPE
      WHERE FID=@formId AND FBASEOBJECTID=N'BD_Department'
    `);
  const row = snapshot.recordset?.[0];
  if (!row?.metadata_xml || !row.has_business_node || !row.has_appearance_node || row.has_physical_column !== 1) {
    throw new Error('The expected test field is incomplete in metadata or physical table. No metadata change was made.');
  }
  if (String(row.business_id).toUpperCase() !== String(row.appearance_id).toUpperCase()) {
    throw new Error('The test field IDs are already distinct. No metadata change was made.');
  }

  const backupDir = path.resolve(fileURLToPath(new URL('../.kingdeeX-backups/', import.meta.url)));
  await mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${formId}_before-id-repair.xml`);
  await writeFile(backupPath, row.metadata_xml, { encoding: 'utf8', flag: 'wx' });

  const appearanceId = randomUUID().replaceAll('-', '').toUpperCase();
  const newVersion = (BigInt(Date.now()) * 10000n + 621355968000000000n).toString();
  const tx = new sql.Transaction(pool);
  await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const update = await new sql.Request(tx)
      .input('formId', sql.VarChar(36), formId)
      .input('fieldKey', sql.NVarChar(128), fieldKey)
      .input('expectedVersion', sql.VarChar(100), String(row.form_version))
      .input('newVersion', sql.VarChar(100), newVersion)
      .input('appearanceId', sql.NVarChar(32), appearanceId)
      .query(`
        IF NOT EXISTS (
          SELECT 1 FROM dbo.T_META_OBJECTTYPE WITH (UPDLOCK, HOLDLOCK)
          WHERE FID=@formId AND FBASEOBJECTID=N'BD_Department' AND FVERSION=@expectedVersion
            AND FKERNELXML.value('(/FormMetadata/BusinessInfo/BusinessInfo/Elements/TextField[Key=sql:variable("@fieldKey")]/Id/text())[1]','nvarchar(64)')
              = FKERNELXML.value('(/FormMetadata/LayoutInfos/LayoutInfo/Appearances/TextFieldAppearance[Key=sql:variable("@fieldKey")]/Id/text())[1]','nvarchar(64)')
        ) THROW 51020, 'Form version or field linkage changed since preview.', 1;

        UPDATE dbo.T_META_OBJECTTYPE
        SET FKERNELXML.modify('replace value of (/FormMetadata/LayoutInfos/LayoutInfo/Appearances/TextFieldAppearance[Key=sql:variable("@fieldKey")]/Id/text())[1] with sql:variable("@appearanceId")'),
            FVERSION=@newVersion
        WHERE FID=@formId AND FVERSION=@expectedVersion;
        IF @@ROWCOUNT<>1 THROW 51021, 'Could not update the field appearance linkage.', 1;

        SELECT @formId AS form_id, @fieldKey AS field_key, @appearanceId AS appearance_id, @newVersion AS new_version;
      `);
    await tx.commit();
    console.log(JSON.stringify({
      upgraded: true,
      database: allowedDatabase,
      form_id: formId,
      field_key: fieldKey,
      old_shared_id: row.business_id,
      new_appearance_id: update.recordset?.[0]?.appearance_id,
      business_id_preserved: true,
      visibility_values_preserved: true,
      physical_column_exists: true,
      new_form_version: update.recordset?.[0]?.new_version,
      backup_file: backupPath,
      procedure_updated_for_future_fields: procedureUpdated || hasSeparateAppearanceId,
      next_step: 'Refresh Kingdee metadata/cache, then reopen the department add form.',
    }));
  } catch (error) {
    if (tx._aborted !== true) await tx.rollback().catch(() => {});
    throw error;
  }
} finally {
  await pool.close();
}

function replaceOnce(source, before, after) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error('The stored procedure source did not match the expected safe upgrade pattern.');
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}
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
  return process.env.SQLSERVER_PORT ? numberOr('SQLSERVER_PORT', undefined) : undefined;
}
function boolOr(name, fallback) {
  const value = process.env[name]?.toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}
