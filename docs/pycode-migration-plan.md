# pycode → CrewFlow 迁移方案

> 版本:v1.0(2026-08-29)
> 依据:2026-08 两系统代码分析(pycode @ liuhf/pycode,CrewFlow @ 当前仓库 main)
> 结论先行:两系统"请假/加班/审批"核心账务模型同构,可迁移;差异集中在规则统一化、
> 历史数据口径与定时提醒缺失,均已有明确处理方案,见第 4、7 节。

## 1. 背景与目标

pycode(Flask + MySQL)为现有考勤系统,功能完整但为裸 SQL 单体,维护成本高。
CrewFlow(微信小程序 + Fastify/PostgreSQL)一期已完成请假、加班调休、一级审批、
签名与 PDF 请假单、WxPusher 通知。本方案目标:

1. pycode 全量用户与历史业务数据迁移至 CrewFlow;
2. 业务规则平滑过渡,调休余额对账可验证;
3. 明确切换步骤与回滚预案,旧系统切换后转只读归档。

## 2. 迁移范围

**迁移**:用户与审批关系、加班(值班)记录、请假单(含历史已通过)、调休抵扣明细、
WxPusher 推送绑定。

**不迁移,改由 CrewFlow 承接或放弃**:

| pycode 项 | 处理 |
| --- | --- |
| `date_list`/`daliy_list` 全年日历 | 不迁移。法定节假日改为仓库静态配置(`leave-policy.ts` 与 `config/holidays.js`,现为 2026 年版,每年手工更新) |
| `qian_zi_list` 文件签署体系 | 与考勤无关,不迁移 |
| 请假凭证 xlsx/PDF 附件 | 不迁移进库,旧文件服务器归档保留,历史单据需要时人工调阅 |
| 新生儿(`xinshenger`)、哺乳假校验 | 一期不迁移,列为 P2 功能缺口(见 7.2) |
| 值班(硬件/生产)体系 | 已由 CrewFlow duty 模块另行承接,不在本次数据迁移范围 |

## 3. 两系统核心差异(决定迁移策略的差异)

| 维度 | pycode | CrewFlow | 迁移影响 |
| --- | --- | --- | --- |
| 主键体系 | `user_name` 字符串 + 自增/`tx_id` | UUID | 需建名称↔UUID 映射 |
| 请假状态 | `waite`/`YES`/`JI`,**无驳回态**(不通过靠删单) | `pending/approved/rejected/cancelled` 四态 | 撤销单已物理删除,历史无"驳回/撤销"记录,属预期数据缺口 |
| 调休扣减 | 提交时写 `jian_jia_xiu`,剩余量靠 `left_t` 链式推算 | `timeoff_allocations` 快照(含 before/after 不变式)+ `timeoff_ledger` 流水 | **不能逐行搬运,必须重放重算**(见 6.4) |
| 加班时长 | 任意小时数 | 2~6 整小时(数据库 CHECK 约束) | 超范围历史数据入库前需决策(见 6.5) |
| 调休有效期 | 个人化 `qingjia_rule`(3 个月/当月核算等) | 统一 3 个月 | 统一化,见决策 D2 |
| 审批层级 | 单级(manager_id) | 单级(manager_id),表结构支持多级 | 直接映射 |

## 4. 待确认决策(切换前必须闭环)

| 编号 | 决策点 | 建议方案 |
| --- | --- | --- |
| D1 | 加班时长 CHECK(2~6 整小时)与历史数据冲突 | 新增迁移用迁移:约束放宽为 `0<hours<=12` 并允许一位小数,仅对 `migrated=true` 行生效;新录入仍走应用层 2~6 校验 |
| D2 | 历史调休有效期是否统一为 3 个月 | 统一为 `加班日+3 个月`,与现有规则对齐;个别人 `当月核算` 口径在备注字段保留原值,不参与计算 |
| D3 | `JI` 状态单(签名被撤回/预出具)如何映射 | 统一映射为 `approved`,CrewFlow 审批快照用审批人当前签名;原 PDF 已生成的不重建 |
| D4 | `butiaoxiu='不可休'` 的加班 | 映射为 `duty_records.status='revoked'`,不入余额 |
| D5 | 切换日期后的在途审批单 | 切换日 T 前 pycode 冻结写入;T 日仍有 `waite` 的单在旧系统审批完(或驳回后由申请人不再重提),迁移脚本只取最终态;如需带 `waite` 迁移则照常映射为 `pending` |
| D6 | 迁移后用户如何首次登录 | 沿用现有注册/绑定流程:按 姓名+手机号 `/bind` 绑定微信;迁移脚本预写姓名、手机号、部门等档案字段 |

