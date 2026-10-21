import { allowedDatabase, departmentFormId, assertProvisioning } from './scope.js';
import dotenv from 'dotenv';
import { appendFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sql from 'mssql';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
dotenv.config({ path: envPath });

const database = process.env.SQLSERVER_DATABASE;
assertProvisioning();
const writerLogin = 'mcp_kingdeex_deptmeta';
if (database.toLowerCase() !== allowedDatabase) {
  throw new Error(`Refusing to provision kingdeeX outside the configured test database (configured database: ${database}).`);
}

const common = {
  server: required('SQLSERVER_HOST'),
  port: optionalNumber('SQLSERVER_PORT'),
  database,
  connectionTimeout: numberOr('SQLSERVER_CONNECTION_TIMEOUT_MS', 15000),
  requestTimeout: numberOr('SQLSERVER_QUERY_TIMEOUT_MS', 30000),
  options: {
    encrypt: boolOr('SQLSERVER_ENCRYPT', true),
    trustServerCertificate: boolOr('SQLSERVER_TRUST_SERVER_CERTIFICATE', false),
    instanceName: process.env.SQLSERVER_INSTANCE || undefined,
    enableArithAbort: true,
  },
};

let writerPassword = process.env.SQLSERVER_KINGDEEX_WRITE_PASSWORD?.trim();
if (!writerPassword) {
  writerPassword = randomBytes(36).toString('base64url');
  await appendFile(envPath, `\n# Dedicated restricted credential for the kingdeeX department metadata test MCP.\nSQLSERVER_KINGDEEX_WRITE_PASSWORD=${writerPassword}\n`, 'utf8');
  process.env.SQLSERVER_KINGDEEX_WRITE_PASSWORD = writerPassword;
}

const adminPool = await new sql.ConnectionPool({
  ...common,
  user: process.env.KINGDEEX_ADMIN_USER || 'sa',
  password: required('KINGDEEX_ADMIN_PASSWORD'),
  pool: { max: 1, min: 0, idleTimeoutMillis: 30000 },
}).connect();

const procedureSql = String.raw`
CREATE PROCEDURE dbo.MCP_KINGDEEX_AddDeptTextField
  @FieldKey nvarchar(128),
  @DisplayName nvarchar(128),
  @ExpectedVersion varchar(100),
  @NewVersion varchar(100),
  @ScopeFormId varchar(36)
WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;
  IF @ScopeFormId IS NULL OR @ScopeFormId<>'${departmentFormId}' THROW 51901, 'Runtime scope does not match the provisioned extension form.', 1;
  IF LOWER(DB_NAME())<>N'${allowedDatabase}' THROW 51900, 'Procedure is restricted to its provisioned test database.', 1;

  IF @FieldKey NOT LIKE N'F_KINGDIEX[_]%'
     OR @FieldKey LIKE N'%[^A-Za-z0-9_]%' COLLATE Latin1_General_100_BIN2
     OR LEN(@FieldKey) > 54
    THROW 51001, 'FieldKey must use the F_KINGDIEX_ prefix and ASCII letters, digits, or underscores.', 1;
  IF NULLIF(LTRIM(RTRIM(@DisplayName)), N'') IS NULL OR LEN(@DisplayName) > 128
    THROW 51002, 'DisplayName is required and must be at most 128 characters.', 1;
  IF @NewVersion NOT LIKE '[0-9]%' OR LEN(@NewVersion) > 100
    THROW 51003, 'NewVersion is invalid.', 1;
  IF NOT EXISTS (SELECT 1 FROM dbo.T_META_OBJECTTYPE WHERE FID='${departmentFormId}' AND FBASEOBJECTID='BD_Department')
    THROW 51004, 'The allowlisted department extension metadata is missing.', 1;

  DECLARE @metadata xml;
  SELECT @metadata=FKERNELXML FROM dbo.T_META_OBJECTTYPE WHERE FID='${departmentFormId}';
  IF @metadata IS NULL
    THROW 51005, 'The allowlisted department form has no kernel XML.', 1;
  IF NOT EXISTS (SELECT 1 FROM dbo.T_META_OBJECTTYPE WHERE FID='${departmentFormId}' AND FVERSION=@ExpectedVersion)
    THROW 51013, 'The department metadata version changed since preview. Refresh and retry after review.', 1;
  IF @metadata.exist('/FormMetadata/BusinessInfo/BusinessInfo/Elements/*[Key=sql:variable("@FieldKey")]')=1
    THROW 51006, 'The field key already exists in metadata.', 1;
  IF @metadata.exist('/FormMetadata/LayoutInfos/LayoutInfo/Appearances/*[Key=sql:variable("@FieldKey")]')=1
    THROW 51007, 'The field key already exists in layout metadata.', 1;
  IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'dbo.T_BD_DEPARTMENT') AND name=@FieldKey)
    THROW 51008, 'The physical column already exists.', 1;
  IF @metadata.exist('/FormMetadata/BusinessInfo/BusinessInfo/Elements')=0
     OR @metadata.exist('/FormMetadata/LayoutInfos/LayoutInfo/Appearances')=0
    THROW 51009, 'Expected metadata or layout XML nodes are missing.', 1;

  DECLARE @ListTabIndex int, @ZOrderIndex int, @TabIndex int, @Top int;
  SELECT @ListTabIndex=ISNULL(MAX(TRY_CONVERT(int, E.N.value('(ListTabIndex/text())[1]','nvarchar(20)'))),0)+1
  FROM @metadata.nodes('/FormMetadata/BusinessInfo/BusinessInfo/Elements/*') E(N);
  SELECT @ZOrderIndex=ISNULL(MAX(TRY_CONVERT(int, A.N.value('(ZOrderIndex/text())[1]','nvarchar(20)'))),0)+1,
         @TabIndex=ISNULL(MAX(TRY_CONVERT(int, A.N.value('(Tabindex/text())[1]','nvarchar(20)'))),0)+1,
         @Top=ISNULL(MAX(TRY_CONVERT(int, A.N.value('(Top/text())[1]','nvarchar(20)'))),201)+32
  FROM @metadata.nodes('/FormMetadata/LayoutInfos/LayoutInfo/Appearances/*') A(N)
  WHERE A.N.value('(Container/text())[1]','nvarchar(128)')=N'FTAB_PBASE';

  DECLARE @ElementId nvarchar(32)=REPLACE(CONVERT(nvarchar(36),NEWID()),N'-',N'');
  DECLARE @AppearanceId nvarchar(32)=REPLACE(CONVERT(nvarchar(36),NEWID()),N'-',N'');
  DECLARE @FieldNode xml, @AppearanceNode xml;
  SELECT @FieldNode=(
    SELECT N'1' AS [@ElementType], N'0' AS [@ElementStyle],
           N'0' AS [ConditionType], @FieldKey AS [PropertyName],
           UPPER(@FieldKey) AS [FieldName], @ListTabIndex AS [ListTabIndex],
           @DisplayName AS [Name], @ElementId AS [Id], @FieldKey AS [Key]
    FOR XML PATH('TextField'), TYPE
  );
  SELECT @AppearanceNode=(
    SELECT N'1' AS [@ElementType], N'1' AS [@ElementStyle],
           N'setnull' AS [EmptyText/@action], @FieldKey AS [Key],
           100 AS [ListDefaultWidth], N'FTAB_PBASE' AS [Container],
           @ZOrderIndex AS [ZOrderIndex], @TabIndex AS [Tabindex],
           12 AS [Left], @Top AS [Top], 100 AS [LabelWidth], 300 AS [Width],
           1023 AS [Visible], 100 AS [VisibleExt], @DisplayName AS [Caption],
           @AppearanceId AS [Id]
    FOR XML PATH('TextFieldAppearance'), TYPE
  );

  BEGIN TRY
    BEGIN TRANSACTION;
    DECLARE @ddl nvarchar(max)=N'ALTER TABLE dbo.T_BD_DEPARTMENT ADD '+QUOTENAME(@FieldKey)+N' nvarchar(255) NULL;';
    EXEC sys.sp_executesql @ddl;

    UPDATE dbo.T_META_OBJECTTYPE
      SET FKERNELXML.modify('insert sql:variable("@FieldNode") as last into (/FormMetadata/BusinessInfo/BusinessInfo/Elements)[1]')
      WHERE FID='${departmentFormId}' AND FVERSION=@ExpectedVersion;
    IF @@ROWCOUNT<>1 THROW 51010, 'Could not append the field metadata node.', 1;

    UPDATE dbo.T_META_OBJECTTYPE
      SET FKERNELXML.modify('insert sql:variable("@AppearanceNode") as last into (/FormMetadata/LayoutInfos/LayoutInfo/Appearances)[1]')
      WHERE FID='${departmentFormId}' AND FVERSION=@ExpectedVersion;
    IF @@ROWCOUNT<>1 THROW 51011, 'Could not append the field layout node.', 1;

    UPDATE dbo.T_META_OBJECTTYPE SET FVERSION=@NewVersion
      WHERE FID='${departmentFormId}' AND FVERSION=@ExpectedVersion;
    IF @@ROWCOUNT<>1 THROW 51012, 'Could not update the metadata version.', 1;
    COMMIT TRANSACTION;
  END TRY
  BEGIN CATCH
    IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
    THROW;
  END CATCH;

  SELECT N'${departmentFormId}' AS form_id,
         N'T_BD_DEPARTMENT' AS physical_table,
         @FieldKey AS field_key,
         UPPER(@FieldKey) AS physical_column,
         @DisplayName AS display_name,
         @NewVersion AS new_version,
         @Top AS layout_top;
END;
`;

try {
  const identity = await adminPool.request().query(`
    SELECT DB_NAME() AS database_name,
           IS_SRVROLEMEMBER('sysadmin') AS is_sysadmin,
           SUSER_ID(N'${writerLogin}') AS existing_login_id,
           OBJECT_ID(N'dbo.MCP_KINGDEEX_AddDeptTextField', N'P') AS existing_procedure_id
  `);
  const row = identity.recordset?.[0];
  if (row?.database_name?.toLowerCase() !== allowedDatabase || row?.is_sysadmin !== 1) {
    throw new Error('The configured local sa connection did not confirm sysadmin access to the configured test database.');
  }
  if (row.existing_login_id !== null || row.existing_procedure_id !== null) {
    throw new Error('The dedicated login or procedure already exists. Nothing was changed; inspect it before reuse.');
  }

  await adminPool.request().batch(procedureSql);
  const request = adminPool.request().input('writerPassword', sql.NVarChar(256), writerPassword);
  await request.query(`
    DECLARE @sql nvarchar(max)=N'CREATE LOGIN [mcp_kingdeex_deptmeta] WITH PASSWORD = '
      + QUOTENAME(@writerPassword, '''') + N', CHECK_POLICY = ON, CHECK_EXPIRATION = OFF;';
    EXEC sys.sp_executesql @sql;
    CREATE USER [mcp_kingdeex_deptmeta] FOR LOGIN [mcp_kingdeex_deptmeta];
    GRANT EXECUTE ON OBJECT::dbo.MCP_KINGDEEX_AddDeptTextField TO [mcp_kingdeex_deptmeta];
  `);

  console.log(JSON.stringify({
    provisioned: true,
    database: allowedDatabase,
    login: 'mcp_kingdeex_deptmeta',
    execute_permission: 'dbo.MCP_KINGDEEX_AddDeptTextField only',
    broad_write_roles: false,
    allowed_form: departmentFormId,
    allowed_physical_table: 'dbo.T_BD_DEPARTMENT',
  }));
} finally {
  await adminPool.close();
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
  return process.env[name] ? numberOr(name, undefined) : undefined;
}
function boolOr(name, fallback) {
  const value = process.env[name]?.toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}
