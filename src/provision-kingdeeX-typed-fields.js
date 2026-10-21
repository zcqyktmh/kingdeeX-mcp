import { allowedDatabase, departmentFormId, assertProvisioning } from './scope.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import sql from 'mssql';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const database = process.env.SQLSERVER_DATABASE;
assertProvisioning();
const writerLogin = 'mcp_kingdeex_deptmeta';
if (database.toLowerCase() !== allowedDatabase) {
  throw new Error(`Refusing to provision kingdeeX outside the configured test database (configured database: ${database}).`);
}

const adminPool = await new sql.ConnectionPool({
  server: required('SQLSERVER_HOST'),
  port: optionalNumber('SQLSERVER_PORT'),
  database,
  user: process.env.KINGDEEX_ADMIN_USER || 'sa',
  password: required('KINGDEEX_ADMIN_PASSWORD'),
  connectionTimeout: numberOr('SQLSERVER_CONNECTION_TIMEOUT_MS', 15000),
  requestTimeout: numberOr('SQLSERVER_QUERY_TIMEOUT_MS', 30000),
  options: {
    encrypt: boolOr('SQLSERVER_ENCRYPT', true),
    trustServerCertificate: boolOr('SQLSERVER_TRUST_SERVER_CERTIFICATE', false),
    instanceName: process.env.SQLSERVER_INSTANCE || undefined,
    enableArithAbort: true,
  },
  pool: { max: 1, min: 0, idleTimeoutMillis: 30000 },
}).connect();

