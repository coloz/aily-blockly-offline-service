# aily blockly离线服务
`本程序仅供教育用途，禁止用于商业用途`

运行aily blockly离线服务，会在本地启动一套私有仓库服务，用于管理和分发aily blockly相关的开发板、库、编译器、SDK 和工具包。

## 功能特性
- 🚀 本地私有 npm 仓库服务（Verdaccio）
- 📦 自动克隆/更新远程仓库并发布包
- 🖼️ 静态文件服务器（提供开发板、库目录及图片等资源）
- 🔐 内置用户认证管理
- 🔄 一键更新所有依赖包

## 环境要求

- Node.js >= 20.x
- Windows 操作系统（当前版本针对 Windows 优化）

## 安装

```bash
# 克隆仓库
git clone https://github.com/ailyProject/aily-blockly-offline-service.git
cd aily-blockly-offline-service

# 安装依赖
npm install
```

## 快速开始

### 1. 启动服务

```bash
node cli.js run
```

这将启动：
- **Verdaccio 服务**: `http://localhost:4873` - npm 私有仓库
- **静态文件服务器**: `http://localhost:4874` - 静态资源服务

### 2. 更新/发布包

```bash
node cli.js update
```

此命令会：
1. 克隆或更新以下仓库：
   - `aily-blockly-boards` - 开发板配置
   - `aily-blockly-libraries` - 库配置
   - `aily-project-tools` - 工具包
   - `aily-project-compilers` - 编译器
   - `aily-project-sdks` - SDK
2. 执行仓库中配置的构建命令
3. 将所有包发布到本地 Verdaccio

### 3. 停止服务

```bash
node cli.js stop
```

### 4. 查看状态

```bash
node cli.js status
```

## 命令参考

| 命令 | 说明 |
|------|------|
| `node cli.js run` | 启动 Verdaccio 和静态文件服务器 |
| `node cli.js stop` | 停止所有服务 |
| `node cli.js status` | 查看服务运行状态 |
| `node cli.js update` | 克隆/更新仓库并发布包到本地 Verdaccio |
| `node cli.js help` | 显示帮助信息 |

## npm 脚本

也可以使用 npm 脚本运行：

```bash
npm run run      # 启动服务
npm run stop     # 停止服务
npm run status   # 查看状态
npm run update   # 更新包
npm start        # 前台启动 Verdaccio
```

## 目录结构

```
aily-blockly-offline-service/
├── cli.js              # 命令行工具入口
├── start-verdaccio.js  # Verdaccio 启动脚本
├── config.yaml         # Verdaccio 配置文件
├── htpasswd            # 用户认证文件
├── package.json        # 项目配置
├── public/             # 静态资源目录
│   ├── index.html      # 静态服务首页
│   ├── boards.json     # 开发板配置 JSON
│   ├── libraries.json  # 库配置 JSON
│   └── boards/         # 开发板图片资源
├── repos/              # 克隆的远程仓库
│   ├── aily-blockly-boards/
│   ├── aily-blockly-libraries/
│   ├── aily-project-compilers/
│   ├── aily-project-sdks/
│   └── aily-project-tools/
└── storage/            # Verdaccio 包存储目录
```

## 配置说明

### Verdaccio 配置 (config.yaml)

- **存储路径**: `./storage`
- **认证方式**: htpasswd 文件认证
- **上游代理**: npmjs.org

### 默认用户

服务启动时会自动创建默认用户：

- **用户名**: `aily-admin`
- **密码**: `aily123456`
- **邮箱**: `admin@aily.local`

用户信息保存在 `.env` 文件中。

## 使用本地仓库

在其他项目中使用本地 Verdaccio 仓库：

```bash
# 临时使用
npm install <package-name> --registry http://localhost:4873

# 配置为默认仓库
npm config set registry http://localhost:4873

# 或在项目根目录创建 .npmrc 文件
echo "registry=http://localhost:4873" > .npmrc
```

## 日志文件

- `verdaccio.log` - Verdaccio 服务日志
- `static-server.log` - 静态文件服务器日志

## 常见问题

### Q: 服务无法启动？

检查端口 4873 和 4874 是否被占用：

```bash
netstat -ano | findstr :4873
netstat -ano | findstr :4874
```

### Q: update 命令失败？

1. 确保 Verdaccio 服务已启动 (`node cli.js run`)
2. 检查网络连接是否正常（需要访问 Gitee 仓库）
3. 确保 Git 已正确安装

### Q: 如何清理所有数据重新开始？

```bash
# 停止服务
node cli.js stop

# 删除存储和仓库目录
rmdir /s /q storage
rmdir /s /q repos

# 删除 PID 和日志文件
del .verdaccio.pid .static-server.pid verdaccio.log static-server.log

# 重新启动
node cli.js run
```

## 许可证

ISC
