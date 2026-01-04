#!/usr/bin/env node

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

const crypto = require('crypto');

const verdaccioBin = path.join(__dirname, 'node_modules', '.bin', 'verdaccio.cmd');
const configPath = path.join(__dirname, 'config.yaml');
const pidFile = path.join(__dirname, '.verdaccio.pid');
const staticPidFile = path.join(__dirname, '.static-server.pid');
const reposDir = path.join(__dirname, 'repos');
const publicDir = path.join(__dirname, 'public');
const npmrcPath = path.join(__dirname, '.npmrc');
const STATIC_SERVER_PORT = 4874;

// Cloudflare R2 配置
const CLOUDFLARE_R2_CONFIG = {
    publicUrl: 'https://rs1.aily.pro',
    bucket: 'ailyblockly',
    manifestFile: 'manifest.json'  // 文件清单
};

// 默认用户信息
const DEFAULT_USER = {
    username: 'aily-admin',
    password: 'aily123456',
    email: 'admin@aily.local'
};


/**
 * 等待 verdaccio 启动
 */
function waitForVerdaccio(maxRetries = 30, interval = 1000) {
    return new Promise((resolve, reject) => {
        let retries = 0;

        const check = () => {
            const req = http.get('http://localhost:4873/-/ping', (res) => {
                res.resume(); // 消费响应数据
                if (res.statusCode === 200) {
                    res.destroy(); // 销毁连接
                    resolve();
                } else {
                    res.destroy();
                    retry();
                }
            });

            req.on('error', () => {
                retry();
            });

            req.setTimeout(1000, () => {
                req.destroy();
                retry();
            });
        };

        const retry = () => {
            retries++;
            if (retries >= maxRetries) {
                reject(new Error('Verdaccio 启动超时'));
            } else {
                setTimeout(check, interval);
            }
        };

        check();
    });
}

/**
 * 直接通过 htpasswd 文件创建用户（备用方案）
 * 这种方式不依赖 npm adduser 的交互式输入
 */
function createUserViaHtpasswd(userInfo) {
    // 注意：config.yaml 中配置的是 ./htpasswd，即项目根目录
    const htpasswdPath = path.join(__dirname, 'htpasswd');
    
    console.log(`尝试通过 htpasswd 文件创建用户: ${userInfo.username}`);
    console.log(`htpasswd 文件路径: ${htpasswdPath}`);
    
    // 生成 bcrypt 风格的密码哈希（Verdaccio 使用的格式）
    // 使用 Apache 的 SHA1 格式: {SHA}base64(sha1(password))
    const sha1Hash = crypto.createHash('sha1').update(userInfo.password).digest('base64');
    const passwordHash = `{SHA}${sha1Hash}`;
    
    const userLine = `${userInfo.username}:${passwordHash}:autocreated ${new Date().toISOString()}`;
    
    try {
        // 读取现有的 htpasswd 文件
        let existingContent = '';
        if (fs.existsSync(htpasswdPath)) {
            existingContent = fs.readFileSync(htpasswdPath, 'utf8');
            
            // 检查用户是否已存在
            const lines = existingContent.split('\n');
            const userExists = lines.some(line => line.startsWith(userInfo.username + ':'));
            
            if (userExists) {
                console.log(`用户 ${userInfo.username} 已存在于 htpasswd 文件中`);
                return true;
            }
        }
        
        // 添加新用户
        const newContent = existingContent ? existingContent.trim() + '\n' + userLine + '\n' : userLine + '\n';
        fs.writeFileSync(htpasswdPath, newContent, 'utf8');
        console.log(`用户 ${userInfo.username} 已通过 htpasswd 创建成功`);
        return true;
    } catch (error) {
        console.error(`通过 htpasswd 创建用户失败: ${error.message}`);
        return false;
    }
}

/**
 * 确保用户已创建
 */
function ensureAuthenticated() {
    console.log('通过 htpasswd 文件创建用户...');
    const success = createUserViaHtpasswd(DEFAULT_USER);
    
    if (success) {
        console.log(`用户 ${DEFAULT_USER.username} 已就绪`);
        return DEFAULT_USER;
    } else {
        throw new Error('创建用户失败');
    }
}

/**
 * 创建本地 .npmrc 配置文件
 * 配置 registry、认证 token 和禁用代理
 */
