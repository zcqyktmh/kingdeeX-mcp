# kingdeeX MCP

**简体中文** | [English](README.en.md)

面向金蝶云星空企业版测试副本的实验性 MCP 服务，用于预览、新增部门扩展表单字段，以及只读检查指定表单元数据。服务通过 Node.js 和 SQL Server 直接操作元数据，不是金蝶官方产品。

本项目单独发布，保留 kingdeeX 的受限写入能力；通用 SQL 只读查询项目见 [kingdee-sqlserver-mcp](https://github.com/zcqyktmh/kingdee-sqlserver-mcp)。

## 适用范围与限制

- 只允许本机配置的一个测试数据库、一个继承 `BD_Department` 的扩展表单；物理表固定为 `dbo.T_BD_DEPARTMENT`，布局容器固定为 `FTAB_PBASE`。
- 不能新建业务对象或单据，也不是任意表、任意表单的字段编辑器。
- 直接修改 `T_META_OBJECTTYPE`、布局 XML 和物理列；下拉字段还会写枚举表。这会绕过 BOS/SVN 变更历史，不能直接拿来修改生产库。
- 写入默认关闭。新增字段需要本机 `KINGDEEX_ENABLE_WRITES=true`，并在 MCP 调用中传 `apply:true`。
- MCP 运行时读写账号分离；专用写账号只获指定过程的执行权。过程使用 `EXECUTE AS OWNER`，内部限制才是实际写入边界，部署后应审阅其定义。
- 新增前检查字段键、布局和物理列占用，备份原表单 XML，并按元数据版本检查冲突；新增列、元数据和枚举修改在过程事务内执行。
- XML 备份用于检查和恢复参考，不是完整数据库备份；当前未提供一键撤销或删字段功能。先备份完整测试数据库。
- 新增后仍需在 BOS 保存/发布对象、刷新元数据与缓存，并在前端重新打开部门表单验证。脚本不会自动更新 BOS/SVN 应用文件。

## 功能

统一工具名为 `kingdeeX`，通过 `action` 选择操作：

| action | 用途 | 是否写入 |
|---|---|---|
| `inspect_form_metadata` | 检索本机配置的表单代码和表名模式，返回有长度限制的 XML 预览与表字段候选 | 否 |
| `preview_add_department_text_field` | 预览文本字段 | 否 |
| `add_department_text_field` | 新增文本字段 | 是 |
| `preview_add_department_customer_field` | 预览客户引用字段 | 否 |
| `add_department_customer_field` | 新增客户引用字段 | 是 |
| `preview_add_department_typed_field` | 预览指定类型字段 | 否 |
| `add_department_typed_field` | 新增指定类型字段 | 是 |

支持类型：`TextField`、`IntegerField`、`DecimalField`、`AmountField`、`QtyField`、`BaseQtyField`、`DateField`、`DateTimeField`、`TimeField`、`CheckBoxField`、`ComboField`、`BaseDataField`、`OrgField`、`UserField`、`UnitField`、`AssistantField`。

字段键必须匹配 `F_KINGDIEX_[A-Z0-9_]{1,40}`。通用类型可用 `isRequired:true` 写入必填标记；`precision` 为 1–23，`scale` 为 0–10 且不能大于 precision。多语言文本、多选基础资料和分录字段不在支持范围内。最终兼容性取决于实际金蝶版本与元数据结构。

## 环境与本机配置

需要 Node.js 20+、SQL Server 2016 SP1+（使用 `CREATE OR ALTER PROCEDURE` 与 JSON 功能）、兼容的金蝶云星空测试库，以及支持 MCP stdio 的客户端。

```powershell
npm ci
Copy-Item .env.example .env
```

在本机 `.env` 配置连接参数与只读账号。`SQLSERVER_DATABASE` 与 `KINGDEEX_ALLOWED_DATABASE` 必须一致且不能是系统库。`KINGDEEX_DEPARTMENT_FORM_ID` 填入测试库中真实的部门扩展表单 GUID；示例占位值无法启动。

客户、组织、用户、单位引用对象 GUID 不随公开版本提供：从本机元数据确认后填写 `KINGDEEX_CUSTOMER_OBJECT_ID`、`KINGDEEX_ORG_OBJECT_ID`、`KINGDEEX_USER_OBJECT_ID`、`KINGDEEX_UNIT_OBJECT_ID`；通用引用字段也可通过 `lookupObjectId` 指定。不要从其它账套照搬这些值。

可选的 `inspect_form_metadata` 需要 `KINGDEEX_INSPECT_FORM_CODE` 与 `KINGDEEX_INSPECT_TABLE_PATTERN`。它按 XML 文本/表名模式检索，返回的是候选匹配，不保证精确对象映射。

## 初始化写入过程

仅需预览时可跳过初始化，保持写入关闭。实际新增字段前，先审阅源码与测试库备份，再在 `.env` 配置管理员账号、密码并将 `KINGDEEX_ENABLE_WRITES` 改为 `true`。初始化脚本要求 sysadmin；管理员凭据只由本机脚本读取。

按顺序运行，每一步都需要显式 `--apply`：

```powershell
npm run provision -- --apply
npm run provision:customer -- --apply
npm run provision:typed -- --apply
```

第一步创建专用登录 `mcp_kingdeex_deptmeta`、数据库用户和文本字段过程；写密码为空时生成随机密码并保存到 `.env`。第二步需要配置客户对象 GUID，创建客户引用过程。第三步首次创建或更新通用字段过程。初始化不是全程原子的；如果中途失败，先检查现有登录、用户、过程和权限再决定后续动作。

运行时只读登录需有元数据/结构读取权限；写登录只获三个指定过程的执行权，不加入 `db_datawriter` 或 `sysadmin`。数据库、扩展表单 GUID 在初始化时固化到过程定义；后续修改 `.env` 不会自动迁移或重定向已部署过程，需管理员重新审阅。

## MCP 客户端配置

```toml
[mcp_servers.kingdeeX]
command = "node"
args = ["C:/path/to/kingdeeX-mcp/src/kingdeeX.js"]
cwd = "C:/path/to/kingdeeX-mcp"
```

换成实际绝对路径，重新连接 MCP。也可用 `npm start` 启动 stdio 服务。

## 调用示例

先预览：

```json
{"action":"preview_add_department_typed_field","fieldKey":"F_KINGDIEX_SAMPLE","displayName":"示例数量","fieldType":"QtyField","precision":23,"scale":4}
```

确认 `can_apply`、数据库、表单和字段类型符合预期后，使用相同参数新增：

```json
{"action":"add_department_typed_field","fieldKey":"F_KINGDIEX_SAMPLE","displayName":"示例数量","fieldType":"QtyField","precision":23,"scale":4,"apply":true}
```

下拉字段需 2–50 个不重复的 ASCII 编码选项；可用中文标题：

```json
{"action":"preview_add_department_typed_field","fieldKey":"F_KINGDIEX_STATUS","displayName":"示例状态","fieldType":"ComboField","enumOptions":[{"value":"A","caption":"启用"},{"value":"B","caption":"停用"}]}
```

引用字段需要 `lookupObjectId` 或配置好的本机默认值；`orgFieldKey`、金额/数量的 `controlFieldKey`、数量的 `baseQtyFieldKey` 必须引用目标对象已有字段。

## 可选的旧字段 ID 修复

`npm run repair:element-ids -- --apply` 仅用于旧文本字段的业务节点与外观节点共用 ID 的情况。必须先在 `.env` 明确填写 `KINGDEEX_REPAIR_FIELD_KEY`，并启用写入。脚本可能先更新旧文本过程，再检查并修复指定字段，执行前应审阅；新安装已生成独立 ID，不需要此步骤。

## 发布与验证说明

公开包不含真实连接配置、密码、原测试库名、私有扩展表单/引用对象 GUID、业务特定表单代码、XML 备份、日志或原 Git 历史。连接与范围占位值需要在本机填写。

发布版做了 JavaScript 语法与离线范围检查；未在你的数据库执行初始化、字段新增或 BOS 发布。SQL 和元数据兼容性需要在隔离测试副本验证。

## 许可

未附带开源许可证。公开可见不代表授予复制、修改或分发许可；采用前请联系仓库维护者确认授权。