const procedureSql = String.raw`
CREATE OR ALTER PROCEDURE dbo.MCP_KINGDEEX_AddDeptTypedField
  @FieldKey nvarchar(128),
  @DisplayName nvarchar(128),
  @FieldType varchar(32),
  @ExpectedVersion varchar(100),
  @NewVersion varchar(100),
  @ScopeFormId varchar(36),
  @FieldPrecision int=23,
  @FieldScale int=10,
  @LookupObjectId varchar(36)=NULL,
  @OrgFieldKey varchar(64)=NULL,
  @ControlFieldKey varchar(64)=NULL,
  @BaseQtyFieldKey varchar(64)=NULL,
  @IsRequired bit=0,
  @EnumOptionsJson nvarchar(max)=NULL
WITH EXECUTE AS OWNER
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;
  IF @ScopeFormId IS NULL OR @ScopeFormId<>'${departmentFormId}' THROW 51901, 'Runtime scope does not match the provisioned extension form.', 1;
  IF LOWER(DB_NAME())<>N'${allowedDatabase}' THROW 51900, 'Procedure is restricted to its provisioned test database.', 1;

  IF @FieldKey NOT LIKE N'F_KINGDIEX[_]%'
     OR @FieldKey LIKE N'%[^A-Za-z0-9_]%' COLLATE Latin1_General_100_BIN2
     OR LEN(@FieldKey)>54
    THROW 51201, 'FieldKey must use the F_KINGDIEX_ prefix and ASCII letters, digits, or underscores.', 1;
  IF NULLIF(LTRIM(RTRIM(@DisplayName)),N'') IS NULL OR LEN(@DisplayName)>128
    THROW 51202, 'DisplayName is required and must be at most 128 characters.', 1;
  IF @NewVersion NOT LIKE '[0-9]%' OR LEN(@NewVersion)>100
    THROW 51203, 'NewVersion is invalid.', 1;
  IF @FieldType NOT IN ('TextField','IntegerField','DecimalField','AmountField','QtyField','BaseQtyField','DateField','DateTimeField','TimeField','CheckBoxField','ComboField','BaseDataField','OrgField','UserField','UnitField','AssistantField')
    THROW 51204, 'FieldType is not in the fixed supported type list.', 1;
  IF @FieldPrecision<1 OR @FieldPrecision>23 OR @FieldScale<0 OR @FieldScale>10 OR @FieldScale>@FieldPrecision
    THROW 51205, 'Numeric precision or scale is invalid.', 1;
  IF @NewVersion=@ExpectedVersion
    THROW 51206, 'NewVersion must differ from the current metadata version.', 1;
  IF NOT EXISTS (SELECT 1 FROM dbo.T_META_OBJECTTYPE WHERE FID='${departmentFormId}' AND FBASEOBJECTID='BD_Department')
    THROW 51207, 'The allowlisted department extension metadata is missing.', 1;

  DECLARE @metadata xml, @baseMetadata xml;
  SELECT @metadata=FKERNELXML FROM dbo.T_META_OBJECTTYPE WHERE FID='${departmentFormId}';
  SELECT @baseMetadata=FKERNELXML FROM dbo.T_META_OBJECTTYPE WHERE FID='BD_Department';
  IF @metadata IS NULL OR @baseMetadata IS NULL
    THROW 51208, 'Department metadata or base metadata is missing.', 1;
  IF NOT EXISTS (SELECT 1 FROM dbo.T_META_OBJECTTYPE WHERE FID='${departmentFormId}' AND FVERSION=@ExpectedVersion)
    THROW 51209, 'Department metadata version changed since preview. Refresh and retry.', 1;
  IF @metadata.exist('/FormMetadata/BusinessInfo/BusinessInfo/Elements/*[Key=sql:variable("@FieldKey")]')=1
     OR @baseMetadata.exist('/FormMetadata/BusinessInfo/BusinessInfo/Elements/*[Key=sql:variable("@FieldKey")]')=1
    THROW 51210, 'The field key already exists in metadata.', 1;
  IF @metadata.exist('/FormMetadata/LayoutInfos/LayoutInfo/Appearances/*[Key=sql:variable("@FieldKey")]')=1
    THROW 51211, 'The field key already exists in layout metadata.', 1;
  IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID(N'dbo.T_BD_DEPARTMENT') AND UPPER(name)=UPPER(@FieldKey))
    THROW 51212, 'The physical column already exists.', 1;
  IF @metadata.exist('/FormMetadata/BusinessInfo/BusinessInfo/Elements')=0 OR @metadata.exist('/FormMetadata/LayoutInfos/LayoutInfo/Appearances')=0
    THROW 51213, 'Expected metadata or layout XML nodes are missing.', 1;

  IF @FieldType IN ('BaseDataField','AssistantField','OrgField','UserField','UnitField')
  BEGIN
    IF @LookupObjectId IS NULL OR TRY_CONVERT(uniqueidentifier,@LookupObjectId) IS NULL
      THROW 51214, 'LookupObjectId must be a valid GUID for lookup fields.', 1;
  END;
  IF @FieldType NOT IN ('BaseDataField','AssistantField','OrgField','UserField','UnitField') AND @LookupObjectId IS NOT NULL
    THROW 51215, 'LookupObjectId is only accepted for lookup fields.', 1;
  IF @OrgFieldKey IS NOT NULL
  BEGIN
    IF @FieldType NOT IN ('BaseDataField','OrgField','UserField','UnitField')
       OR @OrgFieldKey LIKE '%[^A-Za-z0-9_]%' COLLATE Latin1_General_100_BIN2
      THROW 51216, 'OrgFieldKey is invalid for this field type.', 1;
    IF @metadata.exist('/FormMetadata/BusinessInfo/BusinessInfo/Elements/*[Key=sql:variable("@OrgFieldKey")]')=0
       AND @baseMetadata.exist('/FormMetadata/BusinessInfo/BusinessInfo/Elements/*[Key=sql:variable("@OrgFieldKey")]')=0
      THROW 51217, 'OrgFieldKey must refer to a field on the department object.', 1;
  END;
  IF @ControlFieldKey IS NOT NULL
  BEGIN
    IF @FieldType NOT IN ('AmountField','QtyField','BaseQtyField')
       OR @ControlFieldKey LIKE '%[^A-Za-z0-9_]%' COLLATE Latin1_General_100_BIN2
      THROW 51218, 'ControlFieldKey is invalid for this field type.', 1;
    IF @metadata.exist('/FormMetadata/BusinessInfo/BusinessInfo/Elements/*[Key=sql:variable("@ControlFieldKey")]')=0
       AND @baseMetadata.exist('/FormMetadata/BusinessInfo/BusinessInfo/Elements/*[Key=sql:variable("@ControlFieldKey")]')=0
      THROW 51219, 'ControlFieldKey must refer to a field on the department object.', 1;
  END;
  IF @BaseQtyFieldKey IS NOT NULL
  BEGIN
    IF @FieldType<>'QtyField' OR @BaseQtyFieldKey LIKE '%[^A-Za-z0-9_]%' COLLATE Latin1_General_100_BIN2
      THROW 51220, 'BaseQtyFieldKey is only accepted for QtyField.', 1;
    IF @metadata.exist('/FormMetadata/BusinessInfo/BusinessInfo/Elements/*[Key=sql:variable("@BaseQtyFieldKey")]')=0
       AND @baseMetadata.exist('/FormMetadata/BusinessInfo/BusinessInfo/Elements/*[Key=sql:variable("@BaseQtyFieldKey")]')=0
      THROW 51221, 'BaseQtyFieldKey must refer to a field on the department object.', 1;
  END;

  DECLARE @EnumOptions TABLE(Seq int NOT NULL,OptionValue varchar(100) NOT NULL,Caption nvarchar(200) NOT NULL);
  IF @FieldType='ComboField'
  BEGIN
    IF @EnumOptionsJson IS NULL OR ISJSON(@EnumOptionsJson)<>1
      THROW 51222, 'ComboField requires valid enumOptions JSON.', 1;
    INSERT INTO @EnumOptions(Seq,OptionValue,Caption)
      SELECT TRY_CONVERT(int,[key])+1,JSON_VALUE([value],'$.value'),JSON_VALUE([value],'$.caption')
      FROM OPENJSON(@EnumOptionsJson);
    IF (SELECT COUNT(*) FROM @EnumOptions)<2 OR (SELECT COUNT(*) FROM @EnumOptions)>50
      THROW 51223, 'ComboField requires between 2 and 50 enum options.', 1;
    IF EXISTS (SELECT 1 FROM @EnumOptions WHERE NULLIF(OptionValue,'') IS NULL OR NULLIF(Caption,N'') IS NULL OR OptionValue LIKE '%[^A-Za-z0-9_-]%' COLLATE Latin1_General_100_BIN2)
      THROW 51224, 'Enum option values must be unique ASCII codes and captions must be nonempty.', 1;
    IF EXISTS (SELECT OptionValue FROM @EnumOptions GROUP BY OptionValue HAVING COUNT(*)>1)
      THROW 51225, 'Enum option values must be unique.', 1;
  END
  ELSE IF @EnumOptionsJson IS NOT NULL
    THROW 51226, 'Enum options are only accepted for ComboField.', 1;

  DECLARE @SqlType nvarchar(100),@ElementTypeCode int,@FieldTypeCode int=NULL,@FunControl int=NULL,@ConditionType nvarchar(20)=N'0',@ElementId nvarchar(36)=CONVERT(nvarchar(36),NEWID()),@AppearanceId nvarchar(36)=CONVERT(nvarchar(36),NEWID()),@EnumId varchar(36)=NULL;
  SET @SqlType=CASE
    WHEN @FieldType='TextField' THEN N'nvarchar(255) NULL'
    WHEN @FieldType='IntegerField' THEN N'int NULL'
    WHEN @FieldType IN ('DecimalField','AmountField','QtyField','BaseQtyField') THEN N'decimal('+CONVERT(nvarchar(2),@FieldPrecision)+N','+CONVERT(nvarchar(2),@FieldScale)+N') NULL'
    WHEN @FieldType IN ('DateField','DateTimeField','TimeField') THEN N'datetime NULL'
    WHEN @FieldType='CheckBoxField' THEN N'bit NULL'
    WHEN @FieldType='ComboField' THEN N'varchar(100) NULL'
    WHEN @FieldType IN ('BaseDataField','OrgField','UserField','UnitField','AssistantField') THEN N'int NULL'
  END;
  SET @ElementTypeCode=CASE @FieldType
    WHEN 'TextField' THEN 1 WHEN 'DecimalField' THEN 2 WHEN 'IntegerField' THEN 3 WHEN 'DateField' THEN 4
    WHEN 'DateTimeField' THEN 5 WHEN 'OrgField' THEN 7 WHEN 'CheckBoxField' THEN 8 WHEN 'ComboField' THEN 9
    WHEN 'BaseDataField' THEN 13 WHEN 'UserField' THEN 18 WHEN 'AmountField' THEN 21 WHEN 'QtyField' THEN 22
    WHEN 'AssistantField' THEN 30 WHEN 'TimeField' THEN 43 WHEN 'UnitField' THEN 46 WHEN 'BaseQtyField' THEN 47 END;
  SET @FieldTypeCode=CASE
    WHEN @FieldType IN ('BaseDataField','OrgField','UserField','UnitField') THEN 127
    WHEN @FieldType='AssistantField' THEN 231
    WHEN @FieldType='ComboField' THEN 167
    WHEN @FieldType IN ('DateTimeField','TimeField') THEN 61 END;
  SET @FunControl=CASE @FieldType
    WHEN 'IntegerField' THEN 61967 WHEN 'DecimalField' THEN 62575 WHEN 'AmountField' THEN 62063
    WHEN 'QtyField' THEN 63103 WHEN 'BaseQtyField' THEN 62063 WHEN 'DateField' THEN 62015
    WHEN 'DateTimeField' THEN 63103 WHEN 'CheckBoxField' THEN 61455 WHEN 'ComboField' THEN 62543
    WHEN 'BaseDataField' THEN 61503 WHEN 'OrgField' THEN 62079 WHEN 'UserField' THEN 61455
    WHEN 'UnitField' THEN 63102 WHEN 'AssistantField' THEN 62575 END;
  SET @ConditionType=CASE WHEN @FieldType IN ('DecimalField','AmountField','QtyField','BaseQtyField','IntegerField') THEN N'1' WHEN @FieldType IN ('DateField','DateTimeField') THEN N'2' WHEN @FieldType='ComboField' THEN N'5' WHEN @FieldType='CheckBoxField' THEN N'7' ELSE N'0' END;
  IF @FieldType='ComboField' SET @EnumId=CONVERT(varchar(36),NEWID());

  DECLARE @ListTabIndex int,@ZOrderIndex int,@TabIndex int,@Top int;
  SELECT @ListTabIndex=ISNULL(MAX(TRY_CONVERT(int,E.N.value('(ListTabIndex/text())[1]','nvarchar(20)'))),0)+1
  FROM @metadata.nodes('/FormMetadata/BusinessInfo/BusinessInfo/Elements/*') E(N);
  SELECT @ZOrderIndex=ISNULL(MAX(TRY_CONVERT(int,A.N.value('(ZOrderIndex/text())[1]','nvarchar(20)'))),0)+1,
         @TabIndex=ISNULL(MAX(TRY_CONVERT(int,A.N.value('(Tabindex/text())[1]','nvarchar(20)'))),0)+1,
         @Top=ISNULL(MAX(TRY_CONVERT(int,A.N.value('(Top/text())[1]','nvarchar(20)'))),201)+32
  FROM @metadata.nodes('/FormMetadata/LayoutInfos/LayoutInfo/Appearances/*') A(N)
  WHERE A.N.value('(Container/text())[1]','nvarchar(128)')=N'FTAB_PBASE';

  DECLARE @FieldNode xml,@AppearanceNode xml,@FieldXmlText nvarchar(max),@AppearanceXmlText nvarchar(max),@AppearanceName nvarchar(64)=@FieldType+N'Appearance';
  SELECT @FieldNode=(
    SELECT CONVERT(nvarchar(10),@ElementTypeCode) AS [@ElementType],N'0' AS [@ElementStyle],
      @ConditionType AS [ConditionType],
      CASE WHEN @FieldType IN ('DecimalField','AmountField','QtyField','BaseQtyField') THEN CONVERT(nvarchar(10),@FieldScale) END AS [FieldScale],
      CASE WHEN @FieldType IN ('DecimalField','AmountField','QtyField','BaseQtyField') THEN CONVERT(nvarchar(10),@FieldPrecision) END AS [FieldPrecision],
      CASE WHEN @FieldType IN ('BaseDataField','OrgField','UserField','UnitField','AssistantField') THEN @LookupObjectId END AS [LookUpObjectID],
      CASE WHEN @FieldType IN ('BaseDataField','OrgField','UserField','UnitField') THEN @OrgFieldKey END AS [OrgFieldKey],
      CASE WHEN @FieldType IN ('BaseDataField','AssistantField') THEN N'FNUMBER' END AS [SrcFindFieldName],
      CASE WHEN @FieldType IN ('BaseDataField','AssistantField') THEN N'FNAME' END AS [SrcDisplayFieldName],
      CASE WHEN @FieldType='OrgField' THEN N'107' END AS [OrgFuncs],
      CASE WHEN @FieldType='OrgField' THEN N'108' END AS [OrgBizRel],
      CASE WHEN @FieldType='OrgField' THEN N'2' END AS [OrgBizRelWay],
      CASE WHEN @FieldType='OrgField' THEN @OrgFieldKey END AS [OrgBizRelField],
      CASE WHEN @FieldType='UnitField' THEN N'0' END AS [UnitTypeKey],
      CASE WHEN @FieldType='ComboField' THEN @EnumId END AS [EnumType],
      CASE WHEN @FieldType IN ('ComboField','CheckBoxField') THEN N'0' END AS [DatabaseType],
      CASE WHEN @FieldType='ComboField' THEN N'100' WHEN @FieldType='CheckBoxField' THEN N'1' END AS [Editlen],
      CASE WHEN @FieldType='CheckBoxField' THEN N'False' END AS [DefValue/DefaultValue/Value],
      CASE WHEN @IsRequired=1 THEN N'1' END AS [MustInput],
      CASE
        WHEN @FieldType IN ('DateTimeField','TimeField') THEN CONVERT(nvarchar(10),@FieldTypeCode)
        WHEN @FieldType IN ('ComboField','BaseDataField','OrgField','UserField','UnitField','AssistantField') THEN CONVERT(nvarchar(10),@FieldTypeCode)
      END AS [FieldType],
      CASE WHEN @FieldType='ComboField' THEN N'1' WHEN @FieldType IN ('DateTimeField','TimeField','CheckBoxField','BaseDataField','OrgField','UserField','UnitField','AssistantField') THEN N'1' END AS [FireUpdateEvent],
      @FieldKey AS [PropertyName],UPPER(@FieldKey) AS [FieldName],
      CASE WHEN @FieldType IN ('AmountField','QtyField','BaseQtyField') THEN @ControlFieldKey END AS [ControlFieldKey],
      CASE WHEN @FieldType='QtyField' THEN @BaseQtyFieldKey END AS [BaseQtyFieldKey],
      CASE WHEN @FieldType IN ('IntegerField','DecimalField','AmountField','QtyField','BaseQtyField','DateField','DateTimeField','TimeField','CheckBoxField','ComboField','BaseDataField','OrgField','UserField','UnitField','AssistantField') THEN CONVERT(nvarchar(20),@FunControl) END AS [FunControl],
      @ListTabIndex AS [ListTabIndex],@DisplayName AS [Name],@ElementId AS [Id],@FieldKey AS [Key]
    FOR XML PATH('GenericField'),TYPE
  );
  SET @FieldXmlText=REPLACE(REPLACE(CONVERT(nvarchar(max),@FieldNode),N'<GenericField',N'<'+@FieldType),N'</GenericField>',N'</'+@FieldType+N'>');
  SET @FieldNode=CONVERT(xml,@FieldXmlText);
  SELECT @AppearanceNode=(
    SELECT CONVERT(nvarchar(10),@ElementTypeCode) AS [@ElementType],N'1' AS [@ElementStyle],
      N'setnull' AS [EmptyText/@action],@FieldKey AS [Key],100 AS [ListDefaultWidth],N'FTAB_PBASE' AS [Container],
      @ZOrderIndex AS [ZOrderIndex],@TabIndex AS [Tabindex],12 AS [Left],@Top AS [Top],
      100 AS [LabelWidth],300 AS [Width],1023 AS [Visible],100 AS [VisibleExt],0 AS [Locked],
      @DisplayName AS [Caption],@AppearanceId AS [Id]
    FOR XML PATH('GenericFieldAppearance'),TYPE
  );
  SET @AppearanceXmlText=REPLACE(REPLACE(CONVERT(nvarchar(max),@AppearanceNode),N'<GenericFieldAppearance',N'<'+@AppearanceName),N'</GenericFieldAppearance>',N'</'+@AppearanceName+N'>');
  SET @AppearanceNode=CONVERT(xml,@AppearanceXmlText);

  BEGIN TRY
    BEGIN TRANSACTION;
    IF @FieldType='ComboField'
    BEGIN
      INSERT INTO dbo.T_META_FORMENUM(FID,FCATEGORY,FISSYSPRESET) VALUES(@EnumId,0,'0');
      INSERT INTO dbo.T_META_FORMENUM_L(FPKID,FID,FLOCALEID,FNAME) VALUES(CONVERT(varchar(36),NEWID()),@EnumId,2052,@DisplayName);
      INSERT INTO dbo.T_META_FORMENUMITEM(FID,FENUMID,FVALUE,FSEQ,FINVALID,FISSYSPRESET)
        SELECT @EnumId,CONVERT(varchar(36),NEWID()),OptionValue,Seq,'0','0' FROM @EnumOptions;
      INSERT INTO dbo.T_META_FORMENUMITEM_L(FPKID,FENUMID,FLOCALEID,FCAPTION)
        SELECT CONVERT(varchar(36),NEWID()),i.FENUMID,2052,o.Caption
        FROM dbo.T_META_FORMENUMITEM i JOIN @EnumOptions o ON o.Seq=i.FSEQ WHERE i.FID=@EnumId;
    END;

    DECLARE @ddl nvarchar(max)=N'ALTER TABLE dbo.T_BD_DEPARTMENT ADD '+QUOTENAME(@FieldKey)+N' '+@SqlType+N';';
    EXEC sys.sp_executesql @ddl;

    UPDATE dbo.T_META_OBJECTTYPE
      SET FKERNELXML.modify('insert sql:variable("@FieldNode") as last into (/FormMetadata/BusinessInfo/BusinessInfo/Elements)[1]')
      WHERE FID='${departmentFormId}' AND FVERSION=@ExpectedVersion;
    IF @@ROWCOUNT<>1 THROW 51227, 'Could not append the typed field metadata node.', 1;
    UPDATE dbo.T_META_OBJECTTYPE
      SET FKERNELXML.modify('insert sql:variable("@AppearanceNode") as last into (/FormMetadata/LayoutInfos/LayoutInfo/Appearances)[1]')
      WHERE FID='${departmentFormId}' AND FVERSION=@ExpectedVersion;
    IF @@ROWCOUNT<>1 THROW 51228, 'Could not append the typed field appearance node.', 1;
    UPDATE dbo.T_META_OBJECTTYPE SET FVERSION=@NewVersion
      WHERE FID='${departmentFormId}' AND FVERSION=@ExpectedVersion;
    IF @@ROWCOUNT<>1 THROW 51229, 'Could not update the metadata version.', 1;
    COMMIT TRANSACTION;
  END TRY
  BEGIN CATCH
    IF XACT_STATE()<>0 ROLLBACK TRANSACTION;
    THROW;
  END CATCH;

  SELECT N'${departmentFormId}' AS form_id,N'T_BD_DEPARTMENT' AS physical_table,
    @FieldKey AS field_key,@FieldType AS field_type,@SqlType AS physical_column,@LookupObjectId AS lookup_object_id,
    @EnumId AS enum_id,@DisplayName AS display_name,@NewVersion AS new_version,@Top AS layout_top;
END;
`;