function createLocalNpmrc() {
    return new Promise((resolve, reject) => {
        console.log('创建本地 .npmrc 配置文件...');
        
        // 通过 Verdaccio API 登录获取真正的 token
        const postData = JSON.stringify({
            name: DEFAULT_USER.username,
            password: DEFAULT_USER.password
        });

        // 生成 Basic Auth 头
        const basicAuth = Buffer.from(`${DEFAULT_USER.username}:${DEFAULT_USER.password}`).toString('base64');
        
        const req = http.request({
            hostname: 'localhost',
            port: 4873,
            path: '/-/user/org.couchdb.user:' + DEFAULT_USER.username,
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
                'Authorization': 'Basic ' + basicAuth
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    const token = result.token;
                    
                    if (!token) {
                        // 如果没有获取到 token，使用 Basic Auth 方式
                        console.log('使用 Basic Auth 认证方式...');
                        const npmrcContent = `# 本地 Verdaccio 配置（由 cli.js 自动生成）
registry=http://localhost:4873/
//localhost:4873/:_auth=${basicAuth}
//localhost:4873/:username=${DEFAULT_USER.username}
//localhost:4873/:_password=${Buffer.from(DEFAULT_USER.password).toString('base64')}
# 禁用代理以避免 localhost 请求走代理导致 502 错误
proxy=null
https-proxy=null
noproxy=localhost,127.0.0.1
`;
                        fs.writeFileSync(npmrcPath, npmrcContent, 'utf8');
                        console.log(`本地 .npmrc 已创建 (Basic Auth): ${npmrcPath}`);
                        resolve(true);
                        return;
                    }
                    
                    const npmrcContent = `# 本地 Verdaccio 配置（由 cli.js 自动生成）
registry=http://localhost:4873/
//localhost:4873/:_authToken=${token}
# 禁用代理以避免 localhost 请求走代理导致 502 错误
proxy=null
https-proxy=null
noproxy=localhost,127.0.0.1
`;
                    
                    fs.writeFileSync(npmrcPath, npmrcContent, 'utf8');
                    console.log(`本地 .npmrc 已创建: ${npmrcPath}`);
                    resolve(true);
                } catch (error) {
                    console.error(`解析响应失败: ${error.message}`);
                    reject(error);
                }
            });
        });
        
        req.on('error', (error) => {
            console.error(`请求失败: ${error.message}`);
            reject(error);
        });
        
        req.write(postData);
        req.end();
    });
}

const REPOS = [
    {
        name: 'aily-blockly-boards',
        github: 'https://github.com/ailyProject/aily-blockly-boards/archive/refs/heads/main.zip',
        url: 'https://gitee.com/coloz/aily-blockly-boards.git',
        cmd: ["npm i", "node genjson.js"],
        public: ["boards.json"]
    },
    {
        name: 'aily-blockly-libraries',
        github: 'https://github.com/ailyProject/aily-blockly-libraries/archive/refs/heads/main.zip',
        url: 'https://gitee.com/coloz/aily-blockly-libraries.git',
        cmd: ["npm i", "node genjson.js"],
        public: ["libraries.json"]
    },
    {
        name: 'aily-project-tools',
        github: 'https://github.com/ailyProject/aily-project-tools/archive/refs/heads/main.zip',
        url: 'https://gitee.com/coloz/aily-project-tools.git'
    },
    {
        name: 'aily-project-compilers',
        github: 'https://github.com/ailyProject/aily-project-compilers/archive/refs/heads/main.zip',
        url: 'https://gitee.com/coloz/aily-project-compilers.git'
    },
    {
        name: 'aily-project-sdks',
        github: 'https://github.com/ailyProject/aily-project-sdks/archive/refs/heads/main.zip',
        url: 'https://gitee.com/coloz/aily-project-sdks.git'
    }
];

const args = process.argv.slice(2);
const command = args[0];
const subCommand = args[1];

function showHelp() {
    console.log(`
Verdaccio 服务管理工具

用法:
  node cli.js run                       启动 verdaccio 后台服务
  node cli.js stop                      停止 verdaccio 后台服务
  node cli.js status                    查看 verdaccio 服务状态
  node cli.js update                    克隆/更新仓库、发布包并同步资源（跳过已存在的文件）
  node cli.js update --force            克隆/更新仓库、发布包并强制同步资源（覆盖已有文件）
  node cli.js unpublish <包名>          从 npm 仓库中卸载指定的包
  node cli.js unpublish <包名>@<版本>   从 npm 仓库中卸载指定版本的包
  node cli.js help                      显示帮助信息

示例:
  node cli.js unpublish @aily/arduino_uno
  node cli.js unpublish @aily/arduino_uno@1.0.0
`);
}

function isProcessRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

function getPid() {
    if (fs.existsSync(pidFile)) {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
        if (!isNaN(pid) && isProcessRunning(pid)) {
            return pid;
        }
        // PID 文件存在但进程不存在，清理 PID 文件
        fs.unlinkSync(pidFile);
    }
    return null;
}

async function startVerdaccio() {
    const existingPid = getPid();
    if (existingPid) {
        console.log(`Verdaccio 已经在运行中 (PID: ${existingPid})`);
    } else {
        console.log('正在启动 Verdaccio 后台服务...');

        // 使用 wscript 运行 VBS 脚本来启动隐藏窗口的进程
        const vbsScript = path.join(__dirname, '.start-verdaccio.vbs');
        const vbsContent = `Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """${verdaccioBin.replace(/\\/g, '\\\\')}""" & " --config " & """${configPath.replace(/\\/g, '\\\\')}""", 0, False
`;
        fs.writeFileSync(vbsScript, vbsContent);

        try {
            execSync(`cscript //nologo "${vbsScript}"`, {
                encoding: 'utf8',
                windowsHide: true
            });

            // 等待一下让进程启动
            execSync('ping 127.0.0.1 -n 2 > nul', { shell: true, windowsHide: true });

            // 通过 PowerShell 查找 verdaccio 进程的 PID
            const psCmd = `powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*verdaccio*' -and $_.CommandLine -like '*config.yaml*' } | Select-Object -First 1 -ExpandProperty ProcessId"`;
            const result = execSync(psCmd, {
                encoding: 'utf8',
                windowsHide: true
            }).trim();

            if (result && !isNaN(parseInt(result, 10))) {
                const pid = parseInt(result, 10);
                fs.writeFileSync(pidFile, pid.toString());
                console.log(`Verdaccio 后台服务已启动 (PID: ${pid})`);
                console.log(`访问地址: http://localhost:4873`);
            } else {
                console.log('Verdaccio 后台服务已启动（无法获取 PID）');
                console.log(`访问地址: http://localhost:4873`);
            }

            // 删除临时 VBS 文件
            fs.unlinkSync(vbsScript);
        } catch (e) {
            console.error('启动 Verdaccio 失败:', e.message);
            if (fs.existsSync(vbsScript)) fs.unlinkSync(vbsScript);
            return;
        }
    }

    // 等待 verdaccio 启动并进行用户认证
    console.log('等待 Verdaccio 服务就绪...');
    try {
        await waitForVerdaccio(30, 1000);
        console.log('Verdaccio 服务已就绪');
    } catch (error) {
        console.error('Verdaccio 启动超时:', error.message);
        return;
    }

    // 确保用户已创建
    try {
        const authInfo = ensureAuthenticated();
        console.log(`已创建用户: ${authInfo.username}`);
        
        // 创建本地 .npmrc 配置文件
        await createLocalNpmrc();
    } catch (error) {
        console.error('用户创建或配置失败:', error.message);
    }
}

/**
 * 获取静态服务器 PID
 */
function getStaticPid() {
    if (fs.existsSync(staticPidFile)) {
        const pid = parseInt(fs.readFileSync(staticPidFile, 'utf8').trim());
        // 检查进程是否存在
        try {
            process.kill(pid, 0);
            return pid;
        } catch (e) {
            // PID 文件存在但进程不存在，清理 PID 文件
            fs.unlinkSync(staticPidFile);
        }
    }
    return null;
}

/**
 * 启动静态文件服务器
 */
function startStaticServer() {
    const existingPid = getStaticPid();
    if (existingPid) {
        console.log(`静态文件服务器已经在运行中 (PID: ${existingPid})`);
        return;
    }

    console.log('正在启动静态文件服务器...');

    // 内联的静态服务器代码
    const serverCode = `
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const publicDir = ${JSON.stringify(publicDir)};
const port = ${STATIC_SERVER_PORT};

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip'
};

const server = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  let pathname = decodeURIComponent(parsedUrl.pathname);
  
  if (pathname === '/') {
    pathname = '/index.html';
  }

  const filePath = path.join(publicDir, pathname);
  
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error');
        return;
      }

      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  });
});

server.listen(port, () => {
  console.log('Static server running on http://localhost:' + port);
});
`;

    // 使用 spawn 启动 detached 子进程，直接执行内联代码
    const child = spawn('node', ['-e', serverCode], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
    });

    child.unref();

    // 保存 PID
    if (child.pid) {
        fs.writeFileSync(staticPidFile, child.pid.toString());
        console.log(`静态文件服务器已启动 (PID: ${child.pid})`);
        console.log(`访问地址: http://localhost:${STATIC_SERVER_PORT}`);
    } else {
        console.log('静态文件服务器已启动（无法获取 PID）');
    }
}