## 5. 表映射总览

| pycode(MySQL `manage`) | CrewFlow(PostgreSQL) | 迁移方式 |
| --- | --- | --- |
| `user_db_acct_info` | `users` | 字段映射 + 角色换算(6.1) |
| `user_db_acct_info.manager_id` 关系 | `users.manager_id` | 按姓名查映射后回填 |
| `jian_jia`(加班) | `duty_records` | 字段映射 + 状态重算(6.3) |
| `jian_qing_jia`(请假主表) | `leave_requests` + `approval_records` | 一拆二(6.3) |
| `jian_jia_xiu`(抵扣明细) | `timeoff_allocations` | **重放重算,不逐行搬**(6.4) |
| `jian_tiao_log`(调休日志) | `timeoff_ledger` | 重放时同步生成 earn/use/expire 流水 |
| `tixing_token`(wxpusher 行) | `wxpusher_bindings` | 按 acct↔用户映射直迁 |
| `jian_qing_list_all` 按日明细 | (无对应表) | 不迁移;CrewFlow 以区间+时段表达 |

## 6. 数据迁移细则

迁移工具:一次性 Node.js 脚本(放 `server/scripts/migrate-from-pycode/`),读 MySQL
(`mysql2`)写 PostgreSQL(复用 `pg`),全程事务、可重复执行(按 `external_id` 幂等)。
`duty_records`/`leave_requests` 增加可空列 `external_id` 记录源表主键,便于对账与回溯。

### 6.1 用户与审批关系

- 匹配键:姓名 + 手机号。pycode 缺手机号的,导出缺失清单由管理员补录后再迁。
- 角色换算:被配置为他人 manager 的 → `admin`;其余 → `user`;`role_id` 超管映射
  `super_admin`(以 pycode 后台名单为准,人工复核)。
- `status` 全部置 `active`(旧系统账号即有效账号);首登微信后走 `/bind` 关联 openid。
- `manager_id`、`agent_user_id` 按姓名映射回填,找不到 manager 的进人工清单。

### 6.2 请假单(`jian_qing_jia` → `leave_requests` + `approval_records`)

- `type_qing`(中文值)→ `leave_type` 枚举:调休→comp_time、年假→annual、病假→sick、
  公出→public_out、事假→personal、婚假→marriage、陪产假→paternity、产检假→prenatal、
  产假→maternity、育儿假→parental、丧假→bereavement、哺乳假→breastfeeding。
- `s_date/e_date` + `kaishi/jieshu`(上午/下午)→ `start_date/end_date` +
  `start_period/end_period`(morning/afternoon/day);`day` 列 → `requested_days`,
  `requested_hours = requested_days × 8`(半天按 4)。
- `sp_stat`:`waite→pending`、`YES→approved`、`JI→approved`(D3)。
- 同步生成 `approval_records`(step_no=1):`approver_id` 取该员工当前 manager 映射,
  状态同主表;approved 的写入 `result_snapshot`(按 CrewFlow 规则重算文本)与
  `signer_name`,签名图取审批人当前签名,**历史签名图不逐一回贴**。
- 理由/事由字段并入 `reason`;pycode 侧附件仅在 `remark` 记录归档路径。

### 6.3 加班(`jian_jia` → `duty_records`)

- `tim`→`hours`,`date`→`duty_date`,固定 `start_time='17:30'`,
  `end_time = 17:30 + hours`(与现系统展示口径一致)。
- `expires_at = date + 3 个月`(D2)。
- 状态重算:`不可休`→`revoked`(D4);`expires_at < 迁移日` 且尚有剩余→`expired`
  并记 `expire` 流水;其余 `active`。
- `end_time` 超 23:30 或小时数超界的行按 D1 放宽约束入库,并打 `migrated=true`。

### 6.4 调休余额重放(核心)

不搬 `jian_jia_xiu` 旧行,以"事件重放"重建一致性账目:

1. 取全部请假单按提交时间升序,仅 `comp_time` 且终态 ∈ {approved, pending};
   (pycode 已删除的撤销单天然不在,回放结果即"现存事实")
2. 逐单按 CrewFlow `allocateTimeoff` 规则分配:候选 = 该员工 `active` 且未过期加班,
   按 `expires_at` 升序、`duty_date` 升序;生成 `timeoff_allocations`
   (含 before/after)与 `timeoff_ledger 'use'` 流水;
3. 额度不足的异常单不阻塞迁移,进《迁移异常清单》人工裁定(改单或作废);
4. 完成后校验不变式:`remaining_after = remaining_before − hours ≥ 0`;
   `duty_records.remaining_hours = hours − Σallocations(该记录)`;
