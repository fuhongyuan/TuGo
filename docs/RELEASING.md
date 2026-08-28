# TuGo 1.0.0 发布清单

[文档目录](README.md) · [打包手册](../release-docs/PACKAGING.md)

这是待执行清单，不是验收报告。首个公开版本统一为 1.0.0，源码发布与安装包发布分别验收。

## 仓库

- [ ] 确认 GitHub 账户、仓库名称、Description、Topics 和可见性。
- [ ] 检查暂存区及拟公开历史，排除密钥、用户数据、安装包、日志、本机路径、编辑器/Agent 会话。
- [ ] 若只公开首版，保留私有备份后，由维护者明确选择新公开仓库或历史整理方案；不要直接重置、强推现有仓库。
- [ ] package.json、锁文件根版本与标签一致：1.0.0 / v1.0.0。
- [ ] 检查中英文文档、功能范围、图像/资源来源和第三方许可。
- [ ] 在 GitHub 启用 **Private vulnerability reporting** 并验证报告入口。
- [ ] 按需启用 Discussions；当前 Issue 模板不含未经确认的仓库 URL。

## 代码与产物

在最终提交执行并记录：

```bash
npm ci
npm run verify:release
```

需要 GUI、回环网络与 LibreOffice。失败先处理或明确记录影响；不能因为 build 成功就声称完整验收通过。

签名 Mac 发布包：

```bash
npm run package:mac:release
npm run test:electron:packaged
```

- [ ] 干净环境首次启动、真实模型连接与工具调用。
- [ ] 自动保存/重启、图片导入、区域引用、单页与多页 PPT。
- [ ] 数据库恢复及备份范围验证，不使用唯一真实数据副本。
- [ ] 语言偏好、提示词、Logo、图狗游标和错误/取消/重试状态。
- [ ] 在目标软件打开导出文件，检查字体、图像、页序与连线。
- [ ] 对实际支持的系统/架构做实机验证，尤其 Windows x64。
- [ ] 核对 Developer ID、Gatekeeper 和公证票据；ad-hoc 包不能称为已公证。
- [ ] 保留项目 LICENSE、NOTICE、依赖原始许可证和 Electron/Chromium notices。
- [ ] 前端 devDependencies 会进入 Renderer，不能在许可证审查时忽略。
- [ ] 校验安装包、SHA-256、SBOM 与依赖清单，确保实际上传文件都被覆盖。

注意：`npm run release:artifacts` 当前按文件名中的 `-1.0.0` 筛选，默认 Windows 文件名 `TuGo Setup 1.0.0.exe` 可能不被纳入。发布 EXE 时单独核对并生成哈希；SBOM 不替代许可证全文。

## GitHub Release

- [ ] 对确认的提交创建 v1.0.0 标签。
- [ ] 使用 [发布说明](../release-docs/RELEASE_NOTES.md)，填写真实日期、提交、系统、验证与签名状态。
- [ ] 上传最终附件及校验/许可材料，不上传旧品牌和内部候选包。
- [ ] 从用户角度重新下载、校验和安装。
- [ ] 未完成正式验收时明确标记 prerelease。

上述公开发布、历史修改、上传或删除操作需由维护者单独执行，不由文档整理自动触发。
