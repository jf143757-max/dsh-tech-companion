# Changelog

## 0.2.0 — 2026-11-03

### Added

- 知识点卡片：每次「吱吱老师提醒你：」都可以落成一张卡，固定 7 个字段（日期、原话、知识点、为什么是这样、今天在哪个任务里遇到的、能这样说、易错点）。只记卡片，不记聊天全文；第一次使用时给出默认套餐，用户同意后才写入；「关闭记录」后不再写新卡。
- 学习账本组件 `skills/tech-companion/scripts/ledger.mjs`（零依赖 Node.js），数据在 `~/.tech-companion/ledger.json`（`TECH_COMPANION_HOME` 可改），以及命令行 `companion.mjs`。
- 每日汇总：默认 21:00、有新点或到期点才发（空日不发）、就在对话里、新点最多 3 个按影响排序、固定格式加 1 道复盘小问题；每一项都能用一句话改（「改成 22 点」「以后只发 1 个」等）。
- 间隔复习：+1/+3/+7/+15/+30 天；记得拉长、忘了回到 +1、没回答算看过一次；+30 仍记得即掌握。代码注释和文档说明遗忘曲线不是算法、间隔是经验启发式。
- 两种复习模式：定期复习（默认，最多 3 个快问）和每天复习（昨天和过去 7 天的点每天问，直到连续两次记得，最多 5 个快问），一句话切换。
- Harness：第二个插件行 `tech-companion-ledger`（`dsh-tech-companion/ledger`），注册 `tech_companion_card`、`tech_companion_digest`、`tech_companion_review`、`tech_companion_settings` 四个工具和一段账本说明；需要工具注册表，可用 profile 补丁 `disabled: true` 单独关闭。定时由 Harness 的定时任务（`schedule_create`）在用户同意后创建。
- Hermes：`SKILL.md` 增加账本说明（通过 `terminal` 调用脚本），以及 cron 门控脚本 `hermes-cron-gate.sh`（空日输出 `{"wakeAgent": false}`，不调用模型）和零模型调用的 `hermes-cron-text.sh`。
- 测试：账本、汇总、间隔、复习模式、记录边界、命令行和 Hermes 脚本（`npm test`）；`test/harness-runtime.mjs` 可在 npm 版 Harness 上运行；`test/eval-examples.mjs` 用真实模型检查 13 个任务例子。

### Changed

- 提醒改成小卡片形状：知识点一句，「为什么：」一行，事实确认时「能这样说：」一行，必要时「易错点：」。原有底线不变：先做完任务再提醒；没有术语可补充时不强行提醒；不把口语、合理类比、正在探索的想法当成错误；不编造用户没说过的信息；可能造成伤害或不可逆后果时在操作前说。
- `SKILL.md` 现在逐字包含 `index.js` 的指导，并由测试保证两者不再分叉。
- README：补上主题、核心理念、用户痛点；按“静态指导 / 账本 / 定时器”三层说明能做什么、需要什么；写明降级方案和诚实边界。
- README：独立 CLI 不能用 `--profile desktop`（Harness 0.2.1-rc.5 会拒绝），示例改为普通 profile；Hermes 0.19.0 没有 `skills.auto_load`，需要用 `-s`。

## 0.1.0

- 首个版本：DeepSeek Harness bundle 与 Hermes 技能，提供同一段静态行为指导，在任务完成后以「吱吱老师提醒你：」温和地补充更准确的技术说法。