function stopVerdaccio() {
    // 停止静态文件服务器
    stopStaticServer();

    const pid = getPid();
    if (!pid) {
        console.log('Verdaccio 服务未在运行');
        return;
    }

    console.log(`正在停止 Verdaccio 服务 (PID: ${pid})...`);

    try {
        // Windows 下使用 taskkill 来终止进程树
        const { execSync } = require('child_process');
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });

        // 删除 PID 文件
        if (fs.existsSync(pidFile)) {
            fs.unlinkSync(pidFile);
        }

        console.log('Verdaccio 服务已停止');
    } catch (e) {
        console.error('停止服务失败:', e.message);
        // 尝试清理 PID 文件
        if (fs.existsSync(pidFile)) {
            fs.unlinkSync(pidFile);
        }
    }
}

/**
 * 停止静态文件服务器
 */
function stopStaticServer() {
    const pid = getStaticPid();
    if (!pid) {
        console.log('静态文件服务器未在运行');
        return;
    }

    console.log(`正在停止静态文件服务器 (PID: ${pid})...`);

    try {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });

        if (fs.existsSync(staticPidFile)) {
            fs.unlinkSync(staticPidFile);
        }

        console.log('静态文件服务器已停止');
    } catch (e) {
        console.error('停止静态文件服务器失败:', e.message);
        if (fs.existsSync(staticPidFile)) {
            fs.unlinkSync(staticPidFile);
        }
    }
}

function showStatus() {
    const pid = getPid();
    if (pid) {
        console.log(`Verdaccio 服务正在运行 (PID: ${pid})`);
        console.log(`访问地址: http://localhost:4873`);
    } else {
        console.log('Verdaccio 服务未在运行');
    }

    const staticPid = getStaticPid();
    if (staticPid) {
        console.log(`静态文件服务器正在运行 (PID: ${staticPid})`);
        console.log(`访问地址: http://localhost:${STATIC_SERVER_PORT}`);
    } else {
        console.log('静态文件服务器未在运行');
    }
}

function runCommand(cmd, cwd, description) {
    console.log(`>>> ${description}`);
    console.log(`>>> 目录: ${cwd}`);
    try {
        execSync(cmd, { cwd, stdio: 'inherit', shell: true });
        return true;
    } catch (e) {
        console.error(`命令执行失败: ${e.message}`);
        return false;
    }
}

/**
 * 下载文件（支持重定向）
 */
function downloadFile(fileUrl, destPath, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        if (maxRedirects <= 0) {
            reject(new Error('重定向次数过多'));
            return;
        }

        const protocol = fileUrl.startsWith('https') ? https : http;
        console.log(`正在下载: ${fileUrl}`);

        const request = protocol.get(fileUrl, (response) => {
            // 处理重定向
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                console.log(`重定向到: ${response.headers.location}`);
                downloadFile(response.headers.location, destPath, maxRedirects - 1)
                    .then(resolve)
                    .catch(reject);
                return;
            }

            if (response.statusCode !== 200) {
                reject(new Error(`下载失败: HTTP ${response.statusCode}`));
                return;
            }

            const fileStream = fs.createWriteStream(destPath);
            response.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close();
                console.log(`下载完成: ${destPath}`);
                resolve(destPath);
            });

            fileStream.on('error', (err) => {
                fs.unlink(destPath, () => { });
                reject(err);
            });
        });

        request.on('error', (err) => {
            reject(err);
        });

        request.setTimeout(60000, () => {
            request.destroy();
            reject(new Error('下载超时'));
        });
    });
}

/**
 * 解压 zip 文件（使用 PowerShell）
 */
function extractZip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        console.log(`正在解压: ${zipPath} -> ${destDir}`);
        try {
            // 确保目标目录存在
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
            }

            // 使用 PowerShell 解压
            const cmd = `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`;
            execSync(cmd, { stdio: 'inherit', shell: true });
            console.log(`解压完成: ${destDir}`);
            resolve(destDir);
        } catch (e) {
            reject(new Error(`解压失败: ${e.message}`));
        }
    });
}