try {
  const identity = await adminPool.request().query(`
    SELECT DB_NAME() AS database_name,
           IS_SRVROLEMEMBER('sysadmin') AS is_sysadmin,
           SUSER_ID(N'${writerLogin}') AS writer_login_id,
           OBJECT_ID(N'dbo.MCP_KINGDEEX_AddDeptTextField', N'P') AS text_procedure_id,
           OBJECT_ID(N'dbo.MCP_KINGDEEX_AddDeptCustomerField', N'P') AS customer_procedure_id,
           OBJECT_ID(N'dbo.MCP_KINGDEEX_AddDeptTypedField', N'P') AS typed_procedure_id
  `);
  const row = identity.recordset?.[0];
  if (row?.database_name?.toLowerCase() !== allowedDatabase || row?.is_sysadmin !== 1) {
    throw new Error('The configured local sa connection did not confirm sysadmin access to the configured test database.');
  }
  if (row.writer_login_id === null || row.text_procedure_id === null || row.customer_procedure_id === null) {
    throw new Error('The restricted kingdeeX login or an existing field procedure is missing. Nothing was changed.');
  }
  await adminPool.request().batch(procedureSql);
  await adminPool.request().query(`GRANT EXECUTE ON OBJECT::dbo.MCP_KINGDEEX_AddDeptTypedField TO [${writerLogin}]`);
  console.log(JSON.stringify({
    provisioned: true,
    database: allowedDatabase,
    login: writerLogin,
    execute_permission: 'dbo.MCP_KINGDEEX_AddDeptTypedField only',
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