5. 将重放结果与 pycode `jian_tiao_log` 尾条记录、页面"年度汇总"抽样比对。

### 6.5 数据清洗

- 手机号去空格/全角转半角;日期统一 `Asia/Shanghai`;
- 同人同名不同 mobile 的重复账号进人工清单,禁止自动合并;
- `type_qing` 出现枚举外取值的行进异常清单。

## 7. 功能补齐计划(迁移前后的开发项)

### 7.1 P0:切换阻塞项

- [ ] 迁移脚本 + 幂等重跑 + 异常清单导出(第 6 节)
- [ ] D1~D6 决策落地的 migration(SQL)与应用层改动
- [ ] 用户批量激活与角色批量设置页面(管理员,免逐一操作)
- [ ] 月度台账(month-records)兼容展示迁移历史数据

### 7.2 P1:切换后一个月内

- [ ] 定时提醒:待办催办(每日)、加班未登记提醒、调休到期提醒
      (复用 WxPusher,APScheduler 对应物用 node-cron 或系统 cron 调脚本)
- [ ] 调休到期分档预警(<7 天紧急 / 7~14 天临近)
- [ ] 产假 158 天自动口径;批量审批
- [ ] `situation` 展开口径修复:排除法定节假日(`situation.ts:82` 当前只排周末)

### 7.3 P2:按需排期

- [ ] 请假单 Excel 导出与 zip 打包
- [ ] 年假额度视图;"当月核算"人员口径
- [ ] 哺乳假新生儿额度校验;值班与调休联动

## 8. 切换方案

采用**冻结切换 + 双跑对账**:

1. **T-7 天**:发布 P0 项;测试环境用 pycode 生产库快照试迁,产出异常清单并清零;
2. **T-3 天**:全员通告切换日期与"旧单尽快在旧系统办结";
3. **T 日(建议周五晚)**:pycode 关闭写入(改只读展示)→ 生产库 dump → 正式迁移 →
   对账通过 → 开放 CrewFlow;
4. **T+1 周**:双跑对账期,CrewFlow 实际运行,pycode 只读可查,差异按日清零;
5. **T+1 月**:pycode 下线,MySQL dump 与附件归档保存 ≥2 年。

**回滚预案**:T+1 周内出现阻塞性问题 → 旧系统解除只读恢复使用(它从未停机,天然回滚点);
CrewFlow 期间产生的数据以导出件留档,人工补录回旧系统。切换窗口内不做不可逆操作
(所有迁移幂等、可整库重放)。

## 9. 验收标准

- [ ] 用户:迁移数 = pycode 在册有效数,缺失手机号清单为 0 或已签核;
- [ ] 审批关系:每人 manager 非空(普通用户),抽样 10 人核对一致;
- [ ] 调休对账:全员 `duty_records` 可用余额与 pycode 页面"年度汇总剩余"逐人一致,
      差异清单为 0(或每条差异有人工裁定记录);
- [ ] 请假单:总数一致;抽样 20 张(含婚假/陪产假/半天/跨节假日)字段比对通过;
- [ ] 流程冒烟:新提交请假 → 审批通过/驳回 → PDF 下载 → 通知触达,全链路通过;
- [ ] 历史单据:任意已通过请假单可在月度台账查看、可下载 PDF。

## 10. 风险清单

| 风险 | 等级 | 应对 |
| --- | --- | --- |
| pycode 余额口径本身有历史脏数据,重放结果与页面显示不一致 | 高 | 以重放(规则化)为准,差异清单逐条人工签核,不做静默抹平 |
| 姓名重复/缺手机号导致用户匹配失败 | 中 | 迁移前两周发普查通知补全;匹配失败的走管理员人工建档 |
| 老员工不熟悉小程序 | 中 | T-3 天培训+图文操作手册;双跑期旧系统只读兜底 |
| 镜像/依赖国内网络问题 | 低 | 已解决(Docker 镜像加速已配,开发服务器已就绪) |
| 节假日配置年份过期 | 低 | 每年国务院文件发布后同步 `leave-policy.ts` 与 `config/holidays.js`(文档已有注明) |

## 11. 里程碑

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| M1 | D1~D6 决策签核、pycode 数据质量普查(手机号/重复名) | 3 个工作日 |
| M2 | P0 开发:迁移脚本 + 管理批量页 + migration | 1 周 |
| M3 | 测试环境试迁 + 异常清零 + 验收演练 | 3 个工作日 |
| M4 | 生产切换 + 双跑对账 | 1 天 + 1 周 |
| M5 | P1 功能补齐 | 切换后 1 个月内 |