/**
 * 从 GitHub 下载 zip 并解压到指定目录
 */
async function downloadAndExtractRepo(repo, reposDir) {
    const repoPath = path.join(reposDir, repo.name);
    const zipPath = path.join(reposDir, `${repo.name}.zip`);
    const tempExtractDir = path.join(reposDir, `${repo.name}-temp`);

    try {
        // 1. 下载 zip 文件
        await downloadFile(repo.github, zipPath);

        // 2. 删除旧的仓库目录（如果存在）
        if (fs.existsSync(repoPath)) {
            console.log(`删除旧目录: ${repoPath}`);
            fs.rmSync(repoPath, { recursive: true, force: true });
        }

        // 3. 删除临时解压目录（如果存在）
        if (fs.existsSync(tempExtractDir)) {
            fs.rmSync(tempExtractDir, { recursive: true, force: true });
        }

        // 4. 解压到临时目录
        await extractZip(zipPath, tempExtractDir);

        // 5. GitHub zip 包解压后会有一个 repo-name-branch 格式的子目录，需要移动到正确位置
        const extractedItems = fs.readdirSync(tempExtractDir);
        if (extractedItems.length === 1) {
            const extractedDir = path.join(tempExtractDir, extractedItems[0]);
            const stat = fs.statSync(extractedDir);
            if (stat.isDirectory()) {
                // 移动解压后的目录到目标位置
                fs.renameSync(extractedDir, repoPath);
                console.log(`已移动: ${extractedDir} -> ${repoPath}`);
            }
        } else {
            // 如果不是单个目录，直接重命名临时目录
            fs.renameSync(tempExtractDir, repoPath);
        }

        // 6. 清理临时目录和 zip 文件
        if (fs.existsSync(tempExtractDir)) {
            fs.rmSync(tempExtractDir, { recursive: true, force: true });
        }
        if (fs.existsSync(zipPath)) {
            fs.unlinkSync(zipPath);
            console.log(`已删除 zip 文件: ${zipPath}`);
        }

        return true;
    } catch (error) {
        console.error(`下载或解压仓库失败: ${error.message}`);
        // 清理可能存在的临时文件
        if (fs.existsSync(zipPath)) {
            fs.unlinkSync(zipPath);
        }
        if (fs.existsSync(tempExtractDir)) {
            fs.rmSync(tempExtractDir, { recursive: true, force: true });
        }
        return false;
    }
}

