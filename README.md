# Tech Companion / 技术学习搭子

一边完成你的任务，一边在出现有实际影响的技术误解时，用简短、尊重的方式解释关键概念。正确表达、口语简称和不确定的猜测不应被当作错误。

提醒通常放在任务回复末尾，以「吱吱老师提醒你：」开头。可能造成伤害、数据丢失或不可逆后果的问题会在相关操作之前说明；没有需要纠正的误解时，不强行插入提醒。

示例：

> 你：把 Mac Studio 设成睡眠，让它晚上继续运行任务。
>
> 助手：我先检查电源设置和任务安排。\n>\n> 吱吱老师提醒你：Mac 睡眠时程序通常会暂停，也可能无法远程连接。可以关闭屏幕，同时让电脑保持唤醒。

> 你：UDP 和 ASCII 是二选一吗？
>
> 助手：可以一起用。UDP 负责通过网络传数据，ASCII 是数据的文字编码格式。例如，可以用 UDP 发送一条 ASCII 文字指令。

> 你：我网速测到 1400 Mbps，是不是每秒能下载 1400 MB？
>
> 助手：通常需要先区分单位：1400 Mbps 约等于 175 MB/s，这是理论换算，实际速度还受网络和服务器影响。

> 你：帮我把这个文件改个名字。
>
> 助手：直接处理请求，不强行插入技术科普。

## DeepSeek Harness

本项目是 Harness bundle，为现有会话添加一小段静态行为指导，不创建独立后台服务、不保存聊天记录，也不触发额外模型调用。助手原有的模型提供商仍会按用户的配置处理聊天内容；插件不能保证模型每次都遵循指导。

本地开发测试：

```sh
npm test
```

安装到已有 Harness profile：

```sh
dsh plugin --profile desktop add github:jf143757-max/dsh-tech-companion
```

新会话中试问：“UDP 和 ASCII 是二选一吗？”和“帮我把文件改名”。卸载：

```sh
dsh plugin --profile desktop remove dsh-tech-companion
```

具体 profile 名与启动方式取决于你的 Harness 安装；详见 [Harness 官方打包文档](https://github.com/deepseek-ai/DeepSeek-Harness/blob/master/docs/user/develop/basic/publish.md)。

当前已在 DeepSeek Harness 0.2.1-rc.3 的真实 Cordis / SystemPrompt 运行时验证加载、提示词注册和卸载，并在隔离配置中验证本地包安装。完整对话效果取决于所选模型，遇到不确定问题仍应核对事实。

## Hermes Agent

`skills/tech-companion/SKILL.md` 提供相同的对话指导。Hermes 的普通技能通常按需加载；要在每个新会话应用，需要用户显式配置 `skills.auto_load`，而不是假装安装技能后会自动覆盖每个对话。CLI 测试可以使用 `hermes -s tech-companion chat -q '你的问题'`。详见 [Hermes 技能文档](https://hermes-agent.nousresearch.com/docs/guides/work-with-skills/) 和 [自动加载说明](https://hermes-agent.nousresearch.com/docs/user-guide/cli)。
