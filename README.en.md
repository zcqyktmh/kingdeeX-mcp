# kingdeeX MCP

[简体中文](README.md) | **English**

An experimental MCP server for Kingdee Cloud Galaxy Enterprise test copies. It previews and adds fields to one department extension form, and provides read-only discovery of configured form metadata. It uses Node.js and direct SQL Server metadata operations and is not an official Kingdee product.

This standalone package preserves scoped field writes. For general read-only SQL queries, see [kingdee-sqlserver-mcp](https://github.com/zcqyktmh/kingdee-sqlserver-mcp).

## Scope and limitations

- One locally configured test database and one extension form inheriting `BD_Department`. The physical table is fixed to `dbo.T_BD_DEPARTMENT` and the layout container to `FTAB_PBASE`.
- It does not create business objects or documents, and is not a general editor for arbitrary tables or forms.
- Writes update `T_META_OBJECTTYPE`, layout XML and physical columns. Combo fields also update enum tables. These operations bypass BOS/SVN history; do not run them against production.
- Writes are disabled by default. Field creation requires local `KINGDEEX_ENABLE_WRITES=true` and `apply:true` in the MCP call.
- Runtime reader and writer accounts are separate. The writer receives execution rights on specific procedures. Those procedures use `EXECUTE AS OWNER`; their internal checks are the actual write boundary. Review deployed definitions.
- Creation checks metadata, layout and column occupancy, saves an XML snapshot, and checks the metadata version. Column, metadata and enum changes run inside a procedure transaction.
- XML snapshots support inspection and recovery work; they are not full database backups. There is no automatic rollback or field deletion tool. Back up the test database first.
- After creation, save/publish the object in BOS, refresh metadata/cache and reopen the department form to verify behavior. The scripts do not update BOS/SVN application files automatically.

## Features

One MCP tool, `kingdeeX`, exposes these actions:

| Action | Purpose | Writes |
|---|---|---|
| `inspect_form_metadata` | Search configured form code/table pattern; return bounded XML previews and table/column candidates | No |
| `preview_add_department_text_field` | Preview a text field | No |
| `add_department_text_field` | Add a text field | Yes |
| `preview_add_department_customer_field` | Preview a customer reference field | No |
| `add_department_customer_field` | Add a customer reference field | Yes |
| `preview_add_department_typed_field` | Preview a supported typed field | No |
| `add_department_typed_field` | Add a supported typed field | Yes |

Supported types: `TextField`, `IntegerField`, `DecimalField`, `AmountField`, `QtyField`, `BaseQtyField`, `DateField`, `DateTimeField`, `TimeField`, `CheckBoxField`, `ComboField`, `BaseDataField`, `OrgField`, `UserField`, `UnitField`, `AssistantField`.

Field keys must match `F_KINGDIEX_[A-Z0-9_]{1,40}`. Typed actions accept `isRequired:true` for the BOS required flag, precision 1–23 and scale 0–10 with scale no greater than precision. Multilingual text, multi-select references and entry fields are unsupported. Compatibility depends on the actual Kingdee version and metadata structure.

## Requirements and local configuration

Use Node.js 20+, SQL Server 2016 SP1+ (`CREATE OR ALTER PROCEDURE` and JSON support), a compatible Kingdee test database and an MCP client supporting stdio.

```powershell
npm ci
Copy-Item .env.example .env
```

Configure the connection and read-only account in local `.env`. `SQLSERVER_DATABASE` must match `KINGDEEX_ALLOWED_DATABASE`, and system databases are rejected. Set `KINGDEEX_DEPARTMENT_FORM_ID` to the actual GUID of your department extension metadata. Placeholder settings cannot start the service.

No customer, organization, user or unit lookup object GUIDs are shipped. Confirm your local metadata and fill `KINGDEEX_CUSTOMER_OBJECT_ID`, `KINGDEEX_ORG_OBJECT_ID`, `KINGDEEX_USER_OBJECT_ID`, and `KINGDEEX_UNIT_OBJECT_ID`. Typed references also accept `lookupObjectId`. Do not copy these identifiers from another account set.

Optional `inspect_form_metadata` requires both `KINGDEEX_INSPECT_FORM_CODE` and `KINGDEEX_INSPECT_TABLE_PATTERN`. It searches XML text and table-name patterns; results are candidates, not guaranteed exact object mappings.

## Provisioning write procedures

Skip provisioning for previews and keep writes disabled. Before adding fields, review the source, back up the test database, configure local administrator credentials, and set `KINGDEEX_ENABLE_WRITES=true`. Setup scripts require sysadmin; only the local scripts read administrator credentials.

Run these in order. Every step requires explicit `--apply`:

```powershell
npm run provision -- --apply
npm run provision:customer -- --apply
npm run provision:typed -- --apply
```

Step 1 creates the dedicated `mcp_kingdeex_deptmeta` login/user and text-field procedure. If blank, a random writer password is generated and saved to `.env`. Step 2 requires the customer object GUID and creates the customer procedure. Step 3 creates or updates the typed-field procedure. Setup is not atomic across all steps. After a failure, inspect existing logins, users, procedures and grants before continuing.

The reader needs metadata/schema read access. The writer receives execution rights on the three procedures, without `db_datawriter` or `sysadmin` membership. The database and extension GUID are embedded in procedure definitions when provisioned. Changing `.env` does not migrate or redirect existing procedures; administrator review is required.

## MCP client configuration

```toml
[mcp_servers.kingdeeX]
command = "node"
args = ["C:/path/to/kingdeeX-mcp/src/kingdeeX.js"]
cwd = "C:/path/to/kingdeeX-mcp"
```

Replace the paths and reconnect the MCP client. `npm start` also launches the stdio server.

## Examples

Preview first:

```json
{"action":"preview_add_department_typed_field","fieldKey":"F_KINGDIEX_SAMPLE","displayName":"Sample quantity","fieldType":"QtyField","precision":23,"scale":4}
```

Review `can_apply`, database, form and field type, then add with the same parameters:

```json
{"action":"add_department_typed_field","fieldKey":"F_KINGDIEX_SAMPLE","displayName":"Sample quantity","fieldType":"QtyField","precision":23,"scale":4,"apply":true}
```

Combo fields need 2–50 options with unique ASCII codes and nonempty captions:

```json
{"action":"preview_add_department_typed_field","fieldKey":"F_KINGDIEX_STATUS","displayName":"Sample status","fieldType":"ComboField","enumOptions":[{"value":"A","caption":"Enabled"},{"value":"B","caption":"Disabled"}]}
```

References require `lookupObjectId` or configured local defaults. `orgFieldKey`, amount/quantity `controlFieldKey`, and quantity `baseQtyFieldKey` must refer to existing fields on the target object.

## Optional legacy ID repair

`npm run repair:element-ids -- --apply` handles an old text field whose business and appearance nodes share an ID. Explicitly configure `KINGDEEX_REPAIR_FIELD_KEY` and enable writes. The script may update the legacy text procedure before checking/repairing the field; review it first. Fresh installations already generate separate IDs and do not need this step.

## Publication and validation

This package excludes real connection settings, passwords, original test database names, private extension/reference GUIDs, business-specific form codes, XML backups, logs and original Git history. Configure connection and scope values locally.

The release was checked for JavaScript syntax and offline scope handling. Provisioning, field creation and BOS publishing were not run against your database. Validate SQL and metadata compatibility on an isolated test copy.

## License

No open-source license is included. Public visibility does not grant copying, modification or distribution rights. Contact the maintainer to confirm authorization before adopting the project.