async function runUpdate(forceUpdate = false) {
    console.log('========================================');
    console.log('开始更新仓库并发布包...');
    console.log(`资源同步模式: ${forceUpdate ? '强制更新（覆盖已有文件）' : '增量同步（跳过已有文件）'}`);
    console.log('========================================\n');

    // 检查 verdaccio 是否运行
    console.log('检查 Verdaccio 服务状态...');
    try {
        await waitForVerdaccio(10, 1000);
        console.log('Verdaccio 服务已就绪');
    } catch (error) {
        console.error('Verdaccio 服务未运行，请先执行: node cli.js run');
        return;
    }

    // 确保认证已设置
    try {
        ensureAuthenticated();
        await createLocalNpmrc();
        console.log('认证配置已就绪');
    } catch (error) {
        console.error('认证配置失败:', error.message);
        return;
    }

    // 创建 repos 目录
    if (!fs.existsSync(reposDir)) {
        fs.mkdirSync(reposDir, { recursive: true });
        console.log(`创建目录: ${reposDir}`);
    }

    for (const repo of REPOS) {
        const repoPath = path.join(reposDir, repo.name);

        console.log('\n----------------------------------------');
        console.log(`处理仓库: ${repo.name}`);
        console.log('----------------------------------------');

        // 1. 从 GitHub 下载 zip 并解压
        const downloadSuccess = await downloadAndExtractRepo(repo, reposDir);
        if (!downloadSuccess) {
            console.error(`仓库 ${repo.name} 下载失败，跳过...`);
            continue;
        }

        // 2. 如果配置了 cmd，执行命令
        if (repo.cmd && repo.cmd.length > 0) {
            for (const cmd of repo.cmd) {
                if (!runCommand(cmd, repoPath, `执行: ${cmd}`)) {
                    console.error(`命令执行失败: ${cmd}`);
                }
            }
        } else {
            console.log('该仓库未配置命令，跳过命令执行步骤');
        }

        // 2.5 复制 public 字段中的文件到项目 public 目录
        if (repo.public && repo.public.length > 0) {
            console.log('\n>>> 复制文件到 public 目录...');
            // 确保 public 目录存在
            if (!fs.existsSync(publicDir)) {
                fs.mkdirSync(publicDir, { recursive: true });
                console.log(`创建目录: ${publicDir}`);
            }
            for (const file of repo.public) {
                const srcPath = path.join(repoPath, file);
                const destPath = path.join(publicDir, file);
                if (fs.existsSync(srcPath)) {
                    try {
                        fs.copyFileSync(srcPath, destPath);
                        console.log(`已复制: ${file} -> ${destPath}`);
                    } catch (e) {
                        console.error(`复制文件失败: ${file} - ${e.message}`);
                    }
                } else {
                    console.warn(`源文件不存在: ${srcPath}`);
                }
            }
        }

        // 2.6 对于 aily-blockly-boards，复制各包的 board.webp 到 public/boards/<name>/board.webp
        if (repo.name === 'aily-blockly-boards') {
            console.log('\n>>> 复制开发板图片到 public/imgs/boards 目录...');
            const boardsPublicDir = path.join(publicDir, 'imgs', 'boards');
            if (!fs.existsSync(boardsPublicDir)) {
                fs.mkdirSync(boardsPublicDir, { recursive: true });
            }
            const repoItems = fs.readdirSync(repoPath);
            for (const item of repoItems) {
                const itemPath = path.join(repoPath, item);
                const stat = fs.statSync(itemPath);
                if (stat.isDirectory() && !item.startsWith('.') && item !== 'node_modules') {
                    const boardWebpSrc = path.join(itemPath, 'board.webp');
                    if (fs.existsSync(boardWebpSrc)) {
                        const destDir = path.join(boardsPublicDir, item);
                        if (!fs.existsSync(destDir)) {
                            fs.mkdirSync(destDir, { recursive: true });
                        }
                        const destPath = path.join(destDir, 'board.webp');
                        try {
                            fs.copyFileSync(boardWebpSrc, destPath);
                            console.log(`已复制: ${item}/board.webp -> ${destPath}`);
                        } catch (e) {
                            console.error(`复制文件失败: ${item}/board.webp - ${e.message}`);
                        }
                    }
                }
            }
        }

        // 3. 遍历一级文件夹，发布包
        console.log('\n>>> 开始发布包到本地 verdaccio...');
        const items = fs.readdirSync(repoPath);

        for (const item of items) {
            const itemPath = path.join(repoPath, item);
            const stat = fs.statSync(itemPath);

            if (stat.isDirectory() && !item.startsWith('.') && item !== 'node_modules') {
                const pkgJsonPath = path.join(itemPath, 'package.json');

                if (fs.existsSync(pkgJsonPath)) {
                    console.log(`\n发现包: ${item}`);

                    // 读取 package.json 获取包名和版本
                    try {
                        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
                        const pkgName = pkgJson.name;
                        const pkgVersion = pkgJson.version;

                        if (pkgName && pkgVersion) {
                            // 检查包是否已存在
                            let packageExists = false;
                            try {
                                execSync(`npm view ${pkgName}@${pkgVersion} --registry http://localhost:4873`, {
                                    stdio: 'pipe',
                                    shell: true
                                });
                                packageExists = true;
                            } catch (e) {
                                // 包不存在，继续发布
                                packageExists = false;
                            }

                            if (packageExists) {
                                if (forceUpdate) {
                                    // 强制更新模式：先移除再发布
                                    runCommand(
                                        `npm unpublish ${pkgName}@${pkgVersion} --registry http://localhost:4873 --userconfig "${npmrcPath}" --force`,
                                        itemPath,
                                        `移除 ${pkgName}@${pkgVersion}`
                                    );
                                    runCommand(`npm publish --registry http://localhost:4873 --userconfig "${npmrcPath}"`, itemPath, `发布 ${item}`);
                                } else {
                                    // 非强制更新模式：跳过已存在的包
                                    console.log(`包 ${pkgName}@${pkgVersion} 已存在，跳过发布`);
                                }
                            } else {
                                // 包不存在，直接发布
                                runCommand(`npm publish --registry http://localhost:4873 --userconfig "${npmrcPath}"`, itemPath, `发布 ${item}`);
                            }
                        } else {
                            // 无法获取包名或版本，直接尝试发布
                            runCommand('npm publish --registry http://localhost:4873', itemPath, `发布 ${item}`);
                        }
                    } catch (e) {
                        console.log(`读取 package.json 失败: ${e.message}，尝试直接发布`);
                        runCommand(`npm publish --registry http://localhost:4873 --userconfig "${npmrcPath}"`, itemPath, `发布 ${item}`);
                    }
                }
            }
        }
    }

    console.log('\n========================================');
    console.log('仓库更新和包发布完成!');
    console.log('========================================');

    // 执行资源同步（从 Cloudflare R2 同步资源到本地）
    console.log('\n');
    await runSync(forceUpdate);

    console.log('\n========================================');
    console.log('update done!');
    console.log('========================================');
}

/**
 * 发起 HTTP/HTTPS GET 请求并返回响应内容
 */
function httpGet(url, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        if (maxRedirects <= 0) {
            reject(new Error('重定向次数过多'));
            return;
        }

        const protocol = url.startsWith('https') ? https : http;

        const request = protocol.get(url, (response) => {
            // 处理重定向
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                httpGet(response.headers.location, maxRedirects - 1)
                    .then(resolve)
                    .catch(reject);
                return;
            }

            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }

            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => resolve(data));
        });

        request.on('error', reject);
        request.setTimeout(30000, () => {
            request.destroy();
            reject(new Error('请求超时'));
        });
    });
}

/**
 * 从文件清单获取文件列表
 */
async function fetchManifest(baseUrl, manifestFile) {
    const manifestUrl = `${baseUrl}/${manifestFile}`;
    console.log(`正在获取文件清单: ${manifestUrl}`);
    
    try {
        const content = await httpGet(manifestUrl);
        const manifest = JSON.parse(content);
        
        // 支持两种格式：
        // 1. 直接是文件路径数组: ["file1.txt", "dir/file2.txt"]
        // 2. 对象格式: { files: ["file1.txt", "dir/file2.txt"] }
        if (Array.isArray(manifest)) {
            return manifest;
        } else if (manifest.files && Array.isArray(manifest.files)) {
            return manifest.files;
        } else {
            throw new Error('清单格式无效，应为文件路径数组或包含 files 字段的对象');
        }
    } catch (error) {
        if (error.message.includes('HTTP 404')) {
            throw new Error(`文件清单不存在: ${manifestUrl}\n请在 R2 存储桶中创建 ${manifestFile} 文件`);
        }
        throw error;
    }
}

/**
 * 下载单个文件到指定路径
 */
function downloadFileToPath(fileUrl, destPath, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        if (maxRedirects <= 0) {
            reject(new Error('重定向次数过多'));
            return;
        }

        // 确保目标目录存在
        const destDir = path.dirname(destPath);
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }

        const protocol = fileUrl.startsWith('https') ? https : http;

        const request = protocol.get(fileUrl, (response) => {
            // 处理重定向
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                downloadFileToPath(response.headers.location, destPath, maxRedirects - 1)
                    .then(resolve)
                    .catch(reject);
                return;
            }

            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }

            const fileStream = fs.createWriteStream(destPath);
            response.pipe(fileStream);

            fileStream.on('finish', () => {
                fileStream.close();
                resolve(destPath);
            });

            fileStream.on('error', (err) => {
                fs.unlink(destPath, () => { });
                reject(err);
            });
        });

        request.on('error', reject);
        request.setTimeout(120000, () => {
            request.destroy();
            reject(new Error('下载超时'));
        });
    });
}

/**
 * 从 Cloudflare R2 同步资源到本地
 * @param {boolean} forceUpdate - 是否强制更新（覆盖已有文件）
 */
async function runSync(forceUpdate = false) {
    console.log('========================================');
    console.log('开始从 Cloudflare R2 同步资源...');
    console.log(`公开 URL: ${CLOUDFLARE_R2_CONFIG.publicUrl}`);
    console.log(`存储桶: ${CLOUDFLARE_R2_CONFIG.bucket}`);
    console.log(`文件清单: ${CLOUDFLARE_R2_CONFIG.manifestFile}`);
    console.log(`模式: ${forceUpdate ? '强制更新（覆盖已有文件）' : '增量同步（跳过已有文件）'}`);
    console.log('========================================\n');

    // 确保 public 目录存在
    if (!fs.existsSync(publicDir)) {
        fs.mkdirSync(publicDir, { recursive: true });
        console.log(`创建目录: ${publicDir}`);
    }

    try {
        // 1. 从文件清单获取文件列表
        const files = await fetchManifest(CLOUDFLARE_R2_CONFIG.publicUrl, CLOUDFLARE_R2_CONFIG.manifestFile);
        
        if (files.length === 0) {
            console.log('文件清单为空，没有文件需要下载');
            return;
        }

        console.log(`\n共 ${files.length} 个文件在清单中...\n`);

        // 2. 下载所有文件
        let successCount = 0;
        let skipCount = 0;
        let failCount = 0;

        for (let i = 0; i < files.length; i++) {
            const fileKey = files[i];
            const fileUrl = `${CLOUDFLARE_R2_CONFIG.publicUrl}/${encodeURIComponent(fileKey).replace(/%2F/g, '/')}`;
            const destPath = path.join(publicDir, fileKey);

            const progress = `[${i + 1}/${files.length}]`;

            // 检查文件是否已存在（非强制更新模式）
            if (!forceUpdate && fs.existsSync(destPath)) {
                console.log(`${progress} - ${fileKey} (已存在，跳过)`);
                skipCount++;
                continue;
            }
            
            try {
                await downloadFileToPath(fileUrl, destPath);
                console.log(`${progress} ✓ ${fileKey}`);
                successCount++;
            } catch (error) {
                console.error(`${progress} ✗ ${fileKey}: ${error.message}`);
                failCount++;
            }
        }

        console.log('\n========================================');
        console.log('同步完成!');
        console.log(`下载成功: ${successCount} 个文件`);
        console.log(`已跳过: ${skipCount} 个文件`);
        console.log(`下载失败: ${failCount} 个文件`);
        console.log(`目标目录: ${publicDir}`);
        console.log('========================================');

    } catch (error) {
        console.error(`同步失败: ${error.message}`);
    }
}

/**
 * 从 npm 仓库中卸载指定的包
 * @param {string} packageSpec - 包名或包名@版本
 */
async function runUnpublish(packageSpec) {
    if (!packageSpec) {
        console.error('错误: 请指定要卸载的包名');
        console.log('用法: node cli.js unpublish <包名>[@版本]');
        console.log('示例:');
        console.log('  node cli.js unpublish @aily/arduino_uno');
        console.log('  node cli.js unpublish @aily/arduino_uno@1.0.0');
        return;
    }

    console.log('========================================');
    console.log(`准备从 npm 仓库中卸载包: ${packageSpec}`);
    console.log('========================================\n');

    // 检查 verdaccio 是否运行
    console.log('检查 Verdaccio 服务状态...');
    try {
        await waitForVerdaccio(10, 1000);
        console.log('Verdaccio 服务已就绪');
    } catch (error) {
        console.error('Verdaccio 服务未运行，请先执行: node cli.js run');
        return;
    }

    // 执行 unpublish 命令
    try {
        console.log(`\n正在卸载: ${packageSpec}...`);
        execSync(`npm unpublish ${packageSpec} --registry http://localhost:4873 --force`, {
            stdio: 'inherit',
            shell: true
        });
        console.log(`\n✓ 包 ${packageSpec} 已成功从仓库中卸载`);
    } catch (error) {
        console.error(`\n✗ 卸载失败: ${error.message}`);
        console.log('\n可能的原因:');
        console.log('  1. 包名不存在');
        console.log('  2. 指定的版本不存在');
        console.log('  3. 没有足够的权限');
    }

    console.log('\n========================================');
    console.log('unpublish 操作完成');
    console.log('========================================');
}

// 主命令处理
switch (command) {
    case 'run':
        // 启动Verdaccio
        (async () => {
            await startVerdaccio();
            // 启动静态文件服务器
            startStaticServer();
        })();
        break;
    case 'update':
        // 检查是否有 --force 参数
        const forceUpdate = args.includes('--force') || args.includes('-f');
        runUpdate(forceUpdate);
        break;
    case 'unpublish':
        runUnpublish(subCommand);
        break;
    case 'stop':
        stopVerdaccio();
        break;
    case 'status':
        showStatus();
        break;
    case 'help':
    case '--help':
    case '-h':
        showHelp();
        break;
    default:
        if (!command) {
            showHelp();
        } else {
            console.error(`未知命令: ${command}`);
            showHelp();
        }
}
